// The app reads /deployment.json at runtime. Locally, scripts/e2e/deploy-local.ts writes
// public/deployment.json; a hosted build (Vercel, a fresh clone) has none, so it ships a committed
// deployment from ../deployments/ instead: ECLYPS_DEPLOYMENT names it (default "testnet"). An
// existing public/deployment.json is never overwritten.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

const out = new URL("../public/deployment.json", import.meta.url);
if (existsSync(out)) {
  console.log("deployment.json: keeping public/deployment.json");
} else {
  const name = process.env.ECLYPS_DEPLOYMENT ?? "testnet";
  if (!/^[\w-]+$/.test(name)) throw new Error(`ECLYPS_DEPLOYMENT must be a plain name, got "${name}"`);
  const src = new URL(`../../deployments/${name}.json`, import.meta.url);
  if (!existsSync(src)) throw new Error(`No deployments/${name}.json`);
  mkdirSync(new URL("../public/", import.meta.url), { recursive: true });
  copyFileSync(src, out);
  console.log(`deployment.json: using deployments/${name}.json`);
}
