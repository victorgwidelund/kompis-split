import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

let requestContentType = "";
let requestBody = Buffer.alloc(0);
let responseMode = "normal";
let modeRequestCount = 0;
const server = http.createServer((request, response) => {
  requestContentType = String(request.headers["content-type"] || "");
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    modeRequestCount += 1;
    requestBody = Buffer.concat(chunks);
    const completeRows = [
      "ICA Nära", "2026-08-26 12:34", "2 x Mjölk à 19,90 39,80", "Medlemsrabatt -10,00", "TOTAL 29,80",
    ];
    const rows = responseMode === "retry" && modeRequestCount === 1 ? ["oläsligt"] : completeRows;
    const payload = {
      engine: "mock-rapidocr", width: 800, height: 1200, inferenceMs: 25, queueMs: 0, totalMs: 30,
      lines: rows.map((text, index) => ({
        box: [[10, 20 + index * 30], [500, 20 + index * 30], [500, 40 + index * 30], [10, 40 + index * 30]],
        text, confidence: rows.length === 1 ? 0.2 : 0.96,
      })),
    };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  });
});

test("low evidence triggers one normalized local retry and selects the stronger interpretation", async () => {
  responseMode = "retry"; modeRequestCount = 0;
  const image = await readFile(new URL("./ocr-benchmark/corpus/dev/grocery_clean_dev1.jpg", import.meta.url));
  const result = await recognizeReceipt(image);
  assert.equal(modeRequestCount, 2);
  assert.equal(result.passes, 2);
  assert.equal(result.ai.retried, true);
  assert.equal(result.receipt.totalOre, 2980);
  responseMode = "normal";
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.RECEIPT_INFERENCE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.RECEIPT_INFERENCE_ALLOWED_HOSTS = "127.0.0.1";
process.env.RECEIPT_NORMALIZED_FALLBACK = "true";
const { closeReceiptOcr, recognizeReceipt, receiptInferenceReady } = await import("../dist/receipt-ocr.js");

test("production client sends raw bytes to the local OCR service and returns typed validated evidence", async () => {
  const image = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02]);
  const result = await recognizeReceipt(image);
  assert.equal(requestContentType, "application/octet-stream");
  assert.deepEqual(requestBody, image);
  assert.equal(result.source, "rapidocr");
  assert.equal(result.suggestion.items.length, 1);
  assert.equal(result.receipt.discounts[0].amountOre, 1000);
  assert.equal(result.receipt.totalOre, 2980);
  assert.equal(result.validation.arithmeticDeltaOre, 0);
  assert.equal(result.needsReview, false);
  assert.equal((await receiptInferenceReady()).ready, true);
});

test("receipt inference rejects an allowlisted public Internet host", () => {
  const moduleUrl = pathToFileURL(resolve("dist/receipt-ocr.js")).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { receiptInferenceReady } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await receiptInferenceReady()));`], {
    cwd: resolve("."), encoding: "utf8", env: {
      ...process.env,
      RECEIPT_INFERENCE_URL: "http://api.openai.com/v1",
      RECEIPT_INFERENCE_ALLOWED_HOSTS: "api.openai.com",
    },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).configured, false);
});

test.after(async () => {
  await closeReceiptOcr();
  await new Promise((resolve) => server.close(resolve));
  delete process.env.RECEIPT_INFERENCE_URL;
  delete process.env.RECEIPT_INFERENCE_ALLOWED_HOSTS;
  delete process.env.RECEIPT_NORMALIZED_FALLBACK;
});
