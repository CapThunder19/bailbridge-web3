import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Deployment info (address, chainId, deployment block, ABI) exported by contracts/scripts/deploy.ts.
// Missing file = off-chain demo build.
const deploymentFile = fileURLToPath(new URL("./src/generated/deployment.json", import.meta.url));
const deployment = existsSync(deploymentFile) ? JSON.parse(readFileSync(deploymentFile, "utf8")) : null;
if (deployment && process.env.VITE_PUBLIC_RPC_URL) deployment.publicRpcUrl = process.env.VITE_PUBLIC_RPC_URL;

export default defineConfig({
  plugins: [react()],
  define: {
    __DEPLOYMENT__: JSON.stringify(deployment?.address ? deployment : null),
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:4000" },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
