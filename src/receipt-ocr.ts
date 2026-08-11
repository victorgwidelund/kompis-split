import { createRequire } from "node:module";
import { createWorker, OEM, type Worker } from "tesseract.js";

const require = createRequire(import.meta.url);
const swedishLanguage = require("@tesseract.js-data/swe") as { langPath: string; gzip: boolean };

export type ReceiptSuggestion = {
  title: string | null;
  amount: string | null;
  expenseDate: string | null;
  category: "food" | "travel" | "stay" | "fun" | "other";
};

const ignoredMerchantWords = /^(kassa)?kvitto$|^välkommen|^tack för|^org\.?\s*nr|^datum|^tid|^tel|^telefon|^www\.|^moms|^total|^summa|^att betala|^butik\s*nr/i;
const totalWords = /att\s+betala|kortbelopp|belopp\s+sek|totalt?|summa/i;
const excludedTotalWords = /moms|vat|växel|change|rabatt|subtotal|delsumma/i;

function normalizedLines(text: string) {
  return text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
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
  }
  return null;
}

function merchantName(lines: string[]) {
  for (const line of lines.slice(0, 14)) {
    if (line.length < 2 || line.length > 60 || ignoredMerchantWords.test(line)) continue;
    const letters = (line.match(/[A-Za-zÅÄÖåäö]/g) || []).length;
    const digits = (line.match(/\d/g) || []).length;
    if (letters < 2 || digits > letters) continue;
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

function suggestedCategory(text: string): ReceiptSuggestion["category"] {
  if (/restaurang|restaurant|café|cafe|espresso|pizza|burger|sushi|mat|livs|ica|coop|willys|hemköp/i.test(text)) return "food";
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
  };
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

export async function recognizeReceipt(content: Buffer) {
  const job = queue.then(async () => {
    const worker = await receiptWorker();
    const result = await worker.recognize(content, { rotateAuto: true }, { text: true });
    return { suggestion: parseReceiptText(result.data.text), confidence: Math.max(0, Math.min(100, Math.round(result.data.confidence || 0))) };
  });
  queue = job.then(() => undefined, () => undefined);
  return job;
}

export async function closeReceiptOcr() {
  const worker = workerPromise ? await workerPromise.catch(() => null) : null;
  workerPromise = null;
  if (worker) await worker.terminate();
}
