/**
 * The Docs page names the public copy of the code (scripts/publish/export.sh); bounty reports go
 * to that copy's Security tab. Run with `pnpm --filter @eclyps/app test`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const docs = readFileSync(new URL("../src/app/(landing)/docs/page.tsx", import.meta.url), "utf8");
const code = /const CODE = "([^"]+)";/.exec(docs)?.[1];

describe("the code link", () => {
  it("names the public copy, set before the bounty goes live", () => {
    assert.ok(code, "docs/page.tsx defines CODE");
    assert.doesNotMatch(code, /PUBLIC_ORG/, "set CODE to the public repository");
  });
});
