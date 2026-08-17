// Builds a receipt CONTENT model (no image yet): which lines exist, in what order, with what exact
// öre amounts, and what quantity notation style is used. Ground truth is derived directly from this
// model, and both the "ideal OCR text" (for parser-only benchmarking) and the rendered image (for real
// image-pipeline benchmarking) are generated from the same source of truth, so they can never disagree.
import { venueTemplates, metadataPools, paymentLines, totalWordVariants } from "./data.mjs";

const quantityStyles = [
  (rng, qty, name, unit, total) => `${qty} x ${name} ${money(unit)} ${money(total)}`,
  (rng, qty, name, unit, total) => `${qty}x ${name} ${money(total)}`,
  (rng, qty, name, unit, total) => `${name} ${qty} st ${money(total)}`,
  (rng, qty, name, unit, total) => `${qty} x ${name} ${money(total)}`,
];

function money(ore) {
  const sign = ore < 0 ? "-" : "";
  const abs = Math.abs(ore);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

function isoDate(rng) {
  const now = new Date("2026-08-17T12:00:00Z");
  const daysAgo = rng.int(0, 550);
  const date = new Date(now.getTime() - daysAgo * 86_400_000);
  return date.toISOString().slice(0, 10);
}

const swedishMonths = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
function formatDate(iso, format) {
  const [year, month, day] = iso.split("-").map(Number);
  if (format === "iso") return iso;
  if (format === "slash") return `${year}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
  if (format === "european-dash") return `${String(day).padStart(2, "0")}-${String(month).padStart(2, "0")}-${year}`;
  if (format === "european-slash") return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
  if (format === "swedish-words") return `${day} ${swedishMonths[month - 1]} ${year}`;
  return iso;
}

// Difficulty controls CONTENT complexity (independent of the later photo-realism transform, which
// controls IMAGE complexity) -- a "difficult" receipt has more items, denser metadata, and a wrapped
// name even before any blur/rotation is applied.
const difficultyProfiles = {
  clean: { itemCount: [3, 5], metadataCount: [1, 2], wrapChance: 0, splitBlockChance: 0, discountChance: 0.1 },
  normal: { itemCount: [4, 7], metadataCount: [2, 4], wrapChance: 0.15, splitBlockChance: 0.1, discountChance: 0.2 },
  difficult: { itemCount: [5, 9], metadataCount: [3, 6], wrapChance: 0.3, splitBlockChance: 0.25, discountChance: 0.3 },
  pathological: { itemCount: [6, 10], metadataCount: [4, 7], wrapChance: 0.4, splitBlockChance: 0.35, discountChance: 0.35 },
};

export function buildReceipt(rng, { category, difficulty, split, id }) {
  const template = category ? venueTemplates.find((entry) => entry.category === category) : rng.pick(venueTemplates);
  const profile = difficultyProfiles[difficulty];
  const merchant = rng.pick(template.merchants);
  const address = rng.pick(template.addresses);
  const dateIso = isoDate(rng);
  const dateFormat = rng.pick(["iso", "slash", "european-dash", "european-slash", "swedish-words"]);

  const itemCount = rng.int(...profile.itemCount);
  const pool = rng.shuffle(template.items);
  const chosen = pool.slice(0, Math.min(itemCount, pool.length));
  const items = chosen.map((entry, index) => {
    const unitOre = rng.int(entry.price[0], entry.price[1]);
    const quantity = entry.multi && rng.chance(0.5) ? rng.int(2, difficulty === "pathological" ? 6 : 4) : 1;
    const totalOre = unitOre * quantity;
    // Wrap-rendering (see renderRows) always prints a hardcoded "1.00" prefix and never consults
    // item.style, so a wrapped name silently drops any real quantity > 1 -- restrict wrapping to
    // quantity===1 items rather than teaching the renderer a name-wrap + multi-quantity combination it
    // doesn't need to support yet.
    const wrap = index === 0 && quantity === 1 && rng.chance(profile.wrapChance) && entry.name.length > 10;
    const wrapMergeTail = wrap && rng.chance(0.5);
    const style = quantity > 1 ? rng.pick(quantityStyles) : null;
    return { name: entry.name, quantity, unitOre, totalOre, wrap, wrapMergeTail, style };
  });

  let discountOre = 0;
  if (template.discounts && rng.chance(profile.discountChance)) {
    discountOre = Math.min(Math.round(items[0].totalOre * 0.15), rng.int(1000, 3000));
  }
  let pantOre = 0;
  const pantItems = [];
  if (template.pant && rng.chance(0.4)) {
    const count = rng.int(1, 3);
    pantOre = count * 200;
    // A quantity > 1 must always be rendered through one of the quantityStyles (never style:null with a
    // pre-multiplied total and no visible count) -- otherwise the printed line never shows the "3"
    // anywhere, making the count structurally unrecoverable from the text and the ground truth unfair.
    pantItems.push({ name: "Pant burk", quantity: count, unitOre: 200, totalOre: pantOre, wrap: false, style: count > 1 ? rng.pick(quantityStyles) : null });
  }

  const itemsSubtotal = items.reduce((sum, item) => sum + item.totalOre, 0) + pantOre;
  const totalOre = itemsSubtotal - discountOre;
  const vatOre = Math.round((totalOre * template.vatRate) / (100 + template.vatRate));

  const metadataCount = template.tables ? rng.int(...profile.metadataCount) : rng.int(0, Math.max(0, profile.metadataCount[0] - 1));
  const metadataKeys = rng.shuffle(Object.keys(metadataPools)).slice(0, metadataCount);
  const headerMetadata = metadataKeys.filter((_, index) => index % 2 === 0).map((key) => metadataPools[key](rng));
  const footerMetadata = metadataKeys.filter((_, index) => index % 2 === 1).map((key) => metadataPools[key](rng));

  const payment = rng.pick(Object.values(paymentLines));
  const totalWord = rng.pick(totalWordVariants);
  const splitBlock = rng.chance(profile.splitBlockChance) && items.every((item) => item.quantity === 1) && items.length >= 3;

  return {
    id, category: template.category, difficulty, split,
    merchant, address, dateIso, dateFormat, dateText: formatDate(dateIso, dateFormat),
    items: [...items, ...pantItems], discountOre, pantOre, vatRate: template.vatRate, vatOre,
    totalOre, totalWord, payment, headerMetadata, footerMetadata, splitBlock,
  };
}

export { money };
