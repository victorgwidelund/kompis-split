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
import { parseReceiptText, recognizeReceipt, type ReceiptSuggestion } from "./receipt-ocr.js";

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
  id: string; category: string; difficulty: string; split: "dev" | "legacy";
  merchant: string; date: string | null; totalOre: number;
  items: OcrGroundTruthItem[]; rejectedMetadata: string[]; discountOre: number; idealText: string;
}
export interface OcrFixture { groundTruth: OcrGroundTruth; imagePath: string }

export type OcrBenchmarkPublicSplit = "dev" | "legacy" | "all-public";

export async function loadOcrBenchmarkCorpus(split: OcrBenchmarkPublicSplit): Promise<OcrFixture[]> {
  const parts = split === "all-public" ? ["dev", "legacy"] as const : [split];
  const fixtures: OcrFixture[] = [];
  for (const part of parts) {
    const dir = join(ocrBenchmarkCorpusRoot, part === "legacy" ? "legacy_regression" : part);
    let files: string[];
    try { files = await readdir(dir); } catch { continue; }
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const parsed = JSON.parse(await readFile(join(dir, file), "utf8")) as Omit<OcrGroundTruth, "split"> & { split?: string };
      // `legacy_regression` used to be called "holdout". The old value may still exist inside a
      // generated fixture while a corpus is being migrated, but it must never escape this loader as a
      // claim that these repeatedly inspected fixtures are an untouched holdout.
      const groundTruth: OcrGroundTruth = { ...parsed, split: part };
      fixtures.push({ groundTruth, imagePath: join(dir, file.replace(/\.json$/, ".jpg")) });
    }
  }
  return fixtures;
}

// ---- evaluator-owned v2 schema ---------------------------------------------------------------
//
// This schema deliberately does not reuse ReceiptSuggestion or any production-parser types. An
// evaluator that imports the system under test's normalization, matching, confidence, or arithmetic
// rules can reproduce the same bug on both sides and report a false success. The v2 scorer therefore
// owns all normalization, matching, arithmetic, and confidence-calibration rules below.

export const OCR_BENCHMARK_SCHEMA_VERSION = 2 as const;

export type OcrBenchmarkItemKindV2 = "product" | "pant" | "fee" | "discount" | "unknown";
export type OcrBenchmarkUnitV2 = "st" | "kg" | "g" | "l" | "ml" | "cl" | "m" | "other";
export type OcrBenchmarkFailureStageV2 =
  | "capture"
  | "upload"
  | "preprocessing"
  | "ocr"
  | "inference"
  | "parsing"
  | "validation"
  | "storage"
  | "timeout"
  | "cancelled"
  | "unknown";
export type OcrBenchmarkTimedStageV2 =
  | "preprocessing"
  | "ocr"
  | "inference"
  | "parsing"
  | "validation"
  | "storage";

export interface OcrBenchmarkMultipackV2 {
  count: number | null;
  unitSize: number | null;
  unit: OcrBenchmarkUnitV2 | null;
}

export interface OcrBenchmarkItemV2 {
  id: string | null;
  rawName: string | null;
  normalizedName: string | null;
  kind: OcrBenchmarkItemKindV2 | null;
  quantity: number | null;
  unit: OcrBenchmarkUnitV2 | null;
  unitPriceOre: number | null;
  // Net amount charged for this item after an attached item discount. Associated pant is included
  // here when it is printed as part of the same charged row, and described separately by pantOre.
  lineTotalOre: number | null;
  weightGrams: number | null;
  multipack: OcrBenchmarkMultipackV2 | null;
  // Positive magnitudes. Null means not observed/known; zero means explicitly no adjustment.
  discountOre: number | null;
  pantOre: number | null;
}

export interface OcrBenchmarkDiscountV2 {
  id: string | null;
  label: string | null;
  amountOre: number | null;
  itemId: string | null;
}

export interface OcrBenchmarkVatLineV2 {
  rateBasisPoints: number | null;
  netOre: number | null;
  vatOre: number | null;
  grossOre: number | null;
}

export interface OcrBenchmarkPaymentV2 {
  method: string | null;
  amountOre: number | null;
}

export interface OcrBenchmarkReceiptV2 {
  merchant: string | null;
  date: string | null;
  time: string | null;
  receiptNumber: string | null;
  currency: string | null;
  items: OcrBenchmarkItemV2[];
  subtotalOre: number | null;
  discounts: OcrBenchmarkDiscountV2[];
  vat: OcrBenchmarkVatLineV2[];
  totalOre: number | null;
  pantTotalOre: number | null;
  payments: OcrBenchmarkPaymentV2[];
}

export interface OcrBenchmarkGroundTruthV2 {
  schemaVersion: typeof OCR_BENCHMARK_SCHEMA_VERSION;
  id: string;
  category: string;
  difficulty: string;
  split: string;
  receipt: OcrBenchmarkReceiptV2;
  rejectedMetadata: string[];
  reviewExpected: boolean | null;
}

export interface OcrBenchmarkScanResultV2 {
  schemaVersion: typeof OCR_BENCHMARK_SCHEMA_VERSION;
  status: "success" | "failure";
  receipt: OcrBenchmarkReceiptV2 | null;
  source: string | null;
  needsReview: boolean | null;
  failureStage: OcrBenchmarkFailureStageV2 | null;
  failureCode: string | null;
  latencyMs: number | null;
  stageLatencyMs: Partial<Record<OcrBenchmarkTimedStageV2, number | null>>;
}

export interface OcrBenchmarkItemMatchV2 {
  truthIndex: number;
  predictedIndex: number;
  nameSimilarity: number;
}

export interface OcrBenchmarkLatencyStatsV2 {
  count: number;
  medianMs: number | null;
  p90Ms: number | null;
  p95Ms: number | null;
  meanMs: number | null;
}

export type OcrBenchmarkReviewOutcomeV2 = "true-positive" | "true-negative" | "false-positive" | "false-negative" | "missing" | "not-scored";

export interface OcrFixtureScoreV2 {
  schemaVersion: typeof OCR_BENCHMARK_SCHEMA_VERSION;
  id: string;
  category: string;
  difficulty: string;
  split: string;
  scanSucceeded: boolean;
  failureStage: OcrBenchmarkFailureStageV2 | null;
  failureCode: string | null;
  merchantEligible: boolean; merchantCorrect: boolean;
  dateEligible: boolean; dateCorrect: boolean;
  timeEligible: boolean; timeCorrect: boolean;
  receiptNumberEligible: boolean; receiptNumberCorrect: boolean;
  currencyEligible: boolean; currencyCorrect: boolean;
  subtotalEligible: boolean; subtotalCorrect: boolean;
  totalEligible: boolean; totalCorrect: boolean;
  pantTotalEligible: boolean; pantTotalCorrect: boolean;
  truthItemCount: number; predictedItemCount: number; matchedItemCount: number;
  missedItemCount: number; extraItemCount: number; hallucinatedItemCount: number; duplicateItemCount: number;
  nameExactEligible: number; nameExactCorrect: number; nameSimilaritySum: number;
  lineTotalEligible: number; lineTotalCorrect: number;
  unitPriceEligible: number; unitPriceCorrect: number;
  quantityEligible: number; quantityCorrect: number;
  unitEligible: number; unitCorrect: number;
  quantityAndUnitEligible: number; quantityAndUnitCorrect: number;
  weightEligible: number; weightCorrect: number;
  multipackEligible: number; multipackCorrect: number;
  itemDiscountEligible: number; itemDiscountCorrect: number;
  itemPantEligible: number; itemPantCorrect: number;
  truthDiscountCount: number; predictedDiscountCount: number; matchedDiscountCount: number; discountAmountCorrect: number;
  truthVatCount: number; predictedVatCount: number; matchedVatCount: number; vatAmountCorrect: number;
  truthPaymentCount: number; predictedPaymentCount: number; matchedPaymentCount: number; paymentAmountCorrect: number;
  metadataHallucinationCount: number; metadataHallucinations: string[];
  unmatchedTruthNames: string[]; unmatchedPredictedNames: string[];
  arithmeticEvaluable: boolean; arithmeticDeltaOre: number | null; arithmeticConsistent: boolean;
  reviewExpected: boolean | null; reviewPredicted: boolean | null; reviewOutcome: OcrBenchmarkReviewOutcomeV2;
  latencyMs: number | null;
  stageLatencyMs: Partial<Record<OcrBenchmarkTimedStageV2, number | null>>;
}

export interface OcrBenchmarkAggregateV2 {
  schemaVersion: typeof OCR_BENCHMARK_SCHEMA_VERSION;
  receiptCount: number;
  successfulScans: number;
  failedScans: number;
  scanSuccessRate: number;
  merchantAccuracy: number | null;
  dateAccuracy: number | null;
  timeAccuracy: number | null;
  receiptNumberAccuracy: number | null;
  currencyAccuracy: number | null;
  subtotalAccuracy: number | null;
  totalAccuracy: number | null;
  pantTotalAccuracy: number | null;
  itemPrecision: number;
  itemRecall: number;
  itemF1: number;
  itemNameExactAccuracy: number | null;
  itemNameSimilarity: number | null;
  lineTotalAccuracy: number | null;
  unitPriceAccuracy: number | null;
  quantityAccuracy: number | null;
  unitAccuracy: number | null;
  quantityAndUnitAccuracy: number | null;
  weightAccuracy: number | null;
  multipackAccuracy: number | null;
  itemDiscountAccuracy: number | null;
  discountAccuracy: number | null;
  discountPrecision: number;
  discountRecall: number;
  pantAccuracy: number | null;
  vatPrecision: number;
  vatRecall: number;
  vatAmountAccuracy: number | null;
  paymentPrecision: number;
  paymentRecall: number;
  paymentAmountAccuracy: number | null;
  missedItems: number;
  extraItems: number;
  hallucinatedItems: number;
  duplicateItems: number;
  metadataHallucinations: number;
  arithmeticCoverage: number;
  arithmeticConsistencyRate: number;
  arithmeticConsistencyWhenEvaluable: number | null;
  meanAbsoluteArithmeticDeltaOre: number | null;
  reviewsExpected: number;
  reviewsPredicted: number;
  reviewTruePositives: number;
  reviewTrueNegatives: number;
  reviewFalsePositives: number;
  reviewFalseNegatives: number;
  reviewMissing: number;
  reviewAccuracy: number | null;
  reviewPrecision: number | null;
  reviewRecall: number | null;
  failureCountsByStage: Partial<Record<OcrBenchmarkFailureStageV2, number>>;
  latency: OcrBenchmarkLatencyStatsV2;
  stageLatency: Partial<Record<OcrBenchmarkTimedStageV2, OcrBenchmarkLatencyStatsV2>>;
}

export function normalizeOcrBenchmarkTextV2(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("sv-SE")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compactOcrBenchmarkTextV2(value: string | null | undefined): string {
  return normalizeOcrBenchmarkTextV2(value).replace(/\s/g, "");
}

function evaluatorEditDistance(leftValue: string, rightValue: string): number {
  const left = Array.from(leftValue);
  const right = Array.from(rightValue);
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = new Array<number>(right.length + 1).fill(0);
    current[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1]! + 1,
        previous[column]! + 1,
        previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

function tokenDiceSimilarity(leftValue: string, rightValue: string): number {
  const left = normalizeOcrBenchmarkTextV2(leftValue).split(" ").filter(Boolean);
  const right = normalizeOcrBenchmarkTextV2(rightValue).split(" ").filter(Boolean);
  if (!left.length || !right.length) return left.length === right.length ? 1 : 0;
  const remaining = [...right];
  let intersection = 0;
  for (const token of left) {
    const index = remaining.indexOf(token);
    if (index >= 0) { intersection += 1; remaining.splice(index, 1); }
  }
  return (2 * intersection) / (left.length + right.length);
}

export function ocrBenchmarkTextSimilarityV2(leftValue: string | null | undefined, rightValue: string | null | undefined): number {
  const left = compactOcrBenchmarkTextV2(leftValue);
  const right = compactOcrBenchmarkTextV2(rightValue);
  if (!left || !right) return left === right ? 1 : 0;
  if (left === right) return 1;
  const characterSimilarity = 1 - evaluatorEditDistance(left, right) / Math.max(Array.from(left).length, Array.from(right).length, 1);
  const tokenSimilarity = tokenDiceSimilarity(String(leftValue ?? ""), String(rightValue ?? ""));
  return Math.max(0, Math.min(1, Math.max(characterSimilarity, tokenSimilarity * 0.72 + characterSimilarity * 0.28)));
}

function evaluatorNamesMatch(leftValue: string | null | undefined, rightValue: string | null | undefined): boolean {
  const left = compactOcrBenchmarkTextV2(leftValue);
  const right = compactOcrBenchmarkTextV2(rightValue);
  if (!left || !right) return false;
  if (left === right) return true;
  const similarity = ocrBenchmarkTextSimilarityV2(leftValue, rightValue);
  return similarity >= (Math.max(Array.from(left).length, Array.from(right).length) <= 4 ? 0.75 : 0.58);
}

function validOre(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function closeNumber(left: number | null | undefined, right: number | null | undefined, tolerance = 0.000_001): boolean {
  return typeof left === "number" && Number.isFinite(left) && typeof right === "number" && Number.isFinite(right)
    && Math.abs(left - right) <= tolerance;
}

function sameNullableText(left: string | null | undefined, right: string | null | undefined): boolean {
  return normalizeOcrBenchmarkTextV2(left) === normalizeOcrBenchmarkTextV2(right);
}

function sameMultipack(left: OcrBenchmarkMultipackV2 | null | undefined, right: OcrBenchmarkMultipackV2 | null | undefined): boolean {
  if (!left || !right) return left === right;
  return closeNumber(left.count, right.count)
    && closeNumber(left.unitSize, right.unitSize)
    && left.unit === right.unit;
}

// Hungarian assignment: polynomial-time, deterministic, and globally optimal. A bit-mask exhaustive
// matcher becomes unusable on realistic long receipts, while a greedy matcher mispairs repeated names.
function maximumWeightAssignment(weights: number[][]): number[] {
  const rowCount = weights.length;
  const columnCount = weights.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  if (!rowCount) return [];
  const size = Math.max(rowCount, columnCount);
  if (!size) return new Array<number>(rowCount).fill(-1);
  const square = Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => weights[row]?.[column] ?? 0));
  const maximumWeight = square.reduce((outerMaximum, row) => Math.max(outerMaximum, ...row), 0);
  const u = new Array<number>(size + 1).fill(0);
  const v = new Array<number>(size + 1).fill(0);
  const matchedRowForColumn = new Array<number>(size + 1).fill(0);
  const previousColumn = new Array<number>(size + 1).fill(0);

  for (let row = 1; row <= size; row += 1) {
    matchedRowForColumn[0] = row;
    let column0 = 0;
    const minimumReducedCost = new Array<number>(size + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Array<boolean>(size + 1).fill(false);
    do {
      used[column0] = true;
      const row0 = matchedRowForColumn[column0]!;
      let delta = Number.POSITIVE_INFINITY;
      let column1 = 0;
      for (let column = 1; column <= size; column += 1) {
        if (used[column]) continue;
        const cost = maximumWeight - square[row0 - 1]![column - 1]!;
        const reducedCost = cost - u[row0]! - v[column]!;
        if (reducedCost < minimumReducedCost[column]!) {
          minimumReducedCost[column] = reducedCost;
          previousColumn[column] = column0;
        }
        if (minimumReducedCost[column]! < delta) { delta = minimumReducedCost[column]!; column1 = column; }
      }
      for (let column = 0; column <= size; column += 1) {
        if (used[column]) {
          const matchedRow = matchedRowForColumn[column]!;
          u[matchedRow] = u[matchedRow]! + delta;
          v[column] = v[column]! - delta;
        } else if (column > 0) minimumReducedCost[column] = minimumReducedCost[column]! - delta;
      }
      column0 = column1;
    } while (matchedRowForColumn[column0] !== 0);

    do {
      const column1 = previousColumn[column0]!;
      matchedRowForColumn[column0] = matchedRowForColumn[column1]!;
      column0 = column1;
    } while (column0 !== 0);
  }

  const assignment = new Array<number>(rowCount).fill(-1);
  for (let column = 1; column <= size; column += 1) {
    const row = matchedRowForColumn[column]! - 1;
    if (row >= 0 && row < rowCount && column - 1 < columnCount) assignment[row] = column - 1;
  }
  return assignment;
}

function itemName(item: OcrBenchmarkItemV2): string {
  return item.normalizedName || item.rawName || "";
}

export function matchOcrBenchmarkItemsV2(truth: OcrBenchmarkItemV2[], predicted: OcrBenchmarkItemV2[]): {
  matches: OcrBenchmarkItemMatchV2[];
  unmatchedTruthIndexes: number[];
  unmatchedPredictedIndexes: number[];
} {
  const weights = truth.map((truthItem) => predicted.map((predictedItem) => {
    const truthName = itemName(truthItem);
    const predictedName = itemName(predictedItem);
    if (!evaluatorNamesMatch(truthName, predictedName)) return 0;
    const similarity = ocrBenchmarkTextSimilarityV2(truthName, predictedName);
    let weight = Math.round(similarity * 1_000_000);
    if (compactOcrBenchmarkTextV2(truthName) === compactOcrBenchmarkTextV2(predictedName)) weight += 100_000;
    if (validOre(truthItem.lineTotalOre) !== null && validOre(truthItem.lineTotalOre) === validOre(predictedItem.lineTotalOre)) weight += 10_000;
    if (validOre(truthItem.unitPriceOre) !== null && validOre(truthItem.unitPriceOre) === validOre(predictedItem.unitPriceOre)) weight += 1_000;
    if (truthItem.quantity !== null && closeNumber(truthItem.quantity, predictedItem.quantity)) weight += 100;
    if (truthItem.unit !== null && truthItem.unit === predictedItem.unit) weight += 10;
    return weight;
  }));
  const assignment = maximumWeightAssignment(weights);
  const matchedPredicted = new Set<number>();
  const matches: OcrBenchmarkItemMatchV2[] = [];
  const unmatchedTruthIndexes: number[] = [];
  assignment.forEach((predictedIndex, truthIndex) => {
    if (predictedIndex < 0 || (weights[truthIndex]?.[predictedIndex] ?? 0) <= 0) {
      unmatchedTruthIndexes.push(truthIndex);
      return;
    }
    matchedPredicted.add(predictedIndex);
    matches.push({
      truthIndex,
      predictedIndex,
      nameSimilarity: ocrBenchmarkTextSimilarityV2(itemName(truth[truthIndex]!), itemName(predicted[predictedIndex]!)),
    });
  });
  return {
    matches,
    unmatchedTruthIndexes,
    unmatchedPredictedIndexes: predicted.map((_, index) => index).filter((index) => !matchedPredicted.has(index)),
  };
}

function namedAmountMatches<T>(
  truth: T[],
  predicted: T[],
  label: (value: T) => string | null,
  amount: (value: T) => number | null,
): Array<{ truthIndex: number; predictedIndex: number }> {
  const weights = truth.map((truthValue) => predicted.map((predictedValue) => {
    const truthAmount = validOre(amount(truthValue));
    const predictedAmount = validOre(amount(predictedValue));
    const amountEqual = truthAmount !== null && truthAmount === predictedAmount;
    const truthLabel = label(truthValue);
    const predictedLabel = label(predictedValue);
    const labelSimilarity = truthLabel && predictedLabel ? ocrBenchmarkTextSimilarityV2(truthLabel, predictedLabel) : 0;
    if (!amountEqual && labelSimilarity < 0.58) return 0;
    return (amountEqual ? 1_000_000 : 0) + Math.round(labelSimilarity * 100_000);
  }));
  const assignment = maximumWeightAssignment(weights);
  return assignment.flatMap((predictedIndex, truthIndex) =>
    predictedIndex >= 0 && (weights[truthIndex]?.[predictedIndex] ?? 0) > 0 ? [{ truthIndex, predictedIndex }] : []);
}

function vatMatches(truth: OcrBenchmarkVatLineV2[], predicted: OcrBenchmarkVatLineV2[]): Array<{ truthIndex: number; predictedIndex: number }> {
  const weights = truth.map((truthValue) => predicted.map((predictedValue) => {
    const rateEqual = truthValue.rateBasisPoints !== null && truthValue.rateBasisPoints === predictedValue.rateBasisPoints;
    const amountFields: Array<keyof Pick<OcrBenchmarkVatLineV2, "netOre" | "vatOre" | "grossOre">> = ["netOre", "vatOre", "grossOre"];
    const equalAmounts = amountFields.filter((field) => validOre(truthValue[field]) !== null && validOre(truthValue[field]) === validOre(predictedValue[field])).length;
    if (!rateEqual && equalAmounts === 0) return 0;
    return (rateEqual ? 1_000_000 : 0) + equalAmounts * 10_000;
  }));
  const assignment = maximumWeightAssignment(weights);
  return assignment.flatMap((predictedIndex, truthIndex) =>
    predictedIndex >= 0 && (weights[truthIndex]?.[predictedIndex] ?? 0) > 0 ? [{ truthIndex, predictedIndex }] : []);
}

function vatAmountsEqual(truth: OcrBenchmarkVatLineV2, predicted: OcrBenchmarkVatLineV2): boolean {
  const fields: Array<keyof Pick<OcrBenchmarkVatLineV2, "netOre" | "vatOre" | "grossOre">> = ["netOre", "vatOre", "grossOre"];
  const eligible = fields.filter((field) => validOre(truth[field]) !== null);
  return eligible.length > 0 && eligible.every((field) => validOre(truth[field]) === validOre(predicted[field]));
}

function arithmeticTotal(receipt: OcrBenchmarkReceiptV2): number | null {
  const itemAmounts = receipt.items.map((item) => validOre(item.lineTotalOre));
  const discountAmounts = receipt.discounts.map((discount) => validOre(discount.amountOre));
  if (itemAmounts.some((amount) => amount === null) || discountAmounts.some((amount) => amount === null)) return null;
  return itemAmounts.reduce<number>((sum, amount) => sum + (amount ?? 0), 0)
    - discountAmounts.reduce<number>((sum, amount) => sum + (amount ?? 0), 0);
}

function reviewOutcome(expected: boolean | null, predicted: boolean | null): OcrBenchmarkReviewOutcomeV2 {
  if (expected === null) return "not-scored";
  if (predicted === null) return "missing";
  if (expected && predicted) return "true-positive";
  if (!expected && !predicted) return "true-negative";
  return predicted ? "false-positive" : "false-negative";
}

function receiptOrEmpty(receipt: OcrBenchmarkReceiptV2 | null): OcrBenchmarkReceiptV2 {
  return receipt ?? {
    merchant: null, date: null, time: null, receiptNumber: null, currency: null,
    items: [], subtotalOre: null, discounts: [], vat: [], totalOre: null, pantTotalOre: null, payments: [],
  };
}

function eligibleOre(value: number | null): boolean { return validOre(value) !== null; }
function oreCorrect(truth: number | null, predicted: number | null): boolean {
  return validOre(truth) !== null && validOre(truth) === validOre(predicted);
}

export function scoreOcrFixtureV2(groundTruth: OcrBenchmarkGroundTruthV2, scan: OcrBenchmarkScanResultV2): OcrFixtureScoreV2 {
  if (groundTruth.schemaVersion !== OCR_BENCHMARK_SCHEMA_VERSION || scan.schemaVersion !== OCR_BENCHMARK_SCHEMA_VERSION) {
    throw new Error(`Unsupported OCR benchmark schema version; expected ${OCR_BENCHMARK_SCHEMA_VERSION}`);
  }
  const truth = groundTruth.receipt;
  const scanSucceeded = scan.status === "success" && scan.receipt !== null;
  const predicted = receiptOrEmpty(scanSucceeded ? scan.receipt : null);
  const itemMatching = matchOcrBenchmarkItemsV2(truth.items, predicted.items);
  const duplicatePredictedIndexes = itemMatching.unmatchedPredictedIndexes.filter((predictedIndex) =>
    truth.items.some((truthItem) => evaluatorNamesMatch(itemName(truthItem), itemName(predicted.items[predictedIndex]!))));
  const duplicateSet = new Set(duplicatePredictedIndexes);
  const metadataItemHallucinations = itemMatching.unmatchedPredictedIndexes
    .map((index) => predicted.items[index]!)
    .filter((item) => groundTruth.rejectedMetadata.some((metadata) => evaluatorNamesMatch(itemName(item), metadata)))
    .map(itemName);
  // A nullable truth field means "not present", not an invitation to invent a plausible value.
  // Count those scalar inventions separately from ordinary field accuracy so a parser cannot improve
  // apparent recall by filling every unknown field.
  const metadataHallucinations = [
    ...metadataItemHallucinations,
    ...([
      ["merchant", truth.merchant, predicted.merchant],
      ["date", truth.date, predicted.date],
      ["time", truth.time, predicted.time],
      ["receiptNumber", truth.receiptNumber, predicted.receiptNumber],
      ["currency", truth.currency, predicted.currency],
      ["subtotalOre", truth.subtotalOre, predicted.subtotalOre],
      ["totalOre", truth.totalOre, predicted.totalOre],
      ["pantTotalOre", truth.pantTotalOre, predicted.pantTotalOre],
    ] as const).flatMap(([field, truthValue, predictedValue]) =>
      truthValue === null && predictedValue !== null ? [`${field}:${String(predictedValue)}`] : []),
  ];

  const countMatched = (eligible: (truthItem: OcrBenchmarkItemV2) => boolean, correct: (truthItem: OcrBenchmarkItemV2, predictedItem: OcrBenchmarkItemV2) => boolean) => ({
    eligible: truth.items.filter(eligible).length,
    correct: itemMatching.matches.filter((match) => {
      const truthItem = truth.items[match.truthIndex]!;
      return eligible(truthItem) && correct(truthItem, predicted.items[match.predictedIndex]!);
    }).length,
  });
  const nameExact = countMatched(() => true, (truthItem, predictedItem) => compactOcrBenchmarkTextV2(itemName(truthItem)) === compactOcrBenchmarkTextV2(itemName(predictedItem)));
  const lineTotal = countMatched((item) => eligibleOre(item.lineTotalOre), (truthItem, predictedItem) => oreCorrect(truthItem.lineTotalOre, predictedItem.lineTotalOre));
  const unitPrice = countMatched((item) => eligibleOre(item.unitPriceOre), (truthItem, predictedItem) => oreCorrect(truthItem.unitPriceOre, predictedItem.unitPriceOre));
  const quantity = countMatched((item) => item.quantity !== null, (truthItem, predictedItem) => closeNumber(truthItem.quantity, predictedItem.quantity));
  const unit = countMatched((item) => item.unit !== null, (truthItem, predictedItem) => truthItem.unit === predictedItem.unit);
  const quantityAndUnit = countMatched((item) => item.quantity !== null && item.unit !== null, (truthItem, predictedItem) => closeNumber(truthItem.quantity, predictedItem.quantity) && truthItem.unit === predictedItem.unit);
  const weight = countMatched((item) => item.weightGrams !== null, (truthItem, predictedItem) => closeNumber(truthItem.weightGrams, predictedItem.weightGrams, 1));
  const multipack = countMatched((item) => item.multipack !== null, (truthItem, predictedItem) => sameMultipack(truthItem.multipack, predictedItem.multipack));
  const itemDiscount = countMatched((item) => eligibleOre(item.discountOre), (truthItem, predictedItem) => oreCorrect(truthItem.discountOre, predictedItem.discountOre));
  const itemPant = countMatched((item) => eligibleOre(item.pantOre), (truthItem, predictedItem) => oreCorrect(truthItem.pantOre, predictedItem.pantOre));

  const discountMatches = namedAmountMatches(truth.discounts, predicted.discounts, (discount) => discount.label, (discount) => discount.amountOre);
  const paymentMatches = namedAmountMatches(truth.payments, predicted.payments, (payment) => payment.method, (payment) => payment.amountOre);
  const matchedVat = vatMatches(truth.vat, predicted.vat);
  const discountAmountCorrect = discountMatches.filter(({ truthIndex, predictedIndex }) => oreCorrect(truth.discounts[truthIndex]!.amountOre, predicted.discounts[predictedIndex]!.amountOre)).length;
  const paymentAmountCorrect = paymentMatches.filter(({ truthIndex, predictedIndex }) => oreCorrect(truth.payments[truthIndex]!.amountOre, predicted.payments[predictedIndex]!.amountOre)).length;
  const vatAmountCorrect = matchedVat.filter(({ truthIndex, predictedIndex }) => vatAmountsEqual(truth.vat[truthIndex]!, predicted.vat[predictedIndex]!)).length;

  const calculatedTotal = arithmeticTotal(predicted);
  const predictedTotal = validOre(predicted.totalOre);
  const arithmeticDeltaOre = calculatedTotal !== null && predictedTotal !== null ? calculatedTotal - predictedTotal : null;
  const arithmeticEvaluable = arithmeticDeltaOre !== null;

  const merchantEligible = Boolean(normalizeOcrBenchmarkTextV2(truth.merchant));
  const dateEligible = truth.date !== null;
  const timeEligible = truth.time !== null;
  const receiptNumberEligible = truth.receiptNumber !== null;
  const currencyEligible = truth.currency !== null;
  const subtotalEligible = eligibleOre(truth.subtotalOre);
  const totalEligible = eligibleOre(truth.totalOre);
  const pantTotalEligible = eligibleOre(truth.pantTotalOre);
  const expectedReview = groundTruth.reviewExpected === null ? null : (
    groundTruth.reviewExpected
    || !scanSucceeded
    || (totalEligible && !oreCorrect(truth.totalOre, predicted.totalOre))
    || itemMatching.unmatchedTruthIndexes.length > 0
    || itemMatching.unmatchedPredictedIndexes.length > 0
    || (arithmeticEvaluable && Math.abs(arithmeticDeltaOre) > 1)
  );

  return {
    schemaVersion: OCR_BENCHMARK_SCHEMA_VERSION,
    id: groundTruth.id, category: groundTruth.category, difficulty: groundTruth.difficulty, split: groundTruth.split,
    scanSucceeded,
    failureStage: scanSucceeded ? null : (scan.failureStage ?? "unknown"),
    failureCode: scanSucceeded ? null : scan.failureCode,
    merchantEligible,
    merchantCorrect: merchantEligible && evaluatorNamesMatch(truth.merchant, predicted.merchant),
    dateEligible, dateCorrect: dateEligible && sameNullableText(truth.date, predicted.date),
    timeEligible, timeCorrect: timeEligible && sameNullableText(truth.time, predicted.time),
    receiptNumberEligible, receiptNumberCorrect: receiptNumberEligible && sameNullableText(truth.receiptNumber, predicted.receiptNumber),
    currencyEligible, currencyCorrect: currencyEligible && sameNullableText(truth.currency, predicted.currency),
    subtotalEligible, subtotalCorrect: subtotalEligible && oreCorrect(truth.subtotalOre, predicted.subtotalOre),
    totalEligible, totalCorrect: totalEligible && oreCorrect(truth.totalOre, predicted.totalOre),
    pantTotalEligible, pantTotalCorrect: pantTotalEligible && oreCorrect(truth.pantTotalOre, predicted.pantTotalOre),
    truthItemCount: truth.items.length,
    predictedItemCount: predicted.items.length,
    matchedItemCount: itemMatching.matches.length,
    missedItemCount: itemMatching.unmatchedTruthIndexes.length,
    extraItemCount: itemMatching.unmatchedPredictedIndexes.length,
    hallucinatedItemCount: itemMatching.unmatchedPredictedIndexes.filter((index) => !duplicateSet.has(index)).length,
    duplicateItemCount: duplicatePredictedIndexes.length,
    nameExactEligible: nameExact.eligible, nameExactCorrect: nameExact.correct,
    nameSimilaritySum: itemMatching.matches.reduce((sum, match) => sum + match.nameSimilarity, 0),
    lineTotalEligible: lineTotal.eligible, lineTotalCorrect: lineTotal.correct,
    unitPriceEligible: unitPrice.eligible, unitPriceCorrect: unitPrice.correct,
    quantityEligible: quantity.eligible, quantityCorrect: quantity.correct,
    unitEligible: unit.eligible, unitCorrect: unit.correct,
    quantityAndUnitEligible: quantityAndUnit.eligible, quantityAndUnitCorrect: quantityAndUnit.correct,
    weightEligible: weight.eligible, weightCorrect: weight.correct,
    multipackEligible: multipack.eligible, multipackCorrect: multipack.correct,
    itemDiscountEligible: itemDiscount.eligible, itemDiscountCorrect: itemDiscount.correct,
    itemPantEligible: itemPant.eligible, itemPantCorrect: itemPant.correct,
    truthDiscountCount: truth.discounts.length,
    predictedDiscountCount: predicted.discounts.length,
    matchedDiscountCount: discountMatches.length,
    discountAmountCorrect,
    truthVatCount: truth.vat.length,
    predictedVatCount: predicted.vat.length,
    matchedVatCount: matchedVat.length,
    vatAmountCorrect,
    truthPaymentCount: truth.payments.length,
    predictedPaymentCount: predicted.payments.length,
    matchedPaymentCount: paymentMatches.length,
    paymentAmountCorrect,
    metadataHallucinationCount: metadataHallucinations.length,
    metadataHallucinations,
    unmatchedTruthNames: itemMatching.unmatchedTruthIndexes.map((index) => itemName(truth.items[index]!)),
    unmatchedPredictedNames: itemMatching.unmatchedPredictedIndexes.map((index) => itemName(predicted.items[index]!)),
    arithmeticEvaluable,
    arithmeticDeltaOre,
    arithmeticConsistent: arithmeticDeltaOre !== null && Math.abs(arithmeticDeltaOre) <= 1,
    reviewExpected: expectedReview,
    reviewPredicted: scan.needsReview,
    reviewOutcome: reviewOutcome(expectedReview, scan.needsReview),
    latencyMs: typeof scan.latencyMs === "number" && Number.isFinite(scan.latencyMs) && scan.latencyMs >= 0 ? scan.latencyMs : null,
    stageLatencyMs: scan.stageLatencyMs,
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function latencyStats(values: Array<number | null | undefined>): OcrBenchmarkLatencyStatsV2 {
  const sorted = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0).sort((left, right) => left - right);
  const quantile = (fraction: number): number | null => {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower]!;
    return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
  };
  return {
    count: sorted.length,
    medianMs: quantile(0.5),
    p90Ms: quantile(0.9),
    p95Ms: quantile(0.95),
    meanMs: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
  };
}

export function aggregateOcrScoresV2(scores: OcrFixtureScoreV2[]): OcrBenchmarkAggregateV2 | null {
  if (!scores.length) return null;
  const sum = (getter: (score: OcrFixtureScoreV2) => number) => scores.reduce((total, score) => total + getter(score), 0);
  const correctness = (eligible: (score: OcrFixtureScoreV2) => boolean, correct: (score: OcrFixtureScoreV2) => boolean) =>
    ratio(sum((score) => eligible(score) ? Number(correct(score)) : 0), sum((score) => Number(eligible(score))));
  const totalTruthItems = sum((score) => score.truthItemCount);
  const totalPredictedItems = sum((score) => score.predictedItemCount);
  const totalMatchedItems = sum((score) => score.matchedItemCount);
  const itemPrecision = ratio(totalMatchedItems, totalPredictedItems) ?? 1;
  const itemRecall = ratio(totalMatchedItems, totalTruthItems) ?? 1;
  const itemF1 = itemPrecision + itemRecall > 0 ? (2 * itemPrecision * itemRecall) / (itemPrecision + itemRecall) : 0;
  const totalTruthDiscounts = sum((score) => score.truthDiscountCount);
  const totalPredictedDiscounts = sum((score) => score.predictedDiscountCount);
  const totalMatchedDiscounts = sum((score) => score.matchedDiscountCount);
  const totalTruthVat = sum((score) => score.truthVatCount);
  const totalPredictedVat = sum((score) => score.predictedVatCount);
  const totalMatchedVat = sum((score) => score.matchedVatCount);
  const totalTruthPayments = sum((score) => score.truthPaymentCount);
  const totalPredictedPayments = sum((score) => score.predictedPaymentCount);
  const totalMatchedPayments = sum((score) => score.matchedPaymentCount);
  const itemDiscountEligible = sum((score) => score.itemDiscountEligible);
  const receiptDiscountEligible = totalTruthDiscounts;
  const itemPantEligible = sum((score) => score.itemPantEligible);
  const pantTotalEligible = sum((score) => Number(score.pantTotalEligible));
  const arithmeticEvaluable = sum((score) => Number(score.arithmeticEvaluable));
  const arithmeticConsistent = sum((score) => Number(score.arithmeticConsistent));
  const arithmeticDeltas = scores.flatMap((score) => score.arithmeticDeltaOre === null ? [] : [Math.abs(score.arithmeticDeltaOre)]);
  const reviewScored = scores.filter((score) => score.reviewExpected !== null);
  const outcomeCount = (outcome: OcrBenchmarkReviewOutcomeV2) => reviewScored.filter((score) => score.reviewOutcome === outcome).length;
  const reviewTruePositives = outcomeCount("true-positive");
  const reviewTrueNegatives = outcomeCount("true-negative");
  const reviewFalsePositives = outcomeCount("false-positive");
  const reviewFalseNegatives = outcomeCount("false-negative");
  const reviewMissing = outcomeCount("missing");
  const expectedReviews = reviewScored.filter((score) => score.reviewExpected).length;
  const predictedReviews = reviewScored.filter((score) => score.reviewPredicted === true).length;
  const failureCountsByStage: Partial<Record<OcrBenchmarkFailureStageV2, number>> = {};
  for (const score of scores) {
    if (!score.scanSucceeded && score.failureStage) failureCountsByStage[score.failureStage] = (failureCountsByStage[score.failureStage] ?? 0) + 1;
  }
  const timedStages: OcrBenchmarkTimedStageV2[] = ["preprocessing", "ocr", "inference", "parsing", "validation", "storage"];
  const stageLatency: Partial<Record<OcrBenchmarkTimedStageV2, OcrBenchmarkLatencyStatsV2>> = {};
  for (const stage of timedStages) stageLatency[stage] = latencyStats(scores.map((score) => score.stageLatencyMs[stage]));

  const countMetric = (eligibleKey: keyof OcrFixtureScoreV2, correctKey: keyof OcrFixtureScoreV2): number | null => {
    const eligible = sum((score) => Number(score[eligibleKey]));
    const correct = sum((score) => Number(score[correctKey]));
    return ratio(correct, eligible);
  };

  return {
    schemaVersion: OCR_BENCHMARK_SCHEMA_VERSION,
    receiptCount: scores.length,
    successfulScans: sum((score) => Number(score.scanSucceeded)),
    failedScans: sum((score) => Number(!score.scanSucceeded)),
    scanSuccessRate: sum((score) => Number(score.scanSucceeded)) / scores.length,
    merchantAccuracy: correctness((score) => score.merchantEligible, (score) => score.merchantCorrect),
    dateAccuracy: correctness((score) => score.dateEligible, (score) => score.dateCorrect),
    timeAccuracy: correctness((score) => score.timeEligible, (score) => score.timeCorrect),
    receiptNumberAccuracy: correctness((score) => score.receiptNumberEligible, (score) => score.receiptNumberCorrect),
    currencyAccuracy: correctness((score) => score.currencyEligible, (score) => score.currencyCorrect),
    subtotalAccuracy: correctness((score) => score.subtotalEligible, (score) => score.subtotalCorrect),
    totalAccuracy: correctness((score) => score.totalEligible, (score) => score.totalCorrect),
    pantTotalAccuracy: correctness((score) => score.pantTotalEligible, (score) => score.pantTotalCorrect),
    itemPrecision, itemRecall, itemF1,
    itemNameExactAccuracy: countMetric("nameExactEligible", "nameExactCorrect"),
    itemNameSimilarity: ratio(sum((score) => score.nameSimilaritySum), sum((score) => score.nameExactEligible)),
    lineTotalAccuracy: countMetric("lineTotalEligible", "lineTotalCorrect"),
    unitPriceAccuracy: countMetric("unitPriceEligible", "unitPriceCorrect"),
    quantityAccuracy: countMetric("quantityEligible", "quantityCorrect"),
    unitAccuracy: countMetric("unitEligible", "unitCorrect"),
    quantityAndUnitAccuracy: countMetric("quantityAndUnitEligible", "quantityAndUnitCorrect"),
    weightAccuracy: countMetric("weightEligible", "weightCorrect"),
    multipackAccuracy: countMetric("multipackEligible", "multipackCorrect"),
    itemDiscountAccuracy: countMetric("itemDiscountEligible", "itemDiscountCorrect"),
    discountAccuracy: ratio(sum((score) => score.itemDiscountCorrect + score.discountAmountCorrect), itemDiscountEligible + receiptDiscountEligible),
    discountPrecision: ratio(totalMatchedDiscounts, totalPredictedDiscounts) ?? 1,
    discountRecall: ratio(totalMatchedDiscounts, totalTruthDiscounts) ?? 1,
    pantAccuracy: ratio(sum((score) => score.itemPantCorrect + Number(score.pantTotalCorrect)), itemPantEligible + pantTotalEligible),
    vatPrecision: ratio(totalMatchedVat, totalPredictedVat) ?? 1,
    vatRecall: ratio(totalMatchedVat, totalTruthVat) ?? 1,
    vatAmountAccuracy: ratio(sum((score) => score.vatAmountCorrect), totalTruthVat),
    paymentPrecision: ratio(totalMatchedPayments, totalPredictedPayments) ?? 1,
    paymentRecall: ratio(totalMatchedPayments, totalTruthPayments) ?? 1,
    paymentAmountAccuracy: ratio(sum((score) => score.paymentAmountCorrect), totalTruthPayments),
    missedItems: sum((score) => score.missedItemCount),
    extraItems: sum((score) => score.extraItemCount),
    hallucinatedItems: sum((score) => score.hallucinatedItemCount),
    duplicateItems: sum((score) => score.duplicateItemCount),
    metadataHallucinations: sum((score) => score.metadataHallucinationCount),
    arithmeticCoverage: arithmeticEvaluable / scores.length,
    arithmeticConsistencyRate: arithmeticConsistent / scores.length,
    arithmeticConsistencyWhenEvaluable: ratio(arithmeticConsistent, arithmeticEvaluable),
    meanAbsoluteArithmeticDeltaOre: arithmeticDeltas.length ? arithmeticDeltas.reduce((sum, value) => sum + value, 0) / arithmeticDeltas.length : null,
    reviewsExpected: expectedReviews,
    reviewsPredicted: predictedReviews,
    reviewTruePositives,
    reviewTrueNegatives,
    reviewFalsePositives,
    reviewFalseNegatives,
    reviewMissing,
    reviewAccuracy: ratio(reviewTruePositives + reviewTrueNegatives, reviewScored.length),
    reviewPrecision: ratio(reviewTruePositives, reviewTruePositives + reviewFalsePositives),
    reviewRecall: ratio(reviewTruePositives, expectedReviews),
    failureCountsByStage,
    latency: latencyStats(scores.map((score) => score.latencyMs)),
    stageLatency,
  };
}

export function adaptLegacyGroundTruthToV2(groundTruth: OcrGroundTruth): OcrBenchmarkGroundTruthV2 {
  const discountOre = validOre(groundTruth.discountOre) ?? 0;
  return {
    schemaVersion: OCR_BENCHMARK_SCHEMA_VERSION,
    id: groundTruth.id,
    category: groundTruth.category,
    difficulty: groundTruth.difficulty,
    split: groundTruth.split,
    receipt: {
      merchant: groundTruth.merchant,
      date: groundTruth.date,
      time: null,
      receiptNumber: null,
      currency: "SEK",
      items: groundTruth.items.map((item, index) => ({
        id: `legacy-${index}`,
        rawName: item.name,
        normalizedName: null,
        kind: "product",
        quantity: item.quantity,
        unit: null,
        unitPriceOre: null,
        lineTotalOre: item.totalOre,
        weightGrams: null,
        multipack: null,
        discountOre: null,
        pantOre: null,
      })),
      subtotalOre: null,
      discounts: discountOre > 0 ? [{ id: "legacy-discount", label: null, amountOre: discountOre, itemId: null }] : [],
      vat: [],
      totalOre: groundTruth.totalOre,
      pantTotalOre: null,
      payments: [],
    },
    rejectedMetadata: groundTruth.rejectedMetadata ?? [],
    reviewExpected: null,
  };
}

export function adaptLegacyPredictionToV2(prediction: ReceiptSuggestion, timingMs: number, needsReview: boolean | null = null): OcrBenchmarkScanResultV2 {
  return {
    schemaVersion: OCR_BENCHMARK_SCHEMA_VERSION,
    status: "success",
    receipt: {
      merchant: prediction.title,
      date: prediction.expenseDate,
      time: null,
      receiptNumber: null,
      currency: "SEK",
      items: (prediction.items ?? []).map((item, index) => ({
        id: `legacy-prediction-${index}`,
        rawName: item.name,
        normalizedName: null,
        kind: "product",
        quantity: Number.isFinite(Number(item.quantity)) ? Number(item.quantity) : null,
        unit: null,
        unitPriceOre: null,
        lineTotalOre: amountToOre(item.amount),
        weightGrams: null,
        multipack: null,
        discountOre: null,
        pantOre: null,
      })),
      subtotalOre: null,
      discounts: [],
      vat: [],
      totalOre: amountToOre(prediction.amount),
      pantTotalOre: null,
      payments: [],
    },
    source: null,
    needsReview,
    failureStage: null,
    failureCode: null,
    latencyMs: timingMs,
    stageLatencyMs: {},
  };
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
      if (!evaluatorNamesMatch(predItem.name, truthItem.name)) return;
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
  const falseMetadataItems = unmatchedPred.filter((item) => (groundTruth.rejectedMetadata || []).some((metadata) => evaluatorNamesMatch(item.name, metadata) || fuzzyTextMatch(item.name, metadata)));

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
    // A valid discount makes the raw item sum differ from the paid total by design. Calling that an
    // OCR review case made the admin panel flag a correctly interpreted discount receipt even though
    // the scorer already proves it reconciles after known adjustments.
    receiptsNeedingReview: sum((s) => (s.reconciledAfterKnownAdjustments ? 0 : 1)),
    medianMs: percentile(0.5), p90Ms: percentile(0.9), p95Ms: percentile(0.95),
  };
}

export interface OcrBenchmarkReport {
  mode: "parser" | "image"; split: string; fixtureCount: number; generatedAt: string;
  overall: OcrBenchmarkAggregate | null; dev: OcrBenchmarkAggregate | null; legacy: OcrBenchmarkAggregate | null;
  sources?: Record<string, number>;
  scores?: OcrFixtureScore[];
}

function buildReport(mode: "parser" | "image", split: string, scores: OcrFixtureScore[], detailed = true): OcrBenchmarkReport {
  return {
    mode, split, fixtureCount: scores.length, generatedAt: new Date().toISOString(),
    overall: aggregateOcrScores(scores),
    dev: aggregateOcrScores(scores.filter((score) => score.split === "dev")),
    legacy: aggregateOcrScores(scores.filter((score) => score.split === "legacy")),
    ...(detailed ? { scores } : {}),
  };
}

// Deterministic, no OCR/GPU -- feeds each fixture's ground-truth "ideal OCR text" straight into
// parseReceiptText(), isolating pure parser accuracy. Finishes in well under a second even for the
// whole corpus, so this never needs the async job/progress machinery runOcrBenchmarkImage does.
export async function runOcrBenchmarkParser(split: OcrBenchmarkPublicSplit): Promise<OcrBenchmarkReport> {
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
export async function runOcrBenchmarkImage(split: OcrBenchmarkPublicSplit, onProgress?: (completed: number, total: number) => void): Promise<OcrBenchmarkReport> {
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
