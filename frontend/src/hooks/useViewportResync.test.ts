import { describe, expect, it } from "vitest";
import { needsViewportResync } from "./useViewportResync";

describe("needsViewportResync", () => {
  it("corrects a viewport offset left behind after the keyboard closed", () => {
    expect(needsViewportResync(337, 1, false)).toBe(true);
  });

  it("leaves the keyboard, pinch-zoom and an aligned viewport alone", () => {
    expect(needsViewportResync(337, 1, true)).toBe(false);
    expect(needsViewportResync(337, 1.8, false)).toBe(false);
    expect(needsViewportResync(0, 1, false)).toBe(false);
    expect(needsViewportResync(0.5, 1, false)).toBe(false);
  });
});
