// After `aztec codegen`, make the bindings self-contained so the app builds anywhere (Vercel, a fresh
// clone) without the Aztec toolchain: each compiled contract JSON is copied next to its binding with
// `file_map` (the debug source map: local paths and full sources) emptied, and the binding's import
// is pointed at the copy. The contract class id does not depend on `file_map` (it hashes names,
// signatures, outputs and bytecode), so the copies describe exactly the same contracts.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = new URL("../artifacts/", import.meta.url).pathname;
const target = new URL("../target/", import.meta.url).pathname;
const IMPORT = /from '\.\.\/target\/([\w.-]+\.json)'/;

for (const ts of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
  const path = join(dir, ts);
  const src = readFileSync(path, "utf8");
  const m = src.match(IMPORT);
  if (!m) continue; // already vendored
  const json = m[1];
  const artifact = JSON.parse(readFileSync(join(target, json), "utf8"));
  artifact.file_map = {};
  writeFileSync(join(dir, json), `${JSON.stringify(artifact)}\n`);
  writeFileSync(path, src.replace(IMPORT, `from './${json}'`));
  console.log(`vendored ${json} for ${ts}`);
}
