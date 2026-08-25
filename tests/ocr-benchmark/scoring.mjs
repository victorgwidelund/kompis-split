// Re-exports the canonical scoring implementation from src/ocr-benchmark.ts (compiled to
// dist/ocr-benchmark.js, the same module the in-app admin OCR-benchmark panel uses) so this CLI tool
// and the in-app panel can never silently disagree about how a prediction is scored against ground
// truth. Run `pnpm build:server` before using this file directly if dist/ is stale.
export { scoreOcrFixture as scoreFixture, aggregateOcrScores as aggregate } from "../../dist/ocr-benchmark.js";

export function groupBy(scores, key) {
  const groups = new Map();
  for (const score of scores) {
    const groupKey = score[key];
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(score);
  }
  return groups;
}
