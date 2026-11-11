import type { OcrAiStatus } from "../../types/models";
import { validateOriginalReceiptFile } from "./imagePrep";

export const acceptedReceiptImages = ["image/jpeg", "image/png", "image/webp"];

export function validateReceiptImage(file: File): string {
  return validateOriginalReceiptFile(file);
}

// Long enough for the slow Tesseract fallback (up to ~20 s on a real photo) plus an upload over mobile data.
export const receiptScanTimeoutMs = 45_000;

// Times out by aborting the scan's own controller and remembering that it did, instead of combining
// signals with AbortSignal.any() and inspecting the error name: iOS Safari surfaces that abort as a
// generic "Fetch is aborted" error, so the name check failed and users saw the raw message.
export function scanTimeout(controller: AbortController, ms = receiptScanTimeoutMs) {
  let expired = false;
  const timer = setTimeout(() => { expired = true; controller.abort(); }, ms);
  return { expired: () => expired, clear: () => clearTimeout(timer) };
}

export function scanFailureMessage(caught: unknown, timedOut: boolean): string {
  if (timedOut) return "Kvittoanalysen tog för lång tid.";
  if (caught instanceof TypeError || (caught instanceof Error && caught.name === "AbortError")) return "Kvittot kunde inte skickas – kontrollera uppkopplingen.";
  return caught instanceof Error ? caught.message : "Kvittot kunde inte läsas.";
}

export function receiptAiStatus(ai?: OcrAiStatus): string {
  if (!ai) return "";
  const seconds = Number.isFinite(ai.durationMs) ? ` (${Math.max(0.1, Number(ai.durationMs) / 1000).toFixed(1)} s)` : "";
  if (ai.status === "ok") return ` Den lokala OCR-tjänsten användes${seconds}.`;
  if (ai.status === "unstructured") return ` OCR-svaret${seconds} behövde reservtolkas.`;
  if (ai.status === "cancelled_local_complete") return ` Den snabba lokala tolkningen summerade exakt${seconds}.`;
  if (ai.status === "timeout") return ` OCR-tjänsten nådde tidsgränsen${seconds}; lokal reserv-OCR användes.`;
  if (ai.status === "token_limit") return ` Den äldre modelltjänsten nådde sin svarsgräns${seconds}; lokal reserv-OCR användes.`;
  if (ai.status === "disabled") return " OCR-tjänsten är inte konfigurerad; lokal reserv-OCR användes.";
  if (ai.status === "connection_error") return ` Appen fick ingen kontakt med OCR-tjänsten${seconds}; lokal reserv-OCR användes.`;
  return ` OCR-tjänsten kunde inte användas (${ai.status}${seconds}); lokal reserv-OCR användes.`;
}
