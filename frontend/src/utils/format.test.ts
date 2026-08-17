import { describe, expect, it } from "vitest";
import { formatMoney, initials, kronorToOre, shortVersion } from "./format";

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

describe("initialer för avatarer", () => {
  it("tar första bokstaven i de två första orden", () => {
    expect(initials("Anna Svensson")).toBe("AS");
    expect(initials("Erik")).toBe("E");
  });

  it("hoppar över ledande skiljetecken istället för att visa dem som en initial", () => {
    // A guest-typed name can start with a dash, quote, or emoji -- part[0] would have picked
    // that up literally instead of the person's actual first letter.
    expect(initials("-Anna Svensson")).toBe("AS");
    expect(initials("'Erik Karlsson")).toBe("EK");
    expect(initials("(Test) Persson")).toBe("TP");
  });

  it("hanterar extra mellanslag och saknat namn", () => {
    expect(initials("  Anna   Svensson  ")).toBe("AS");
    expect(initials("")).toBe("?");
    expect(initials(undefined as unknown as string)).toBe("?");
  });
});
