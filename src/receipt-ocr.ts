import { createRequire } from "node:module";
import sharp from "sharp";
import { createWorker, OEM, PSM, type Worker } from "tesseract.js";

const require = createRequire(import.meta.url);
const swedishLanguage = require("@tesseract.js-data/swe") as { langPath: string; gzip: boolean };
const ollamaModel = String(process.env.OLLAMA_MODEL || "qwen3-vl:4b-instruct-q4_K_M").trim();
const ollamaMaxTokens = Math.min(1_536, Math.max(256, Number(process.env.OLLAMA_OCR_MAX_TOKENS) || 768));
const ollamaUrl = (() => {
  const value = String(process.env.OLLAMA_URL || "").trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href.replace(/\/$/, "") : null;
  } catch { return null; }
})();
const paddleOcrModel = String(process.env.PADDLEOCR_MODEL || "PaddleOCR-VL-1.6").trim();
const paddleOcrMaxTokens = Math.min(1_024, Math.max(256, Number(process.env.PADDLEOCR_MAX_TOKENS) || 512));
const paddleOcrUrl = (() => {
  const value = String(process.env.PADDLEOCR_URL || "").trim();
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

const ignoredMerchantWords = /^(kassa)?kvitto$|^g[äa]stnota$|^välkommen|^tack för|^org\.?\s*nr|^datum|^tid|^tel|^telefon|^www\.|^moms|^total|^summa|^att betala|^butik\s*nr|^[^\s]*örhandsvisning|tillbaka|^bord\b|^kassa\b|^kassör|^beställning|^order\b|^referens|^transaktions?[-\s]?id|^antal\s+g[äa]ster|^g[äa]ster\b|^swish\b/i;
const totalWords = /att\s+betala|betalt|kortbelopp|belopp\s+sek|totalt?|f[öo]tatt|summa/i;
const excludedTotalWords = /moms|vat|växel|change|rabatt|subtotal|delsumma/i;
// Receipt structure/metadata that must never become a purchased row, even when a nearby unrelated
// price gets merged onto it by the multi-line "name, then price on the next line" OCR heuristic.
// Word-boundaried so real product names are never caught (e.g. a wine called "Bordeaux" must not
// match \bbord\b).
const metadataLineWords = /\bbord\b|\bkassa\b|\bkassör(?:en|ska)?\b|\bbeställning\b|\börder\b|\breferens\b|\btransaktions?[-\s]?id\b|\bantal\s+g[äa]ster\b|\bg[äa]ster\b|\bswish\b|\btip\b|\bdricks\b|\bnetto(?:belopp)?\b|\bnet\s+amount\b/i;
// Discounts/coupons reduce the total rather than describing something purchased; letting them
// become an "item" both mislabels them and throws off the exact-total reconciliation.
const nonItemAdjustmentWords = /\brabatt\b|\bkupong\b|\bcoupon\b/i;

// Terminal/register/POS identifiers (e.g. "XCL AT-150-E-18E #1") are all-caps codes with a dash — a
// shape no real Swedish dish name has — so they must never become an item even when a nearby
// unrelated number gets misread as their price. OCR on the small stylized font these are printed in
// regularly drops one letter to lowercase (confirmed against a real misread: "XCL...E-18E #1" came
// back as "Cl AT-150-E-18E 41" — the "#" vanished and one letter's case flipped), so requiring *zero*
// lowercase letters is too strict; tolerate a small minority of them instead of demanding perfection.
function looksLikeSystemCode(line: string) {
  if (!/-/.test(line)) return false;
  const letters = line.match(/[A-Za-zÅÄÖåäö]/g) || [];
  if (letters.length < 3) return false;
  const lowercase = letters.filter((letter) => /[a-zåäö]/.test(letter)).length;
  return lowercase / letters.length <= 0.25;
}

type ReceiptPass = { text: string; confidence: number; suggestion: ReceiptSuggestion };

function normalizeNumericGlyphs(line: string, previousLine?: string) {
  let result = line
    .replace(/^\s*[Il|]\s+[xX]{1,2}\s+/, "1 x ")
    .replace(/^\s*[oO]{0,2}[1Il|]\s+[oO]?[xX][oO]?\s*/, "1 x ")
    .replace(/^\s*[oO]{1,2}(\d{1,2})\s+[oO]?[xX][oO]?\s*/, "$1 x ")
    .replace(/(\d)\s+([.,])\s*(\d{2})(?!\d)/g, "$1$2$3")
    .replace(/(\d)([.,])\s+(\d{2})(?!\d)/g, "$1$2$3")
    .replace(/(\d+[.,]\d{2})0(?=\s*(?:kr|sek)?$)/i, "$1")
    .replace(/(?<![\d.,])(\d{1,6})(?=\s*(?:kr|sek)\s*$)/i, "$1.00")
    .replace(/(\d{1,5})\s+(\d{2})(?=\s*(?:kr|sek)?$)/i, "$1.$2");
  // A bare 3-5 digit line is only treated as a price with an implied decimal point when it isn't the
  // continuation of a terminal/register code printed on the line above it (e.g. "XCL AT-150-E-18E #1"
  // followed by "3564") — that's an id fragment, not a SEK amount, even though it has the same shape.
  if (!(previousLine !== undefined && looksLikeSystemCode(previousLine))) {
    result = result.replace(/(?<!\d)(\d{3,5})(?=\s*(?:kr|sek)?$)/i, (value) => `${value.slice(0, -2)}.${value.slice(-2)}`);
  }
  return result.replace(/(?<![A-Za-zÅÄÖåäö])[\dOo]{1,8}[.,][\dOo]{2}(?![A-Za-zÅÄÖåäö])/g, (value) => value.replace(/[Oo]/g, "0"));
}

// A long dish name can wrap onto its own line on a narrow receipt, leaving just its last 1-3 letters
// stranded alone on the next line (e.g. "Caesarsalla" / "d", "Tryffelpast" / "a"). A bare short
// lowercase-only line with nothing else on it is essentially never a meaningful standalone entry on a
// Swedish receipt, so it's reattached to the previous line instead of being dropped or misread.
// If that previous line already has its price on it (name and price wrapped down together as a pair,
// confirmed against a real receipt: "1.00 Caesarsalla 285.00" then bare "d"), the fragment has to be
// spliced in *before* the price rather than appended at the very end — appending after "285.00" would
// leave the row not ending in a price and it would be dropped entirely, not just misnamed.
const trailingPricePattern = /^(.*\S)(\s+)((?:\d{1,3}(?:[ .]\d{3})*|\d+)[,.]\d{2}\s*(?:kr|sek)?)$/i;
function reuniteWrappedWords(lines: string[]) {
  const result: string[] = [];
  for (const line of lines) {
    const bareFragment = /^[a-zåäö]{1,3}$/.exec(line);
    const fragmentBeforePrice = /^([a-zåäö]{1,3})\s+(\d{1,6}[,.]\d{2}.*)$/.exec(line);
    if (result.length && bareFragment) {
      const previous = result[result.length - 1]!;
      const trailingPrice = trailingPricePattern.exec(previous);
      result[result.length - 1] = trailingPrice ? `${trailingPrice[1]}${line}${trailingPrice[2]}${trailingPrice[3]}` : previous + line;
    }
    else if (result.length && fragmentBeforePrice) { result[result.length - 1] += fragmentBeforePrice[1]!; result.push(fragmentBeforePrice[2]!); }
    else result.push(line);
  }
  return result;
}

function normalizedLines(text: string) {
  const cleaned = text.split(/\r?\n/).map((line) => line
    .replace(/\s*[|¦]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()).filter(Boolean);
  const lines = cleaned.map((line, index) => normalizeNumericGlyphs(line, index > 0 ? cleaned[index - 1] : undefined));
  return reuniteWrappedWords(lines);
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
  const orderedLines = [...lines.filter((line) => /beställd|bestalld|datum|köpt|kopdatum/i.test(line)), ...lines.filter((line) => !/beställd|bestalld|datum|köpt|kopdatum/i.test(line))];
  for (const line of orderedLines) {
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
  const candidates: string[] = [];
  for (const line of lines.slice(0, 14)) {
    if (line.length < 2 || line.length > 60 || ignoredMerchantWords.test(line)) continue;
    if (amountCandidates(line).length) continue;
    const letters = (line.match(/[A-Za-zÅÄÖåäö]/g) || []).length;
    const digits = (line.match(/\d/g) || []).length;
    if (letters < 3 || digits > letters) continue;
    const candidate = line.replace(/^[^A-Za-zÅÄÖåäö]+|[^A-Za-zÅÄÖåäö0-9)&'. -]+$/g, "").slice(0, 60);
    if (candidate) candidates.push(candidate);
  }
  // A merchant's name is often printed twice near the top of a Swedish receipt (once in the header,
  // again just above the order/table details), while a street address only appears once — a candidate
  // repeated verbatim is a much stronger signal of being the actual business name than whichever line
  // happens to have marginally more letters (confirmed against a real receipt: "Strandbryggan" printed
  // twice lost to the single-occurrence "Stranvägskajen 27" on letter count alone before this).
  const repeatCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = candidate.toLocaleLowerCase("sv-SE");
    repeatCounts.set(key, (repeatCounts.get(key) || 0) + 1);
  }
  return candidates.sort((first, second) => {
    const repeats = (repeatCounts.get(second.toLocaleLowerCase("sv-SE")) || 1) - (repeatCounts.get(first.toLocaleLowerCase("sv-SE")) || 1);
    return repeats || merchantNameScore(second) - merchantNameScore(first);
  })[0] || null;
}

function merchantNameScore(value: string) {
  const letters = (value.match(/[A-Za-zÅÄÖåäö]/g) || []).length;
  const digits = (value.match(/\d/g) || []).length;
  const businessWord = /restaurang|restaurant|ste[a-z]{1,3}house|hotell|hotel|café|cafe|bistro|bar\b|grill|krog|butik/i.test(value);
  const isolatedLetters = (value.match(/(?:^|\s)[A-Za-zÅÄÖåäö](?=\s|$)/g) || []).length;
  // A street address almost always has a number in it (house number, postcode); a business name
  // almost never does, so a small per-digit penalty helps tell them apart when letter counts are close.
  return letters + (businessWord ? 100 : 0) - isolatedLetters * 4 - digits * 3;
}

function receiptTotal(lines: string[]) {
  const prioritized: number[] = [];
  const fallback: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const amounts = amountCandidates(line);
    if (!amounts.length) continue;
    fallback.push(...amounts);
    if (totalWords.test(line) && !excludedTotalWords.test(line)) prioritized.push(...amounts);
  }
  if (!prioritized.length) {
    for (let index = 0; index < lines.length - 1; index += 1) {
      const line = lines[index]!;
      const next = lines[index + 1]!;
      if (!totalWords.test(line) || excludedTotalWords.test(line)) continue;
      if (!/^\s*\d{1,6}[,.]\d{2}\s*(?:kr|sek)?\s*$/i.test(next)) continue;
      prioritized.push(...amountCandidates(next));
    }
  }
  if (!prioritized.length && lines.some((line) => totalWords.test(line) && !excludedTotalWords.test(line))) return null;
  const candidates = prioritized.length ? prioritized : fallback;
  return candidates.length ? Math.max(...candidates) : null;
}

// A receipt always has the same shape: header (merchant, address, table/terminal info) → items →
// tax/subtotal → total → payment details. Rather than growing an ever-longer list of header/footer
// keywords one real receipt at a time, find the items section structurally and only let the riskier
// cross-line merge heuristics (which glue a name on one line to a price from another) fire inside it.
// Same-line name+price pairs are unaffected — that path never "guesses" a pairing, so it's not
// section-gated. A misread header/footer line that already contains its own price would still need
// its own exclusion rule (see metadataLineWords etc.); this specifically targets the actual bug shape
// seen twice now: an unrelated price merging onto a nearby header/footer line.
const quantityNamePattern = /^\s*\d{1,2}\s*[xX]\s*\S.*[A-Za-zÅÄÖåäö]/;

function itemsSectionBounds(lines: string[]): { start: number; end: number } {
  // PaddleOCR sometimes emits every item name first, then a separate block of prices further down
  // (see the "name and price blocks are paired" fixture) — the section can start at a quantity-
  // prefixed name well before the first price shows up, not just near the first price itself.
  const firstCandidateIndex = lines.findIndex((line) => amountCandidates(line).length > 0 || quantityNamePattern.test(line));
  if (firstCandidateIndex === -1) return { start: 0, end: lines.length };
  const start = Math.max(0, firstCandidateIndex - 2);
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (totalWords.test(lines[index]!)) { end = index; break; }
  }
  return { start, end };
}

function receiptItems(lines: string[]) {
  const { start: sectionStart, end: sectionEnd } = itemsSectionBounds(lines);
  const items: Array<{ name: string; quantity: number; amount: string }> = [];
  const itemLines: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const inItemsSection = index >= sectionStart && index < sectionEnd;
    const separatedNames: string[] = [];
    let cursor = index;
    while (inItemsSection && cursor < lines.length && /^\s*\d{1,2}\s*[xX]\s*\S.*[A-Za-zÅÄÖåäö]/.test(lines[cursor]!) && !amountCandidates(lines[cursor]!).length) {
      separatedNames.push(lines[cursor]!);
      cursor += 1;
    }
    if (separatedNames.length >= 2) {
      const separatedAmounts: string[] = [];
      while (cursor < lines.length && /^\s*\d{1,6}[,.]\d{2}\s*(?:kr|sek)?\s*$/i.test(lines[cursor]!)) {
        separatedAmounts.push(lines[cursor]!);
        cursor += 1;
      }
      if (separatedAmounts.length === separatedNames.length) {
        for (let pairIndex = 0; pairIndex < separatedNames.length; pairIndex += 1) {
          itemLines.push(`${separatedNames[pairIndex]} ${separatedAmounts[pairIndex]}`);
        }
        index = cursor - 1;
        continue;
      }
    }
    const next = lines[index + 1] || "";
    const hasProductText = (line.match(/[A-Za-zÅÄÖåäö]/g) || []).length >= 2;
    const endsWithAmount = /\d[,.]\d{2}\s*(?:kr|sek)?\s*$/i.test(line);
    const nextIsAmount = /^\s*\d{1,6}[,.]\d{2}\s*(?:kr|sek)?\s*$/i.test(next);
    if (inItemsSection && hasProductText && !endsWithAmount && nextIsAmount && !metadataLineWords.test(line) && !looksLikeSystemCode(line)) {
      itemLines.push(`${line} ${next}`);
      index += 1;
    } else itemLines.push(line);
  }
  const seen = new Set<string>();
  for (const line of itemLines) {
    if (totalWords.test(line) || excludedTotalWords.test(line) || metadataLineWords.test(line) || nonItemAdjustmentWords.test(line) || looksLikeSystemCode(line) || /moms|org\.?\s*nr|kort|visa|mastercard|datum|kvitto|summa|subtotal|delsumma|betalt|godkänt|\bköp\b|terminal|kontroll(enhet)?|ctuid|\baid\b|\btvr\b|\bref\.?|\bpsn\b|#\s*\d+|\bstkk\b|\b(?:mån|tis|ons|tor|fre|lör|sön)\b/i.test(line)) continue;
    const amounts = amountCandidates(line);
    if (!amounts.length || !/\d[,.]\d{2}\s*(?:kr|sek)?\s*$/i.test(line)) continue;
    const quantityPattern = /^\s*(?:[A-Za-z]{1,3}\s+)?(\d{1,2})(?:(?:[,.]0{1,2})\s+|\s*[A-Za-z]?[xX]{1,2}[oO]?\s+|\s*\*\s+)/;
    const quantityMatch = line.match(quantityPattern);
    if (!quantityMatch && amounts.length > 1 && /^\s*\d+[,.]\d{2}\b/.test(line)) continue;
    const quantity = Math.min(20, Math.max(1, Number(quantityMatch?.[1] || 1)));
    let amount = amounts.at(-1)!;
    if (quantity > 1 && amounts.length > 1) {
      const unitAmount = amounts.at(-2)!;
      const calculatedRowAmount = unitAmount * quantity;
      if (Math.abs(calculatedRowAmount - amount) <= Math.max(20, calculatedRowAmount * 0.12)) amount = calculatedRowAmount;
    }
    const name = line
      .replace(quantityPattern, "")
      .replace(/\(\s*\d+[,.]\d{2}\s*\)/g, " ")
      .replace(/(?<!\d)(\d{1,3}(?:[ .]\d{3})*|\d+)[,.]\d{2}(?!\d)/g, " ")
      .replace(/\(\s*\)/g, " ")
      .replace(/\b(?:kr|sek|st)\b/gi, " ")
      .replace(/[.·_-]{2,}/g, " ")
      .replace(/\s+/g, " ").trim()
      .replace(/^(?:[oO]{0,2}[1Il|]\s*)?(?:[oO]?[xX][oO]?\s*)/, "")
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

function similarItem(first: ReceiptSuggestion["items"][number], second: ReceiptSuggestion["items"][number]) {
  if (first.quantity !== second.quantity) return false;
  const left = normalizedItemName(first.name); const right = normalizedItemName(second.name);
  return left === right || editDistance(left, right) <= Math.max(2, Math.floor(Math.max(left.length, right.length) * 0.18));
}

function sameItem(first: ReceiptSuggestion["items"][number], second: ReceiptSuggestion["items"][number]) {
  return itemCents(first) === itemCents(second) && similarItem(first, second);
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
        if (items.some((existing) => sameItem(existing, item))) continue;
        const similarIndex = items.findIndex((existing) => similarItem(existing, item));
        if (similarIndex >= 0) {
          const replacedTotal = itemTotal - itemCents(items[similarIndex]!) + cents;
          if (Math.abs(total - replacedTotal) < Math.abs(total - itemTotal)) {
            itemTotal = replacedTotal;
            items[similarIndex] = item;
          }
          if (itemTotal === total) break;
          continue;
        }
        if (itemTotal + cents > total) continue;
        items.push(item); itemTotal += cents;
        if (itemTotal === total) break;
      }
      if (itemTotal === total) break;
    }
  }
  // Title used to be picked by re-scoring every pass's candidate line across the board, independent of
  // which pass actually won on items/total — a long garbled misread from a weaker pass (e.g. the local
  // Tesseract fallback) could out-score a short, correct name like "Strandbryggan" purely by letter
  // count. Trusting the winning pass first, same as amount/expenseDate already do, fixes that.
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

const ollamaReceiptSchema = {
  type: "object",
  properties: {
    merchant: { type: "string", description: "Exakt restaurang- eller butiksnamn, annars tom sträng" },
    date: { type: "string", description: "Datum som YYYY-MM-DD, annars tom sträng" },
    total: { type: "number", description: "Slutsumman att betala i SEK, annars 0" },
    items: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          quantity: { type: "integer", minimum: 1, maximum: 20 },
          amount: { type: "number", description: "Hela radens summa i SEK, inte styckpriset" },
        },
        required: ["name", "quantity", "amount"],
        additionalProperties: false,
      },
    },
  },
  required: ["merchant", "date", "total", "items"],
  additionalProperties: false,
} as const;

function receiptPrompt(verification: boolean) {
  return `${verification ? "Kontrollera kvittot en andra gång mycket noggrant." : "Läs det svenska restaurang- eller butikskvittot noggrant."}
Returnera endast JSON enligt detta schema: ${JSON.stringify(ollamaReceiptSchema)}
Regler:
- Läs bara synlig text och gissa aldrig dolda rader.
- En rad som \"7x Smirnoff ICE 665.00\" betyder quantity 7 och amount 665.00.
- En rad som \"2st * 55 kr 110.00\" betyder quantity 2 och amount 110.00.
- amount är alltid hela radens summa, aldrig styckpriset inom parentes.
- Ta med varje synlig köpt rad exakt en gång. Upprepa aldrig samma fysiska kvittorad.
- Ta inte med moms, delsumma, total, betalning, kortnummer, terminaldata eller kvittonummer som artiklar.
- total är den tydliga slutsumman/att betala, inte moms eller delsumma.
- Kontrollera att antal och decimaler återges exakt. Använd tom sträng eller 0 när ett fält inte går att läsa.`;
}

function balancedPass(pass: ReceiptPass) {
  const total = amountCents(pass.suggestion.amount);
  const itemTotal = pass.suggestion.items.reduce((sum, item) => sum + itemCents(item), 0);
  return total !== null && pass.suggestion.items.length > 0 && itemTotal === total;
}

type AiAttempt = { pass: ReceiptPass | null; status: string; durationMs: number; httpStatus?: number };

function logOcr(event: Record<string, string | number | boolean | null | undefined>) {
  console.info(`[receipt-ocr] ${JSON.stringify(event)}`);
}

// Off by default: every prior version of this file has kept receipt content out of the logs on
// purpose. Set RECEIPT_OCR_DEBUG_LOG=true (server-side only, never sent to the client) to include a
// truncated raw-text snippet in the "ai"/"ai_verify" log lines when actively diagnosing a bad scan.
const receiptOcrDebugLog = String(process.env.RECEIPT_OCR_DEBUG_LOG || "").toLowerCase() === "true";
function logSnippet(text: string) {
  if (!receiptOcrDebugLog) return undefined;
  return text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
}

export function ollamaReceiptRequest(content: Buffer, verification = false) {
  return {
    model: ollamaModel,
    stream: false,
    think: false,
    format: ollamaReceiptSchema,
    messages: [{ role: "user", content: receiptPrompt(verification), images: [content.toString("base64")] }],
    options: { temperature: 0, seed: verification ? 239017 : 837451, num_ctx: 8192, num_predict: ollamaMaxTokens },
    keep_alive: "10m",
  };
}

export function paddleOcrReceiptRequest(content: Buffer, verification = false) {
  return {
    model: paddleOcrModel,
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${content.toString("base64")}` } },
        { type: "text", text: "OCR:" },
      ],
    }],
    temperature: 0,
    seed: verification ? 239017 : 837451,
    max_tokens: paddleOcrMaxTokens,
    stream: false,
  };
}

async function recognizeWithPaddleOcr(content: Buffer, verification = false, cancelled?: AbortSignal): Promise<AiAttempt> {
  const startedAt = Date.now();
  if (!paddleOcrUrl) return { pass: null, status: "disabled", durationMs: 0 };
  try {
    const timeout = Math.min(180_000, Math.max(15_000, Number(process.env.PADDLEOCR_TIMEOUT_MS) || 60_000));
    const timeoutSignal = AbortSignal.timeout(timeout);
    const response = await fetch(`${paddleOcrUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: cancelled ? AbortSignal.any([timeoutSignal, cancelled]) : timeoutSignal,
      body: JSON.stringify(paddleOcrReceiptRequest(content, verification)),
    });
    if (!response.ok) {
      const attempt = { pass: null, status: `http_${response.status}`, durationMs: Date.now() - startedAt, httpStatus: response.status } satisfies AiAttempt;
      logOcr({ stage: verification ? "ai_verify" : "ai", model: paddleOcrModel, status: attempt.status, durationMs: attempt.durationMs });
      return attempt;
    }
    const payload = await response.json() as {
      choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }>;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    const text = typeof payload.choices?.[0]?.message?.content === "string" ? payload.choices[0].message.content.trim() : "";
    const finishReason = typeof payload.choices?.[0]?.finish_reason === "string" ? payload.choices[0].finish_reason : undefined;
    const metrics = {
      doneReason: finishReason,
      outputTokens: Number.isFinite(Number(payload.usage?.completion_tokens)) ? Number(payload.usage?.completion_tokens) : undefined,
      promptTokens: Number.isFinite(Number(payload.usage?.prompt_tokens)) ? Number(payload.usage?.prompt_tokens) : undefined,
    };
    if (!text) {
      const attempt = { pass: null, status: "empty_response", durationMs: Date.now() - startedAt } satisfies AiAttempt;
      logOcr({ stage: verification ? "ai_verify" : "ai", model: paddleOcrModel, status: attempt.status, durationMs: attempt.durationMs, ...metrics });
      return attempt;
    }
    const tokenLimited = finishReason === "length";
    const attempt = { pass: tokenLimited ? null : { text, confidence: verification ? 94 : 92, suggestion: parseReceiptText(text) }, status: tokenLimited ? "token_limit" : "ok", durationMs: Date.now() - startedAt } satisfies AiAttempt;
    logOcr({ stage: verification ? "ai_verify" : "ai", model: paddleOcrModel, status: attempt.status, durationMs: attempt.durationMs, items: attempt.pass?.suggestion.items.length, rawText: logSnippet(text), ...metrics });
    return attempt;
  } catch (error) {
    const status = cancelled?.aborted ? "cancelled_local_complete" : error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : "connection_error";
    const attempt = { pass: null, status, durationMs: Date.now() - startedAt } satisfies AiAttempt;
    logOcr({ stage: verification ? "ai_verify" : "ai", model: paddleOcrModel, status, durationMs: attempt.durationMs });
    return attempt;
  }
}

async function recognizeWithOllama(content: Buffer, verification = false, cancelled?: AbortSignal): Promise<AiAttempt> {
  const startedAt = Date.now();
  if (!ollamaUrl) return { pass: null, status: "disabled", durationMs: 0 };
  try {
    const timeout = Math.min(180_000, Math.max(15_000, Number(process.env.OLLAMA_OCR_TIMEOUT_MS) || 60_000));
    const timeoutSignal = AbortSignal.timeout(timeout);
    const response = await fetch(`${ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: cancelled ? AbortSignal.any([timeoutSignal, cancelled]) : timeoutSignal,
      body: JSON.stringify(ollamaReceiptRequest(content, verification)),
    });
    if (!response.ok) {
      const attempt = { pass: null, status: `http_${response.status}`, durationMs: Date.now() - startedAt, httpStatus: response.status } satisfies AiAttempt;
      logOcr({ stage: verification ? "ai_verify" : "ai", model: ollamaModel, status: attempt.status, durationMs: attempt.durationMs });
      return attempt;
    }
    const payload = await response.json() as {
      message?: { content?: unknown; thinking?: unknown };
      done_reason?: unknown;
      eval_count?: unknown;
      eval_duration?: unknown;
      prompt_eval_count?: unknown;
      prompt_eval_duration?: unknown;
      load_duration?: unknown;
    };
    const text = typeof payload.message?.content === "string" ? payload.message.content.trim() : "";
    const thinkingOnly = !text && typeof payload.message?.thinking === "string" && payload.message.thinking.trim().length > 0;
    const metrics = {
      doneReason: typeof payload.done_reason === "string" ? payload.done_reason : undefined,
      outputTokens: Number.isFinite(Number(payload.eval_count)) ? Number(payload.eval_count) : undefined,
      outputMs: Number.isFinite(Number(payload.eval_duration)) ? Math.round(Number(payload.eval_duration) / 1_000_000) : undefined,
      promptTokens: Number.isFinite(Number(payload.prompt_eval_count)) ? Number(payload.prompt_eval_count) : undefined,
      promptMs: Number.isFinite(Number(payload.prompt_eval_duration)) ? Math.round(Number(payload.prompt_eval_duration) / 1_000_000) : undefined,
      loadMs: Number.isFinite(Number(payload.load_duration)) ? Math.round(Number(payload.load_duration) / 1_000_000) : undefined,
    };
    if (!text) {
      const attempt = { pass: null, status: thinkingOnly ? "thinking_only" : "empty_response", durationMs: Date.now() - startedAt } satisfies AiAttempt;
      logOcr({ stage: verification ? "ai_verify" : "ai", model: ollamaModel, status: attempt.status, durationMs: attempt.durationMs, ...metrics });
      return attempt;
    }
    try {
      const pass = parseOllamaReceipt(JSON.parse(text));
      const attempt = { pass: pass ? { ...pass, confidence: verification ? 94 : 92 } : null, status: pass ? "ok" : "invalid_schema", durationMs: Date.now() - startedAt } satisfies AiAttempt;
      logOcr({ stage: verification ? "ai_verify" : "ai", model: ollamaModel, status: attempt.status, durationMs: attempt.durationMs, items: attempt.pass?.suggestion.items.length, ...metrics });
      return attempt;
    } catch {
      const tokenLimited = metrics.doneReason === "length";
      const attempt = { pass: tokenLimited ? null : { text, confidence: 70, suggestion: parseReceiptText(text) }, status: tokenLimited ? "token_limit" : "unstructured", durationMs: Date.now() - startedAt } satisfies AiAttempt;
      logOcr({ stage: verification ? "ai_verify" : "ai", model: ollamaModel, status: attempt.status, durationMs: attempt.durationMs, items: attempt.pass?.suggestion.items.length, ...metrics });
      return attempt;
    }
  } catch (error) {
    const status = cancelled?.aborted ? "cancelled_local_complete" : error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : "connection_error";
    const attempt = { pass: null, status, durationMs: Date.now() - startedAt } satisfies AiAttempt;
    logOcr({ stage: verification ? "ai_verify" : "ai", model: ollamaModel, status, durationMs: attempt.durationMs });
    return attempt;
  }
}

function recognizeWithDocumentAi(content: Buffer, verification = false, cancelled?: AbortSignal) {
  return paddleOcrUrl ? recognizeWithPaddleOcr(content, verification, cancelled) : recognizeWithOllama(content, verification, cancelled);
}

const localWorkerCount = Math.min(4, Math.max(1, Number(process.env.RECEIPT_OCR_WORKERS) || 2));
const workerPromises: Array<Promise<Worker> | undefined> = Array(localWorkerCount);
const queues: Promise<void>[] = Array.from({ length: localWorkerCount }, () => Promise.resolve());
let nextWorker = 0;
let nextScanId = 0;

async function receiptWorker(index: number) {
  workerPromises[index] ||= createWorker("swe", OEM.LSTM_ONLY, {
    langPath: swedishLanguage.langPath,
    gzip: swedishLanguage.gzip,
    cacheMethod: "none",
  });
  return workerPromises[index]!;
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

function otsuThreshold(data: Buffer) {
  const histogram = Array<number>(256).fill(0);
  for (const value of data) histogram[value]! += 1;
  let totalSum = 0;
  for (let value = 0; value < 256; value += 1) totalSum += value * histogram[value]!;
  let backgroundWeight = 0; let backgroundSum = 0; let bestVariance = 0; let threshold = 128;
  for (let value = 0; value < 256; value += 1) {
    backgroundWeight += histogram[value]!;
    if (!backgroundWeight) continue;
    const foregroundWeight = data.length - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += value * histogram[value]!;
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (totalSum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) { bestVariance = variance; threshold = value; }
  }
  return threshold;
}

async function rectifiedPaperImage(data: Buffer, width: number, height: number, screenshotPreview: boolean) {
  if (screenshotPreview) return null;
  const threshold = otsuThreshold(data);
  if (threshold < 25 || threshold > 205) return null;
  const bounds: Array<[number, number] | null> = [];
  for (let y = 0; y < height; y += 1) {
    let left = width; let right = -1;
    for (let x = 0; x < width; x += 1) {
      if (data[y * width + x]! > threshold) { left = Math.min(left, x); right = Math.max(right, x); }
    }
    bounds.push(right - left >= width * 0.18 ? [left, right] : null);
  }
  const validRows = bounds.map((bound, index) => bound ? index : -1).filter((index) => index >= 0);
  if (validRows.length < height * 0.55) return null;
  const top = validRows[0]!; const bottom = validRows.at(-1)!;
  const averageSpan = validRows.reduce((sum, row) => sum + (bounds[row]![1] - bounds[row]![0] + 1), 0) / validRows.length;
  if (averageSpan > width * 0.97) return null;
  const outputHeight = bottom - top + 1;
  const output = Buffer.alloc(width * outputHeight);
  let lastBound: [number, number] = [0, width - 1];
  for (let outputY = 0; outputY < outputHeight; outputY += 1) {
    const sourceY = top + outputY;
    const bound = bounds[sourceY] || lastBound;
    lastBound = bound;
    for (let outputX = 0; outputX < width; outputX += 1) {
      const sourceX = Math.min(width - 1, Math.max(0, Math.round(bound[0] + outputX * (bound[1] - bound[0]) / Math.max(1, width - 1))));
      output[outputY * width + outputX] = data[sourceY * width + sourceX]!;
    }
  }
  return sharp(output, { raw: { width, height: outputHeight, channels: 1 } })
    .resize({ width: 1600, height: 3400, fit: "inside", withoutEnlargement: false })
    .normalize({ lower: 1, upper: 99 }).sharpen({ sigma: 1 }).png().toBuffer();
}

// Matches the dimension cap enforced in src/server.ts safeReceiptImageDimensions — large enough for
// an unresized high-end phone photo (~50 MP), small enough to keep decompression-bomb protection real.
export const maxReceiptInputPixels = 50_000_000;

export async function prepareReceiptImages(content: Buffer) {
  const analyzed = await sharp(content, { limitInputPixels: maxReceiptInputPixels, failOn: "error" })
    .rotate().flatten({ background: "#ffffff" })
    .resize({ width: 1200, height: 2000, fit: "inside", withoutEnlargement: true })
    .png().toBuffer();
  const raw = await sharp(analyzed).grayscale().raw().toBuffer({ resolveWithObject: true });
  const crop = locateReceipt(raw.data, raw.info.width, raw.info.height);
  const rectified = await rectifiedPaperImage(raw.data, raw.info.width, raw.info.height, crop.screenshotPreview);
  const base = sharp(analyzed).extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
    .resize({ width: 1600, height: 3400, fit: "inside", withoutEnlargement: false });
  const [ai, grayscale, binary] = await Promise.all([
    base.clone().resize({ width: 1024, height: 2048, fit: "inside" }).normalize({ lower: 1, upper: 99 }).sharpen({ sigma: 0.8 }).jpeg({ quality: 90, chromaSubsampling: "4:4:4" }).toBuffer(),
    base.clone().grayscale().sharpen({ sigma: 0.45 }).png().toBuffer(),
    rectified ? Promise.resolve(rectified) : base.clone().grayscale().normalize({ lower: 2, upper: 98 }).threshold(180).png().toBuffer(),
  ]);
  return { ai, grayscale, binary, crop, rectified: Boolean(rectified) };
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
  const workerIndex = nextWorker++ % localWorkerCount;
  const job = queues[workerIndex]!.then(async () => {
    const worker = await receiptWorker(workerIndex);
    const passes: ReceiptPass[] = [await recognizePass(worker, images.grayscale, PSM.SINGLE_BLOCK, false)];
    const first = passes[0]!;
    const firstTotal = amountCents(first.suggestion.amount);
    const firstItemTotal = first.suggestion.items.reduce((sum, item) => sum + itemCents(item), 0);
    if (first.confidence < 75 || first.suggestion.items.length < 2 || firstTotal === null || firstItemTotal !== firstTotal) {
      passes.push(await recognizePass(worker, images.binary, images.rectified ? PSM.SINGLE_BLOCK : PSM.SPARSE_TEXT, false));
    }
    return { ...combineReceiptPasses(passes), passes: passes.length };
  });
  queues[workerIndex] = job.then(() => undefined, () => undefined);
  return job;
}

export async function recognizeReceipt(content: Buffer) {
  const scanId = `${Date.now().toString(36)}-${(++nextScanId).toString(36)}`;
  const startedAt = Date.now();
  const images = await prepareReceiptImages(content);
  const aiCancellation = new AbortController();
  const aiModel = paddleOcrUrl ? paddleOcrModel : ollamaModel;
  const aiPromise = recognizeWithDocumentAi(images.ai, false, aiCancellation.signal);
  const local = await recognizeReceiptLocally(images);
  const localPass = { text: "", confidence: local.confidence, suggestion: local.suggestion } satisfies ReceiptPass;
  if (balancedPass(localPass)) {
    aiCancellation.abort();
    const aiAttempt = await aiPromise;
    const result = { ...local, source: "tesseract" as const, cropped: images.crop.screenshotPreview, rectified: images.rectified, ai: { model: aiModel, status: aiAttempt.status, durationMs: aiAttempt.durationMs, used: false, retried: false }, needsReview: false };
    logOcr({ scanId, stage: "complete", source: result.source, aiStatus: aiAttempt.status, durationMs: Date.now() - startedAt, items: result.suggestion.items.length, balanced: true, rectified: images.rectified });
    return result;
  }
  const aiAttempt = await aiPromise;
  const aiPass = aiAttempt.pass;
  if (!aiPass) {
    const localTotal = amountCents(local.suggestion.amount);
    const localItemTotal = local.suggestion.items.reduce((sum, item) => sum + itemCents(item), 0);
    const balanced = localTotal !== null && local.suggestion.items.length > 0 && localItemTotal === localTotal;
    const result = { ...local, source: "tesseract" as const, cropped: images.crop.screenshotPreview, rectified: images.rectified, ai: { model: aiModel, status: aiAttempt.status, durationMs: aiAttempt.durationMs, used: false, retried: false }, needsReview: !balanced };
    logOcr({ scanId, stage: "complete", source: result.source, aiStatus: aiAttempt.status, durationMs: Date.now() - startedAt, items: result.suggestion.items.length, balanced, rectified: images.rectified });
    return result;
  }
  const aiPasses = [aiPass];
  let verificationAttempt: AiAttempt | null = null;
  const accurateRetry = paddleOcrUrl ? process.env.PADDLEOCR_ACCURATE_RETRY : process.env.OLLAMA_ACCURATE_RETRY;
  if (!balancedPass(aiPass) && String(accurateRetry || "true").toLowerCase() !== "false") {
    verificationAttempt = await recognizeWithDocumentAi(images.grayscale, true);
    if (verificationAttempt.pass) aiPasses.push(verificationAttempt.pass);
  }
  const combined = combineReceiptPasses([...aiPasses, localPass]);
  const totals = aiPasses.map((pass) => pass.suggestion.amount).filter(Boolean);
  if (local.confidence >= 75 && local.suggestion.amount) totals.push(local.suggestion.amount);
  const itemTotal = combined.suggestion.items.reduce((sum, item) => sum + itemCents(item), 0);
  const total = amountCents(combined.suggestion.amount);
  const result = {
    ...combined, passes: local.passes + aiPasses.length, source: paddleOcrUrl ? "paddleocr+tesseract" as const : "ollama+tesseract" as const, cropped: images.crop.screenshotPreview,
    rectified: images.rectified,
    ai: { model: aiModel, status: aiAttempt.status, durationMs: aiAttempt.durationMs + (verificationAttempt?.durationMs || 0), used: true, retried: Boolean(verificationAttempt), verificationStatus: verificationAttempt?.status },
    needsReview: new Set(totals).size > 1 || total === null || !combined.suggestion.items.length || itemTotal !== total,
  };
  logOcr({ scanId, stage: "complete", source: result.source, aiStatus: aiAttempt.status, aiRetried: Boolean(verificationAttempt), aiVerificationStatus: verificationAttempt?.status, durationMs: Date.now() - startedAt, items: result.suggestion.items.length, balanced: !result.needsReview, rectified: images.rectified });
  return result;
}

/**
 * Re-normalizes an already-validated image before it is stored, regardless of what client-side
 * compression already did (never trust the client): strips metadata (Sharp drops EXIF/GPS/etc.
 * unless withMetadata() is called), auto-orients, caps the long edge at a size that stays clearly
 * inspectable, and re-encodes as JPEG so stored receipts have a consistent, bounded footprint.
 */
export async function normalizeReceiptImage(content: Buffer): Promise<{ content: Buffer; mimeType: string }> {
  try {
    const image = sharp(content, { limitInputPixels: maxReceiptInputPixels, failOn: "error" }).rotate();
    const metadata = await image.metadata();
    const longEdge = Math.max(metadata.width || 0, metadata.height || 0);
    const resized = longEdge > 3000 ? image.resize({ width: 3000, height: 3000, fit: "inside", withoutEnlargement: true }) : image;
    const normalized = await resized.jpeg({ quality: 90, chromaSubsampling: "4:4:4" }).toBuffer();
    return { content: normalized, mimeType: "image/jpeg" };
  } catch {
    throw new Error("Bilden kunde inte bearbetas. Prova ett annat foto.");
  }
}

export async function closeReceiptOcr() {
  const workers = await Promise.all(workerPromises.map((worker) => worker?.catch(() => null) || null));
  workerPromises.fill(undefined);
  await Promise.all(workers.map((worker) => worker?.terminate()));
}
