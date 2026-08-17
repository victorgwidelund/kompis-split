// Everything here is derived from the same receipt content model used to render the image, so the
// ground truth, the "ideal OCR transcript", and the rendered pixels can never disagree with each other.
import { money } from "./build-receipt.mjs";

export function groundTruthFor(receipt) {
  return {
    id: receipt.id,
    category: receipt.category,
    difficulty: receipt.difficulty,
    split: receipt.split,
    merchant: receipt.merchant,
    date: receipt.dateIso,
    totalOre: receipt.totalOre,
    items: receipt.items.map((item) => ({ name: item.name, quantity: item.quantity, totalOre: item.totalOre })),
    rejectedMetadata: [...receipt.headerMetadata, ...receipt.footerMetadata],
    discountOre: receipt.discountOre,
  };
}

// A wrapped item name splits its last 1-2 lowercase letters onto their own bare line, mirroring the
// real, production-observed wrap pattern this codebase already has regression tests for (see
// tests/receipt-ocr.test.mjs "a long dish name wrapped..."). Returns [headLine, tailLine, tailHasPrice].
function wrapName(name, priceText, mergeTailWithPrice) {
  const splitAt = name.length > 12 ? name.length - 2 : name.length - 1;
  const head = name.slice(0, splitAt);
  const tail = name.slice(splitAt);
  if (mergeTailWithPrice) return [head, `${tail} ${priceText}`];
  return [head, tail, priceText];
}

function itemLine(item) {
  if (item.quantity > 1 && item.style) return item.style(null, item.quantity, item.name, item.unitOre, item.totalOre);
  return `${item.name} ${money(item.totalOre)}`;
}

export function idealLines(receipt) {
  const lines = [receipt.merchant, receipt.address, ...receipt.headerMetadata, receipt.dateText];
  if (receipt.splitBlock) {
    for (const item of receipt.items) lines.push(`${item.quantity}x ${item.name}`);
    for (const item of receipt.items) lines.push(money(item.totalOre));
  } else {
    for (const item of receipt.items) {
      if (item.wrap) {
        const priceText = money(item.totalOre);
        if (item.wrapMergeTail) { const [head, tailWithPrice] = wrapName(item.name, priceText, true); lines.push(head, tailWithPrice); }
        else { const [head, tail] = wrapName(item.name, priceText, false); lines.push(`1.00 ${head}`, tail, priceText); }
      } else lines.push(itemLine(item));
    }
  }
  if (receipt.discountOre) lines.push(`Rabatt ${money(-receipt.discountOre)}`);
  lines.push(`Moms ${receipt.vatRate}% ${money(receipt.vatOre)}`);
  lines.push(...receipt.footerMetadata);
  lines.push(`${receipt.totalWord} ${money(receipt.totalOre)}`);
  lines.push(receipt.payment);
  return lines;
}

export function idealText(receipt) {
  return idealLines(receipt).join("\n");
}

// Structured rows for the SVG renderer. Simple (qty=1) item rows render as two real visual columns
// (name left, price right on the same baseline) so OCR has to actually reconstruct the row itself --
// exactly the "name and price get column-merged or column-split" failure class this benchmark targets.
// Multi-quantity rows are already one composed string (see itemLine) and render as a single left-aligned
// line, since there's no separate "column" for OCR to lose track of.
export function renderRows(receipt) {
  const rows = [{ kind: "header", text: receipt.merchant }, { kind: "text", text: receipt.address }];
  for (const line of receipt.headerMetadata) rows.push({ kind: "text", text: line });
  rows.push({ kind: "text", text: receipt.dateText });
  rows.push({ kind: "rule" });
  if (receipt.splitBlock) {
    for (const item of receipt.items) rows.push({ kind: "text", text: `${item.quantity}x ${item.name}` });
    for (const item of receipt.items) rows.push({ kind: "text", text: money(item.totalOre) });
  } else {
    for (const item of receipt.items) {
      if (item.wrap) {
        const priceText = money(item.totalOre);
        if (item.wrapMergeTail) {
          const [head, tailWithPrice] = wrapName(item.name, priceText, true);
          rows.push({ kind: "text", text: head }, { kind: "text", text: tailWithPrice, indent: true });
        } else {
          const [head, tail] = wrapName(item.name, priceText, false);
          rows.push({ kind: "row", left: `1.00 ${head}`, right: "" }, { kind: "text", text: tail, indent: true }, { kind: "text", text: priceText, indent: true });
        }
      } else if (item.quantity > 1 && item.style) {
        rows.push({ kind: "text", text: itemLine(item) });
      } else {
        rows.push({ kind: "row", left: item.name, right: money(item.totalOre) });
      }
    }
  }
  rows.push({ kind: "rule" });
  if (receipt.discountOre) rows.push({ kind: "row", left: "Rabatt", right: money(-receipt.discountOre) });
  rows.push({ kind: "row", left: `Moms ${receipt.vatRate}%`, right: money(receipt.vatOre) });
  for (const line of receipt.footerMetadata) rows.push({ kind: "text", text: line });
  rows.push({ kind: "total", left: receipt.totalWord, right: money(receipt.totalOre) });
  rows.push({ kind: "text", text: receipt.payment });
  return rows;
}
