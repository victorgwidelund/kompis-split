// Renders a receipt content model to a PNG image via SVG + Sharp -- the same "build markup, rasterize
// with Sharp" technique already used for the iPhone-preview-chrome test fixture in
// tests/receipt-ocr.test.mjs, just parameterized instead of hand-written per receipt.
import sharp from "sharp";
import { renderRows } from "./derive.mjs";

const fontFamilies = [
  "Courier New, monospace",
  "Consolas, monospace",
  "Arial, sans-serif",
  "Verdana, sans-serif",
  "Helvetica, Arial, sans-serif",
];

function escapeXml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function pickLayout(rng) {
  return {
    width: rng.pick([360, 420, 480, 560]),
    fontFamily: rng.pick(fontFamilies),
    fontSize: rng.int(15, 20),
    lineHeight: rng.float() * 6 + 24,
    boldTotal: rng.chance(0.7),
  };
}

export async function renderReceiptImage(receipt, layout) {
  const rows = renderRows(receipt);
  const paddingX = Math.round(layout.width * 0.07);
  const paddingTop = 26;
  const paddingBottom = 30;
  const lineHeight = layout.lineHeight;
  const height = Math.round(paddingTop + paddingBottom + rows.length * lineHeight + 40);
  const width = layout.width;
  const centerX = width / 2;
  const rightX = width - paddingX;

  let y = paddingTop + layout.fontSize;
  const parts = [];
  for (const row of rows) {
    if (row.kind === "rule") { parts.push(`<line x1="${paddingX}" y1="${y - layout.fontSize / 2}" x2="${rightX}" y2="${y - layout.fontSize / 2}" stroke="#000" stroke-width="1" stroke-dasharray="3,2"/>`); y += lineHeight * 0.6; continue; }
    if (row.kind === "header") {
      parts.push(`<text x="${centerX}" y="${y}" font-family="${layout.fontFamily}" font-size="${layout.fontSize + 4}" font-weight="700" text-anchor="middle">${escapeXml(row.text)}</text>`);
      y += lineHeight * 1.15; continue;
    }
    if (row.kind === "text") {
      const x = row.indent ? paddingX + 22 : centerX;
      const anchor = row.indent ? "start" : "middle";
      parts.push(`<text x="${x}" y="${y}" font-family="${layout.fontFamily}" font-size="${layout.fontSize}" text-anchor="${anchor}">${escapeXml(row.text)}</text>`);
      y += lineHeight; continue;
    }
    if (row.kind === "row" || row.kind === "total") {
      const weight = row.kind === "total" && layout.boldTotal ? "700" : "400";
      const size = row.kind === "total" ? layout.fontSize + 1 : layout.fontSize;
      parts.push(`<text x="${paddingX}" y="${y}" font-family="${layout.fontFamily}" font-size="${size}" font-weight="${weight}" text-anchor="start">${escapeXml(row.left)}</text>`);
      if (row.right) parts.push(`<text x="${rightX}" y="${y}" font-family="${layout.fontFamily}" font-size="${size}" font-weight="${weight}" text-anchor="end">${escapeXml(row.right)}</text>`);
      y += lineHeight; continue;
    }
  }
  // A decorative (non-textual) barcode strip at the foot of the receipt -- realism only, contributes no
  // ground-truth text so it can never affect scoring, but exercises the same visual "noise" a real
  // printed barcode adds near the numbers OCR has to read.
  const barcodeY = y + 10;
  let barcodeBars = "";
  let barX = centerX - 70;
  for (let index = 0; index < 40; index += 1) {
    const barWidth = 1 + (index % 3);
    if (index % 2 === 0) barcodeBars += `<rect x="${barX}" y="${barcodeY}" width="${barWidth}" height="26" fill="#000"/>`;
    barX += barWidth + 1.5;
  }

  const svg = `<svg width="${width}" height="${height + 70}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${height + 70}" fill="#ffffff"/>
    ${parts.join("\n")}
    ${barcodeBars}
  </svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return { png, width, height: height + 70 };
}
