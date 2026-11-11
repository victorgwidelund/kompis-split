import { describe, expect, it } from "vitest";
import { isBajen, isBeer, isBeerTab, makeRainDrops } from "./easterEggs";

describe("easter eggs", () => {
  it("recognises Bajen names, case-insensitively", () => {
    expect(["Bajen borta", "HAMMARBY IF", "Helg på Södermalm"].every(isBajen)).toBe(true);
    expect(isBajen("Sälenresan")).toBe(false);
  });

  it("calls it a beer tab only when at least half of two or more rows are beer", () => {
    expect(isBeer("Norrlands Guld 50cl")).toBe(false);
    expect(isBeerTab(["Mariestad öl", "TT Eko Lager", "Pommes"])).toBe(true);
    expect(isBeerTab(["Mariestad öl", "Pommes", "Burgare"])).toBe(false);
    expect(isBeerTab(["Mariestad öl"])).toBe(false);
  });

  it("makes the requested number of rain drops from the given pieces", () => {
    const drops = makeRainDrops(["💚", "🤍"], 6);
    expect(drops).toHaveLength(6);
    expect(new Set(drops.map((drop) => drop.piece))).toEqual(new Set(["💚", "🤍"]));
    expect(drops.every((drop) => drop.left >= 0 && drop.left <= 100)).toBe(true);
  });
});
