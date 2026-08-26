#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { buildReceipt, money } from "../generator/build-receipt.mjs";
import { idealText } from "../generator/derive.mjs";
import { pickLayout, renderReceiptImage } from "../generator/render.mjs";
import { makeRng } from "../generator/rng.mjs";
import { photograph } from "../generator/transforms.mjs";
import { createScenarioPlan, REQUIRED_SCENARIO_TAGS, scenarioCoverage } from "./scenarios.mjs";
import {
  COMMITMENT_FORMAT, CORPUS_FORMAT, MARKER_FILE, atomicWrite, canonicalJson, deriveFixtureSeed,
  hashFile, markOutputComplete, prepareOutputDirectory, sha256,
} from "./integrity.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const categories = ["grocery", "restaurant", "cafe", "bar", "fastfood", "takeaway", "convenience", "hotel_restaurant"];

function args(argv) {
  const values = { kind: "dev", output: "", secretFile: "", replace: false };
  for (const argument of argv) {
    if (argument === "--replace") values.replace = true;
    else if (argument.startsWith("--kind=")) values.kind = argument.slice(7);
    else if (argument.startsWith("--output=")) values.output = argument.slice(9);
    else if (argument.startsWith("--secret-file=")) values.secretFile = argument.slice(14);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!values.output) throw new Error("--output must be an explicit absolute path");
  if (!["dev", "sealed-final"].includes(values.kind)) throw new Error("--kind must be dev or sealed-final");
  if (values.kind === "sealed-final" && !values.secretFile) throw new Error("sealed-final requires --secret-file outside the repository");
  return values;
}

function applyContentScenario(receipt, scenario, rng) {
  receipt.dateText = `${receipt.dateText} ${String(rng.int(8, 21)).padStart(2, "0")}:${String(rng.int(0, 59)).padStart(2, "0")}`;
  receipt.time = receipt.dateText.match(/(\d{2}:\d{2})$/)?.[1] ?? null;
  receipt.receiptNumber = `${rng.int(100, 999)}-${rng.int(10_000, 99_999)}`;
  receipt.headerMetadata.push(`Kvitto nr ${receipt.receiptNumber}`);
  if (scenario.content.quantityStyle && receipt.items[0]) {
    const item = receipt.items[0];
    item.quantity = Math.max(2, Math.round(item.quantity));
    item.totalOre = item.unitOre * item.quantity;
    const marker = scenario.content.quantityStyle === "star" ? "*" : "x";
    item.style = (_rng, quantity, name, unitOre, totalOre) => `${quantity}${marker}${name} ${money(unitOre)} ${money(totalOre)}`;
  }
  if (scenario.content.weight && receipt.items[0]) {
    const item = receipt.items[0];
    item.quantity = rng.int(180, 1450) / 1000;
    item.unit = "kg";
    item.weightGrams = Math.round(item.quantity * 1000);
    item.unitOre = rng.int(1990, 15990);
    item.totalOre = Math.round(item.quantity * item.unitOre);
    item.style = (_rng, quantity, name, unitOre, totalOre) => `${name} ${String(quantity.toFixed(3)).replace(".", ",")} kg x ${money(unitOre)} ${money(totalOre)}`;
  }
  if (scenario.content.multipack && receipt.items[1]) {
    const item = receipt.items[1];
    item.multipack = { count: rng.pick([4, 6, 8]), unitSize: rng.pick([25, 33, 50]), unit: "cl" };
    item.name = `${item.name} ${item.multipack.count}x${item.multipack.unitSize}cl`;
  }
  if ((scenario.content.discount || scenario.content.campaign) && !receipt.discountOre) {
    receipt.discountOre = Math.min(Math.max(100, Math.round(receipt.items[0].totalOre * 0.12)), 2500);
  }
  if (scenario.content.pant && !receipt.items.some((item) => /pant/i.test(item.name))) {
    const quantity = rng.int(1, 4);
    receipt.items.push({ name: "Pant burk", quantity, unitOre: 200, totalOre: quantity * 200, wrap: false, unit: "st", pantOre: quantity * 200, style: (_rng, q, name, unitOre, totalOre) => `${q}*${name} ${money(unitOre)} ${money(totalOre)}` });
  }
  if (scenario.content.duplicateProducts && receipt.items[0]) {
    const base = receipt.items[0];
    receipt.items.splice(1, 0, { ...base, name: `${base.name} Eko`, totalOre: base.totalOre + 300, unitOre: base.unitOre + 300, wrap: false });
  }
  if (scenario.content.long) {
    const originals = [...receipt.items];
    while (receipt.items.length < 16) {
      const base = originals[receipt.items.length % originals.length];
      receipt.items.push({ ...base, name: `${base.name} ${receipt.items.length + 1}`, wrap: false });
    }
  }
  receipt.pantOre = receipt.items.reduce((sum, item) => sum + (item.pantOre ?? (/pant/i.test(item.name) ? item.totalOre : 0)), 0);
  receipt.itemsSubtotal = receipt.items.reduce((sum, item) => sum + item.totalOre, 0);
  receipt.totalOre = receipt.itemsSubtotal - receipt.discountOre;
  receipt.vatOre = Math.round((receipt.totalOre * receipt.vatRate) / (100 + receipt.vatRate));
  if (scenario.content.payment === "cash") receipt.payment = `Kontant ${money(receipt.totalOre)} Växel 0,00`;
  else if (scenario.content.payment === "swish") receipt.payment = `Swish ${money(receipt.totalOre)}`;
  else if (scenario.content.payment === "card-detailed") receipt.payment = `VISA **** ${rng.int(1000, 9999)} ${money(receipt.totalOre)}`;
  if (scenario.content.mixedVat) receipt.footerMetadata.push(`Moms 12% ${money(Math.round(receipt.vatOre / 2))}`);
  return receipt;
}

function solveLinear(matrix, vector) {
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < vector.length; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < vector.length; row += 1) if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    if (Math.abs(divisor) < 1e-9) throw new Error("Perspective transform is singular");
    for (let entry = column; entry <= vector.length; entry += 1) augmented[column][entry] /= divisor;
    for (let row = 0; row < vector.length; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let entry = column; entry <= vector.length; entry += 1) augmented[row][entry] -= factor * augmented[column][entry];
    }
  }
  return augmented.map((row) => row.at(-1));
}

function invert3(matrix) {
  const [a, b, c, d, e, f, g, h, i] = matrix.flat();
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    [(e * i - f * h) / determinant, (c * h - b * i) / determinant, (b * f - c * e) / determinant],
    [(f * g - d * i) / determinant, (a * i - c * g) / determinant, (c * d - a * f) / determinant],
    [(d * h - e * g) / determinant, (b * g - a * h) / determinant, (a * e - b * d) / determinant],
  ];
}

async function projectiveWarp(buffer, direction) {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = info.width; const height = info.height;
  const margin = direction === "steep" ? 0.2 : 0.1;
  const destination = direction === "left"
    ? [[margin * width, 0], [width - 1, margin * height], [(1 - margin / 2) * width, height - 1], [0, (1 - margin) * height]]
    : direction === "right"
      ? [[0, margin * height], [(1 - margin) * width, 0], [width - 1, (1 - margin) * height], [margin / 2 * width, height - 1]]
      : [[margin * width, 0], [(1 - margin) * width, margin * height], [width - 1, (1 - margin / 2) * height], [0, height - 1]];
  const source = [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]];
  const equations = []; const values = [];
  for (let index = 0; index < 4; index += 1) {
    const [x, y] = source[index]; const [u, v] = destination[index];
    equations.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); values.push(u);
    equations.push([0, 0, 0, x, y, 1, -v * x, -v * y]); values.push(v);
  }
  const [a, b, c, d, e, f, g, h] = solveLinear(equations, values);
  const inverse = invert3([[a, b, c], [d, e, f], [g, h, 1]]);
  const output = Buffer.alloc(width * height * 3, 225);
  for (let targetY = 0; targetY < height; targetY += 1) {
    for (let targetX = 0; targetX < width; targetX += 1) {
      const denominator = inverse[2][0] * targetX + inverse[2][1] * targetY + inverse[2][2];
      const sourceX = (inverse[0][0] * targetX + inverse[0][1] * targetY + inverse[0][2]) / denominator;
      const sourceY = (inverse[1][0] * targetX + inverse[1][1] * targetY + inverse[1][2]) / denominator;
      if (sourceX < 0 || sourceY < 0 || sourceX >= width - 1 || sourceY >= height - 1) continue;
      const left = Math.floor(sourceX); const top = Math.floor(sourceY); const xFraction = sourceX - left; const yFraction = sourceY - top;
      for (let channel = 0; channel < 3; channel += 1) {
        const topLeft = data[(top * width + left) * 3 + channel];
        const topRight = data[(top * width + left + 1) * 3 + channel];
        const bottomLeft = data[((top + 1) * width + left) * 3 + channel];
        const bottomRight = data[((top + 1) * width + left + 1) * 3 + channel];
        output[(targetY * width + targetX) * 3 + channel] = Math.round(
          topLeft * (1 - xFraction) * (1 - yFraction) + topRight * xFraction * (1 - yFraction)
          + bottomLeft * (1 - xFraction) * yFraction + bottomRight * xFraction * yFraction,
        );
      }
    }
  }
  return sharp(output, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

async function photoScenario(cleanPng, receipt, scenario, rng) {
  const photographed = await photograph(cleanPng, rng, scenario.difficulty, {
    extraVerticalFrame: scenario.photo.frameFill && scenario.photo.frameFill < 0.5 ? 1.8 : 1,
  });
  let baseBuffer = photographed.buffer;
  if (scenario.photo.perspective) {
    baseBuffer = await projectiveWarp(baseBuffer, scenario.photo.perspective);
  }
  let image = sharp(baseBuffer).rotate(Number(scenario.photo.rightAngle || 0));
  if (scenario.photo.exposure) image = image.modulate({ brightness: Math.min(1.38, Math.max(0.55, scenario.photo.exposure)) });
  if (scenario.photo.contrast) image = image.linear(scenario.photo.contrast, 128 * (1 - scenario.photo.contrast));
  const blur = Number(scenario.photo.blurSigma || (scenario.photo.motionBlur ? Number(scenario.photo.motionBlur) / 5 : 0));
  if (blur >= 0.3) image = image.blur(Math.min(10, blur));
  if (scenario.photo.hardShadow || scenario.photo.fold || scenario.photo.crumple) {
    const metadata = await image.metadata();
    const width = metadata.width; const height = metadata.height;
    const opacity = scenario.photo.hardShadow ? 0.42 : 0.2;
    const overlay = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="s"><stop stop-color="black" stop-opacity="${opacity}"/><stop offset="1" stop-color="black" stop-opacity="0"/></linearGradient></defs><path d="M0 0 L${Math.round(width * 0.62)} 0 L${Math.round(width * 0.35)} ${height} L0 ${height}Z" fill="url(#s)"/>${scenario.photo.fold ? `<rect x="${Math.round(width / 2)}" width="5" height="${height}" fill="black" opacity=".25"/>` : ""}</svg>`);
    image = image.composite([{ input: overlay, top: 0, left: 0 }]);
  }
  if (scenario.photo.cropBottom) {
    const metadata = await image.metadata();
    image = image.extract({ left: 0, top: 0, width: metadata.width, height: Math.max(1, Math.round(metadata.height * (1 - scenario.photo.cropBottom))) });
  }
  if (scenario.photo.frameFill && scenario.photo.frameFill < 0.5) {
    let materialized = await image.toBuffer();
    let metadata = await sharp(materialized).metadata();
    const projectedLongEdge = Math.max(metadata.width, metadata.height) / scenario.photo.frameFill;
    if (projectedLongEdge > 3200) {
      const scale = 3200 / projectedLongEdge;
      materialized = await sharp(materialized).resize({ width: Math.max(1, Math.round(metadata.width * scale)), height: Math.max(1, Math.round(metadata.height * scale)), fit: "fill" }).toBuffer();
      metadata = await sharp(materialized).metadata();
    }
    image = sharp(materialized);
    const horizontal = Math.round(metadata.width * (1 / scenario.photo.frameFill - 1) / 2);
    const vertical = Math.round(metadata.height * (1 / scenario.photo.frameFill - 1) / 2);
    image = image.extend({ top: vertical, bottom: vertical, left: horizontal, right: horizontal, background: "#7c746b" });
  }
  return { buffer: await image.jpeg({ quality: scenario.photo.jpegQuality || 84 }).toBuffer(), photo: { ...photographed.meta, ...scenario.photo } };
}

function truthFor(receipt, fixtureId, scenario, ideal) {
  const idealLines = ideal.split("\n");
  const items = receipt.items.map((item, index) => ({
    id: `item-${index + 1}`, rawName: item.name, normalizedName: item.name, kind: /pant/i.test(item.name) ? "pant" : "product",
    quantity: item.quantity, unit: item.unit ?? "st",
    unitPriceOre: item.quantity !== 1 && idealLines.some((line) => line.includes(item.name) && line.includes(money(item.unitOre)) && line.includes(money(item.totalOre))) ? item.unitOre : null,
    lineTotalOre: item.totalOre,
    weightGrams: item.weightGrams ?? null, multipack: item.multipack ?? null, discountOre: null,
    pantOre: /pant/i.test(item.name) ? item.totalOre : null,
  }));
  const vat = [{ rateBasisPoints: receipt.vatRate * 100, netOre: null, vatOre: receipt.vatOre, grossOre: null }];
  if (scenario.content.mixedVat) vat.push({ rateBasisPoints: 1200, netOre: null, vatOre: Math.round(receipt.vatOre / 2), grossOre: null });
  const paymentMethod = /\b(swish|kontant|visa|mastercard|kort)\b/i.exec(receipt.payment)?.[1]?.toLocaleLowerCase("sv-SE") ?? null;
  return {
    schemaVersion: 2, id: fixtureId, category: receipt.category, difficulty: scenario.difficulty,
    split: receipt.split,
    scenarioTags: scenario.tags, expectedStatus: scenario.expectedStatus, idealText: ideal,
    receipt: {
      merchant: receipt.merchant, date: receipt.dateIso, time: receipt.time, receiptNumber: receipt.receiptNumber,
      currency: null, items, subtotalOre: null,
      discounts: receipt.discountOre ? [{ id: "discount-1", label: scenario.content.campaign ? "Kampanjrabatt" : "Rabatt", amountOre: receipt.discountOre, itemId: null }] : [],
      vat, totalOre: receipt.totalOre, pantTotalOre: receipt.pantOre || null,
      payments: paymentMethod ? [{ method: paymentMethod, amountOre: /\d+[,.]\d{2}/.test(receipt.payment) ? receipt.totalOre : null }] : [],
    },
    rejectedMetadata: [...receipt.headerMetadata, ...receipt.footerMetadata, receipt.payment],
    reviewExpected: scenario.expectedStatus !== "readable",
  };
}

async function main() {
  const options = args(process.argv.slice(2));
  const plan = createScenarioPlan(options.kind);
  const secret = options.kind === "sealed-final"
    ? (await readFile(resolve(options.secretFile))).toString("utf8").trim()
    : "public-kompis-receipt-development-v2";
  if (secret.length < 24) throw new Error("Corpus seed secret must contain at least 24 characters");
  const expectedFiles = [MARKER_FILE, "manifest.json", "commitment.json", ...plan.flatMap(({ fixtureId }) => [`images/${fixtureId}.jpg`, `truth/${fixtureId}.json`])];
  const { output, marker } = await prepareOutputDirectory(resolve(options.output), { repoRoot, kind: options.kind, replace: options.replace, expectedFiles });
  await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).jpeg().toFile(join(output, ".probe.jpg"));
  await import("node:fs/promises").then(({ unlink, mkdir }) => Promise.all([unlink(join(output, ".probe.jpg")), mkdir(join(output, "images")), mkdir(join(output, "truth"))]));
  const files = [];
  for (let index = 0; index < plan.length; index += 1) {
    const { fixtureId, variant, scenario } = plan[index];
    const seed = deriveFixtureSeed(secret, fixtureId);
    const rng = makeRng(seed.readUInt32LE(0));
    const receipt = applyContentScenario(buildReceipt(rng, { category: categories[(index + variant) % categories.length], difficulty: scenario.difficulty, split: options.kind, id: fixtureId }), scenario, rng);
    const layout = pickLayout(rng);
    const ideal = idealText(receipt);
    const clean = await renderReceiptImage(receipt, layout);
    const photographed = await photoScenario(clean.png, receipt, scenario, rng);
    const imagePath = join(output, "images", `${fixtureId}.jpg`);
    const truthPath = join(output, "truth", `${fixtureId}.json`);
    await atomicWrite(imagePath, photographed.buffer);
    await atomicWrite(truthPath, canonicalJson({ ...truthFor(receipt, fixtureId, scenario, ideal), photo: photographed.photo }));
    for (const [path, relative] of [[imagePath, `images/${fixtureId}.jpg`], [truthPath, `truth/${fixtureId}.json`]]) files.push({ path: relative, ...await hashFile(path) });
  }
  const coverage = scenarioCoverage(plan);
  for (const tag of REQUIRED_SCENARIO_TAGS) if (!coverage.byTag[tag]) throw new Error(`Missing required scenario tag: ${tag}`);
  const manifest = { format: CORPUS_FORMAT, kind: options.kind, fixtureCount: plan.length, generatedAt: new Date().toISOString(), generatorVersion: 1, coverage, files: files.sort((a, b) => a.path.localeCompare(b.path, "en")) };
  const manifestText = canonicalJson(manifest);
  const commitment = { format: COMMITMENT_FORMAT, manifestSha256: sha256(Buffer.from(manifestText)), fixtureCount: plan.length, kind: options.kind };
  await atomicWrite(join(output, "manifest.json"), manifestText);
  await atomicWrite(join(output, "commitment.json"), canonicalJson(commitment));
  await markOutputComplete(output, marker, commitment.manifestSha256);
  console.log(JSON.stringify({ kind: options.kind, fixtureCount: plan.length, commitmentSha256: commitment.manifestSha256, coverage }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
