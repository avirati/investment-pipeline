#!/usr/bin/env tsx
/**
 * Re-render the golden memos from the golden analyses (TESTING §7).
 *
 * `tests/golden/analysis.*.json` and `tests/golden/evidence.*.json` are
 * **inputs**: hand-authored once, frozen, and edited only deliberately. The
 * `memo.*.md` beside them are **outputs**, and this script is how they are
 * regenerated after a change to `templates/memo.md.eta` or to the renderer.
 *
 *     pnpm golden          # rewrite the snapshots
 *     pnpm golden --check  # fail if they are stale, without writing
 *
 * Read the diff before committing it. The whole point of a committed snapshot
 * is that a change to how a memo reads is reviewed by reading a memo.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Analysis, Evidence } from "../src/contracts/index.js";
import { renderMemo } from "../src/memo/render.js";

const GOLDEN = resolve(dirname(fileURLToPath(import.meta.url)), "..", "tests", "golden");
const NAMES = ["golden", "thin"] as const;

const check = process.argv.includes("--check");
let stale = 0;

for (const name of NAMES) {
  const analysis = Analysis.parse(
    JSON.parse(readFileSync(join(GOLDEN, `analysis.${name}.json`), "utf8")),
  );
  const evidence = Evidence.array().parse(
    JSON.parse(readFileSync(join(GOLDEN, `evidence.${name}.json`), "utf8")),
  );
  const path = join(GOLDEN, `memo.${name}.md`);
  const rendered = renderMemo(analysis, evidence).markdown;
  const current = readFileSync(path, "utf8");

  if (rendered === current) {
    console.log(`  ${name}: unchanged`);
    continue;
  }
  if (check) {
    stale += 1;
    console.error(`  ${name}: STALE — run 'pnpm golden' and read the diff`);
    continue;
  }
  writeFileSync(path, rendered);
  console.log(`  ${name}: rewritten (${rendered.split("\n").length} lines)`);
}

if (stale > 0) process.exit(1);
