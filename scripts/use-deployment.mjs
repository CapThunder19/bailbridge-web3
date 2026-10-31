// Point the server and web app at an existing deployment record without redeploying.
//   node scripts/use-deployment.mjs sepolia
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const network = process.argv[2];
const source = path.join(root, "deployments", `${network}.json`);
if (!network || !existsSync(source)) {
  console.error(`No deployment record at deployments/${network ?? "<network>"}.json — deploy first.`);
  process.exit(1);
}
for (const target of ["server/src/generated/deployment.json", "web/src/generated/deployment.json"]) {
  mkdirSync(path.dirname(path.join(root, target)), { recursive: true });
  copyFileSync(source, path.join(root, target));
  console.log(`deployments/${network}.json -> ${target}`);
}
console.log("Restart the server and web dev server to pick it up.");
