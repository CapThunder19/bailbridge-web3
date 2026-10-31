/**
 * Render smoke test: server-side render the case-page components with REAL case data
 * from a live API server, for every role. Catches runtime render errors across
 * journey states (threshold flagged, filed, ordered, revoked, released).
 * Skipped when the local API server is not running.
 */
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { CaseDetail, CaseSummary, User } from "../lib/types";
import { ReviewClock } from "./ReviewClock";
import { Timeline } from "./Timeline";
import { OrdersCard } from "./panels/OrdersCard";
import { PrisonPanel } from "./panels/PrisonPanel";
import { LawyerPanel } from "./panels/LawyerPanel";

const API = "http://localhost:4000/api";

async function cookie(username: string): Promise<string | null> {
  try {
    const res = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: process.env.DEMO_PASSWORD ?? "bailbridge-demo" }),
    });
    return res.ok ? res.headers.get("set-cookie")!.split(";")[0]! : null;
  } catch {
    return null;
  }
}

const cw = await cookie("caseworker");

describe.skipIf(!cw)("case page components render with live data", () => {
  it("renders every case for every role without throwing", async () => {
    const { cases } = (await (await fetch(`${API}/cases`, { headers: { cookie: cw! } })).json()) as { cases: CaseSummary[] };
    expect(cases.length).toBeGreaterThan(0);
    for (const role of ["caseworker", "lawyer", "issuer", "prison"] as const) {
      const c = (await cookie(role))!;
      const me = ((await (await fetch(`${API}/auth/me`, { headers: { cookie: c } })).json()) as { user: User }).user;
      for (const s of cases) {
        const detail = (await (await fetch(`${API}/cases/${s.id}`, { headers: { cookie: c } })).json()) as CaseDetail;
        const html = renderToString(
          <MemoryRouter>
            <ReviewClock screening={detail.screening} headline={detail.headline} />
            <Timeline steps={detail.workflow.steps} />
            <PrisonPanel detail={detail} user={me} onChange={() => {}} />
            <LawyerPanel detail={detail} user={me} onChange={() => {}} />
            <OrdersCard detail={detail} user={me} onChange={() => {}} />
          </MemoryRouter>,
        );
        expect(html).toContain(detail.headline.slice(0, 20));
        expect(html).not.toMatch(/must be released|automatic bail|unlawfully detained/i);
      }
    }
  }, 60_000);
});
