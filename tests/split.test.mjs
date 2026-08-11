import test from "node:test";
import assert from "node:assert/strict";
import { allocateByWeights, allocateItemQuantities, calculateShares, simplifyDebts } from "../dist/split.js";

test("equal splits preserve every öre", () => {
  assert.deepEqual(allocateByWeights(10000, [1, 1, 1]), [3334, 3333, 3333]);
});

test("weighted allocations always conserve the original amount", () => {
  for (let total = 0; total <= 1_000; total += 17) {
    for (const weights of [[1], [1, 1], [1, 2, 3], [0, 5, 0, 7]]) {
      const shares = allocateByWeights(total, weights);
      assert.equal(shares.reduce((sum, amount) => sum + amount, 0), total);
      assert.ok(shares.every(Number.isInteger));
      assert.ok(shares.every((amount) => amount >= 0));
    }
  }
});

test("quick-tab quantities conserve öre and use stable viewer keys", () => {
  assert.deepEqual(allocateItemQuantities(10001, 2, [
    { key: "u:2", quantity: 1 }, { key: "u:1", quantity: 1 },
  ]), {
    claimedQuantity: 2,
    claimedCents: 10001,
    shares: [
      { key: "u:1", quantity: 1, amountCents: 5001 },
      { key: "u:2", quantity: 1, amountCents: 5000 },
    ],
  });
  assert.deepEqual(allocateItemQuantities(10001, 3, [{ key: "g:4", quantity: 1 }]), {
    claimedQuantity: 1,
    claimedCents: 3334,
    shares: [{ key: "g:4", quantity: 1, amountCents: 3334 }],
  });
  assert.throws(() => allocateItemQuantities(54000, 6, [{ key: "u:1", quantity: 7 }]), /invalid/);
});

test("equal balances use stable participant IDs", () => {
  const participants = [{ id: 3 }, { id: 1 }, { id: 2 }];
  const expenses = [{ payerId: 3, amountCents: 300, shares: participants.map((participant) => ({ participantId: participant.id, amountCents: 100 })) }];
  assert.deepEqual(simplifyDebts(participants, expenses).settlements, [
    { fromId: 1, toId: 3, amountCents: 100 },
    { fromId: 2, toId: 3, amountCents: 100 },
  ]);
});

test("invalid weights are rejected", () => {
  assert.throws(() => allocateByWeights(100, []), /participant/);
  assert.throws(() => allocateByWeights(100, [0, 0]), /positive/);
  assert.throws(() => allocateByWeights(100, [1, -1]), /non-negative/);
  assert.throws(() => allocateByWeights(1.5, [1]), /non-negative number of cents/);
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
