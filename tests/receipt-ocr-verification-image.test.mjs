// Separate file (not appended to receipt-ocr.test.mjs) because it needs PADDLEOCR_URL set *before*
// receipt-ocr.js is first evaluated -- that module reads it into a module-level constant at import
// time, and node --test runs each file in its own process, so this can't interfere with the normal
// "no AI configured" tests elsewhere.
//
// Regression test for a real bug: the AI verification/"double-check" retry was sending
// images.grayscale (a desaturated PNG prepared for Tesseract's own pass, mislabeled as image/jpeg) to
// the vision model instead of images.ai (the real color JPEG prepared for it) -- so a "second look" was
// actually a materially worse, wrongly-labeled image, not a genuine self-consistency check.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import sharp from "sharp";

test("the AI verification retry sends the same well-prepared color image as the first pass, not the grayscale Tesseract image", async () => {
  const capturedImages = [];
  const mockPaddleOcr = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const dataUrl = body.messages[0].content[0].image_url.url;
      capturedImages.push(Buffer.from(dataUrl.split(",")[1], "base64"));
      response.writeHead(200, { "Content-Type": "application/json" });
      // Deliberately item-less/unbalanced on every call so the code always proceeds to the
      // verification retry after the first pass -- the test only cares what image each call received.
      response.end(JSON.stringify({ choices: [{ message: { content: "Butiken\nTOTALT 10,00" }, finish_reason: "stop" }], usage: {} }));
    });
  });
  await new Promise((resolve) => mockPaddleOcr.listen(0, resolve));
  process.env.PADDLEOCR_URL = `http://127.0.0.1:${mockPaddleOcr.address().port}`;
  process.env.PADDLEOCR_ACCURATE_RETRY = "true";

  const { recognizeReceipt, closeReceiptOcr } = await import("../dist/receipt-ocr.js");
  try {
    const blankImage = await sharp({ create: { width: 320, height: 120, channels: 3, background: "white" } }).jpeg().toBuffer();
    await recognizeReceipt(blankImage);
    assert.equal(capturedImages.length, 2, "expected a first AI pass and a verification retry");
    for (const [index, bytes] of capturedImages.entries()) {
      // A real JPEG starts with the FF D8 FF magic bytes; the grayscale image is a PNG (89 50 4E 47)
      // that would fail this check despite being wrapped in a "data:image/jpeg" label.
      assert.equal(bytes[0], 0xff, `pass ${index + 1}'s image should be a real JPEG (byte 0)`);
      assert.equal(bytes[1], 0xd8, `pass ${index + 1}'s image should be a real JPEG (byte 1)`);
      assert.equal(bytes[2], 0xff, `pass ${index + 1}'s image should be a real JPEG (byte 2)`);
    }
  } finally {
    // Not awaiting mockPaddleOcr.close(): closing it here as well as terminating the Tesseract workers
    // in the same tick reliably hit a native libuv handle-closing assertion on Windows. The process
    // exits (via --test-force-exit, the same flag every OCR test already needs) right after this test
    // finishes, so leaking one already-served-its-purpose local mock server is harmless.
    await closeReceiptOcr();
    mockPaddleOcr.close();
    delete process.env.PADDLEOCR_URL;
    delete process.env.PADDLEOCR_ACCURATE_RETRY;
  }
});
