#!/usr/bin/env node
// Generates the full synthetic benchmark corpus: one clean receipt content model per (category,
// difficulty) combination goes to `dev`, a second independently-seeded one goes to `holdout`, plus a
// handful of extra dev-only variants for more development-time variety. Deterministic: re-running this
// with the same code produces byte-identical output, because every random choice flows through the
// seeded RNG (see rng.mjs), not Math.random().
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRng, seedFromString } from "./rng.mjs";
import { buildReceipt } from "./build-receipt.mjs";
import { groundTruthFor, idealText } from "./derive.mjs";
import { pickLayout, renderReceiptImage } from "./render.mjs";
import { photograph } from "./transforms.mjs";
import { venueTemplates } from "./data.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const corpusRoot = join(here, "..", "corpus");

const difficulties = ["clean", "normal", "difficult", "pathological"];
const categories = venueTemplates.map((template) => template.category);

async function generateOne({ id, category, difficulty, split }) {
  const rng = makeRng(seedFromString(id));
  const receipt = buildReceipt(rng, { category, difficulty, split, id });
  const layout = pickLayout(rng);
  const { png } = await renderReceiptImage(receipt, layout);
  const { buffer, meta } = await photograph(png, rng, difficulty);
  const groundTruth = { ...groundTruthFor(receipt), idealText: idealText(receipt), photo: meta, layout: { fontFamily: layout.fontFamily, width: layout.width } };
  const dir = join(corpusRoot, split);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.jpg`), buffer);
  await writeFile(join(dir, `${id}.json`), JSON.stringify(groundTruth, null, 2));
  return groundTruth;
}

async function main() {
  const clean = process.argv.includes("--clean");
  if (clean) { await rm(corpusRoot, { recursive: true, force: true }); }

  const plan = [];
  for (const category of categories) {
    for (const difficulty of difficulties) {
      plan.push({ id: `${category}_${difficulty}_dev1`, category, difficulty, split: "dev" });
      plan.push({ id: `${category}_${difficulty}_hold1`, category, difficulty, split: "holdout" });
    }
  }
  // Extra dev-only variety: a second dev sample for every category at normal/difficult tiers, since
  // that's where most real-world receipts and most iteration time land.
  for (const category of categories) {
    for (const difficulty of ["normal", "difficult"]) {
      plan.push({ id: `${category}_${difficulty}_dev2`, category, difficulty, split: "dev" });
    }
  }

  const results = [];
  for (const entry of plan) results.push(await generateOne(entry));

  const summary = { total: results.length, dev: results.filter((r) => r.split === "dev").length, holdout: results.filter((r) => r.split === "holdout").length, byCategory: {}, byDifficulty: {} };
  for (const result of results) {
    summary.byCategory[result.category] = (summary.byCategory[result.category] || 0) + 1;
    summary.byDifficulty[result.difficulty] = (summary.byDifficulty[result.difficulty] || 0) + 1;
  }
  console.log(`Generated ${summary.total} receipts (${summary.dev} dev / ${summary.holdout} holdout)`);
  console.log("By category:", summary.byCategory);
  console.log("By difficulty:", summary.byDifficulty);
  await writeFile(join(corpusRoot, "manifest.json"), JSON.stringify(summary, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
