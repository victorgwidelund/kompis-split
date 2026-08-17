// Pure scoring functions for the OCR benchmark: matching predicted items to ground truth, and turning
// per-fixture results into aggregate metrics. No I/O, no OCR calls -- kept separate from run-benchmark.mjs
// so the matching/aggregation logic itself stays easy to reason about and could be unit tested directly.
import { namesSimilar } from "../../dist/receipt-ocr.js";

export function amountToOre(amount) {
  if (amount === null || amount === undefined) return null;
  const value = Math.round(Number(amount) * 100);
  return Number.isFinite(value) ? value : null;
}

// Greedy bipartite match: for each ground-truth item (in order), take the best still-unused predicted
// item whose name is similar enough. Quantity/price are deliberately NOT part of the matching criterion
// -- getting the quantity or price wrong on an otherwise-correctly-identified row should show up as a
// quantity/price error, not also count as a missed item (that would double-penalize the same mistake
// and make item-level F1 uninformative).
export function matchItems(predicted, truth) {
  const usedPredIndexes = new Set();
  const matches = [];
  const unmatchedTruth = [];
  for (const truthItem of truth) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    predicted.forEach((predItem, index) => {
      if (usedPredIndexes.has(index)) return;
      if (!namesSimilar(predItem.name, truthItem.name)) return;
      const distance = Math.abs(predItem.name.length - truthItem.name.length);
      if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
    });
    if (bestIndex >= 0) { usedPredIndexes.add(bestIndex); matches.push({ pred: predicted[bestIndex], truth: truthItem }); }
    else unmatchedTruth.push(truthItem);
  }
  const unmatchedPred = predicted.filter((_, index) => !usedPredIndexes.has(index));
  return { matches, unmatchedTruth, unmatchedPred };
}

function normalizeForCompare(text) {
  return String(text || "").toLocaleLowerCase("sv-SE").trim();
}

function fuzzyTextMatch(a, b) {
  const left = normalizeForCompare(a); const right = normalizeForCompare(b);
  if (!left || !right) return left === right;
  if (left === right) return true;
  const longer = Math.max(left.length, right.length);
  let distance = 0;
  const shorter = left.length < right.length ? left : right;
  const other = left.length < right.length ? right : left;
  for (let index = 0; index < other.length; index += 1) if (other[index] !== shorter[index]) distance += 1;
  return distance / longer <= 0.15;
}

export function scoreFixture(groundTruth, prediction, timingMs) {
  const predictedItems = prediction.items || [];
  const truthItems = groundTruth.items || [];
  const { matches, unmatchedTruth, unmatchedPred } = matchItems(predictedItems, truthItems);

  const priceCorrect = matches.filter((pair) => amountToOre(pair.pred.amount) === pair.truth.totalOre).length;
  const quantityCorrect = matches.filter((pair) => Number(pair.pred.quantity) === pair.truth.quantity).length;
  const nameSimilaritySum = matches.reduce((sum, pair) => {
    const left = normalizeForCompare(pair.pred.name); const right = normalizeForCompare(pair.truth.name);
    const longer = Math.max(left.length, right.length, 1);
    let distance = 0;
    const shorter = left.length < right.length ? left : right; const other = left.length < right.length ? right : left;
    for (let index = 0; index < other.length; index += 1) if (other[index] !== shorter[index]) distance += 1;
    return sum + (1 - distance / longer);
  }, 0);

  const falseMetadataItems = unmatchedPred.filter((item) => (groundTruth.rejectedMetadata || []).some((metadata) => namesSimilar(item.name, metadata) || fuzzyTextMatch(item.name, metadata)));

  const predictedTotalOre = amountToOre(prediction.amount);
  const totalCorrect = predictedTotalOre !== null && predictedTotalOre === groundTruth.totalOre;
  const merchantCorrect = fuzzyTextMatch(prediction.title, groundTruth.merchant);
  const dateCorrect = prediction.expenseDate === groundTruth.date;

  const predictedItemSum = predictedItems.reduce((sum, item) => sum + (amountToOre(item.amount) || 0), 0);
  const selfConsistent = predictedTotalOre !== null && predictedItemSum === predictedTotalOre;
  // Matches the app's own balancedPass()/needsReview logic exactly (see src/receipt-ocr.ts): a real,
  // uncaptured discount legitimately makes the item sum miss the total, and the app *intentionally*
  // flags that for user review rather than pretending it reconciles (see README's "difference... shown
  // as unallocated"). So this metric is expected to be false whenever a fixture has a discount, even on
  // a perfect parse -- that's the product working as designed, not an extraction bug. reconciledAfterKnownAdjustments
  // below is the metric that actually tells the two apart.
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

export function aggregate(scores) {
  if (!scores.length) return null;
  const sum = (getter) => scores.reduce((total, score) => total + getter(score), 0);
  const truthItemTotal = sum((s) => s.truthItemCount);
  const predictedItemTotal = sum((s) => s.predictedItemCount);
  const matchedTotal = sum((s) => s.matchedCount);
  const precision = predictedItemTotal ? matchedTotal / predictedItemTotal : 1;
  const recall = truthItemTotal ? matchedTotal / truthItemTotal : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const timings = scores.map((s) => s.timingMs).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const percentile = (fraction) => timings.length ? timings[Math.min(timings.length - 1, Math.floor(timings.length * fraction))] : null;
  return {
    receiptCount: scores.length,
    merchantAccuracy: sum((s) => (s.merchantCorrect ? 1 : 0)) / scores.length,
    dateAccuracy: sum((s) => (s.dateCorrect ? 1 : 0)) / scores.length,
    totalAccuracy: sum((s) => (s.totalCorrect ? 1 : 0)) / scores.length,
    itemPrecision: precision,
    itemRecall: recall,
    itemF1: f1,
    nameSimilarity: matchedTotal ? sum((s) => s.nameSimilaritySum) / matchedTotal : null,
    priceAccuracy: truthItemTotal ? sum((s) => s.priceCorrect) / truthItemTotal : null,
    quantityAccuracy: truthItemTotal ? sum((s) => s.quantityCorrect) / truthItemTotal : null,
    exactReconciliation: sum((s) => (s.financiallyReconciled ? 1 : 0)) / scores.length,
    reconciledAfterKnownAdjustments: sum((s) => (s.reconciledAfterKnownAdjustments ? 1 : 0)) / scores.length,
    selfConsistencyRate: sum((s) => (s.selfConsistent ? 1 : 0)) / scores.length,
    falseMetadataItemsTotal: sum((s) => s.falseMetadataItemCount),
    receiptsNeedingReview: sum((s) => (s.financiallyReconciled ? 0 : 1)),
    medianMs: percentile(0.5),
    p90Ms: percentile(0.9),
    p95Ms: percentile(0.95),
  };
}

export function groupBy(scores, key) {
  const groups = new Map();
  for (const score of scores) {
    const groupKey = score[key];
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(score);
  }
  return groups;
}
