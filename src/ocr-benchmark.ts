// Runs the same benchmark as tests/ocr-benchmark/ (see OCR_BENCHMARK.md for the full methodology),
// but in-process against this server's own live receipt-ocr.ts pipeline -- so an admin can check real
// PaddleOCR-VL/Tesseract accuracy from the app itself, with zero SSH/Docker/CLI needed, and results that
// reflect the exact production PADDLEOCR_URL this server instance is actually configured with. The
// scoring logic here is the canonical implementation; tests/ocr-benchmark/scoring.mjs imports from the
// compiled output of this file so the CLI tool and the in-app panel can never silently disagree.
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReceiptText, recognizeReceipt, namesSimilar, type ReceiptSuggestion } from "./receipt-ocr.js";

const here = dirname(fileURLToPath(import.meta.url));
// Resolves the same way in both layouts: locally dist/ and tests/ are sibling directories under the
// repo root; in the production image the Dockerfile copies tests/ocr-benchmark/corpus to the same
// relative place under /app, so this one path works unmodified in dev and in Docker.
export const ocrBenchmarkCorpusRoot = join(here, "..", "tests", "ocr-benchmark", "corpus");

export function ocrBenchmarkAvailable(): boolean {
  return existsSync(ocrBenchmarkCorpusRoot);
}

export interface OcrGroundTruthItem { name: string; quantity: number; totalOre: number }
export interface OcrGroundTruth {
  id: string; category: string; difficulty: string; split: "dev" | "holdout";
  merchant: string; date: string | null; totalOre: number;
  items: OcrGroundTruthItem[]; rejectedMetadata: string[]; discountOre: number; idealText: string;
}
export interface OcrFixture { groundTruth: OcrGroundTruth; imagePath: string }

export async function loadOcrBenchmarkCorpus(split: "dev" | "holdout" | "all"): Promise<OcrFixture[]> {
  const parts = split === "all" ? ["dev", "holdout"] : [split];
  const fixtures: OcrFixture[] = [];
  for (const part of parts) {
    const dir = join(ocrBenchmarkCorpusRoot, part);
    let files: string[];
    try { files = await readdir(dir); } catch { continue; }
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const groundTruth = JSON.parse(await readFile(join(dir, file), "utf8")) as OcrGroundTruth;
      fixtures.push({ groundTruth, imagePath: join(dir, file.replace(/\.json$/, ".jpg")) });
    }
  }
  return fixtures;
}

// ---- scoring: matches a predicted item to its ground-truth counterpart by name only (quantity/price
// are scored separately, see scoreOcrFixture), then aggregates. Ported deliberately 1:1 from
// tests/ocr-benchmark/scoring.mjs's original design -- see that file's history for the reasoning. ----

type PredictedItem = ReceiptSuggestion["items"][number];

function amountToOre(amount: string | null | undefined): number | null {
  if (amount === null || amount === undefined) return null;
  const value = Math.round(Number(amount) * 100);
  return Number.isFinite(value) ? value : null;
}

function matchItems(predicted: PredictedItem[], truth: OcrGroundTruthItem[]) {
  const usedPredIndexes = new Set<number>();
  const matches: Array<{ pred: PredictedItem; truth: OcrGroundTruthItem }> = [];
  const unmatchedTruth: OcrGroundTruthItem[] = [];
  for (const truthItem of truth) {
    let bestIndex = -1; let bestDistance = Infinity;
    predicted.forEach((predItem, index) => {
      if (usedPredIndexes.has(index)) return;
      if (!namesSimilar(predItem.name, truthItem.name)) return;
      const distance = Math.abs(predItem.name.length - truthItem.name.length);
      if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
    });
    if (bestIndex >= 0) { usedPredIndexes.add(bestIndex); matches.push({ pred: predicted[bestIndex]!, truth: truthItem }); }
    else unmatchedTruth.push(truthItem);
  }
  const unmatchedPred = predicted.filter((_, index) => !usedPredIndexes.has(index));
  return { matches, unmatchedTruth, unmatchedPred };
}

function normalizeForCompare(text: string | null | undefined) { return String(text || "").toLocaleLowerCase("sv-SE").trim(); }

function fuzzyTextMatch(a: string | null | undefined, b: string | null | undefined) {
  const left = normalizeForCompare(a); const right = normalizeForCompare(b);
  if (!left || !right) return left === right;
  if (left === right) return true;
  const longer = Math.max(left.length, right.length);
  const shorter = left.length < right.length ? left : right;
  const other = left.length < right.length ? right : left;
  let distance = 0;
  for (let index = 0; index < other.length; index += 1) if (other[index] !== shorter[index]) distance += 1;
  return distance / longer <= 0.15;
}

export interface OcrFixtureScore {
  id: string; category: string; difficulty: string; split: string;
  merchantCorrect: boolean; dateCorrect: boolean; totalCorrect: boolean;
  selfConsistent: boolean; financiallyReconciled: boolean; reconciledAfterKnownAdjustments: boolean;
  truthItemCount: number; predictedItemCount: number; matchedCount: number;
  priceCorrect: number; quantityCorrect: number; nameSimilaritySum: number;
  falseMetadataItemCount: number; falseMetadataItems: string[];
  unmatchedTruthNames: string[]; unmatchedPredNames: string[]; timingMs: number;
}

export function scoreOcrFixture(groundTruth: OcrGroundTruth, prediction: ReceiptSuggestion, timingMs: number): OcrFixtureScore {
  const predictedItems = prediction.items || [];
  const truthItems = groundTruth.items || [];
  const { matches, unmatchedTruth, unmatchedPred } = matchItems(predictedItems, truthItems);

  const priceCorrect = matches.filter((pair) => amountToOre(pair.pred.amount) === pair.truth.totalOre).length;
  const quantityCorrect = matches.filter((pair) => Number(pair.pred.quantity) === pair.truth.quantity).length;
  const nameSimilaritySum = matches.reduce((sum, pair) => {
    const left = normalizeForCompare(pair.pred.name); const right = normalizeForCompare(pair.truth.name);
    const longer = Math.max(left.length, right.length, 1);
    const shorter = left.length < right.length ? left : right; const other = left.length < right.length ? right : left;
    let distance = 0;
    for (let index = 0; index < other.length; index += 1) if (other[index] !== shorter[index]) distance += 1;
    return sum + (1 - distance / longer);
  }, 0);

  // Discounts legitimately make the item sum miss the total (see reconciledAfterKnownAdjustments) --
  // the app's balancedPass()/needsReview logic already treats that as "needs review" by design, not a bug.
  const falseMetadataItems = unmatchedPred.filter((item) => (groundTruth.rejectedMetadata || []).some((metadata) => namesSimilar(item.name, metadata) || fuzzyTextMatch(item.name, metadata)));

  const predictedTotalOre = amountToOre(prediction.amount);
  const totalCorrect = predictedTotalOre !== null && predictedTotalOre === groundTruth.totalOre;
  const merchantCorrect = fuzzyTextMatch(prediction.title, groundTruth.merchant);
  const dateCorrect = prediction.expenseDate === groundTruth.date;

  const predictedItemSum = predictedItems.reduce((sum, item) => sum + (amountToOre(item.amount) || 0), 0);
  const selfConsistent = predictedTotalOre !== null && predictedItemSum === predictedTotalOre;
  const financiallyReconciled = predictedItemSum === groundTruth.totalOre;
  const reconciledAfterKnownAdjustments = predictedItemSum - (groundTruth.discountOre || 0) === groundTruth.totalOre;

  return {
    id: groundTruth.id, category: groundTruth.category, difficulty: groundTruth.difficulty, split: groundTruth.split,
    merchantCorrect, dateCorrect, totalCorrect, selfConsistent, financiallyReconciled, reconciledAfterKnownAdjustments,
    truthItemCount: truthItems.length, predictedItemCount: predictedItems.length,
    matchedCount: matches.length, priceCorrect, quantityCorrect,
    nameSimilaritySum, falseMetadataItemCount: falseMetadataItems.length,
    falseMetadataItems: falseMetadataItems.map((item) => item.name),
    unmatchedTruthNames: unmatchedTruth.map((item) => item.name),
    unmatchedPredNames: unmatchedPred.map((item) => item.name),
    timingMs,
  };
}

export interface OcrBenchmarkAggregate {
  receiptCount: number; merchantAccuracy: number; dateAccuracy: number; totalAccuracy: number;
  itemPrecision: number; itemRecall: number; itemF1: number; nameSimilarity: number | null;
  priceAccuracy: number | null; quantityAccuracy: number | null;
  exactReconciliation: number; reconciledAfterKnownAdjustments: number; selfConsistencyRate: number;
  falseMetadataItemsTotal: number; receiptsNeedingReview: number;
  medianMs: number | null; p90Ms: number | null; p95Ms: number | null;
}

export function aggregateOcrScores(scores: OcrFixtureScore[]): OcrBenchmarkAggregate | null {
  if (!scores.length) return null;
  const sum = (getter: (score: OcrFixtureScore) => number) => scores.reduce((total, score) => total + getter(score), 0);
  const truthItemTotal = sum((s) => s.truthItemCount);
  const predictedItemTotal = sum((s) => s.predictedItemCount);
  const matchedTotal = sum((s) => s.matchedCount);
  const precision = predictedItemTotal ? matchedTotal / predictedItemTotal : 1;
  const recall = truthItemTotal ? matchedTotal / truthItemTotal : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const timings = scores.map((s) => s.timingMs).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const percentile = (fraction: number) => (timings.length ? timings[Math.min(timings.length - 1, Math.floor(timings.length * fraction))]! : null);
  return {
    receiptCount: scores.length,
    merchantAccuracy: sum((s) => (s.merchantCorrect ? 1 : 0)) / scores.length,
    dateAccuracy: sum((s) => (s.dateCorrect ? 1 : 0)) / scores.length,
    totalAccuracy: sum((s) => (s.totalCorrect ? 1 : 0)) / scores.length,
    itemPrecision: precision, itemRecall: recall, itemF1: f1,
    nameSimilarity: matchedTotal ? sum((s) => s.nameSimilaritySum) / matchedTotal : null,
    priceAccuracy: truthItemTotal ? sum((s) => s.priceCorrect) / truthItemTotal : null,
    quantityAccuracy: truthItemTotal ? sum((s) => s.quantityCorrect) / truthItemTotal : null,
    exactReconciliation: sum((s) => (s.financiallyReconciled ? 1 : 0)) / scores.length,
    reconciledAfterKnownAdjustments: sum((s) => (s.reconciledAfterKnownAdjustments ? 1 : 0)) / scores.length,
    selfConsistencyRate: sum((s) => (s.selfConsistent ? 1 : 0)) / scores.length,
    falseMetadataItemsTotal: sum((s) => s.falseMetadataItemCount),
    receiptsNeedingReview: sum((s) => (s.financiallyReconciled ? 0 : 1)),
    medianMs: percentile(0.5), p90Ms: percentile(0.9), p95Ms: percentile(0.95),
  };
}

export interface OcrBenchmarkReport {
  mode: "parser" | "image"; split: string; fixtureCount: number; generatedAt: string;
  overall: OcrBenchmarkAggregate | null; dev: OcrBenchmarkAggregate | null; holdout: OcrBenchmarkAggregate | null;
  sources?: Record<string, number>;
  scores: OcrFixtureScore[];
}

function buildReport(mode: "parser" | "image", split: string, scores: OcrFixtureScore[]): OcrBenchmarkReport {
  return {
    mode, split, fixtureCount: scores.length, generatedAt: new Date().toISOString(),
    overall: aggregateOcrScores(scores),
    dev: aggregateOcrScores(scores.filter((score) => score.split === "dev")),
    holdout: aggregateOcrScores(scores.filter((score) => score.split === "holdout")),
    scores,
  };
}

// Deterministic, no OCR/GPU -- feeds each fixture's ground-truth "ideal OCR text" straight into
// parseReceiptText(), isolating pure parser accuracy. Finishes in well under a second even for the
// whole corpus, so this never needs the async job/progress machinery runOcrBenchmarkImage does.
export async function runOcrBenchmarkParser(split: "dev" | "holdout" | "all"): Promise<OcrBenchmarkReport> {
  const fixtures = await loadOcrBenchmarkCorpus(split);
  const scores = fixtures.map(({ groundTruth }) => {
    const started = performance.now();
    const suggestion = parseReceiptText(groundTruth.idealText);
    return scoreOcrFixture(groundTruth, suggestion, performance.now() - started);
  });
  return buildReport("parser", split, scores);
}

// Runs the real image through this server's own recognizeReceipt() -- real local Tesseract OCR always,
// plus the real PaddleOCR-VL vision model whenever PADDLEOCR_URL is configured and reachable, exactly
// the same call path a genuine user's receipt upload takes. Can run for minutes against the full
// corpus, so the caller (src/server.ts) runs this as a background job rather than a synchronous request.
export async function runOcrBenchmarkImage(split: "dev" | "holdout" | "all", onProgress?: (completed: number, total: number) => void): Promise<OcrBenchmarkReport> {
  const fixtures = await loadOcrBenchmarkCorpus(split);
  const scores: OcrFixtureScore[] = [];
  const sources: Record<string, number> = {};
  let completed = 0;
  onProgress?.(0, fixtures.length);
  for (const { groundTruth, imagePath } of fixtures) {
    const content = await readFile(imagePath);
    const started = performance.now();
    const result = await recognizeReceipt(content);
    const elapsed = performance.now() - started;
    sources[result.source] = (sources[result.source] || 0) + 1;
    scores.push(scoreOcrFixture(groundTruth, result.suggestion, elapsed));
    completed += 1;
    onProgress?.(completed, fixtures.length);
  }
  return { ...buildReport("image", split, scores), sources };
}
