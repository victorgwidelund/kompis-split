#!/usr/bin/env node
// Aggregate-only evaluator for a committed external final corpus. It deliberately never prints or
// writes fixture ids, OCR text, truth, predictions, or per-fixture scores.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { aggregateOcrScoresV2, scoreOcrFixtureV2 } from "../../dist/ocr-benchmark.js";
import { canonicalJson, sha256, verifyBundle, withExclusiveLock } from "./generator-v2/integrity.mjs";
import { typedScanResult } from "./v2-adapter.mjs";

function parseArgs(argv) {
  const result = { bundle: "", candidateModule: "", candidateId: "", ledger: "", timeoutMs: 30_000 };
  for (const argument of argv) {
    const [key, value = ""] = argument.split("=", 2);
    if (key === "--bundle") result.bundle = value;
    else if (key === "--candidate-module") result.candidateModule = value;
    else if (key === "--candidate-id") result.candidateId = value;
    else if (key === "--ledger") result.ledger = value;
    else if (key === "--timeout-ms") result.timeoutMs = Math.min(120_000, Math.max(1_000, Number(value) || 30_000));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  for (const [name, value] of Object.entries({ bundle: result.bundle, candidateModule: result.candidateModule, ledger: result.ledger })) {
    if (!value || !isAbsolute(value)) throw new Error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be an absolute path`);
  }
  if (!/^[a-z0-9][a-z0-9._-]{2,80}$/i.test(result.candidateId)) throw new Error("--candidate-id must be a stable opaque identifier");
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const verified = await verifyBundle(options.bundle, { repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), requireExternal: true });
  if (verified.manifest.kind !== "sealed-final") throw new Error("Only a sealed-final corpus can be evaluated here");
  await mkdir(dirname(options.ledger), { recursive: true });
  await withExclusiveLock(`${options.ledger}.lock`, async () => {
    let ledger = [];
    try { ledger = JSON.parse(await readFile(options.ledger, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    const commitment = verified.commitment.manifestSha256;
    if (ledger.some((entry) => entry.candidateId === options.candidateId && entry.commitmentSha256 === commitment)) {
      throw new Error("This candidate has already consumed its one sealed-final evaluation");
    }
    const candidate = await import(pathToFileURL(resolve(options.candidateModule)).href + `?sealed=${Date.now()}`);
    if (typeof candidate.recognizeReceipt !== "function") throw new Error("Candidate module does not export recognizeReceipt");
    const truthFiles = verified.manifest.files.filter((entry) => entry.path.startsWith("truth/")).sort((left, right) => left.path.localeCompare(right.path, "en"));
    const scores = [];
    const started = performance.now();
    const originalInfo = console.info;
    console.info = () => {};
    try {
      for (const truthEntry of truthFiles) {
        const truth = JSON.parse(await readFile(join(verified.bundle, ...truthEntry.path.split("/")), "utf8"));
        const imagePath = join(verified.bundle, "images", `${truth.id}.jpg`);
        const image = await readFile(imagePath);
        const scanStarted = performance.now();
        let scan;
        let timedOut = false;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs);
          try {
            const result = await candidate.recognizeReceipt(image, controller.signal);
            scan = typedScanResult(result, performance.now() - scanStarted);
          } finally { clearTimeout(timer); }
        } catch (error) {
          scan = { schemaVersion: 2, status: "failure", receipt: null, source: null, needsReview: null,
            failureStage: timedOut || error?.name === "AbortError" ? "timeout" : "unknown", failureCode: "candidate_failure",
            latencyMs: performance.now() - scanStarted, stageLatencyMs: {} };
        }
        scores.push(scoreOcrFixtureV2(truth, scan));
      }
    } finally {
      console.info = originalInfo;
      if (typeof candidate.closeReceiptOcr === "function") await candidate.closeReceiptOcr();
    }
    const overall = aggregateOcrScoresV2(scores);
    const byDifficulty = Object.fromEntries([...new Set(scores.map((score) => score.difficulty))].sort().map((difficulty) => [difficulty, aggregateOcrScoresV2(scores.filter((score) => score.difficulty === difficulty))]));
    const report = {
      format: "kompis-receipt-sealed-evaluation/v1", candidateId: options.candidateId,
      commitmentSha256: commitment, evaluatedAt: new Date().toISOString(), wallMs: performance.now() - started,
      overall, byDifficulty,
    };
    const reportHash = sha256(Buffer.from(canonicalJson(report)));
    ledger.push({ candidateId: options.candidateId, commitmentSha256: commitment, evaluatedAt: report.evaluatedAt, reportSha256: reportHash, report });
    await writeFile(options.ledger, canonicalJson(ledger), "utf8");
    console.log(canonicalJson(report));
  });
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
