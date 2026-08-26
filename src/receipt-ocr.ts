import { createRequire } from "node:module";
import sharp from "sharp";
import { createWorker, OEM, PSM, type Worker } from "tesseract.js";

const require = createRequire(import.meta.url);
const swedishLanguage = require("@tesseract.js-data/swe") as { langPath: string; gzip: boolean };
function isLocalServiceHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || !host.includes(".")) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const private172 = /^172\.(\d{1,2})\./.exec(host);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return true;
  return /^(?:fc|fd|fe8|fe9|fea|feb)[0-9a-f]*:/i.test(host);
}
function internalHttpUrl(value: string, allowedHosts: Set<string>) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (parsed.protocol !== "http:" || !isLocalServiceHost(hostname) || !allowedHosts.has(hostname) || parsed.username || parsed.password) return null;
    return parsed.href.replace(/\/$/, "");
  } catch { return null; }
}
const receiptInferenceUrl = (() => {
  const value = String(process.env.RECEIPT_INFERENCE_URL || "").trim();
  const allowedHosts = new Set(String(process.env.RECEIPT_INFERENCE_ALLOWED_HOSTS || "receipt-inference,localhost,127.0.0.1,::1")
    .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
  return internalHttpUrl(value, allowedHosts);
})();
const legacyLocalModelHosts = new Set(String(process.env.LEGACY_RECEIPT_MODEL_ALLOWED_HOSTS || "paddleocr,ollama,localhost,127.0.0.1,::1")
  .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
const ollamaModel = String(process.env.OLLAMA_MODEL || "qwen3-vl:4b-instruct-q4_K_M").trim();
const ollamaMaxTokens = Math.min(1_536, Math.max(256, Number(process.env.OLLAMA_OCR_MAX_TOKENS) || 768));
const ollamaUrl = (() => {
  const value = String(process.env.OLLAMA_URL || "").trim();
  return internalHttpUrl(value, legacyLocalModelHosts);
})();
const paddleOcrModel = String(process.env.PADDLEOCR_MODEL || "PaddleOCR-VL-1.6").trim();
const paddleOcrMaxTokens = Math.min(1_024, Math.max(256, Number(process.env.PADDLEOCR_MAX_TOKENS) || 512));
const paddleOcrUrl = (() => {
  const value = String(process.env.PADDLEOCR_URL || "").trim();
  return internalHttpUrl(value, legacyLocalModelHosts);
})();

export type ReceiptSuggestion = {
  title: string | null;
  amount: string | null;
  expenseDate: string | null;
  category: "food" | "travel" | "stay" | "fun" | "other";
  items: Array<{ name: string; quantity: number; amount: string }>;
};

const ignoredMerchantWords = /^(kassa)?kvitto$|^g[äa]stnota$|^välkommen|^tack för|^org\.?\s*nr|^datum|^tid|^tel|^telefon|^www\.|^moms|^total|^summa|^att betala|^butik\s*nr|^[^\s]*örhandsvisning|tillbaka|^bord\b|^kassa\b|^kassör|^beställning|^order\b|^referens|^transaktions?[-\s]?id|^antal\s+g[äa]ster|^g[äa]ster\b|^swish\b/i;
// \p{L}/\p{N} rather than the narrower [A-Za-zÅÄÖåäö0-9]: a name can legitimately carry other Latin
// diacritics Swedish text still borrows ("Frukostbuffé", "Crème brûlée", "Café"). The old ASCII+ÅÄÖ-only
// class silently trimmed a trailing "é" off as if it were punctuation -- confirmed via the OCR benchmark
// corpus ("Frukostbuffé" became "Frukostbuff" after an otherwise-correct quantity/price match).
const leadingNonLetterJunk = /^[^\p{L}]+/u;
const trailingNonNameJunk = /[^\p{L}\p{N})&'. -]+$/u;
const totalWords = /att\s+betala|betalt|kortbelopp|belopp\s+sek|totalt?|f[öo]tatt|summa/i;
// Word-boundaried for the same reason metadataLineWords is (see below): an unanchored "vat" matched
// "Mineralvatten" (mineral water) and "moms" or "vat" as bare substrings could equally catch other
// legitimate Swedish product names -- confirmed via the OCR benchmark corpus, where "Mineralvatten"
// was silently dropped as an item on every hotel-restaurant fixture that ordered it.
const excludedTotalWords = /\bmoms\b|\bvat\b|\bväxel\b|\bchange\b|\brabatt\b|\bsubtotal\b|\bdelsumma\b/i;
// Receipt structure/metadata that must never become a purchased row, even when a nearby unrelated
// price gets merged onto it by the multi-line "name, then price on the next line" OCR heuristic.
// Word-boundaried so real product names are never caught (e.g. a wine called "Bordeaux" must not
// match \bbord\b).
// serveringsavgift/service and tel/telefon/telephone added after a real example (a receipt's phone
// number header and service charge line were both captured as purchased items) -- both are ordinary
// receipt-header/footer content on genuine Swedish kvitton too, not specific to that one example.
const metadataLineWords = /\bbord\b|\bkassa\b|\bkassör(?:en|ska)?\b|\bbeställning\b|\börder\b|\breferens\b|\btransaktions?[-\s]?id\b|\bantal\s+g[äa]ster\b|\bg[äa]ster\b|\bswish\b|\btip\b|\bdricks\b|\bnetto(?:belopp)?\b|\bnet\s+amount\b|\bserveringsavgift\b|\bservice\b|\btelefon(?:nummer)?\b|\btel\b|\btelephone\b|\bphone\b/i;
// Discounts/coupons reduce the total rather than describing something purchased; letting them
// become an "item" both mislabels them and throws off the exact-total reconciliation.
const nonItemAdjustmentWords = /rabatt|kupong|coupon|kampanjpris|medlemspris/i;

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

export type ReceiptOcrEvidenceLine = {
  box: [[number, number], [number, number], [number, number], [number, number]];
  text: string;
  confidence: number;
};

type ReceiptInferenceResponse = {
  engine: string;
  width: number;
  height: number;
  inferenceMs: number;
  queueMs: number;
  totalMs: number;
  lines: ReceiptOcrEvidenceLine[];
};

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
  // A trailing bare 3-5 digit number is only treated as a price with an implied decimal point when it
  // isn't the continuation of a terminal/register code printed on the line above it (e.g.
  // "XCL AT-150-E-18E #1" followed by "3564" — an id fragment, not a SEK amount, despite the same shape)
  // and isn't the year of a complete date on the SAME line, in any of the three formats receiptDate()
  // itself recognizes (ISO, European DD-MM-YYYY/DD/MM/YYYY, or Swedish-worded "11 jul 2025") -- confirmed
  // via the OCR benchmark corpus: without this guard, EVERY European-format date silently lost its year
  // ("19/06/2025" -> "19/06/20.25", no longer matching receiptDate()'s own year pattern at all) and a
  // Swedish-worded date became a fake item ("11 jul 2025" -> item "jul" for 20.25 kr), because a
  // complete date's trailing year satisfies the exact same bare-digit-run shape as a lost-decimal price
  // ("Heineken 13000" -> "Heineken 130.00", which this same regex must still keep repairing).
  const trailingCompleteDate = /\b\d{1,2}[-/.]\d{1,2}[-/.]20\d{2}\b|\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b|\b\d{1,2}\s+(?:jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec)[a-zåäö]*\s+(?:\d{2}|20\d{2})\b/i;
  if (!(previousLine !== undefined && looksLikeSystemCode(previousLine)) && !trailingCompleteDate.test(line)) {
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
const trailingPricePattern = /^(.*\S)(\s+)((?:\d{1,3}(?:[ ,.]\d{3})*|\d+)[,.]\d{2}\s*(?:kr|sek)?)$/i;
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
    .replace(/[×✕]/g, "x")
    .replace(/(\p{L})(\d{1,2})\s*st\b/giu, "$1 $2 st")
    .replace(/\s*[|¦]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()).filter(Boolean);
  const lines = cleaned.map((line, index) => normalizeNumericGlyphs(line, index > 0 ? cleaned[index - 1] : undefined));
  return reuniteWrappedWords(lines);
}

function parseMoney(value: string) {
  // Receipts spell the same amount under at least four conventions: space or period as the thousands
  // separator, comma or period as the decimal mark ("1 234,50", "1.234,50", "1,234.50", "1234.50"). The
  // decimal mark is always whichever "," or "." comes LAST (every caller's regex already constrains the
  // value to end in exactly two digits after it) -- so treat that one as the decimal point and strip
  // every earlier "," or "." as a thousands separator, rather than assuming comma is always decimal.
  const trimmed = value.replace(/\s/g, "");
  const decimalIndex = Math.max(trimmed.lastIndexOf(","), trimmed.lastIndexOf("."));
  const compact = decimalIndex === -1 ? trimmed : `${trimmed.slice(0, decimalIndex).replace(/[,.]/g, "")}.${trimmed.slice(decimalIndex + 1)}`;
  const amount = Number(compact);
  return Number.isFinite(amount) && amount > 0 && amount <= 10_000_000 ? amount : null;
}

function amountCandidates(line: string) {
  return [...line.matchAll(/(?<!\d)(\d{1,3}(?:[ ,.]\d{3})*|\d+)[,.](\d{2})(?!\d)/g)]
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
  const candidates: Array<{ text: string; index: number }> = [];
  lines.slice(0, 14).forEach((line, index) => {
    if (line.length < 2 || line.length > 60 || ignoredMerchantWords.test(line)) return;
    if (amountCandidates(line).length) return;
    const letters = (line.match(/[A-Za-zÅÄÖåäö]/g) || []).length;
    const digits = (line.match(/\d/g) || []).length;
    if (letters < 3 || digits > letters) return;
    // A leading "digit(s)-letter" prefix is kept rather than trimmed as punctuation -- a real Swedish
    // chain is legitimately named that way ("7-Eleven"), and stripping it left an admin-facing title of
    // just "Eleven".
    const keepsLeadingDigits = /^\d{1,2}-[A-Za-zÅÄÖåäö]/.test(line);
    const text = (keepsLeadingDigits ? line : line.replace(leadingNonLetterJunk, "")).replace(trailingNonNameJunk, "").slice(0, 60);
    if (text) candidates.push({ text, index });
  });
  // A merchant's name is often printed twice near the top of a Swedish receipt (once in the header,
  // again just above the order/table details), while a street address only appears once — a candidate
  // repeated verbatim is a much stronger signal of being the actual business name than whichever line
  // happens to have marginally more letters (confirmed against a real receipt: "Strandbryggan" printed
  // twice lost to the single-occurrence "Stranvägskajen 27" on letter count alone before this).
  const repeatCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = candidate.text.toLocaleLowerCase("sv-SE");
    repeatCounts.set(key, (repeatCounts.get(key) || 0) + 1);
  }
  return candidates.sort((first, second) => {
    const repeats = (repeatCounts.get(second.text.toLocaleLowerCase("sv-SE")) || 1) - (repeatCounts.get(first.text.toLocaleLowerCase("sv-SE")) || 1);
    return repeats || merchantNameScore(second.text, second.index) - merchantNameScore(first.text, first.index);
  })[0]?.text || null;
}

// Swedish street/thoroughfare suffixes ("Vasagatan", "Kungsvägen", "Sergels Torg") -- a strong,
// structural (not name-specific) signal that a line is an address rather than a business name. Combined
// with the comma penalty below (street + city are conventionally comma-joined, "Vasagatan 4,
// Stockholm"), this reliably beats a plain letter-count comparison, which previously picked the address
// over the merchant on every short/generic business name that isn't printed twice (confirmed via the
// OCR benchmark corpus: "Fikahörnan" consistently lost to "Vasagatan 4, Stockholm" on letter count alone).
// "gränd" (alley) is intentionally NOT given an ä->a OCR-tolerant variant like "vägen" has: doing so
// would also match "grand" -- a common, legitimate word in real hotel/restaurant names ("Grand Hotel")
// -- trading a rare OCR miss for a much more common false positive (confirmed via the benchmark corpus:
// "Grand Hotellets Matsal" lost to "Terminal 01" once "Grand" itself started scoring as a street name).
const streetSuffixWord = /\b\w*(?:gatan|vägen|v[äa]gen|torget|platsen|gränd(?:en)?|all[ée]n?|planen|backen|stigen|esplanaden)\b/i;
function merchantNameScore(value: string, lineIndex = 0) {
  const letters = (value.match(/[A-Za-zÅÄÖåäö]/g) || []).length;
  const digits = (value.match(/\d/g) || []).length;
  // Word-boundaried (with common Swedish inflection suffixes allowed, e.g. "Grillen") so this only
  // credits the actual business-type word, not any longer compound word that happens to start with the
  // same letters -- an unanchored "butik" matched inside "Butiksgatan" (a street name) and "grill"
  // matched inside "Grillplatsen" (ditto), each wrongly handing an address the same +100 bonus meant to
  // recognize an actual "Restaurang X"/"X Grill" business name.
  const businessWord = /\brestaurang(?:en)?\b|\brestaurant\b|\bste[a-z]{1,3}house\b|\bhotell(?:et)?\b|\bhotel\b|\bcafé\b|\bcafe\b|\bbistro(?:n)?\b|\bbar\b|\bgrill(?:en|et)?\b|\bkrog(?:en)?\b|\bbutik(?:en|er)?\b|\bpizzeria(?:n)?\b/i.test(value);
  const isolatedLetters = (value.match(/(?:^|\s)[A-Za-zÅÄÖåäö](?=\s|$)/g) || []).length;
  const looksLikeStreet = streetSuffixWord.test(value);
  const hasComma = value.includes(",");
  // A street address almost always has a number in it (house number, postcode); a business name
  // almost never does, so a small per-digit penalty helps tell them apart when letter counts are close.
  // The merchant's own name is also reliably one of the very first printed lines (header/logo), so
  // earlier candidates get a bonus rather than relying on letter count alone -- and raw letter count is
  // capped, because real OCR garbage (a misread barcode/noise line) can rack up far more letters than
  // any real business name ever does, and would otherwise silently outscore a short but correct name
  // several lines above it (confirmed via the OCR benchmark's real Tesseract pass: a nonsense 40+
  // letter line beat the correct 14-letter "Pizzeria Napoli" on letter count alone).
  return Math.min(letters, 28) + (businessWord ? 100 : 0) - isolatedLetters * 4 - digits * 3
    - (looksLikeStreet ? 40 : 0) - (hasComma ? 20 : 0) + Math.max(0, 6 - lineIndex) * 3;
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
    // "Öl 2 st 158,00" -- quantity written AFTER the name ("name N st price") instead of before it. The
    // shared quantityPattern below only ever looks at the START of a line, so this row-total format
    // (confirmed missed entirely on every corpus fixture using it: quantity silently fell back to 1 and
    // the trailing digit stuck onto the item's name, e.g. "Cider" became "Cider 2") needs its own check.
    // \p{L} rather than the narrower [A-Za-zÅÄÖåäö]: a dish name can carry other Latin diacritics
    // Swedish text still borrows ("Frukostbuffé", "Crème brûlée"), and requiring the name to end in
    // exactly Å/Ä/Ö silently fell through to the generic path (wrong quantity) for those.
    const trailingCountMatch = /^(.+\p{L})\s+(\d{1,2})\s*st\.?\s+((?:\d{1,3}(?:[ ,.]\d{3})*|\d+)[,.]\d{2})\s*(?:kr|sek)?\s*$/iu.exec(line);
    if (trailingCountMatch) {
      const amount = parseMoney(trailingCountMatch[3]!);
      const name = trailingCountMatch[1]!.replace(leadingNonLetterJunk, "").replace(trailingNonNameJunk, "").slice(0, 100);
      const quantity = Math.min(20, Math.max(1, Number(trailingCountMatch[2])));
      if (amount && (name.match(/[A-Za-zÅÄÖåäö]/g) || []).length >= 2) {
        const key = `${name.toLocaleLowerCase("sv-SE").replace(/[^a-z0-9åäö]/g, "")}|${quantity}|${amount.toFixed(2)}`;
        if (!seen.has(key)) { seen.add(key); items.push({ name, quantity, amount: amount.toFixed(2) }); if (items.length >= 60) break; }
        continue;
      }
    }
    // A menu-numbered item name ("Sushi meny 1", "Pizza nr 5", "Meny 1") followed by its price is
    // genuinely ambiguous with a Swedish thousands-separated amount ("1 234,50", a real, already-tested
    // format -- see receiptTotal): amountCandidates() greedily reads "1 159,90" as one number, 1159.90,
    // silently merging the menu index into the price and corrupting both. A real quantity marker
    // (x/*/",00 ") is always present when a leading number genuinely means quantity (see quantityPattern
    // below); a BARE small number directly before a price, coming right after real name text, is far
    // more likely to be part of the item's own printed name than an unmarked quantity, so treat it that
    // way rather than letting the shared thousands-separator parsing eat it.
    const menuIndexAmbiguity = /^(.*\p{L})\s+(\d{1,2})\s+(\d{3}[,.]\d{2})\s*(?:kr|sek)?\s*$/iu.exec(line);
    if (menuIndexAmbiguity) {
      const amount = parseMoney(menuIndexAmbiguity[3]!);
      const name = `${menuIndexAmbiguity[1]} ${menuIndexAmbiguity[2]}`.replace(leadingNonLetterJunk, "").replace(trailingNonNameJunk, "").slice(0, 100);
      if (amount && (name.match(/[A-Za-zÅÄÖåäö]/g) || []).length >= 2) {
        const key = `${name.toLocaleLowerCase("sv-SE").replace(/[^a-z0-9åäö]/g, "")}|1|${amount.toFixed(2)}`;
        if (!seen.has(key)) { seen.add(key); items.push({ name, quantity: 1, amount: amount.toFixed(2) }); if (items.length >= 60) break; }
        continue;
      }
    }
    const amounts = amountCandidates(line);
    if (!amounts.length || !/\d[,.]\d{2}\s*(?:kr|sek)?\s*$/i.test(line)) continue;
    // Swedish receipts commonly fuse the multiplier to the product ("2xNachos" or
    // "3*Pant burk"). Requiring whitespace after x/* silently turned those into a
    // quantity-one item and lost the printed unit price.
    const quantityPattern = /^\s*(?:[A-Za-z]{1,3}\s+)?(\d{1,2})(?:(?:[,.]0{1,2})\s+|\s*[A-Za-z]?[xX]{1,2}[oO]?\s*|\s*\*\s*)/;
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
      .replace(/(?<!\d)(\d{1,3}(?:[ ,.]\d{3})*|\d+)[,.]\d{2}(?!\d)/g, " ")
      .replace(/\(\s*\)/g, " ")
      .replace(/\b(?:kr|sek|st)\b/gi, " ")
      // A standalone "à" is the "at [unit price] each" marker ("2 x Wine à 131,00 262,00"), not part of
      // the name -- \b doesn't reliably bound a non-ASCII letter like à, so it's matched by surrounding
      // whitespace/string-edges instead of a word-boundary here.
      .replace(/(^|\s)à(\s|$)/gi, " ")
      .replace(/[.·_-]{2,}/g, " ")
      .replace(/\s+/g, " ").trim()
      .replace(/^(?:[oO]{0,2}[1Il|]\s*)?(?:[oO]?[xX][oO]?\s*)/, "")
      .replace(leadingNonLetterJunk, "")
      .replace(trailingNonNameJunk, "")
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

function repairedAmbiguousItemLines(lines: string[]) {
  return lines.map((line) => {
    // PP-OCRv5 consistently confuses the lowercase l in very short Swedish words with the digit 1
    // (for example a two-letter word beginning with Ö). Keep this character-level rather than
    // product-specific, and only offer it as a candidate here; arithmetic validation below decides
    // whether the candidate is allowed to affect the returned receipt.
    let repaired = line.replace(
      /(^|[^\p{L}\p{N}])([\u00c5\u00c4\u00d6\u00e5\u00e4\u00f6])1(?=\s+\d{1,6}[,.]\d{2}\s*(?:kr|sek)?\s*$)/gu,
      "$1$2l",
    );

    // A leading price digit can likewise be fused to the final letter of a long item name and read
    // as l/I/| ("...burgarel27,86" instead of "...burgare 127,86"). Requiring a substantial name
    // prefix avoids treating legitimate compact names such as "Öl27,86" as 127,86. This remains only
    // a candidate until the complete receipt total proves it is the better interpretation.
    const fusedPrice = /^(.*\p{L})([lI|])(\d{2,3}[,.]\d{2}\s*(?:kr|sek)?\s*)$/u.exec(repaired);
    if (fusedPrice && (fusedPrice[1]!.match(/\p{L}/gu) || []).length >= 5) {
      repaired = `${fusedPrice[1]} 1${fusedPrice[3]}`;
    }
    return repaired;
  });
}

function receiptItemsWithArithmeticRepair(lines: string[], total: number | null) {
  const original = receiptItems(lines);
  if (total === null) return original;
  const repairedLines = repairedAmbiguousItemLines(lines);
  if (repairedLines.every((line, index) => line === lines[index])) return original;
  const repaired = receiptItems(repairedLines);
  const discountOre = lines
    .filter((line) => nonItemAdjustmentWords.test(line))
    .reduce((sum, line) => sum + Math.round((amountCandidates(line).at(-1) ?? 0) * 100), 0);
  const totalOre = Math.round(total * 100);
  const expectedItemTotalsOre = [totalOre, totalOre + discountOre];
  const deltaOre = (items: ReturnType<typeof receiptItems>) => Math.min(...expectedItemTotalsOre.map((expected) =>
    Math.abs(items.reduce((sum, item) => sum + Math.round(Number(item.amount) * 100), 0) - expected)));
  const originalDeltaOre = deltaOre(original);
  const repairedDeltaOre = deltaOre(repaired);
  return repairedDeltaOre <= 1 && repairedDeltaOre < originalDeltaOre ? repaired : original;
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
    items: receiptItemsWithArithmeticRepair(lines, total),
  };
}

export type ReceiptItemUnit = "st" | "kg" | "g" | "l" | "ml" | "cl" | "m" | "other";
export type ReceiptEvidence = { lineIndexes: number[]; rawLines: string[] };
export type StructuredReceiptItem = {
  rawName: string | null;
  normalizedName: string | null;
  kind: "product" | "pant" | "fee" | "discount" | "unknown";
  quantity: number | null;
  unit: ReceiptItemUnit | null;
  unitPriceOre: number | null;
  lineTotalOre: number | null;
  weightGrams: number | null;
  multipack: { count: number | null; unitSize: number | null; unit: ReceiptItemUnit | null } | null;
  discountOre: number | null;
  pantOre: number | null;
  confidence: number;
  evidence: ReceiptEvidence;
};
export type StructuredReceipt = {
  merchant: string | null;
  date: string | null;
  time: string | null;
  receiptNumber: string | null;
  currency: string | null;
  items: StructuredReceiptItem[];
  subtotalOre: number | null;
  discounts: Array<{ label: string | null; amountOre: number | null; evidence: ReceiptEvidence }>;
  vat: Array<{ rateBasisPoints: number | null; netOre: number | null; vatOre: number | null; grossOre: number | null; evidence: ReceiptEvidence }>;
  totalOre: number | null;
  pantTotalOre: number | null;
  payments: Array<{ method: string | null; amountOre: number | null; evidence: ReceiptEvidence }>;
};
export type ReceiptValidation = {
  confidence: number;
  needsReview: boolean;
  arithmeticDeltaOre: number | null;
  signals: Array<{ code: string; severity: "info" | "warning" | "error"; value?: number | string | null }>;
};

function explicitMoneyValuesOre(line: string) {
  return [...line.matchAll(/(?<!\d)([-−]?\s*(?:\d{1,3}(?:[ .]\d{3})*|\d+)[,.]\d{2})(?!\d)/g)]
    .flatMap((match) => {
      const negative = /^[-−]/.test(match[1]!.trim());
      const value = parseMoney(match[1]!.replace(/^[-−]\s*/, ""));
      return value === null ? [] : [Math.round(value * 100) * (negative ? -1 : 1)];
    });
}

function evidenceFor(lines: string[], index: number): ReceiptEvidence {
  return { lineIndexes: [index], rawLines: [lines[index]!] };
}

function findEvidenceLine(lines: string[], item: ReceiptSuggestion["items"][number]) {
  const normalizedName = normalizedItemName(item.name);
  const amountOre = itemCents(item);
  let best = -1;
  let bestScore = -1;
  lines.forEach((line, index) => {
    const values = explicitMoneyValuesOre(line).map(Math.abs);
    const lineName = normalizedItemName(line.replace(/[-−]?\s*\d[\d .]*[,.]\d{2}/g, " "));
    const score = (values.includes(amountOre) ? 3 : 0) + (lineName.includes(normalizedName) || normalizedName.includes(lineName) ? 2 : 0);
    if (score > bestScore) { best = index; bestScore = score; }
  });
  return bestScore >= 2 ? best : -1;
}

function firstMatchingLineAmount(lines: string[], pattern: RegExp) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!pattern.test(lines[index]!)) continue;
    const amounts = explicitMoneyValuesOre(lines[index]!);
    if (amounts.length) return { amountOre: Math.abs(amounts.at(-1)!), index };
    const nextAmounts = explicitMoneyValuesOre(lines[index + 1] ?? "");
    if (nextAmounts.length) return { amountOre: Math.abs(nextAmounts[0]!), index: index + 1 };
  }
  return null;
}

/** Receipt-specific semantic representation. Missing fields stay null and every extracted detail
 * retains the source line that justified it. All monetary values are integer öre. */
export function parseStructuredReceipt(text: string, ocrConfidence = 0, now = new Date()): { receipt: StructuredReceipt; validation: ReceiptValidation } {
  const lines = normalizedLines(text);
  const rawLines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const suggestion = parseReceiptText(text, now);
  const totalOre = amountCents(suggestion.amount);
  const timePattern = /(?:^|\s)([01]?\d|2[0-3])[:.]([0-5]\d)(?=\s|$)/;
  const timeLines = [
    ...rawLines.filter((line) => /\b(?:datum|date)\b|\b20\d{2}[-/.]|\b\d{1,2}[-/.]\d{1,2}[-/.]20\d{2}\b/i.test(line)),
    ...rawLines.filter((line) => !/\b(?:datum|date)\b|\b20\d{2}[-/.]|\b\d{1,2}[-/.]\d{1,2}[-/.]20\d{2}\b/i.test(line)),
  ];
  const time = timeLines.flatMap((line) => {
    const match = timePattern.exec(line);
    return match ? [`${match[1]!.padStart(2, "0")}:${match[2]}`] : [];
  })[0] ?? null;
  const receiptNumberMatch = rawLines.map((line) => /\b(?:kvitto|receipt|verifikat)(?:\s*nr|nummer|#)?\s*[:#]?\s*([A-Z0-9-]{3,30})\b/i.exec(line)).find(Boolean);
  const subtotal = firstMatchingLineAmount(lines, /\b(?:subtotal|delsumma|summa\s+varor)\b/i);
  const pantTotal = firstMatchingLineAmount(lines, /\b(?:pant|returpack)\s*(?:totalt|summa)?\b/i);

  const discountLines = lines.flatMap((line, index) => {
    if (!/(?:rabatt|kupong|coupon|kampanj|medlemspris)/i.test(line)) return [];
    const values = explicitMoneyValuesOre(line);
    if (!values.length) return [];
    return [{ label: line.replace(/[-−]?\s*\d[\d .]*[,.]\d{2}.*/, "").trim() || null, amountOre: Math.abs(values.at(-1)!), evidence: evidenceFor(lines, index) }];
  });

  const structuredItems: StructuredReceiptItem[] = suggestion.items.map((item) => {
    const index = findEvidenceLine(lines, item);
    const rawLine = index >= 0 ? lines[index]! : item.name;
    const explicitAmounts = explicitMoneyValuesOre(rawLine).map(Math.abs);
    const quantityUnit = /(?<!\d)(\d+(?:[,.]\d+)?)\s*(kg|g|ml|cl|l|st)\b/i.exec(rawLine);
    const unitPriceMatch = /(?:\bx\b|\*|à)\s*((?:\d{1,3}(?:[ .]\d{3})*|\d+)[,.]\d{2})/i.exec(rawLine);
    const multipackMatch = /\b(\d{1,2})\s*[x*]\s*(\d+(?:[,.]\d+)?)\s*(kg|g|ml|cl|l)\b/i.exec(rawLine);
    const unit = quantityUnit?.[2]?.toLowerCase() as ReceiptItemUnit | undefined;
    const numericQuantity = quantityUnit ? Number(quantityUnit[1]!.replace(",", ".")) : item.quantity;
    const isWeight = unit === "kg" || unit === "g";
    const weightGrams = isWeight && Number.isFinite(numericQuantity) ? Math.round(numericQuantity * (unit === "kg" ? 1000 : 1)) : null;
    const kind = /\b(?:pant|returpack)\b/i.test(item.name) ? "pant" : /\b(?:serviceavgift|serveringsavgift|avgift)\b/i.test(item.name) ? "fee" : "product";
    const lineTotalOre = itemCents(item);
    return {
      rawName: item.name,
      normalizedName: item.name.normalize("NFKC").replace(/\s+/g, " ").trim(),
      kind,
      quantity: Number.isFinite(numericQuantity) ? numericQuantity : null,
      unit: unit ?? (item.quantity >= 1 ? "st" : null),
      unitPriceOre: unitPriceMatch ? Math.abs(explicitMoneyValuesOre(unitPriceMatch[1]!).at(-1) ?? 0) || null
        : explicitAmounts.length > 1 && item.quantity > 1 ? explicitAmounts.at(-2)! : null,
      lineTotalOre,
      weightGrams,
      multipack: multipackMatch ? {
        count: Number(multipackMatch[1]),
        unitSize: Number(multipackMatch[2]!.replace(",", ".")),
        unit: multipackMatch[3]!.toLowerCase() as ReceiptItemUnit,
      } : null,
      discountOre: null,
      pantOre: kind === "pant" ? lineTotalOre : null,
      confidence: index >= 0 ? Math.max(0, Math.min(100, ocrConfidence)) : Math.max(0, Math.min(100, ocrConfidence - 20)),
      evidence: index >= 0 ? evidenceFor(lines, index) : { lineIndexes: [], rawLines: [] },
    };
  });

  const vat = lines.flatMap((line, index) => {
    if (!/\b(?:moms|vat)\b/i.test(line)) return [];
    const rate = /\b(\d{1,2}(?:[,.]\d+)?)\s*%/.exec(line);
    const amounts = explicitMoneyValuesOre(line).map(Math.abs);
    if (!rate && !amounts.length) return [];
    return [{
      rateBasisPoints: rate ? Math.round(Number(rate[1]!.replace(",", ".")) * 100) : null,
      netOre: amounts.length >= 3 ? amounts.at(-3)! : null,
      vatOre: amounts.length >= 2 ? amounts.at(-2)! : amounts.length === 1 ? amounts[0]! : null,
      grossOre: amounts.length >= 3 ? amounts.at(-1)! : null,
      evidence: evidenceFor(lines, index),
    }];
  });
  const payments = lines.flatMap((line, index) => {
    const method = /\b(swish|visa|mastercard|kort|kontant|cash)\b/i.exec(line)?.[1];
    if (!method) return [];
    const amounts = explicitMoneyValuesOre(line).map(Math.abs);
    return [{ method: method.toLocaleLowerCase("sv-SE"), amountOre: amounts.at(-1) ?? null, evidence: evidenceFor(lines, index) }];
  });
  const itemSum = structuredItems.reduce((sum, item) => sum + (item.lineTotalOre ?? 0), 0);
  const discountSum = discountLines.reduce((sum, discount) => sum + (discount.amountOre ?? 0), 0);
  const calculatedTotal = structuredItems.length && structuredItems.every((item) => item.lineTotalOre !== null) ? itemSum - discountSum : null;
  const arithmeticDeltaOre = calculatedTotal !== null && totalOre !== null ? calculatedTotal - totalOre : null;
  const duplicateCount = structuredItems.length - new Set(structuredItems.map((item) => `${normalizedItemName(item.normalizedName ?? "")}|${item.quantity}|${item.lineTotalOre}`)).size;
  const signals: ReceiptValidation["signals"] = [];
  if (totalOre === null) signals.push({ code: "missing_total", severity: "error" });
  if (!structuredItems.length) signals.push({ code: "missing_items", severity: "error" });
  if (ocrConfidence < 70) signals.push({ code: "low_ocr_confidence", severity: "warning", value: ocrConfidence });
  if (duplicateCount) signals.push({ code: "duplicate_rows", severity: "warning", value: duplicateCount });
  if (arithmeticDeltaOre !== null && Math.abs(arithmeticDeltaOre) > 1) signals.push({ code: "total_mismatch", severity: Math.abs(arithmeticDeltaOre) > 100 ? "error" : "warning", value: arithmeticDeltaOre });
  if (arithmeticDeltaOre !== null && Math.abs(arithmeticDeltaOre) <= 1) signals.push({ code: "arithmetic_reconciled", severity: "info", value: arithmeticDeltaOre });
  let confidence = Math.max(0, Math.min(100, ocrConfidence));
  if (arithmeticDeltaOre !== null && Math.abs(arithmeticDeltaOre) <= 1) confidence = Math.min(100, confidence + 5);
  for (const signal of signals) confidence -= signal.severity === "error" ? 25 : signal.severity === "warning" ? 10 : 0;
  confidence = Math.max(0, Math.round(confidence));
  const receipt: StructuredReceipt = {
    merchant: suggestion.title,
    date: suggestion.expenseDate,
    time,
    receiptNumber: receiptNumberMatch?.[1] ?? null,
    currency: /\bSEK\b|\bkr\b/i.test(text) ? "SEK" : null,
    items: structuredItems,
    subtotalOre: subtotal?.amountOre ?? null,
    discounts: discountLines,
    vat,
    totalOre,
    pantTotalOre: pantTotal?.amountOre ?? (structuredItems.some((item) => item.kind === "pant") ? structuredItems.reduce((sum, item) => sum + (item.pantOre ?? 0), 0) : null),
    payments,
  };
  return { receipt, validation: { confidence, needsReview: signals.some((signal) => signal.severity !== "info"), arithmeticDeltaOre, signals } };
}

function amountCents(value: string | null) {
  return value === null ? null : Math.round(Number(value) * 100);
}

function itemCents(item: ReceiptSuggestion["items"][number]) {
  return Math.round(Number(item.amount) * 100);
}

export function editDistance(first: string, second: string) {
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

export function normalizedItemName(value: string) {
  return value.toLocaleLowerCase("sv-SE").replace(/[^a-z0-9åäö]/g, "");
}

// Name-only similarity (ignores quantity) -- used by the OCR benchmark to match a predicted item to its
// ground-truth counterpart independently of whether the quantity was read correctly, so a wrong
// quantity is scored as its own metric rather than silently also counting as "item not found."
export function namesSimilar(firstName: string, secondName: string) {
  const left = normalizedItemName(firstName); const right = normalizedItemName(secondName);
  return left === right || editDistance(left, right) <= Math.max(2, Math.floor(Math.max(left.length, right.length) * 0.18));
}

function similarItem(first: ReceiptSuggestion["items"][number], second: ReceiptSuggestion["items"][number]) {
  return first.quantity === second.quantity && namesSimilar(first.name, second.name);
}

function sameItem(first: ReceiptSuggestion["items"][number], second: ReceiptSuggestion["items"][number]) {
  return itemCents(first) === itemCents(second) && similarItem(first, second);
}

function receiptPassScore(pass: ReceiptPass) {
  const total = amountCents(pass.suggestion.amount);
  const itemTotal = pass.suggestion.items.reduce((sum, item) => sum + itemCents(item), 0);
  const exact = total !== null && itemTotal === total;
  const coverage = total && itemTotal <= total ? itemTotal / total : 0;
  // items.length was uncapped and worth 10x more than a full 0-100 confidence swing, so a pass could
  // win purely by finding MORE lines -- including OCR noise/fragments that aren't real items -- even
  // against a pass with visibly higher per-image OCR confidence and cleaner text. Real example: a
  // difficult-tier receipt where Tesseract's cleaner first pass (5 items, confidence 80) lost to its
  // own noisier second pass (7 items, confidence 64, one item a garbled non-word, one a split-off
  // fragment of another) purely on item count. Capping the item bonus at 3 items' worth preserves the
  // existing balance for short receipts (where "found more lines" is still a strong, cheap signal --
  // the AI-vs-Tesseract merge test below relies on exactly this) while removing the incentive to
  // out-hallucinate a cleaner pass on longer, noisier receipts specifically. Confidence's weight was
  // raised only enough to matter as a tie-breaker once the item-count bonus is capped out, not enough
  // to override it outright -- AI passes carry a fixed per-method trust value here (70/85/92/94, not a
  // real per-image signal the way Tesseract's is), so weighting confidence too aggressively made a
  // 1-item AI pass beat a 2-item Tesseract pass regardless of coverage (caught by the existing "local AI
  // receipt output is validated and merged by exact öre" test).
  return (exact ? 1_000_000 : 0) + Math.min(pass.suggestion.items.length, 3) * 10_000 + Math.round(coverage * 1_000) + pass.confidence * 30;
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

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function geometryRows(lines: ReceiptOcrEvidenceLine[], rowFactor = 0.45) {
  if (!lines.length) return [] as ReceiptOcrEvidenceLine[][];
  const angles = lines.map(({ box }) => {
    const horizontal: [number, number] = [box[1][0] - box[0][0], box[1][1] - box[0][1]];
    const vertical: [number, number] = [box[3][0] - box[0][0], box[3][1] - box[0][1]];
    const edge = Math.hypot(...horizontal) >= Math.hypot(...vertical) ? horizontal : vertical;
    let angle = Math.atan2(edge[1], edge[0]);
    while (angle >= Math.PI / 2) angle -= Math.PI;
    while (angle < -Math.PI / 2) angle += Math.PI;
    return angle;
  });
  const angle = median(angles);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const projected = lines.map((line) => {
    const points = line.box.map(([x, y]) => [x * cosine + y * sine, -x * sine + y * cosine]);
    const xs = points.map(([x]) => x!);
    const ys = points.map(([, y]) => y!);
    return { line, x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2, height: Math.max(...ys) - Math.min(...ys) };
  });
  const typicalHeight = Math.max(1, median(projected.map(({ height }) => height)));
  const groups: Array<{ y: number; height: number; lines: typeof projected }> = [];
  for (const line of projected.sort((left, right) => left.y - right.y || left.x - right.x)) {
    let best: typeof groups[number] | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const group of groups) {
      const distance = Math.abs(line.y - group.y);
      if (distance <= rowFactor * Math.max(typicalHeight, line.height, group.height) && distance < bestDistance) {
        best = group;
        bestDistance = distance;
      }
    }
    if (!best) groups.push({ y: line.y, height: line.height, lines: [line] });
    else {
      best.lines.push(line);
      best.y = best.lines.reduce((sum, entry) => sum + entry.y, 0) / best.lines.length;
      best.height = median(best.lines.map((entry) => entry.height));
    }
  }
  return groups.sort((left, right) => left.y - right.y)
    .map((group) => group.lines.sort((left, right) => left.x - right.x).map(({ line }) => line));
}

function evidenceCandidateScore(text: string) {
  const suggestion = parseReceiptText(text);
  const total = amountCents(suggestion.amount);
  const itemTotal = suggestion.items.reduce((sum, item) => sum + itemCents(item), 0);
  const normalized = text.split("\n").map((line) => line.toLocaleLowerCase("sv-SE"));
  const totalIndex = normalized.findIndex((line) => /\b(total|summa|att betala)\b/.test(line));
  const paymentIndex = normalized.findIndex((line) => /\b(visa|mastercard|swish|betalt|kort|kontant)\b/.test(line));
  let score = Math.min(suggestion.items.length, 16) * 20;
  if (total !== null) score += 100;
  if (total !== null && suggestion.items.length && total === itemTotal) score += 2_000;
  if (suggestion.expenseDate) score += 80;
  if (suggestion.title) score += 40;
  if (totalIndex >= Math.floor(normalized.length * 0.4)) score += 120;
  if (paymentIndex > totalIndex && totalIndex >= 0) score += 40;
  return score;
}

/** Converts OCR boxes to reading order while considering 180°/upside-down evidence. */
export function rapidOcrEvidenceText(lines: ReceiptOcrEvidenceLine[]) {
  const rows = geometryRows(lines);
  const forward = rows.map((row) => row.map((line) => line.text).join(" ")).join("\n");
  const reverse = [...rows].reverse().map((row) => [...row].reverse().map((line) => line.text).join(" ")).join("\n");
  return [forward, reverse].sort((left, right) => evidenceCandidateScore(right) - evidenceCandidateScore(left))[0] ?? "";
}

type ReceiptInferenceAttempt = { response: ReceiptInferenceResponse | null; status: string; durationMs: number };

async function recognizeWithReceiptInference(content: Buffer, cancelled?: AbortSignal): Promise<ReceiptInferenceAttempt> {
  const startedAt = Date.now();
  if (!receiptInferenceUrl) return { response: null, status: "disabled", durationMs: 0 };
  try {
    const timeout = Math.min(60_000, Math.max(1_000, Number(process.env.RECEIPT_INFERENCE_TIMEOUT_MS) || 15_000));
    const response = await fetch(`${receiptInferenceUrl}/v1/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(content.length) },
      body: new Uint8Array(content),
      signal: cancelled ? AbortSignal.any([AbortSignal.timeout(timeout), cancelled]) : AbortSignal.timeout(timeout),
    });
    if (!response.ok) return { response: null, status: `http_${response.status}`, durationMs: Date.now() - startedAt };
    const payload = await response.json() as Partial<ReceiptInferenceResponse>;
    if (!Array.isArray(payload.lines) || typeof payload.engine !== "string") {
      return { response: null, status: "invalid_response", durationMs: Date.now() - startedAt };
    }
    const lines = payload.lines.filter((line): line is ReceiptOcrEvidenceLine =>
      Boolean(line && typeof line.text === "string" && typeof line.confidence === "number" && Array.isArray(line.box) && line.box.length === 4));
    return {
      response: {
        engine: payload.engine,
        width: Number(payload.width) || 0,
        height: Number(payload.height) || 0,
        inferenceMs: Number(payload.inferenceMs) || 0,
        queueMs: Number(payload.queueMs) || 0,
        totalMs: Number(payload.totalMs) || Date.now() - startedAt,
        lines,
      },
      status: "ok",
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { response: null, status: cancelled?.aborted ? "cancelled" : timeout ? "timeout" : "connection_error", durationMs: Date.now() - startedAt };
  }
}

export async function receiptInferenceReady() {
  if (!receiptInferenceUrl) return { configured: false, ready: false, status: "disabled" } as const;
  try {
    const response = await fetch(`${receiptInferenceUrl}/ready`, { signal: AbortSignal.timeout(1_500) });
    return { configured: true, ready: response.ok, status: response.ok ? "ready" : `http_${response.status}` } as const;
  } catch {
    return { configured: true, ready: false, status: "unreachable" } as const;
  }
}

type AiAttempt = { pass: ReceiptPass | null; status: string; durationMs: number; httpStatus?: number };

function logOcr(event: Record<string, string | number | boolean | null | undefined>) {
  console.info(`[receipt-ocr] ${JSON.stringify(event)}`);
}

// Never log OCR text, even under a debug flag: receipt contents may contain payment metadata and are
// more sensitive than ordinary diagnostics. Aggregate counts/timings are sufficient for operations.
function logSnippet(_text: string) { return undefined; }

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
  // The production schema-v2 path is the dedicated self-hosted OCR service. If it is configured but
  // temporarily unavailable, degrade to bundled Tesseract without starting a second speculative model.
  if (receiptInferenceUrl) return Promise.resolve({ pass: null, status: "replaced_by_receipt_inference", durationMs: 0 } satisfies AiAttempt);
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

async function prepareEvidenceFallbackImage(content: Buffer) {
  return sharp(content, { limitInputPixels: maxReceiptInputPixels, failOn: "error" })
    .rotate().flatten({ background: "#ffffff" })
    .resize({ width: 3000, height: 3000, fit: "inside", withoutEnlargement: false })
    .grayscale().normalize({ lower: 1, upper: 99 }).sharpen({ sigma: 0.55 })
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
}

function interpretedEvidence(response: ReceiptInferenceResponse) {
  const text = rapidOcrEvidenceText(response.lines);
  const suggestion = parseReceiptText(text);
  const confidence = response.lines.length
    ? Math.round(response.lines.reduce((sum, line) => sum + line.confidence, 0) / response.lines.length * 100)
    : 0;
  const structured = parseStructuredReceipt(text, confidence);
  const errorCount = structured.validation.signals.filter((signal) => signal.severity === "error").length;
  const warningCount = structured.validation.signals.filter((signal) => signal.severity === "warning").length;
  return { text, suggestion, confidence, structured, score: evidenceCandidateScore(text) + confidence * 3 - errorCount * 1_000 - warningCount * 100 };
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

export async function recognizeReceipt(content: Buffer, cancelled?: AbortSignal) {
  const scanId = `${Date.now().toString(36)}-${(++nextScanId).toString(36)}`;
  const startedAt = Date.now();
  const inferenceAttempts = [await recognizeWithReceiptInference(content, cancelled)];
  let selectedResponse = inferenceAttempts[0]!.response;
  let interpreted = selectedResponse ? interpretedEvidence(selectedResponse) : null;
  let fallbackPreparationMs = 0;
  // Disabled by default: controlled dev-v2 measurement found that the normalized second pass reduced
  // item F1 (91.3% -> 89.9%) and raised P95 latency (~1.41s -> ~4.10s). It remains an explicit
  // diagnostic switch, not hidden production work.
  const retryForEvidence = receiptInferenceUrl && String(process.env.RECEIPT_NORMALIZED_FALLBACK || "false").toLowerCase() === "true" && (
    inferenceAttempts[0]!.status === "http_422"
    || Boolean(interpreted && (interpreted.structured.validation.needsReview || interpreted.confidence < 70 || interpreted.suggestion.items.length === 0))
  );
  if (retryForEvidence && !cancelled?.aborted) {
    try {
      const preparationStarted = performance.now();
      const normalized = await prepareEvidenceFallbackImage(content);
      fallbackPreparationMs = performance.now() - preparationStarted;
      const retry = await recognizeWithReceiptInference(normalized, cancelled);
      inferenceAttempts.push(retry);
      if (retry.response) {
        const retryInterpreted = interpretedEvidence(retry.response);
        if (!interpreted || retryInterpreted.score > interpreted.score) {
          interpreted = retryInterpreted;
          selectedResponse = retry.response;
        }
      }
    } catch { /* Original evidence or bundled Tesseract remains available. */ }
  }
  if (selectedResponse && interpreted) {
    const { suggestion, confidence, structured } = interpreted;
    const total = amountCents(suggestion.amount);
    const itemTotal = suggestion.items.reduce((sum, item) => sum + itemCents(item), 0);
    const needsReview = structured.validation.needsReview;
    const successfulResponses = inferenceAttempts.flatMap((attempt) => attempt.response ? [attempt.response] : []);
    const result = {
      confidence,
      suggestion,
      receipt: structured.receipt,
      validation: structured.validation,
      passes: successfulResponses.length,
      source: "rapidocr" as const,
      cropped: false,
      rectified: false,
      ai: {
        model: selectedResponse.engine,
        status: "ok",
        durationMs: Date.now() - startedAt,
        used: true,
        retried: inferenceAttempts.length > 1,
      },
      needsReview,
      timings: {
        preprocessingMs: fallbackPreparationMs + successfulResponses.reduce((sum, response) => sum + Math.max(0, response.totalMs - response.inferenceMs - response.queueMs), 0),
        ocrMs: successfulResponses.reduce((sum, response) => sum + response.inferenceMs, 0),
        queueMs: successfulResponses.reduce((sum, response) => sum + response.queueMs, 0),
        parsingAndValidationMs: Math.max(0, Date.now() - startedAt - successfulResponses.reduce((sum, response) => sum + response.totalMs, 0) - fallbackPreparationMs),
        totalMs: Date.now() - startedAt,
      },
    };
    logOcr({ scanId, stage: "complete", source: result.source, ocrStatus: "ok", durationMs: result.timings.totalMs, inferenceMs: result.timings.ocrMs, queueMs: result.timings.queueMs, items: suggestion.items.length, balanced: total !== null && total === itemTotal, confidence, retried: result.ai.retried });
    return result;
  }
  if (receiptInferenceUrl) logOcr({ scanId, stage: "inference", source: "rapidocr", status: inferenceAttempts.at(-1)!.status, durationMs: Date.now() - startedAt, retried: inferenceAttempts.length > 1 });
  if (cancelled?.aborted) throw new Error("Receipt scan cancelled");
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
    // Must be images.ai (the color image actually prepared for the vision model, wrapped correctly as
    // real JPEG bytes), not images.grayscale (desaturated PNG prepared for Tesseract's own pass below,
    // and mislabeled as image/jpeg if sent here regardless). The verification pass exists to re-ask the
    // *same* well-prepared image with a different seed (see the seed: verification ? ... in
    // paddleOcrReceiptRequest/ollamaReceiptRequest) as a self-consistency check -- sending it a
    // materially different, worse-suited image instead defeats that, and a bad second answer can still
    // win combineReceiptPasses()'s scoring and overwrite an otherwise-good first read.
    verificationAttempt = await recognizeWithDocumentAi(images.ai, true);
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
