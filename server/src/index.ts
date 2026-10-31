import { createApp } from "./app.js";
import { bootstrap } from "./bootstrap.js";
import { sweep } from "./services/cases.js";

const ctx = bootstrap();
const app = createApp(ctx);

app.listen(ctx.config.port, async () => {
  console.log(`BailBridge server listening on http://localhost:${ctx.config.port}`);
  if (ctx.chain) {
    const health = await ctx.chain.health();
    console.log(
      `Chain mode: ${ctx.chain.config.deployment.network} (chainId ${ctx.chain.chainId}) registry ${ctx.chain.address} — ${health.message}`,
    );
    console.log(`Registrar wallet: ${ctx.chain.registrar.address}`);
  } else {
    console.log(`Off-chain demo mode — no blockchain attestations (${ctx.config.offChainReason}).`);
  }
  console.log(`AI summaries: ${ctx.config.gemini.apiKey ? `Gemini (${ctx.config.gemini.model})` : "deterministic fallback (no GEMINI_API_KEY)"}`);
  if (!process.env.COMMITMENT_SECRET) console.warn("COMMITMENT_SECRET not set — using an insecure development default.");

  // Flag cases whose live screening newly reaches the threshold; retry failed anchors.
  const runSweep = () => sweep(ctx).catch((err) => console.error("sweep failed:", err));
  void runSweep();
  setInterval(runSweep, 10 * 60 * 1000).unref();
});
