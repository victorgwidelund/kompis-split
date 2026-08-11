export function allocateByWeights(totalCents: number, weights: number[]): number[] {
  if (!Number.isInteger(totalCents) || totalCents < 0) throw new Error("Amount must be a non-negative number of cents");
  if (!Array.isArray(weights) || weights.length === 0) throw new Error("At least one participant is required");
  if (weights.some((weight) => !Number.isFinite(weight) || weight < 0)) throw new Error("Weights must be non-negative numbers");
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  if (totalWeight <= 0) throw new Error("At least one weight must be positive");

  const raw = weights.map((weight) => (totalCents * weight) / totalWeight);
  const result = raw.map(Math.floor);
  let remainder = totalCents - result.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (let index = 0; index < remainder; index += 1) {
    const target = order[index]!.index;
    result[target] = result[target]! + 1;
  }
  return result;
}

export function calculateShares(totalCents: number, mode: string, entries: Array<{ value: unknown }>): number[] {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("Choose at least one participant");
  if (mode === "equal") return allocateByWeights(totalCents, entries.map(() => 1));
  if (mode === "shares") return allocateByWeights(totalCents, entries.map((entry) => Number(entry.value)));
  if (mode === "percentage") {
    const percentages = entries.map((entry) => Number(entry.value));
    const total = percentages.reduce((sum, value) => sum + value, 0);
    if (Math.abs(total - 100) > 0.001) throw new Error("Percentages must add up to 100");
    return allocateByWeights(totalCents, percentages);
  }
  if (mode === "exact") {
    const shares = entries.map((entry) => Math.round(Number(entry.value) * 100));
    if (shares.some((share) => !Number.isInteger(share) || share < 0)) throw new Error("Exact amounts must be valid and non-negative");
    if (shares.reduce((sum, value) => sum + value, 0) !== totalCents) throw new Error("Exact amounts must equal the expense total");
    return shares;
  }
  throw new Error("Unknown split mode");
}

type Participant = { id: number };
type Expense = { payerId: number; amountCents: number; shares: Array<{ participantId: number; amountCents: number }> };
type Payment = { fromId: number; toId: number; amountCents: number };

export function simplifyDebts(participants: Participant[], expenses: Expense[], payments: Payment[] = []) {
  const balances = new Map(participants.map((participant) => [participant.id, 0]));
  for (const expense of expenses) {
    balances.set(expense.payerId, (balances.get(expense.payerId) || 0) + expense.amountCents);
    for (const share of expense.shares) {
      balances.set(share.participantId, (balances.get(share.participantId) || 0) - share.amountCents);
    }
  }
  for (const payment of payments) {
    balances.set(payment.fromId, (balances.get(payment.fromId) || 0) + payment.amountCents);
    balances.set(payment.toId, (balances.get(payment.toId) || 0) - payment.amountCents);
  }

  const debtors = [];
  const creditors = [];
  for (const [id, balance] of balances) {
    if (balance < 0) debtors.push({ id, amount: -balance });
    if (balance > 0) creditors.push({ id, amount: balance });
  }
  debtors.sort((a, b) => b.amount - a.amount || a.id - b.id);
  creditors.sort((a, b) => b.amount - a.amount || a.id - b.id);

  const settlements = [];
  let debtorIndex = 0;
  let creditorIndex = 0;
  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex]!;
    const creditor = creditors[creditorIndex]!;
    const amountCents = Math.min(debtor.amount, creditor.amount);
    if (amountCents > 0) settlements.push({ fromId: debtor.id, toId: creditor.id, amountCents });
    debtor.amount -= amountCents;
    creditor.amount -= amountCents;
    if (debtor.amount === 0) debtorIndex += 1;
    if (creditor.amount === 0) creditorIndex += 1;
  }
  return { balances: Object.fromEntries(balances), settlements };
}
