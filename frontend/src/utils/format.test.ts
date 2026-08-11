import { describe, expect, it } from "vitest";
import { formatMoney, kronorToOre, shortVersion } from "./format";

describe("frontendens pengahantering", () => {
  it("konverterar kronor till heltalsöre utan flyttalsrester", () => {
    expect(kronorToOre("1312.00")).toBe(131_200);
    expect(kronorToOre("0,10")).toBe(10);
  });

  it("visar heltalsöre som svenska kronor", () => {
    expect(formatMoney(13_120)).toContain("131,20");
  });

  it("förkortar versionsetiketter", () => {
    expect(shortVersion("sha-1234567890abcdef")).toBe("sha-1234567");
    expect(shortVersion("v1.13.0")).toBe("1.13.0");
  });
});
