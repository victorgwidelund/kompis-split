// Client-side receipt image optimization. No new dependency: relies on the browser's own
// createImageBitmap (EXIF-aware decode) and canvas re-encode. Backend re-normalizes every image
// with Sharp regardless (see src/receipt-ocr.ts normalizeReceiptImage) — this step exists purely to
// keep uploads fast on mobile networks and avoid asking the user to resize photos manually.

// Must stay well above what compression should normally produce; only reached when a browser can't
// or won't compress (very old browser, or the image failed to decode) and the original is used as-is.
export const maxOriginalReceiptBytes = 50 * 1024 * 1024;
// Must match src/server.ts receiptMaximumBytes — the hard backend cap on the actual request body.
export const maxUploadReceiptBytes = 20 * 1024 * 1024;

const targetLongEdgePx = 3200;
const proactiveRecompressBytes = 4 * 1024 * 1024;
const jpegQuality = 0.85;

export function isHeicFile(file: File): boolean {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return type === "image/heic" || type === "image/heif" || /\.(heic|heif)$/.test(name);
}

export function validateOriginalReceiptFile(file: File): string {
  if (isHeicFile(file)) return "HEIC-bilder stöds inte direkt. Byt kamerans bildformat till \"Mest kompatibelt\" (Inställningar → Kamera → Format på iPhone) eller välj bilden via Dela → Spara som JPEG, och försök igen.";
  if (file.size > maxOriginalReceiptBytes) return `Bilden är för stor (max ${Math.round(maxOriginalReceiptBytes / 1024 / 1024)} MB). Ta ett nytt foto eller välj en mindre bild.`;
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return "Välj en JPG-, PNG- eller WebP-bild.";
  return "";
}

/**
 * Resizes/recompresses oversized or inefficiently-encoded photos client-side before upload.
 * Falls back to the original file whenever decoding isn't possible or compression wouldn't help —
 * the backend validates and re-normalizes every image regardless, so this is a best-effort optimization,
 * never the only safeguard.
 */
export async function prepareReceiptFile(file: File, onStatus?: (status: string) => void): Promise<File> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return file;
  if (typeof createImageBitmap !== "function") return file;
  onStatus?.("Förbereder bild…");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;
  }
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    const needsResize = longEdge > targetLongEdgePx;
    const needsRecompress = needsResize || file.size > proactiveRecompressBytes;
    if (!needsRecompress) return file;
    onStatus?.("Komprimerar kvitto…");
    const scale = needsResize ? targetLongEdgePx / longEdge : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", jpegQuality));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], `${file.name.replace(/\.\w+$/, "")}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  } finally {
    bitmap.close();
  }
}
