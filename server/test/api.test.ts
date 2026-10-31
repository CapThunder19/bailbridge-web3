import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { PDFDocument } from "pdf-lib";
import { createApp } from "../src/app.js";
import { caseInput, login, testCtx } from "./helpers.js";
import { fallbackSummary, containsForbiddenLanguage, advisorySummary } from "../src/ai.js";
import { screenCase } from "../src/screening/engine.js";
import { findOffence } from "../src/screening/offences.js";

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  app = createApp(testCtx());
});

describe("auth", () => {
  it("rejects a wrong password and unknown users", async () => {
    const bad = await request(app).post("/api/auth/login").send({ username: "lawyer", password: "nope" });
    expect(bad.status).toBe(401);
    const unknown = await request(app).post("/api/auth/login").send({ username: "nobody", password: "x" });
    expect(unknown.status).toBe(401);
  });

  it("sets an httpOnly session cookie and returns the user", async () => {
    const res = await request(app).post("/api/auth/login").send({ username: "lawyer", password: "test-password" });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: "lawyer", role: "lawyer" });
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/bb_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it("requires a session for private endpoints", async () => {
    for (const path of ["/api/cases", "/api/dashboard", "/api/offences", "/api/auth/me"]) {
      expect((await request(app).get(path)).status).toBe(401);
    }
  });

  it("logout invalidates the session", async () => {
    const agent = await login(app, "caseworker");
    expect((await agent.get("/api/auth/me")).status).toBe(200);
    await agent.post("/api/auth/logout");
    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });
});

describe("role enforcement", () => {
  it("only caseworker and lawyer can create cases", async () => {
    for (const role of ["issuer", "prison"]) {
      const agent = await login(app, role);
      expect((await agent.post("/api/cases").send(caseInput(600))).status).toBe(403);
    }
    const cw = await login(app, "caseworker");
    expect((await cw.post("/api/cases").send(caseInput(600))).status).toBe(201);
  });

  it("only the lawyer can download the draft application", async () => {
    const cw = await login(app, "caseworker");
    const id = (await cw.post("/api/cases").send(caseInput(600))).body.case.id;
    expect((await cw.get(`/api/cases/${id}/application-draft.pdf`)).status).toBe(403);
    const prison = await login(app, "prison");
    expect((await prison.get(`/api/cases/${id}/application-draft.pdf`)).status).toBe(403);
  });

  it("wallet endpoints are role-gated before anything else", async () => {
    const cw = await login(app, "caseworker");
    const id = (await cw.post("/api/cases").send(caseInput(600))).body.case.id;
    const lawyer = await login(app, "lawyer");
    expect((await lawyer.post(`/api/cases/${id}/orders/prepare`).send({})).status).toBe(403);
    expect((await lawyer.post(`/api/cases/${id}/milestones/prepare`).send({})).status).toBe(403);
    const issuer = await login(app, "issuer");
    expect((await issuer.post(`/api/cases/${id}/applications?txHash=0x${"1".repeat(64)}`)).status).toBe(403);
  });
});

describe("case intake and screening", () => {
  it("creates a case and returns the live screening + timeline", async () => {
    const cw = await login(app, "caseworker");
    const res = await cw.post("/api/cases").send(caseInput(588));
    expect(res.status).toBe(201);
    expect(res.body.screening.status).toBe("THRESHOLD_REACHED_REVIEW_REQUIRED");
    expect(res.body.headline).toBe("Threshold reached 40 days ago — s.479(3) application and legal review required");
    expect(res.body.case.id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(res.body.case.recordCommitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(res.body.case.chainStatus).toBe("offchain");
    expect(res.body.snapshots).toHaveLength(1);
    expect(res.body.snapshots[0].txHash).toBeNull(); // never fake tx hashes

    const flagged = res.body.workflow.steps[0];
    expect(flagged).toMatchObject({ milestone: "THRESHOLD_FLAGGED", state: "done" });
    expect(flagged.receipt).toMatchObject({ offChain: true, txHash: null });
    expect(res.body.workflow.nextActions.map((a: { key: string }) => a.key)).toEqual(["superintendent", "file"]);
  });

  it("rejects invalid custody periods with a plain error", async () => {
    const cw = await login(app, "caseworker");
    const res = await cw.post("/api/cases").send(
      caseInput(10, {
        custodyPeriods: [
          { start: "2025-01-01", end: "2025-02-01" },
          { start: "2025-01-20", end: null },
        ],
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/overlap/);
  });

  it("rejects unknown offences and malformed input", async () => {
    const cw = await login(app, "caseworker");
    expect((await cw.post("/api/cases").send(caseInput(10, { offenceId: "made-up" }))).status).toBe(400);
    const res = await cw.post("/api/cases").send(caseInput(10, { previousConviction: "maybe" }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/previousConviction/);
  });

  it("previews screening without saving", async () => {
    const cw = await login(app, "caseworker");
    const { personName, age, caseRef, court, ...fields } = caseInput(100);
    void personName, age, caseRef, court;
    const res = await cw.post("/api/screening/preview").send(fields);
    expect(res.status).toBe(200);
    expect(res.body.screening.status).toBe("APPROACHING_THRESHOLD");
    expect((await cw.get("/api/cases")).body.cases).toHaveLength(0);
  });

  it("updating screening fields adds a new snapshot", async () => {
    const cw = await login(app, "caseworker");
    const created = (await cw.post("/api/cases").send(caseInput(100))).body;
    const { personName, age, caseRef, court, ...fields } = caseInput(100, { otherPendingCases: "yes" });
    void personName, age, caseRef, court;
    const res = await cw.put(`/api/cases/${created.case.id}`).send(fields);
    expect(res.status).toBe(200);
    expect(res.body.screening.status).toBe("SPECIALIST_REVIEW_REQUIRED");
    expect(res.body.snapshots).toHaveLength(2);
    expect(res.body.snapshots[0].commitment).not.toBe(res.body.snapshots[1].commitment);
  });

  it("groups the dashboard by who must act next", async () => {
    const cw = await login(app, "caseworker");
    await cw.post("/api/cases").send(caseInput(588, { caseRef: "HERO" }));
    await cw.post("/api/cases").send(caseInput(100, { caseRef: "APPROACH" }));
    await cw.post("/api/cases").send(caseInput(700, { caseRef: "MULTI", otherPendingCases: "yes" }));
    await cw.post("/api/cases").send(caseInput(700, { caseRef: "LIFE", offenceId: "bns-103-1" }));
    const res = await cw.get("/api/dashboard");
    const group = (key: string) => res.body.groups.find((g: { key: string }) => g.key === key);
    expect(group("superintendent").items).toHaveLength(1);
    expect(group("superintendent").items[0]).toMatchObject({ caseRef: "HERO", days: 40 });
    expect(group("specialist").items[0].caseRef).toBe("MULTI");
    expect(res.body.approaching[0].caseRef).toBe("APPROACH");
    const life = res.body.cases.find((c: { caseRef: string }) => c.caseRef === "LIFE");
    expect(life.status).toBe("OUTSIDE_SCREENING_RULE");
    expect(life.nextActions).toHaveLength(0);
  });
});

describe("documents in off-chain mode", () => {
  it("generates a DRAFT application PDF for a reached threshold", async () => {
    const cw = await login(app, "caseworker");
    const id = (await cw.post("/api/cases").send(caseInput(588))).body.case.id;
    const lawyer = await login(app, "lawyer");
    const res = await lawyer.get(`/api/cases/${id}/application-draft.pdf`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    const bytes = res.body as Buffer;
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getTitle()).toMatch(/^DRAFT s\.479 BNSS bail application/);
  });

  it("refuses a draft before the threshold is reached", async () => {
    const cw = await login(app, "caseworker");
    const id = (await cw.post("/api/cases").send(caseInput(100))).body.case.id;
    const lawyer = await login(app, "lawyer");
    expect((await lawyer.get(`/api/cases/${id}/application-draft.pdf`)).status).toBe(409);
  });

  it("disables wallet actions and says so", async () => {
    const cw = await login(app, "caseworker");
    const id = (await cw.post("/api/cases").send(caseInput(588))).body.case.id;
    const prison = await login(app, "prison");
    const res = await prison
      .post(`/api/cases/${id}/milestones/prepare`)
      .send({ milestone: "SUPERINTENDENT_APPLICATION", date: "2026-10-30" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Off-chain demo/);
    const config = await request(app).get("/api/public/config");
    expect(config.body.chain.enabled).toBe(false);
  });
});

describe("advisory summary", () => {
  const facts = () => ({
    offence: findOffence("bns-303-2-first"),
    screening: screenCase({
      offence: findOffence("bns-303-2-first"),
      custodyPeriods: [{ start: "2025-03-22", end: null }],
      excludedDays: 0,
      previousConviction: "unknown" as const,
      otherPendingCases: "no" as const,
      asOf: "2026-10-30",
    }),
    previousConviction: "unknown",
    otherPendingCases: "no",
    stage: "Trial",
    excludedNote: "",
  });

  it("falls back deterministically without a key and lists missing info", async () => {
    const s = await advisorySummary(facts(), { apiKey: null, model: "x" });
    expect(s.source).toBe("fallback");
    expect(s.text).toMatch(/ever been convicted/);
    expect(containsForbiddenLanguage(s.text)).toBe(false);
    expect(s).toEqual(fallbackSummary(facts()));
  });

  it("rejects AI output containing decision language", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "The accused must be released immediately." }] } }] }),
        { status: 200 },
      )) as typeof fetch;
    const s = await advisorySummary(facts(), { apiKey: "k", model: "m" }, fakeFetch);
    expect(s.source).toBe("fallback");
    expect(s.note).toMatch(/wording filter/);
  });

  it("uses AI output that passes the filter, and falls back on HTTP errors", async () => {
    const ok = (async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Custody is 588 days." }] } }] }), {
        status: 200,
      })) as typeof fetch;
    expect((await advisorySummary(facts(), { apiKey: "k", model: "m" }, ok)).source).toBe("gemini");
    const down = (async () => new Response("err", { status: 503 })) as typeof fetch;
    const s = await advisorySummary(facts(), { apiKey: "k", model: "m" }, down);
    expect(s.source).toBe("fallback");
    expect(s.note).toMatch(/HTTP 503/);
  });

  it("is served for a case", async () => {
    const cw = await login(app, "caseworker");
    const id = (await cw.post("/api/cases").send(caseInput(588))).body.case.id;
    const res = await cw.get(`/api/cases/${id}/summary`);
    expect(res.status).toBe(200);
    expect(res.body.summary.source).toBe("fallback");
    expect(res.body.summary.text).not.toMatch(/Demo Person/); // no names in summaries
  });
});
