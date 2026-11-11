import { afterEach, describe, expect, it, vi } from "vitest";
import { scanFailureMessage, scanTimeout } from "./ocr";

afterEach(() => { vi.useRealTimers(); });

describe("receipt scan timeout", () => {
  it("aborts the scan and reports it as a timeout, whatever the browser calls the error", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const timeout = scanTimeout(controller, 45_000);
    vi.advanceTimersByTime(44_999);
    expect(controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(controller.signal.aborted).toBe(true);
    expect(timeout.expired()).toBe(true);
    // iOS Safari: a plain Error named AbortError with the message "Fetch is aborted".
    const safari = Object.assign(new Error("Fetch is aborted"), { name: "AbortError" });
    expect(scanFailureMessage(safari, timeout.expired())).toBe("Kvittoanalysen tog för lång tid.");
  });

  it("does not fire once cleared", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const timeout = scanTimeout(controller, 1_000);
    timeout.clear();
    vi.advanceTimersByTime(5_000);
    expect(controller.signal.aborted).toBe(false);
    expect(timeout.expired()).toBe(false);
  });

  it("never shows a raw network error, but keeps the server's own explanation", () => {
    expect(scanFailureMessage(new TypeError("Load failed"), false)).toBe("Kvittot kunde inte skickas – kontrollera uppkopplingen.");
    expect(scanFailureMessage(Object.assign(new Error("Fetch is aborted"), { name: "AbortError" }), false)).toBe("Kvittot kunde inte skickas – kontrollera uppkopplingen.");
    expect(scanFailureMessage(new Error("För många kvittoanalyser. Vänta en stund och försök igen."), false)).toBe("För många kvittoanalyser. Vänta en stund och försök igen.");
  });
});
