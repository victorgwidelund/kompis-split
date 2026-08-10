import test from "node:test";
import assert from "node:assert/strict";
import { allocateByWeights, calculateShares, simplifyDebts } from "../src/split.mjs";

test("equal splits preserve every öre", () => {
  assert.deepEqual(allocateByWeights(10000, [1, 1, 1]), [3334, 3333, 3333]);
});

test("percentage and exact splits validate totals", () => {
  assert.deepEqual(calculateShares(50000, "percentage", [{ value: 60 }, { value: 40 }]), [30000, 20000]);
  assert.deepEqual(calculateShares(50000, "exact", [{ value: 125 }, { value: 375 }]), [12500, 37500]);
  assert.throws(() => calculateShares(50000, "percentage", [{ value: 50 }, { value: 40 }]), /100/);
});

test("settlements account for expenses and recorded payments", () => {
  const people = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const expenses = [{
    payerId: 1,
    amountCents: 90000,
    shares: people.map((person) => ({ participantId: person.id, amountCents: 30000 })),
  }];
  const result = simplifyDebts(people, expenses);
  assert.deepEqual(result.settlements, [
    { fromId: 2, toId: 1, amountCents: 30000 },
    { fromId: 3, toId: 1, amountCents: 30000 },
  ]);
  const afterPayment = simplifyDebts(people, expenses, [{ fromId: 2, toId: 1, amountCents: 30000 }]);
  assert.deepEqual(afterPayment.settlements, [{ fromId: 3, toId: 1, amountCents: 30000 }]);
});
