import { createRequire } from "node:module";
import sharp from "sharp";
import { createWorker, OEM, PSM, type Worker } from "tesseract.js";

const require = createRequire(import.meta.url);
const swedishLanguage = require("@tesseract.js-data/swe") as { langPath: string; gzip: boolean };
const ollamaModel = String(process.env.OLLAMA_MODEL || "glm-ocr:q8_0").trim();
const ollamaUrl = (() => {
  const value = String(process.env.OLLAMA_URL || "").trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href.replace(/\/$/, "") : null;
  } catch { return null; }
})();

export type ReceiptSuggestion = {
  title: string | null;
  amount: string | null;
  expenseDate: string | null;
  category: "food" | "travel" | "stay" | "fun" | "other";
  items: Array<{ name: string; quantity: number; amount: string }>;
};

const ignoredMerchantWords = /^(kassa)?kvitto$|^välkommen|^tack för|^org\.?\s*nr|^datum|^tid|^tel|^telefon|^www\.|^moms|^total|^summa|^att betala|^butik\s*nr|^[^\s]*örhandsvisning|tillbaka/i;
const totalWords = /att\s+betala|betalt|kortbelopp|belopp\s+sek|totalt?|f[öo]tatt|summa/i;
const excludedTotalWords = /moms|vat|växel|change|rabatt|subtotal|delsumma/i;

type ReceiptPass = { text: string; confidence: number; suggestion: ReceiptSuggestion };

function normalizeNumericGlyphs(line: string) {
  return line
    .replace(/(\d)\s+([.,])\s*(\d{2})(?!\d)/g, "$1$2$3")
    .replace(/(\d)([.,])\s+(\d{2})(?!\d)/g, "$1$2$3")
    .replace(/(\d{1,5})\s+(\d{2})(?=\s*(?:kr|sek)?$)/i, "$1.$2")
    .replace(/(?<!\d)(\d{3,5})(?=\s*(?:kr|sek)?$)/i, (value) => `${value.slice(0, -2)}.${value.slice(-2)}`)
    .replace(/(?<![A-Za-zÅÄÖåäö])[\dOo]{1,8}[.,][\dOo]{2}(?![A-Za-zÅÄÖåäö])/g, (value) => value.replace(/[Oo]/g, "0"));
}

function normalizedLines(text: string) {
  return text.split(/\r?\n/).map((line) => line
    .replace(/\s*[|¦]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()).map(normalizeNumericGlyphs).filter(Boolean);
}

function parseMoney(value: string) {
  const compact = value.replace(/\s/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  const amount = Number(compact);
  return Number.isFinite(amount) && amount > 0 && amount <= 10_000_000 ? amount : null;
}

function amountCandidates(line: string) {
  return [...line.matchAll(/(?<!\d)(\d{1,3}(?:[ .]\d{3})*|\d+)[,.](\d{2})(?!\d)/g)]
    .map((match) => parseMoney(`${match[1]}.${match[2]}`)).filter((amount): amount is number => amount !== null);
}

function validIsoDate(year: number, month: number, day: number, now: Date) {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null;
  if (candidate.getTime() > now.getTime() + 86400000 || year < now.getUTCFullYear() - 20) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function receiptDate(lines: string[], now: Date) {
  const monthNumbers: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, maj: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12 };
  for (const line of lines) {
    const iso = line.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
    if (iso) {
      const value = validIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]), now);
      if (value) return value;
    }
    const european = line.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})\b/);
    if (european) {
      const value = validIsoDate(Number(european[3]), Number(european[2]), Number(european[1]), now);
      if (value) return value;
    }
    const swedish = line.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec)[a-z]*\s+(\d{2}|20\d{2})\b/i);
    if (swedish) {
      const shortYear = Number(swedish[3]!);
      const year = shortYear < 100 ? 2000 + shortYear : shortYear;
      const month = monthNumbers[swedish[2]!.slice(0, 3).toLowerCase()]!;
      const value = validIsoDate(year, month, Number(swedish[1]!), now);
      if (value) return value;
    }
  }
  return null;
}

function merchantName(lines: string[]) {
  for (const line of lines.slice(0, 14)) {
    if (line.length < 2 || line.length > 60 || ignoredMerchantWords.test(line)) continue;
    if (amountCandidates(line).length) continue;
    const letters = (line.match(/[A-Za-zÅÄÖåäö]/g) || []).length;
    const digits = (line.match(/\d/g) || []).length;
    if (letters < 3 || digits > letters) continue;
    return line.replace(/^[^A-Za-zÅÄÖåäö]+|[^A-Za-zÅÄÖåäö0-9)&'. -]+$/g, "").slice(0, 60) || null;
  }
  return null;
}

function receiptTotal(lines: string[]) {
  const prioritized: number[] = [];
  const fallback: number[] = [];
  for (const line of lines) {
    const amounts = amountCandidates(line);
    if (!amounts.length) continue;
    fallback.push(...amounts);
    if (totalWords.test(line) && !excludedTotalWords.test(line)) prioritized.push(...amounts);
  }
  const candidates = prioritized.length ? prioritized : fallback;
  return candidates.length ? Math.max(...candidates) : null;
}

function receiptItems(lines: string[]) {
  const items: Array<{ name: string; quantity: number; amount: string }> = [];
  const itemLines: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const next = lines[index + 1] || "";
    const hasProductText = (line.match(/[A-Za-zÅÄÖåäö]/g) || []).length >= 2;
    const endsWithAmount = /\d[,.]\d{2}\s*(?:kr|sek)?\s*$/i.test(line);
    const nextIsAmount = /^\s*\d{1,6}[,.]\d{2}\s*(?:kr|sek)?\s*$/i.test(next);
    if (hasProductText && !endsWithAmount && nextIsAmount) {
      itemLines.push(`${line} ${next}`);
      index += 1;
    } else itemLines.push(line);
  }
  const seen = new Set<string>();
  for (const line of itemLines) {
    if (totalWords.test(line) || excludedTotalWords.test(line) || /moms|org\.?\s*nr|kort|visa|mastercard|datum|kvitto|summa|subtotal|delsumma|betalt|godkänt|\bköp\b|terminal|kontroll(enhet)?|ctuid|\baid\b|\btvr\b|\bref\.?|\bpsn\b|#\s*\d+|\bstkk\b|\b(?:mån|tis|ons|tor|fre|lör|sön)\b/i.test(line)) continue;
    const amounts = amountCandidates(line);
    if (!amounts.length || !/\d[,.]\d{2}\s*(?:kr|sek)?\s*$/i.test(line)) continue;
    const quantityPattern = /^\s*(?:[A-Za-z]{1,3}\s+)?(\d{1,2})(?:(?:[,.]0{1,2})\s+|\s*[xX*]\s+)/;
    const quantityMatch = line.match(quantityPattern);
    if (!quantityMatch && amounts.length > 1 && /^\s*\d+[,.]\d{2}\b/.test(line)) continue;
    const quantity = Math.min(20, Math.max(1, Number(quantityMatch?.[1] || 1)));
    const amount = amounts.at(-1)!;
    const name = line
      .replace(quantityPattern, "")
      .replace(/\(\s*\d+[,.]\d{2}\s*\)/g, " ")
      .replace(/(?<!\d)(\d{1,3}(?:[ .]\d{3})*|\d+)[,.]\d{2}(?!\d)/g, " ")
      .replace(/\(\s*\)/g, " ")
      .replace(/\b(?:kr|sek|st)\b/gi, " ")
      .replace(/[.·_-]{2,}/g, " ")
      .replace(/\s+/g, " ").trim()
      .replace(/^[^A-Za-zÅÄÖåäö]+|[^A-Za-zÅÄÖåäö0-9)&'. -]+$/g, "")
      .slice(0, 100);
    if ((name.match(/[A-Za-zÅÄÖåäö]/g) || []).length < 2 || amount <= 0) continue;
    const key = `${name.toLocaleLowerCase("sv-SE").replace(/[^a-z0-9åäö]/g, "")}|${quantity}|${amount.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ name, quantity, amount: amount.toFixed(2) });
    if (items.length >= 60) break;
  }
  return items;
}

function suggestedCategory(text: string): ReceiptSuggestion["category"] {
  if (/restaurang|restaurant|café|cafe|espresso|pizza|burger|sushi|mat|livs|ica|coop|willys|hemköp|chips|mandel|heineken|öl|beer|lager|vin|drink|bar\b/i.test(text)) return "food";
  if (/hotell|hotel|hostel|vandrarhem|boende/i.test(text)) return "stay";
  if (/taxi|uber|bolt|sj\b|tåg|buss|biljett|parkering|bensin|diesel/i.test(text)) return "travel";
  if (/bio|cinema|museum|entré|aktivitet|bowling|konsert/i.test(text)) return "fun";
  return "other";
}

export function parseReceiptText(text: string, now = new Date()): ReceiptSuggestion {
  const lines = normalizedLines(text);
  const total = receiptTotal(lines);
  return {
    title: merchantName(lines),
    amount: total === null ? null : total.toFixed(2),
    expenseDate: receiptDate(lines, now),
    category: suggestedCategory(text),
    items: receiptItems(lines),
  };
}

function amountCents(value: string | null) {
  return value === null ? null : Math.round(Number(value) * 100);
}

function itemCents(item: ReceiptSuggestion["items"][number]) {
  return Math.round(Number(item.amount) * 100);
}

function editDistance(first: string, second: string) {
  const previous = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let row = 1; row <= first.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= second.length; column += 1) {
      current[column] = Math.min(
        current[column - 1]! + 1,
        previous[column]! + 1,
        previous[column - 1]! + (first[row - 1] === second[column - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[second.length]!;
}

function normalizedItemName(value: string) {
  return value.toLocaleLowerCase("sv-SE").replace(/[^a-z0-9åäö]/g, "");
}

function sameItem(first: ReceiptSuggestion["items"][number], second: ReceiptSuggestion["items"][number]) {
  if (first.quantity !== second.quantity || itemCents(first) !== itemCents(second)) return false;
  const left = normalizedItemName(first.name); const right = normalizedItemName(second.name);
  return left === right || editDistance(left, right) <= Math.max(2, Math.floor(Math.max(left.length, right.length) * 0.18));
}

function receiptPassScore(pass: ReceiptPass) {
  const total = amountCents(pass.suggestion.amount);
  const itemTotal = pass.suggestion.items.reduce((sum, item) => sum + itemCents(item), 0);
  const exact = total !== null && itemTotal === total;
  const coverage = total && itemTotal <= total ? itemTotal / total : 0;
  return (exact ? 1_000_000 : 0) + pass.suggestion.items.length * 10_000 + Math.round(coverage * 1_000) + pass.confidence;
}

export function combineReceiptPasses(passes: ReceiptPass[]) {
  if (!passes.length) return { suggestion: parseReceiptText(""), confidence: 0 };
  const ordered = [...passes].sort((first, second) => receiptPassScore(second) - receiptPassScore(first));
  const best = ordered[0]!;
  const items = [...best.suggestion.items];
  const total = amountCents(best.suggestion.amount);
  let itemTotal = items.reduce((sum, item) => sum + itemCents(item), 0);
  if (total !== null && itemTotal !== total) {
    for (const pass of ordered.slice(1)) {
      for (const item of pass.suggestion.items) {
        const cents = itemCents(item);
        if (items.some((existing) => sameItem(existing, item)) || itemTotal + cents > total) continue;
        items.push(item); itemTotal += cents;
        if (itemTotal === total) break;
      }
      if (itemTotal === total) break;
    }
  }
  const firstValue = <Key extends "title" | "amount" | "expenseDate">(key: Key) => ordered.find((pass) => pass.suggestion[key])?.suggestion[key] || null;
  const combinedText = ordered.map((pass) => pass.text).join("\n");
  return {
    suggestion: {
      title: firstValue("title"), amount: firstValue("amount"), expenseDate: firstValue("expenseDate"),
      category: suggestedCategory(combinedText), items,
    },
    confidence: Math.max(...passes.map((pass) => pass.confidence)),
  };
}

function ollamaAmount(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value > 0 && value <= 10_000_000 ? value.toFixed(2) : null;
  const amount = parseMoney(String(value ?? ""));
  return amount === null ? null : amount.toFixed(2);
}

export function parseOllamaReceipt(value: unknown, now = new Date()): ReceiptPass | null {
  if (!value || typeof value !== "object") return null;
  const receipt = value as Record<string, unknown>;
  const rawItems = Array.isArray(receipt.items) ? receipt.items : [];
  const items: ReceiptSuggestion["items"] = [];
  for (const rawItem of rawItems.slice(0, 60)) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;
    const name = String(item.name || "").trim().replace(/\s+/g, " ").slice(0, 100);
    const amount = ollamaAmount(item.amount);
    const quantity = Math.min(20, Math.max(1, Math.round(Number(item.quantity) || 1)));
    if ((name.match(/[A-Za-zÅÄÖåäö]/g) || []).length < 2 || !amount) continue;
    const candidate = { name, quantity, amount };
    if (!items.some((existing) => sameItem(existing, candidate))) items.push(candidate);
  }
  const merchant = String(receipt.merchant || "").trim().replace(/\s+/g, " ").slice(0, 60) || null;
  const dateText = String(receipt.date || "");
  const dateMatch = dateText.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  const expenseDate = dateMatch ? validIsoDate(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]), now) : null;
  const amount = ollamaAmount(receipt.total);
  const text = [merchant, ...items.map((item) => `${item.quantity} ${item.name} ${item.amount}`), amount ? `Total ${amount}` : null].filter(Boolean).join("\n");
  if (!merchant && !amount && !items.length) return null;
  return { text, confidence: 85, suggestion: { title: merchant, amount, expenseDate, category: suggestedCategory(text), items } };
}

async function recognizeWithOllama(content: Buffer) {
  if (!ollamaUrl) return null;
  try {
    const timeout = Math.min(120_000, Math.max(10_000, Number(process.env.OLLAMA_OCR_TIMEOUT_MS) || 45_000));
    const response = await fetch(`${ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeout),
      body: JSON.stringify({
        model: ollamaModel,
        stream: false,
        messages: [{ role: "user", content: "Text Recognition:", images: [content.toString("base64")] }],
        options: { temperature: 0, seed: 837451 },
        keep_alive: "10m",
      }),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { message?: { content?: unknown } };
    const text = typeof payload.message?.content === "string" ? payload.message.content.trim() : "";
    if (!text) return null;
    return { text, confidence: 88, suggestion: parseReceiptText(text) } satisfies ReceiptPass;
  } catch { return null; }
}

let workerPromise: Promise<Worker> | null = null;
let queue: Promise<void> = Promise.resolve();

async function receiptWorker() {
  workerPromise ||= createWorker("swe", OEM.LSTM_ONLY, {
    langPath: swedishLanguage.langPath,
    gzip: swedishLanguage.gzip,
    cacheMethod: "none",
  });
  return workerPromise;
}

export type ReceiptCrop = { left: number; top: number; width: number; height: number; screenshotPreview: boolean };

function regionMean(data: Buffer, width: number, top: number, bottom: number) {
  let sum = 0;
  let count = 0;
  for (let y = Math.max(0, top); y < Math.min(bottom, Math.floor(data.length / width)); y += 1) {
    const offset = y * width;
    for (let x = 0; x < width; x += 3) { sum += data[offset + x]!; count += 1; }
  }
  return count ? sum / count : 255;
}

function locateReceipt(data: Buffer, width: number, height: number): ReceiptCrop {
  const topMean = regionMean(data, width, Math.floor(height * 0.02), Math.floor(height * 0.11));
  const bodyMean = regionMean(data, width, Math.floor(height * 0.13), Math.floor(height * 0.24));
  const screenshotPreview = width / height < 0.8 && topMean < 195 && bodyMean > topMean + 35;
  if (!screenshotPreview) return { left: 0, top: 0, width, height, screenshotPreview: false };

  const rowMean = (y: number) => {
    let sum = 0;
    const offset = y * width;
    for (let x = 0; x < width; x += 2) sum += data[offset + x]!;
    return sum / Math.ceil(width / 2);
  };
  let searchTop = Math.floor(height * 0.08);
  for (let y = searchTop; y < Math.floor(height * 0.32); y += 1) {
    if (rowMean(y) > 215 && rowMean(Math.min(height - 1, y + 4)) > 215) { searchTop = y; break; }
  }
  const searchBottom = Math.floor(height * 0.94);
  const darkLimit = 185;
  const columnThreshold = Math.max(4, Math.floor((searchBottom - searchTop) * 0.009));
  let left = width; let right = -1;
  for (let x = 0; x < width; x += 1) {
    let dark = 0;
    for (let y = searchTop; y < searchBottom; y += 2) if (data[y * width + x]! < darkLimit) dark += 1;
    if (dark >= Math.ceil(columnThreshold / 2)) { left = Math.min(left, x); right = Math.max(right, x); }
  }
  if (right < left || right - left < width * 0.16) return { left: 0, top: searchTop, width, height: searchBottom - searchTop, screenshotPreview };

  const horizontalPadding = Math.max(8, Math.floor(width * 0.018));
  left = Math.max(0, left - horizontalPadding);
  right = Math.min(width - 1, right + horizontalPadding);
  const rowThreshold = Math.max(2, Math.floor((right - left + 1) * 0.006));
  let top = searchBottom; let bottom = -1;
  for (let y = searchTop; y < searchBottom; y += 1) {
    let dark = 0;
    for (let x = left; x <= right; x += 2) if (data[y * width + x]! < darkLimit) dark += 1;
    if (dark >= Math.ceil(rowThreshold / 2)) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  if (bottom < top || bottom - top < height * 0.3) { top = searchTop; bottom = searchBottom - 1; }
  const verticalPadding = Math.max(8, Math.floor(height * 0.012));
  top = Math.max(searchTop, top - verticalPadding);
  bottom = Math.min(searchBottom - 1, bottom + verticalPadding);
  return { left, top, width: right - left + 1, height: bottom - top + 1, screenshotPreview };
}

export async function prepareReceiptImages(content: Buffer) {
  const analyzed = await sharp(content, { limitInputPixels: 20_000_000, failOn: "error" })
    .rotate().flatten({ background: "#ffffff" })
    .resize({ width: 1200, height: 2000, fit: "inside", withoutEnlargement: true })
    .png().toBuffer();
  const raw = await sharp(analyzed).grayscale().raw().toBuffer({ resolveWithObject: true });
  const crop = locateReceipt(raw.data, raw.info.width, raw.info.height);
  const base = sharp(analyzed).extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
    .resize({ width: 1600, height: 3400, fit: "inside", withoutEnlargement: false });
  const [ai, grayscale, binary] = await Promise.all([
    base.clone().normalize({ lower: 1, upper: 99 }).sharpen({ sigma: 0.8 }).jpeg({ quality: 90, chromaSubsampling: "4:4:4" }).toBuffer(),
    base.clone().grayscale().normalize({ lower: 1, upper: 99 }).sharpen({ sigma: 0.9 }).png().toBuffer(),
    base.clone().grayscale().normalize({ lower: 2, upper: 98 }).threshold(180).png().toBuffer(),
  ]);
  return { ai, grayscale, binary, crop };
}

async function recognizePass(worker: Worker, content: Buffer, pageMode: PSM, rotateAuto: boolean): Promise<ReceiptPass> {
  await worker.setParameters({
    tessedit_pageseg_mode: pageMode,
  });
  const result = await worker.recognize(content, { rotateAuto }, { text: true });
  const confidence = Math.max(0, Math.min(100, Math.round(result.data.confidence || 0)));
  return { text: result.data.text, confidence, suggestion: parseReceiptText(result.data.text) };
}

async function recognizeReceiptLocally(images: Awaited<ReturnType<typeof prepareReceiptImages>>) {
  const job = queue.then(async () => {
    const worker = await receiptWorker();
    const passes: ReceiptPass[] = [await recognizePass(worker, images.grayscale, PSM.SINGLE_BLOCK, false)];
    const first = passes[0]!;
    const firstTotal = amountCents(first.suggestion.amount);
    const firstItemTotal = first.suggestion.items.reduce((sum, item) => sum + itemCents(item), 0);
    if (first.confidence < 75 || first.suggestion.items.length < 2 || firstTotal === null || firstItemTotal !== firstTotal) {
      passes.push(await recognizePass(worker, images.binary, PSM.SPARSE_TEXT, false));
    }
    return { ...combineReceiptPasses(passes), passes: passes.length };
  });
  queue = job.then(() => undefined, () => undefined);
  return job;
}

export async function recognizeReceipt(content: Buffer) {
  const images = await prepareReceiptImages(content);
  const [aiPass, local] = await Promise.all([
    recognizeWithOllama(images.ai),
    recognizeReceiptLocally(images),
  ]);
  if (!aiPass) {
    const localTotal = amountCents(local.suggestion.amount);
    const localItemTotal = local.suggestion.items.reduce((sum, item) => sum + itemCents(item), 0);
    return { ...local, source: "tesseract" as const, cropped: images.crop.screenshotPreview, needsReview: localTotal !== null && (!local.suggestion.items.length || localItemTotal !== localTotal) };
  }
  const combined = combineReceiptPasses([aiPass, { text: "", confidence: local.confidence, suggestion: local.suggestion }]);
  const totals = [aiPass.suggestion.amount, local.suggestion.amount].filter(Boolean);
  const itemTotal = combined.suggestion.items.reduce((sum, item) => sum + itemCents(item), 0);
  const total = amountCents(combined.suggestion.amount);
  return {
    ...combined, passes: local.passes + 1, source: "ollama+tesseract" as const, cropped: images.crop.screenshotPreview,
    needsReview: new Set(totals).size > 1 || total === null || itemTotal !== total,
  };
}

export async function closeReceiptOcr() {
  const worker = workerPromise ? await workerPromise.catch(() => null) : null;
  workerPromise = null;
  if (worker) await worker.terminate();
}
