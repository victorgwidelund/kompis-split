import type { OcrAiStatus } from "../../types/models";
import { validateOriginalReceiptFile } from "./imagePrep";

export const acceptedReceiptImages = ["image/jpeg", "image/png", "image/webp"];

export function validateReceiptImage(file: File): string {
  return validateOriginalReceiptFile(file);
}

export function receiptAiStatus(ai?: OcrAiStatus): string {
  if (!ai) return "";
  const seconds = Number.isFinite(ai.durationMs) ? ` (${Math.max(0.1, Number(ai.durationMs) / 1000).toFixed(1)} s)` : "";
  if (ai.status === "ok") return ` AI användes${seconds}${ai.retried ? " och gjorde en extra kontroll" : ""}.`;
  if (ai.status === "unstructured") return ` AI svarade${seconds}, men svaret behövde reservtolkas.`;
  if (ai.status === "cancelled_local_complete") return ` Snabb OCR summerade exakt${seconds}, så AI-körningen avbröts.`;
  if (ai.status === "timeout") return ` AI nådde tidsgränsen${seconds}; reserv-OCR användes.`;
  if (ai.status === "token_limit") return ` AI nådde sin svarsgräns${seconds}; reserv-OCR användes.`;
  if (ai.status === "disabled") return " AI är inte konfigurerad; reserv-OCR användes.";
  if (ai.status === "connection_error") return ` Appen fick ingen kontakt med AI-tjänsten${seconds}; reserv-OCR användes.`;
  return ` AI kunde inte användas (${ai.status}${seconds}); reserv-OCR användes.`;
}
