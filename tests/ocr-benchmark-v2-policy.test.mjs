import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createScenarioPlan, REQUIRED_SCENARIO_TAGS, scenarioCoverage } from "./ocr-benchmark/generator-v2/scenarios.mjs";
import { assertSafeOutputPath, canonicalJson, deriveFixtureSeed, isPathInside } from "./ocr-benchmark/generator-v2/integrity.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

test("development and sealed-final v2 plans each contain 48 auditable hard-case scenarios", () => {
  for (const kind of ["dev", "sealed-final"]) {
    const plan = createScenarioPlan(kind);
    assert.equal(plan.length, 48);
    assert.equal(new Set(plan.map((entry) => entry.fixtureId)).size, plan.length);
    const coverage = scenarioCoverage(plan);
    for (const tag of REQUIRED_SCENARIO_TAGS) assert.ok(coverage.byTag[tag] > 0, `${kind} is missing ${tag}`);
    if (kind === "sealed-final") assert.ok(plan.every((entry) => /^sealed_\d{3}$/.test(entry.fixtureId)), "sealed ids must not reveal scenarios");
  }
});

test("fixture seeds are deterministic, secret-dependent and isolated by opaque fixture id", () => {
  const first = deriveFixtureSeed("a sufficiently long secret value", "sealed_001");
  assert.deepEqual(first, deriveFixtureSeed("a sufficiently long secret value", "sealed_001"));
  assert.notDeepEqual(first, deriveFixtureSeed("a different sufficiently long value", "sealed_001"));
  assert.notDeepEqual(first, deriveFixtureSeed("a sufficiently long secret value", "sealed_002"));
});

test("sealed output is rejected anywhere inside the repository and canonical JSON is stable", () => {
  assert.throws(() => assertSafeOutputPath(resolve(repoRoot, "private-final"), { repoRoot, kind: "sealed-final" }), /outside|must live outside|Git repository/);
  const external = resolve(repoRoot, "..", "sealed-final-test-location");
  assert.equal(assertSafeOutputPath(external, { repoRoot, kind: "sealed-final" }), external);
  assert.equal(isPathInside(resolve(repoRoot, "tests"), repoRoot), true);
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), '{\n  "a": {\n    "b": 3,\n    "y": 2\n  },\n  "z": 1\n}\n');
});
