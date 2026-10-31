import { existsSync } from "node:fs";
import path from "node:path";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import { advisorySummary, type AdvisorySummary } from "./ai.js";
import {
  SESSION_COOKIE,
  authenticate,
  createSession,
  destroySession,
  requireRole,
  sessionMiddleware,
} from "./auth.js";
import { ChainError } from "./chain.js";
import { screenCase, statusHeadline } from "./screening/engine.js";
import { findOffence, offenceLabel } from "./screening/offences.js";
import { HttpError, type Ctx } from "./services/context.js";
import {
  caseCreateSchema,
  caseDetail,
  dashboard,
  caseSummary,
  createCase,
  getCaseRow,
  liveScreening,
  offenceOf,
  screeningFieldsSchema,
  updateScreeningFields,
  type CaseRow,
} from "./services/cases.js";
import {
  confirmMilestone,
  confirmOrder,
  confirmRevoke,
  confirmSupersede,
  draftApplicationPdf,
  getApplicationRow,
  getOrderRow,
  milestoneInputSchema,
  orderInputSchema,
  prepareMilestone,
  prepareOrder,
  prepareRevoke,
  prepareSupersede,
  readStored,
  recordFiledApplication,
  supersedeInputSchema,
} from "./services/documents.js";

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
/** Wrap async handlers so rejections reach the error middleware (Express 4). */
const h =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res))
      .then((result) => {
        if (result !== undefined && !res.headersSent) res.json(result);
      })
      .catch(next);
  };

const txBody = z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Invalid transaction hash") });
const hex32 = /^0x[0-9a-fA-F]{64}$/;

function sendPdf(res: Response, bytes: Uint8Array, filename: string) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(Buffer.from(bytes));
}

export function createApp(ctx: Ctx) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(cookieParser());
  app.use(sessionMiddleware(ctx.db));
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    next();
  });

  const api = express.Router();
  api.use(express.json({ limit: "200kb" }));

  // ---------------------------------------------------------------- public
  api.get(
    "/health",
    h(async () => ({ ok: true, chain: ctx.chain ? await ctx.chain.health() : null })),
  );

  api.get("/public/config", (_req, res) => {
    const d = ctx.chain?.config.deployment;
    res.json({
      chain: d
        ? {
            enabled: true,
            network: d.network,
            chainId: d.chainId,
            address: d.address,
            deploymentBlock: d.deploymentBlock,
            explorerUrl: d.explorerUrl,
            publicRpcUrl: d.publicRpcUrl,
          }
        : { enabled: false, reason: ctx.config.offChainReason },
      ai: { enabled: Boolean(ctx.config.gemini.apiKey), model: ctx.config.gemini.apiKey ? ctx.config.gemini.model : null },
    });
  });

  // ---------------------------------------------------------------- auth
  const loginSchema = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) });
  api.post(
    "/auth/login",
    h((req, res) => {
      const { username, password } = loginSchema.parse(req.body);
      const user = authenticate(ctx.db, username, password);
      if (!user) throw new HttpError(401, "Incorrect username or password.");
      const { token, expiresAt } = createSession(ctx.db, user.id);
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: ctx.config.cookieSecure,
        expires: new Date(expiresAt),
        path: "/",
      });
      return { user };
    }),
  );
  api.post("/auth/logout", (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) destroySession(ctx.db, token);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });
  api.get("/auth/me", requireRole(), (req, res) => {
    res.json({ user: req.user });
  });

  // ---------------------------------------------------------------- reference + screening
  api.get("/offences", requireRole(), (_req, res) => {
    res.json({
      offences: ctx.offences.map((o) => ({ ...o, label: offenceLabel(o) })),
    });
  });

  api.post(
    "/screening/preview",
    requireRole(),
    h((req) => {
      const f = screeningFieldsSchema.parse(req.body);
      const result = screenCase({
        offence: findOffence(f.offenceId, ctx.offences),
        custodyPeriods: f.custodyPeriods,
        excludedDays: f.excludedDays,
        previousConviction: f.previousConviction,
        otherPendingCases: f.otherPendingCases,
        asOf: ctx.today(),
      });
      return { screening: result, headline: statusHeadline(result) };
    }),
  );

  // ---------------------------------------------------------------- cases
  api.get("/dashboard", requireRole(), (_req, res) => {
    res.json(dashboard(ctx));
  });

  api.get("/cases", requireRole(), (_req, res) => {
    const rows = ctx.db.prepare("SELECT * FROM cases ORDER BY created_at DESC").all() as CaseRow[];
    res.json({ cases: rows.map((r) => caseSummary(ctx, r)) });
  });

  api.post(
    "/cases",
    requireRole("caseworker", "lawyer"),
    h((req, res) => {
      const input = caseCreateSchema.parse(req.body);
      const id = createCase(ctx, input, req.user!);
      res.status(201);
      return caseDetail(ctx, id, req.user!);
    }),
  );

  api.get(
    "/cases/:id",
    requireRole(),
    h((req) => caseDetail(ctx, req.params.id!, req.user!)),
  );

  api.put(
    "/cases/:id",
    requireRole("caseworker", "lawyer"),
    h((req) => {
      updateScreeningFields(ctx, req.params.id!, screeningFieldsSchema.parse(req.body));
      return caseDetail(ctx, req.params.id!, req.user!);
    }),
  );

  const summaryCache = new Map<string, AdvisorySummary>();
  api.get(
    "/cases/:id/summary",
    requireRole(),
    h(async (req) => {
      const row = getCaseRow(ctx, req.params.id!);
      const screening = liveScreening(ctx, row);
      const key = `${row.id}:${JSON.stringify(screening)}:${row.excluded_note}:${row.stage}`;
      const cached = summaryCache.get(key);
      if (cached) return { summary: cached };
      const summary = await advisorySummary(
        {
          offence: offenceOf(ctx, row),
          screening,
          previousConviction: row.previous_conviction,
          otherPendingCases: row.other_pending,
          stage: row.stage,
          excludedNote: row.excluded_note,
        },
        ctx.config.gemini,
      );
      if (summary.source === "gemini") summaryCache.set(key, summary);
      return { summary };
    }),
  );

  // ---------------------------------------------------------------- lawyer
  api.get(
    "/cases/:id/application-draft.pdf",
    requireRole("lawyer"),
    h(async (req, res) => {
      const pdf = await draftApplicationPdf(ctx, req.params.id!, req.user!);
      sendPdf(res, pdf, `DRAFT-s479-application-${req.params.id!.slice(2, 10)}.pdf`);
    }),
  );

  api.post(
    "/cases/:id/applications",
    requireRole("lawyer"),
    express.raw({ type: "application/pdf", limit: "10mb" }),
    h(async (req, res) => {
      const { txHash } = txBody.parse({ txHash: req.query.txHash });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new HttpError(400, "Upload the exact PDF bytes with Content-Type: application/pdf.");
      }
      const row = await recordFiledApplication(ctx, req.params.id!, req.user!, txHash, new Uint8Array(req.body));
      res.status(201);
      return { application: { id: row.id, chainAppId: row.chain_app_id, pdfHash: row.pdf_hash, txHash: row.tx_hash } };
    }),
  );

  api.get(
    "/applications/:id/pdf",
    requireRole(),
    h((req, res) => {
      const row = getApplicationRow(ctx, Number(req.params.id));
      sendPdf(res, readStored(ctx, row.pdf_path), `s479-application-${row.chain_app_id}.pdf`);
    }),
  );

  // ---------------------------------------------------------------- issuer
  api.post(
    "/cases/:id/orders/prepare",
    requireRole("issuer"),
    h(async (req, res) => {
      const prepared = await prepareOrder(ctx, req.params.id!, req.user!, orderInputSchema.parse(req.body));
      res.status(201);
      return prepared;
    }),
  );

  api.get(
    "/orders/:orderId/pdf",
    requireRole(),
    h((req, res) => {
      if (!hex32.test(req.params.orderId!)) throw new HttpError(400, "Invalid order ID.");
      const order = getOrderRow(ctx, req.params.orderId!);
      if (order.status === "PREPARED" && req.user!.id !== order.issuer_user_id) throw new HttpError(404, "Order not found.");
      sendPdf(res, readStored(ctx, order.pdf_path), `demo-order-${order.order_id.slice(2, 10)}.pdf`);
    }),
  );

  api.post(
    "/orders/:orderId/confirm",
    requireRole("issuer"),
    h(async (req) => {
      const order = await confirmOrder(ctx, req.params.orderId!, req.user!, txBody.parse(req.body).txHash);
      return { order: { orderId: order.order_id, status: order.status, txHash: order.tx_hash } };
    }),
  );

  api.post(
    "/orders/:orderId/revoke/prepare",
    requireRole("issuer"),
    h((req) => {
      const { reason } = z.object({ reason: z.string().trim().min(5).max(500) }).parse(req.body);
      return prepareRevoke(ctx, req.params.orderId!, req.user!, reason);
    }),
  );

  api.post(
    "/orders/:orderId/revoke/confirm",
    requireRole("issuer"),
    h(async (req) => {
      const order = await confirmRevoke(ctx, req.params.orderId!, req.user!, txBody.parse(req.body).txHash);
      return { order: { orderId: order.order_id, status: order.status, revokeTx: order.revoke_tx } };
    }),
  );

  // P1: replace an ACTIVE order (append-only link old -> new).
  api.post(
    "/orders/:orderId/supersede/prepare",
    requireRole("issuer"),
    h(async (req, res) => {
      const prepared = await prepareSupersede(ctx, req.params.orderId!, req.user!, supersedeInputSchema.parse(req.body));
      res.status(201);
      return prepared;
    }),
  );

  api.post(
    "/orders/:orderId/supersede/confirm",
    requireRole("issuer"),
    h(async (req) => {
      const order = await confirmSupersede(ctx, req.params.orderId!, req.user!, txBody.parse(req.body).txHash);
      return { order: { orderId: order.order_id, status: order.status, supersedes: order.supersedes, txHash: order.tx_hash } };
    }),
  );

  // ---------------------------------------------------------------- prison
  api.post(
    "/cases/:id/milestones/prepare",
    requireRole("prison"),
    h((req, res) => {
      const prepared = prepareMilestone(ctx, req.params.id!, req.user!, milestoneInputSchema.parse(req.body));
      res.status(201);
      return prepared;
    }),
  );

  api.post(
    "/milestones/:id/confirm",
    requireRole("prison"),
    h(async (req) => {
      const row = await confirmMilestone(ctx, Number(req.params.id), req.user!, txBody.parse(req.body).txHash);
      return { milestone: { id: row.id, milestone: row.milestone, txHash: row.tx_hash } };
    }),
  );

  api.use((_req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  app.use("/api", api);

  // Serve the built web app if present (single-origin deployment).
  if (existsSync(ctx.config.webDistDir)) {
    app.use(express.static(ctx.config.webDistDir, { index: false }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(ctx.config.webDistDir, "index.html")));
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "),
        issues: err.issues,
      });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
    if (err instanceof ChainError) return res.status(err.status).json({ error: err.message, chain: true });
    const e = err as { type?: string; status?: number; message?: string };
    if (e?.type === "entity.too.large") return res.status(413).json({ error: "Upload too large." });
    if (e?.type === "entity.parse.failed") return res.status(400).json({ error: "Malformed JSON body." });
    console.error(err);
    return res.status(500).json({ error: "Internal server error." });
  });

  return app;
}
