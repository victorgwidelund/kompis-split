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

test("named financial edge cases conserve the total exactly and assign remainders deterministically", () => {
  assert.deepEqual(allocateByWeights(1, [1, 1, 1]), [1, 0, 0]);
  assert.deepEqual(allocateByWeights(2, [1, 1, 1]), [1, 1, 0]);
  assert.deepEqual(allocateByWeights(10000, [1, 1, 1]), [3334, 3333, 3333]);
  assert.deepEqual(allocateByWeights(0, [1, 1]), [0, 0]);
  assert.deepEqual(allocateByWeights(999999999, [1]), [999999999]);
  assert.deepEqual(allocateByWeights(100, Array.from({ length: 37 }, () => 1)).reduce((sum, value) => sum + value, 0), 100);
  // Splitting the same amount the same way twice must produce the same remainder assignment every time.
  assert.deepEqual(allocateByWeights(10, [1, 1, 1]), allocateByWeights(10, [1, 1, 1]));
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

test("Swedish comma-decimal values are accepted identically to period-decimal values", () => {
  // The frontend's split-value fields are plain text inputs (not type="number", which silently
  // rejects a comma), so a real request can carry "33,33" here -- this must parse the same as "33.33".
  assert.deepEqual(calculateShares(50000, "percentage", [{ value: "60" }, { value: "40" }]), calculateShares(50000, "percentage", [{ value: "60,0" }, { value: "40,0" }]));
  assert.deepEqual(calculateShares(50000, "exact", [{ value: "125,00" }, { value: "375" }]), [12500, 37500]);
  assert.deepEqual(calculateShares(90000, "shares", [{ value: "1,5" }, { value: "1" }]), calculateShares(90000, "shares", [{ value: 1.5 }, { value: 1 }]));
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
