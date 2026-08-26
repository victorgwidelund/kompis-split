import type { OcrAiStatus } from "../../types/models";
import { validateOriginalReceiptFile } from "./imagePrep";

export const acceptedReceiptImages = ["image/jpeg", "image/png", "image/webp"];

export function validateReceiptImage(file: File): string {
  return validateOriginalReceiptFile(file);
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
