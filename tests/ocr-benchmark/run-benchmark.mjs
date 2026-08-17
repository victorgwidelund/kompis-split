#!/usr/bin/env node
// The actual benchmark runner. Two independent modes:
//
//   --mode=parser  Feeds each fixture's ground-truth "ideal OCR text" straight into parseReceiptText().
//                   Fast (milliseconds/fixture), fully deterministic, no image processing or GPU --
//                   this is what CI runs (see the "fast" npm script) and isolates pure PARSER accuracy
//                   from OCR-engine accuracy.
//   --mode=image   Runs the real image pipeline (prepareReceiptImages + recognizeReceipt) against the
//                   actual JPEG fixture: real Tesseract OCR (CPU, no GPU needed) always, plus the real
//                   PaddleOCR-VL vision model IF PADDLEOCR_URL is set and reachable (e.g. run on the
//                   Unraid GTX 1080 Ti box) -- otherwise it degrades to the same Tesseract-only path
//                   production itself falls back to, and the report says so explicitly rather than
//                   pretending the vision model ran.
//
// --mode=both (default) runs both and reports them separately -- they are not comparable numbers and
// must never be merged into one score.
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReceiptText, recognizeReceipt, closeReceiptOcr } from "../../dist/receipt-ocr.js";
import { scoreFixture, aggregate, groupBy } from "./scoring.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const corpusRoot = join(here, "corpus");
const reportsRoot = join(here, "reports");

function parseArgs(argv) {
  const args = { mode: "both", split: "all", verbose: false, limit: Infinity, category: null, difficulty: null, label: null, compare: null };
  for (const raw of argv) {
    const [key, value] = raw.replace(/^--/, "").split("=");
    if (key === "verbose") args.verbose = true;
    else if (key === "mode") args.mode = value;
    else if (key === "split") args.split = value;
    else if (key === "limit") args.limit = Number(value);
    else if (key === "category") args.category = value;
    else if (key === "difficulty") args.difficulty = value;
    else if (key === "label") args.label = value;
    else if (key === "compare") args.compare = value;
  }
  return args;
}

async function loadCorpus(splitFilter) {
  const splits = splitFilter === "all" ? ["dev", "holdout"] : [splitFilter];
  const fixtures = [];
  for (const split of splits) {
    const dir = join(corpusRoot, split);
    let files;
    try { files = await readdir(dir); } catch { continue; }
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const groundTruth = JSON.parse(await readFile(join(dir, file), "utf8"));
      fixtures.push({ groundTruth, imagePath: join(dir, file.replace(/\.json$/, ".jpg")) });
    }
  }
  return fixtures;
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

async function runImageMode(fixtures, verbose) {
  const scores = [];
  const sources = new Map();
  for (const { groundTruth, imagePath } of fixtures) {
    const content = await readFile(imagePath);
    const started = performance.now();
    const result = await recognizeReceipt(content);
    const elapsed = performance.now() - started;
    sources.set(result.source, (sources.get(result.source) || 0) + 1);
    scores.push(scoreFixture(groundTruth, result.suggestion, elapsed));
    if (verbose) console.log(`  ${groundTruth.id}: source=${result.source} needsReview=${result.needsReview} items=${result.suggestion.items.length}/${groundTruth.items.length}`);
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

  console.log(`Kompis Split OCR benchmark -- ${fixtures.length} fixture(s), mode=${args.mode}`);
  const report = { generatedAt: new Date().toISOString(), label: args.label, fixtureCount: fixtures.length, args };

  if (args.mode === "parser" || args.mode === "both") {
    const parserScores = await runParserMode(fixtures);
    report.parser = { scores: parserScores, overall: aggregate(parserScores), dev: aggregate(parserScores.filter((s) => s.split === "dev")), holdout: aggregate(parserScores.filter((s) => s.split === "holdout")) };
    console.log("\n=== Parser-only mode (deterministic, no OCR/GPU) ===");
    printSummary("Overall", report.parser.overall);
    printSummary("Dev", report.parser.dev);
    printSummary("Holdout", report.parser.holdout);
    if (args.verbose) { printBreakdown(parserScores, "category", "category"); printBreakdown(parserScores, "difficulty", "difficulty"); printFailures(parserScores); }
  }

  if (args.mode === "image" || args.mode === "both") {
    console.log("\n=== Real image pipeline mode (Tesseract always; PaddleOCR-VL only if PADDLEOCR_URL is reachable) ===");
    const { scores: imageScores, sources } = await runImageMode(fixtures, args.verbose);
    report.image = { scores: imageScores, overall: aggregate(imageScores), dev: aggregate(imageScores.filter((s) => s.split === "dev")), holdout: aggregate(imageScores.filter((s) => s.split === "holdout")), sources: Object.fromEntries(sources) };
    console.log(`Sources used: ${JSON.stringify(Object.fromEntries(sources))}`);
    if (!sources.has("paddleocr+tesseract") && !sources.has("ollama+tesseract")) {
      console.log("NOTE: no vision-model backend was reachable (PADDLEOCR_URL/OLLAMA_URL unset or unreachable) -- these numbers are Tesseract+parser only, not the full production pipeline. Run on the Unraid/GTX 1080 Ti box for the full-pipeline benchmark.");
    }
    printSummary("Overall", report.image.overall);
    printSummary("Dev", report.image.dev);
    printSummary("Holdout", report.image.holdout);
    if (args.verbose) { printBreakdown(imageScores, "category", "category"); printBreakdown(imageScores, "difficulty", "difficulty"); printFailures(imageScores); }
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

main().catch((error) => { console.error(error); process.exitCode = 1; });
