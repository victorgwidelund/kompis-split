import { describe, expect, it } from "vitest";
import { splitInputsFromShares } from "./splitInputs";

const shares = (...amounts: number[]) => amounts.map((amountCents, index) => ({ participantId: index + 1, amountCents }));

describe("splitInputsFromShares", () => {
  it("shows the percentages someone typed, not kronor (bug report #11)", () => {
    expect(splitInputsFromShares("percentage", 93400, shares(28020, 18680, 18680, 28020))).toEqual({ mode: "percentage", values: { 1: "30", 2: "20", 3: "20", 4: "30" } });
  });

  it("rebuilds uneven percentages that sum to exactly 100", () => {
    expect(splitInputsFromShares("percentage", 10000, shares(3333, 3333, 3334)).values).toEqual({ 1: "33,33", 2: "33,33", 3: "33,34" });
  });

  it("rebuilds share weights, including a remainder öre", () => {
    expect(splitInputsFromShares("shares", 1000, shares(500, 250, 250)).values).toEqual({ 1: "2", 2: "1", 3: "1" });
    expect(splitInputsFromShares("shares", 1000, shares(334, 333, 333)).values).toEqual({ 1: "1", 2: "1", 3: "1" });
  });

  it("keeps exact amounts in kronor", () => {
    expect(splitInputsFromShares("exact", 12001, shares(6001, 6000))).toEqual({ mode: "exact", values: { 1: "60,01", 2: "60,00" } });
  });

  it("falls back to exact kronor rather than showing a percentage that would move an öre", () => {
    // Found by search: no 2- or 4-decimal percentages reproduce this split of a very large total.
    expect(splitInputsFromShares("percentage", 82268116, shares(66789428, 3661600, 11817088))).toEqual({ mode: "exact", values: { 1: "667894,28", 2: "36616,00", 3: "118170,88" } });
  });
});
