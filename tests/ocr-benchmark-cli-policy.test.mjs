import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./ocr-benchmark/run-benchmark.mjs";

test("OCR benchmark CLI defaults to development data without per-fixture details", () => {
  const args = parseArgs([]);
  assert.equal(args.split, "dev");
  assert.equal(args.detailed, false);
});

test("OCR benchmark CLI only accepts explicitly public corpus splits", () => {
  for (const split of ["dev", "legacy", "all-public"]) {
    assert.equal(parseArgs([`--split=${split}`]).split, split);
  }

  for (const split of ["final", "holdout", "all", "../../private", ""]) {
    assert.throws(() => parseArgs([`--split=${split}`]), /Invalid --split/);
  }
});

test("OCR benchmark CLI requires an explicit detail flag before exposing fixture results", () => {
  assert.equal(parseArgs(["--detailed"]).detailed, true);
  assert.equal(parseArgs(["--verbose"]).detailed, true, "the historical flag remains a safe alias");
});
