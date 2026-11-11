// Only the per-person öre amounts are stored, not the percentages/weights someone typed in, so the
// edit dialog rebuilds them from the amounts. A rebuilt value is only used if re-saving it would
// reproduce the stored öre exactly -- opening and saving an expense must never move an öre.
type Share = { participantId: number; amountCents: number };

// Mirrors allocateByWeights in src/split.ts, used here purely to check the round trip.
function allocate(totalCents: number, weights: number[]): number[] {
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const raw = weights.map((weight) => (totalCents * weight) / totalWeight);
  const result = raw.map(Math.floor);
  const remainder = totalCents - result.reduce((sum, value) => sum + value, 0);
  const order = raw.map((value, index) => ({ index, fraction: value - Math.floor(value) })).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let index = 0; index < remainder; index += 1) result[order[index]!.index]! += 1;
  return result;
}

const formatInput = (value: number) => String(Number(value.toFixed(4))).replace(".", ",");
const parsed = (values: number[]) => values.map((value) => Number(formatInput(value).replace(",", ".")));
const reproduces = (totalCents: number, values: number[], amounts: number[]) => {
  const weights = parsed(values);
  return weights.reduce((sum, value) => sum + value, 0) > 0 && allocate(totalCents, weights).every((amount, index) => amount === amounts[index]);
};

function percentages(totalCents: number, amounts: number[], decimals: number): number[] {
  const scale = 10 ** decimals; const target = 100 * scale;
  const units = amounts.map((amount) => Math.round((amount * target) / totalCents));
  units[units.length - 1]! += target - units.reduce((sum, value) => sum + value, 0);
  return units.map((unit) => unit / scale);
}

const gcd = (left: number, right: number): number => (right === 0 ? left : gcd(right, left % right));

// Returns the mode to open in plus the per-person field values. In the rare case a percentage split
// can't be rebuilt exactly, it opens as "exact" with the stored kronor instead -- lossless, and never
// kronor shown under a percentage heading.
export function splitInputsFromShares(mode: string, totalCents: number, shares: Share[]): { mode: string; values: Record<number, string> } {
  const amounts = shares.map((share) => share.amountCents);
  let rebuilt: number[] | null = null;
  if (totalCents > 0 && mode === "percentage") {
    rebuilt = [2, 4].map((decimals) => percentages(totalCents, amounts, decimals)).find((candidate) => reproduces(totalCents, candidate, amounts)) ?? null;
  } else if (totalCents > 0 && mode === "shares") {
    const smallest = Math.min(...amounts.filter((amount) => amount > 0));
    const ratios = amounts.map((amount) => Math.round((amount / smallest) * 100) / 100);
    const divisor = amounts.reduce((current, amount) => gcd(current, amount), 0) || 1;
    rebuilt = reproduces(totalCents, ratios, amounts) ? ratios : amounts.map((amount) => amount / divisor);
  }
  const values: Record<number, string> = {};
  shares.forEach((share, index) => { values[share.participantId] = rebuilt ? formatInput(rebuilt[index]!) : (share.amountCents / 100).toFixed(2).replace(".", ","); });
  return { mode: !rebuilt && (mode === "percentage" || mode === "shares") ? "exact" : mode, values };
}
