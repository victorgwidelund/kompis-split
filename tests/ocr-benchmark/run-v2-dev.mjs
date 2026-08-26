#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { aggregateOcrScoresV2, scoreOcrFixtureV2 } from "../../dist/ocr-benchmark.js";
import { canonicalJson, verifyBundle } from "./generator-v2/integrity.mjs";
import { typedScanResult } from "./v2-adapter.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const values = { bundle: "", candidateModule: resolve(repoRoot, "dist", "receipt-ocr.js"), detailed: false, label: "dev-v2" };
for (const argument of process.argv.slice(2)) {
  if (argument === "--detailed") values.detailed = true;
  else if (argument.startsWith("--bundle=")) values.bundle = argument.slice(9);
  else if (argument.startsWith("--candidate-module=")) values.candidateModule = argument.slice(19);
  else if (argument.startsWith("--label=")) values.label = argument.slice(8).replace(/[^a-z0-9._-]/gi, "-");
  else throw new Error(`Unknown argument: ${argument}`);
}
if (!values.bundle || !isAbsolute(values.bundle) || !isAbsolute(values.candidateModule)) throw new Error("--bundle and --candidate-module must be absolute paths");
const verified = await verifyBundle(values.bundle, { repoRoot, requireExternal: false });
if (verified.manifest.kind !== "dev") throw new Error("The development runner only accepts a dev bundle");
const candidate = await import(pathToFileURL(values.candidateModule).href + `?dev=${Date.now()}`);
const truthFiles = verified.manifest.files.filter((entry) => entry.path.startsWith("truth/")).sort((left, right) => left.path.localeCompare(right.path, "en"));
const scores = []; const details = [];
for (const entry of truthFiles) {
  const truth = JSON.parse(await readFile(join(verified.bundle, ...entry.path.split("/")), "utf8"));
  const image = await readFile(join(verified.bundle, "images", `${truth.id}.jpg`));
  const started = performance.now();
  let scan;
  try { scan = typedScanResult(await candidate.recognizeReceipt(image), performance.now() - started); }
  catch { scan = { schemaVersion: 2, status: "failure", receipt: null, source: null, needsReview: null, failureStage: "unknown", failureCode: "candidate_failure", latencyMs: performance.now() - started, stageLatencyMs: {} }; }
  const score = scoreOcrFixtureV2(truth, scan);
  scores.push(score);
  if (values.detailed) details.push({ id: truth.id, tags: truth.scenarioTags, score });
}
if (typeof candidate.closeReceiptOcr === "function") await candidate.closeReceiptOcr();
const report = {
  format: "kompis-receipt-development-evaluation/v1", commitmentSha256: verified.commitment.manifestSha256,
  generatedAt: new Date().toISOString(), overall: aggregateOcrScoresV2(scores),
  byDifficulty: Object.fromEntries([...new Set(scores.map((score) => score.difficulty))].sort().map((difficulty) => [difficulty, aggregateOcrScoresV2(scores.filter((score) => score.difficulty === difficulty))])),
  ...(values.detailed ? { details } : {}),
};
const output = join(here, "reports", `${values.label}-${Date.now()}.json`);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, canonicalJson(report));
console.log(canonicalJson({ output, overall: report.overall, byDifficulty: report.byDifficulty }));
