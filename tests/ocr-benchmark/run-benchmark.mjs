#!/usr/bin/env node
// The actual benchmark runner. Two independent modes:
//
//   --mode=parser  Feeds each fixture's ground-truth "ideal OCR text" straight into parseReceiptText().
//                   Fast (milliseconds/fixture), fully deterministic, no image processing or GPU --
//                   this is what CI runs (see the "fast" npm script) and isolates pure PARSER accuracy
//                   from OCR-engine accuracy.
//   --mode=image   Runs the real image pipeline against each JPEG. The internal RapidOCR service is
//                   preferred; bundled Tesseract is the explicit outage fallback.
//
// --mode=both (default) runs both and reports them separately -- they are not comparable numbers and
// must never be merged into one score.
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseReceiptText, recognizeReceipt, closeReceiptOcr } from "../../dist/receipt-ocr.js";
import { scoreFixture, aggregate, groupBy } from "./scoring.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const corpusRoot = join(here, "corpus");
const reportsRoot = join(here, "reports");

const publicSplits = new Set(["dev", "legacy", "all-public"]);
const modes = new Set(["parser", "image", "both"]);

export function parseArgs(argv) {
  const args = { mode: "both", split: "dev", detailed: false, limit: Infinity, category: null, difficulty: null, label: null, compare: null };
  for (const raw of argv) {
    if (!raw.startsWith("--")) throw new Error(`Unexpected argument: ${raw}`);
    const [key, value] = raw.replace(/^--/, "").split("=");
    if (key === "verbose" || key === "detailed") args.detailed = true;
    else if (key === "mode") args.mode = value;
    else if (key === "split") args.split = value;
    else if (key === "limit") args.limit = Number(value);
    else if (key === "category") args.category = value;
    else if (key === "difficulty") args.difficulty = value;
    else if (key === "label") args.label = value;
    else if (key === "compare") args.compare = value;
    else throw new Error(`Unknown option: --${key}`);
  }
  if (!modes.has(args.mode)) throw new Error(`Invalid --mode=${args.mode}. Expected parser, image, or both.`);
  if (!publicSplits.has(args.split)) throw new Error(`Invalid --split=${args.split}. Expected dev, legacy, or all-public.`);
  if (Number.isNaN(args.limit) || args.limit < 1) throw new Error("--limit must be a positive number.");
  return args;
}

async function loadCorpus(splitFilter) {
  const splits = splitFilter === "all-public" ? ["dev", "legacy"] : [splitFilter];
  const fixtures = [];
  for (const split of splits) {
    const dir = join(corpusRoot, split === "legacy" ? "legacy_regression" : split);
    let files;
    try { files = await readdir(dir); } catch { continue; }
    for (const file of files.filter((name) => name.endsWith(".json")).sort((left, right) => left.localeCompare(right, "en"))) {
      const groundTruth = JSON.parse(await readFile(join(dir, file), "utf8"));
      fixtures.push({ groundTruth, imagePath: join(dir, file.replace(/\.json$/, ".jpg")) });
    }
  }
  return fixtures.sort((left, right) => left.groundTruth.id.localeCompare(right.groundTruth.id, "en"));
}

async function runParserMode(fixtures) {
  const scores = [];
  for (const { groundTruth } of fixtures) {
    const started = performance.now();
    const suggestion = parseReceiptText(groundTruth.idealText);
    scores.push(scoreFixture(groundTruth, suggestion, performance.now() - started));
  }
  return scores;
}

async function runImageMode(fixtures, detailed) {
  const scores = [];
  const sources = new Map();
  for (const { groundTruth, imagePath } of fixtures) {
    const content = await readFile(imagePath);
    const started = performance.now();
    const result = await recognizeReceipt(content);
    const elapsed = performance.now() - started;
    sources.set(result.source, (sources.get(result.source) || 0) + 1);
    scores.push(scoreFixture(groundTruth, result.suggestion, elapsed));
    if (detailed) console.log(`  ${groundTruth.id}: source=${result.source} needsReview=${result.needsReview} items=${result.suggestion.items.length}/${groundTruth.items.length}`);
  }
  await closeReceiptOcr();
  return { scores, sources };
}

function formatPercent(value) { return value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`; }
function formatMs(value) { return value === null || value === undefined ? "n/a" : `${Math.round(value)} ms`; }

function printSummary(title, summary) {
  if (!summary) { console.log(`${title}: no fixtures`); return; }
  console.log(`\n${title}  (n=${summary.receiptCount})`);
  console.log(`  Merchant accuracy:      ${formatPercent(summary.merchantAccuracy)}`);
  console.log(`  Date accuracy:          ${formatPercent(summary.dateAccuracy)}`);
  console.log(`  Total accuracy:         ${formatPercent(summary.totalAccuracy)}`);
  console.log(`  Item precision:         ${formatPercent(summary.itemPrecision)}`);
  console.log(`  Item recall:            ${formatPercent(summary.itemRecall)}`);
  console.log(`  Item F1:                ${formatPercent(summary.itemF1)}`);
  console.log(`  Name similarity:        ${formatPercent(summary.nameSimilarity)}`);
  console.log(`  Price accuracy:         ${formatPercent(summary.priceAccuracy)}`);
  console.log(`  Quantity accuracy:      ${formatPercent(summary.quantityAccuracy)}`);
  console.log(`  Exact reconciliation:   ${formatPercent(summary.exactReconciliation)}`);
  console.log(`  Reconciled w/ discounts:${formatPercent(summary.reconciledAfterKnownAdjustments)}`);
  console.log(`  False metadata items:   ${summary.falseMetadataItemsTotal}`);
  console.log(`  Receipts needing review:${summary.receiptsNeedingReview}/${summary.receiptCount}`);
  if (summary.medianMs !== null) console.log(`  Median / P90 / P95 time:${formatMs(summary.medianMs)} / ${formatMs(summary.p90Ms)} / ${formatMs(summary.p95Ms)}`);
}

function printBreakdown(scores, key, label) {
  const groups = groupBy(scores, key);
  console.log(`\n-- By ${label} --`);
  for (const [name, groupScores] of [...groups.entries()].sort()) {
    const summary = aggregate(groupScores);
    console.log(`  ${String(name).padEnd(14)} n=${String(summary.receiptCount).padEnd(3)} F1=${formatPercent(summary.itemF1).padEnd(7)} total=${formatPercent(summary.totalAccuracy).padEnd(7)} recon=${formatPercent(summary.exactReconciliation).padEnd(7)} falseMeta=${summary.falseMetadataItemsTotal}`);
  }
}

function printFailures(scores) {
  const failures = scores.filter((score) => !score.totalCorrect || !score.financiallyReconciled || score.falseMetadataItemCount > 0 || score.unmatchedTruthNames.length || score.unmatchedPredNames.length);
  if (!failures.length) { console.log("\nNo fixture failures."); return; }
  console.log(`\n-- ${failures.length} fixture(s) with at least one issue --`);
  for (const score of failures) {
    console.log(`  [${score.split}/${score.category}/${score.difficulty}] ${score.id}`);
    if (!score.totalCorrect) console.log(`      total mismatch`);
    if (score.unmatchedTruthNames.length) console.log(`      missed items: ${score.unmatchedTruthNames.join(", ")}`);
    if (score.unmatchedPredNames.length) console.log(`      extra/unmatched predicted items: ${score.unmatchedPredNames.join(", ")}`);
    if (score.falseMetadataItemCount) console.log(`      false metadata items: ${score.falseMetadataItems.join(", ")}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let fixtures = await loadCorpus(args.split);
  if (args.category) fixtures = fixtures.filter((fixture) => fixture.groundTruth.category === args.category);
  if (args.difficulty) fixtures = fixtures.filter((fixture) => fixture.groundTruth.difficulty === args.difficulty);
  if (Number.isFinite(args.limit)) fixtures = fixtures.slice(0, args.limit);
  if (!fixtures.length) { console.error("No fixtures matched. Run `pnpm benchmark:ocr:corpus` first."); process.exitCode = 1; return; }

  console.log(`Kompis Split OCR benchmark -- ${fixtures.length} fixture(s), mode=${args.mode}, split=${args.split}${args.detailed ? ", detailed" : ""}`);
  const report = { generatedAt: new Date().toISOString(), label: args.label, fixtureCount: fixtures.length, args };

  if (args.mode === "parser" || args.mode === "both") {
    const parserScores = await runParserMode(fixtures);
    report.parser = { ...(args.detailed ? { scores: parserScores } : {}), overall: aggregate(parserScores), dev: aggregate(parserScores.filter((s) => s.split === "dev")), legacy: aggregate(parserScores.filter((s) => s.split === "legacy")) };
    console.log("\n=== Parser-only mode (deterministic, no OCR/GPU) ===");
    printSummary("Overall", report.parser.overall);
    printSummary("Dev", report.parser.dev);
    printSummary("Legacy regression", report.parser.legacy);
    if (args.detailed) { printBreakdown(parserScores, "category", "category"); printBreakdown(parserScores, "difficulty", "difficulty"); printFailures(parserScores); }
  }

  if (args.mode === "image" || args.mode === "both") {
    console.log("\n=== Real image pipeline mode (internal RapidOCR service, bundled Tesseract fallback) ===");
    const { scores: imageScores, sources } = await runImageMode(fixtures, args.detailed);
    report.image = { ...(args.detailed ? { scores: imageScores } : {}), overall: aggregate(imageScores), dev: aggregate(imageScores.filter((s) => s.split === "dev")), legacy: aggregate(imageScores.filter((s) => s.split === "legacy")), sources: Object.fromEntries(sources) };
    console.log(`Sources used: ${JSON.stringify(Object.fromEntries(sources))}`);
    if (!sources.has("rapidocr")) {
      console.log("NOTE: RECEIPT_INFERENCE_URL was not reachable; these numbers measure only the bundled Tesseract outage fallback.");
    }
    printSummary("Overall", report.image.overall);
    printSummary("Dev", report.image.dev);
    printSummary("Legacy regression", report.image.legacy);
    if (args.detailed) { printBreakdown(imageScores, "category", "category"); printBreakdown(imageScores, "difficulty", "difficulty"); printFailures(imageScores); }
  }

  await mkdir(reportsRoot, { recursive: true });
  const reportName = `${args.label || "report"}-${Date.now()}.json`;
  const reportPath = join(reportsRoot, reportName);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${reportPath}`);

  if (args.compare) {
    const baseline = JSON.parse(await readFile(args.compare, "utf8"));
    console.log(`\n=== Comparison vs ${basename(args.compare)} ===`);
    for (const mode of ["parser", "image"]) {
      if (!report[mode] || !baseline[mode]) continue;
      console.log(`\n-- ${mode} mode, overall --`);
      const keys = ["merchantAccuracy", "dateAccuracy", "totalAccuracy", "itemPrecision", "itemRecall", "itemF1", "priceAccuracy", "quantityAccuracy", "exactReconciliation"];
      for (const key of keys) {
        const before = baseline[mode].overall?.[key]; const after = report[mode].overall?.[key];
        if (before === undefined || after === undefined) continue;
        const delta = after - before;
        console.log(`  ${key.padEnd(20)} ${formatPercent(before).padEnd(8)} -> ${formatPercent(after).padEnd(8)} (${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}pp)`);
      }
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
