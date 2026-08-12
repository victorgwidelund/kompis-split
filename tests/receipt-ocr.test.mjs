import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { closeReceiptOcr, combineReceiptPasses, paddleOcrReceiptRequest, parseOllamaReceipt, parseReceiptText, prepareReceiptImages, recognizeReceipt } from "../dist/receipt-ocr.js";

test("PaddleOCR receipt requests use the documented OCR prompt without forced JSON", () => {
  const request = paddleOcrReceiptRequest(Buffer.from("test-image"));
  assert.equal(request.stream, false);
  assert.equal(request.model, "PaddleOCR-VL-1.6");
  assert.equal(request.max_tokens, 512);
  assert.equal(request.messages[0].content[1].text, "OCR:");
  assert.match(request.messages[0].content[0].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal("format" in request, false);
});

test("PaddleOCR name and price blocks are paired without losing quantities", () => {
  const suggestion = parseReceiptText(`
    RESTAURANG MAIZ
    Sankt Eriksgatan 92
    2019-10-29 18:01
    2x Läsk
    1x Asado
    1x Atun
    1x Zetas
    1x Chicharron
    1x Pollo
    1x Crudo
    1x Salmon
    64,00
    68,00
    69,00
    62,00
    96,00
    89,00
    59,00
    55,00
    TOTALT (kr)
    562,00
  `, new Date("2026-08-11T12:00:00Z"));
  assert.equal(suggestion.title, "RESTAURANG MAIZ");
  assert.equal(suggestion.amount, "562.00");
  assert.equal(suggestion.expenseDate, "2019-10-29");
  assert.deepEqual(suggestion.items, [
    { name: "Läsk", quantity: 2, amount: "64.00" },
    { name: "Asado", quantity: 1, amount: "68.00" },
    { name: "Atun", quantity: 1, amount: "69.00" },
    { name: "Zetas", quantity: 1, amount: "62.00" },
    { name: "Chicharron", quantity: 1, amount: "96.00" },
    { name: "Pollo", quantity: 1, amount: "89.00" },
    { name: "Crudo", quantity: 1, amount: "59.00" },
    { name: "Salmon", quantity: 1, amount: "55.00" },
  ]);
  assert.equal(suggestion.items.reduce((sum, item) => sum + Math.round(Number(item.amount) * 100), 0), 56_200);
});

test("an unreadable explicit total is not replaced by the largest item price", () => {
  const suggestion = parseReceiptText("1x Asado 68,00\n1x Atun 69,00\nTOTALT (kr)");
  assert.equal(suggestion.amount, null);
  assert.deepEqual(suggestion.items.map((item) => item.amount), ["68.00", "69.00"]);
});

test("Swedish receipt fields are extracted as editable suggestions", () => {
  const suggestion = parseReceiptText(`
    RESTAURANG HÖRNET
    Storgatan 1 Stockholm
    Datum 2026-08-10 19:42
    Mat 100,00
    Moms 12% 132,00
    TOTALT 1 234,50
  `, new Date("2026-08-11T12:00:00Z"));
  assert.deepEqual(suggestion, {
    title: "RESTAURANG HÖRNET",
    amount: "1234.50",
    expenseDate: "2026-08-10",
    category: "food",
    items: [{ name: "Mat", quantity: 1, amount: "100.00" }],
  });
});

test("receipt rows and quantities are extracted for quick tab claiming", () => {
  const suggestion = parseReceiptText(`
    BISTRO KAJEN
    2 x Lager 65,00 130,00
    Fish and chips 189,00
    MOMS 34,18
    ATT BETALA 319,00
  `);
  assert.deepEqual(suggestion.items, [
    { name: "Lager", quantity: 2, amount: "130.00" },
    { name: "Fish and chips", quantity: 1, amount: "189.00" },
  ]);
});

test("Bord 17 is table metadata, not a purchased article, even when a nearby price gets merged onto it", () => {
  const suggestion = parseReceiptText(`
    RESTAURANG SOLGLÄNTAN
    Storgatan 12
    Bord 17
    189,00
    1 x Stor stark 79,00
    1 x Coca-Cola 39,00
    Moms 12% 30,44
    ATT BETALA 307,00
    Kort Godkänt
  `);
  assert.equal(suggestion.title, "RESTAURANG SOLGLÄNTAN");
  assert.equal(suggestion.amount, "307.00");
  assert.equal(suggestion.items.some((item) => /bord/i.test(item.name)), false, "Bord 17 must never become an item");
  assert.deepEqual(suggestion.items, [
    { name: "Stor stark", quantity: 1, amount: "79.00" },
    { name: "Coca-Cola", quantity: 1, amount: "39.00" },
  ]);
});

test("Swedish receipt metadata (kassör, beställning, referens, swish) never becomes an item", () => {
  const suggestion = parseReceiptText(`
    KAFÉ LINNÉA
    Kassör 4
    Beställning 145
    Referens 88213
    2 x Kanelbulle 79,00
    1 x Kaffe 35,00
    Swish
    SUMMA 114,00
  `);
  assert.deepEqual(suggestion.items, [
    { name: "Kanelbulle", quantity: 2, amount: "79.00" },
    { name: "Kaffe", quantity: 1, amount: "35.00" },
  ]);
});

test("grocery receipt: discounts and coupons are excluded from items, deposits are kept", () => {
  const suggestion = parseReceiptText(`
    ICA SUPERMARKET
    Kundvagn 3
    Mjölk 15,90
    Bröd 32,50
    2 x Räksmörgås 89,00 178,00
    Rabatt -10,00
    Pant burk 2,00
    Moms 12% 25,15
    SUMMA 216,90
  `);
  assert.equal(suggestion.items.some((item) => /rabatt/i.test(item.name)), false, "a discount line must never become a purchased item");
  assert.deepEqual(suggestion.items, [
    { name: "Mjölk", quantity: 1, amount: "15.90" },
    { name: "Bröd", quantity: 1, amount: "32.50" },
    { name: "Räksmörgås", quantity: 2, amount: "178.00" },
    { name: "Pant burk", quantity: 1, amount: "2.00" },
  ]);
});

test("bar receipt: drinks and an order/table number are told apart", () => {
  const suggestion = parseReceiptText(`
    ÅNGBÅTSBRYGGANS PUB
    Bord 4
    3 x Öl 79,00 237,00
    2 x Cider 69,00 138,00
    1 x Blåbärspaj 65,00
    Kort
    ATT BETALA 440,00
  `);
  assert.equal(suggestion.items.some((item) => /bord/i.test(item.name)), false, "Bord 4 must never become an item");
  assert.deepEqual(suggestion.items, [
    { name: "Öl", quantity: 3, amount: "237.00" },
    { name: "Cider", quantity: 2, amount: "138.00" },
    { name: "Blåbärspaj", quantity: 1, amount: "65.00" },
  ]);
});

test("difficult OCR: Swedish characters, split name/price lines and mixed-in metadata still parse correctly", () => {
  const suggestion = parseReceiptText(`
    ÅNGBÅTSBRYGGANS KAFÉ
    Bord 9
    2 x Köttbullar
    1 x Räksmörgås
    139,00
    89,00
    Moms 25% 45,80
    TOTALT 228,00
  `);
  assert.deepEqual(suggestion.items, [
    { name: "Köttbullar", quantity: 2, amount: "139.00" },
    { name: "Räksmörgås", quantity: 1, amount: "89.00" },
  ]);
});

test("a long dish name wrapped onto its own line is reunited, whether the price stays with the wrapped letters or not", () => {
  const priceOnItsOwnLine = parseReceiptText(`
    1.00 Caesarsalla
    d
    285.00
    1.00 Tryffelpast
    a
    295.00
  `);
  assert.deepEqual(priceOnItsOwnLine.items, [
    { name: "Caesarsallad", quantity: 1, amount: "285.00" },
    { name: "Tryffelpasta", quantity: 1, amount: "295.00" },
  ]);

  const priceMergedWithFragment = parseReceiptText(`
    1.00 Caesarsalla
    d 285.00
    1.00 Tryffelpast
    a 295.00
  `);
  assert.deepEqual(priceMergedWithFragment.items, [
    { name: "Caesarsallad", quantity: 1, amount: "285.00" },
    { name: "Tryffelpasta", quantity: 1, amount: "295.00" },
  ]);
});

test("a terminal/register ID code is never treated as a purchased item", () => {
  const suggestion = parseReceiptText(`
    STRANDBRYGGAN
    XCL AT-150-E-18E #1
    3564
    1.00 Läsk 48.00
    Total 48.00
  `);
  assert.equal(suggestion.items.length, 1);
  assert.equal(suggestion.items[0].name, "Läsk");
});

test("real Strandbryggan PaddleOCR-VL output: terminal code, wrapped names and the tip line are all handled correctly", () => {
  // This is the verbatim raw OCR text captured from production via RECEIPT_OCR_DEBUG_LOG (not a
  // reconstruction). It exposed three separate bugs at once: (1) the terminal code and its register
  // number are printed on ONE line joined by " : " ("xCL_AT-150-E-18E #1 : 3564"), with the "x"
  // misread as lowercase — looksLikeSystemCode() must still exclude it and the trailing "3564" must
  // not become a fake "35,64" price; (2) "Caesarsalla"/"Tryffelpast" wrap their last letter onto the
  // *next* line alone, but the name+price were already together on the line above — appending the
  // fragment at the very end used to leave the row not ending in a price, silently dropping both
  // items (580 kr) instead of just losing a letter; (3) the card slip's "Tip: 182,50 SEK" line was
  // not recognized as payment metadata and became a fake purchased item.
  const suggestion = parseReceiptText(`
    Strandbryggan
    Stranvägskajen 27
    114 5G Stockholm

    xCL_AT-150-E-18E #1 : 3564

    Strandbryggan
    tis 14 apr 26 12:52
    Servis
    Bord 204

    1.00 1/1 Räbiff 335.00
    1.00 Raksallad 295.00
    1.00 Caesarsalla 285.00
    d
    1.00 Tryffelpast 295.00
    a
    1.00 Lässk 48.00
    4.00 1664 Blanc 392.00
    1.00 GL Minuty 175.00

    Total 1825.00

    MasterCard 2007.50
    14042026 12:52
    Status: GODKANT
    ONLINE
    Transaktionstyp:
    KÖP
    Ref. nr:
    200478100751

    Net amount:
    1825,00 SEK
    Tip: 182,50 SEK
  `);
  assert.deepEqual(suggestion.items.map((item) => item.name), [
    "Räbiff", "Raksallad", "Caesarsallad", "Tryffelpasta", "Lässk", "Blanc", "GL Minuty",
  ]);
  const total = suggestion.items.reduce((sum, item) => sum + Math.round(Number(item.amount) * 100), 0);
  assert.equal(total, 182500, "the 7 real items must sum to the receipt's exact total, 1825.00 SEK");
});

test("a brand-new, never-seen-before header field is excluded structurally, not by keyword", () => {
  // No word in this header line appears in any exclusion list — this only works if the items section
  // is genuinely found by position (header before items, footer after), the way a person would read
  // the receipt, rather than by matching an ever-growing list of known metadata terms.
  const suggestion = parseReceiptText(`
    KROGEN VID ÅN
    Löpnummer 88213-A
    2026-05-01 19:00
    1 x Fisksoppa 145,00
    1 x Vitt vin 95,00
    Totalt 240,00
  `);
  assert.equal(suggestion.items.length, 2);
  assert.equal(suggestion.items.some((item) => /löpnummer|88213/i.test(item.name)), false, "an unrecognized header field must still be excluded by section position alone");
});

test("compact quantity prefixes are kept and payment rows are excluded", () => {
  const suggestion = parseReceiptText(`
    KVÄLLSKROGEN
    Produkt Pris
    3x Mariestad 261.00
    7x Smirnoff ICE 665.00
    TOTALT SEK 926.00
    Betalt SEK 926.00
  `);
  assert.equal(suggestion.amount, "926.00");
  assert.deepEqual(suggestion.items, [
    { name: "Mariestad", quantity: 3, amount: "261.00" },
    { name: "Smirnoff ICE", quantity: 7, amount: "665.00" },
  ]);
});

test("missing OCR decimal separators are repaired without treating card IDs as products", () => {
  const suggestion = parseReceiptText(`
    Mixed Grill 595 00
    Heineken 13000
    Extra SEK 168 .00
    Total SEK 893.00
    CTUIDSISTCSKSA000000011
    AID A000000004 1010
    TVR 0000008001
  `);
  assert.deepEqual(suggestion.items, [
    { name: "Mixed Grill", quantity: 1, amount: "595.00" },
    { name: "Heineken", quantity: 1, amount: "130.00" },
    { name: "Extra", quantity: 1, amount: "168.00" },
  ]);
});

test("integer SEK totals, preferred order dates and unit prices repair a low-resolution restaurant receipt", () => {
  const first = parseReceiptText(`
    GÄSTNOTA
    2018-01-23 21:22:37
    Beställd: 2018-01-25 19:30:23
    2 Xx Munn Cordon Roug à 131,00 252,00
    2 x Ostron à 29,00 58,00
    1 x Kalventrecote 250 gram 285,00
    1 x Flankstek 200 gram 255,00
    2 x La Croix Merlot à 95,00 190,00
    1 x Créme Brölée 35,00
    1 x Hasselnötskräm 105,00
    1 x Bryggkaffe 32,00
    1 x Dubbel Espresso 30,00
    ATT BETALA 1312 SEK
  `, new Date("2026-08-11T12:00:00Z"));
  assert.equal(first.amount, "1312.00");
  assert.equal(first.expenseDate, "2018-01-25");
  assert.deepEqual(first.items[0], { name: "Munn Cordon Roug ", quantity: 2, amount: "262.00" });
  const second = parseReceiptText("1 x Créme Brölée 95,00\nATT BETALA 1312 SEK");
  const combined = combineReceiptPasses([
    { text: "", confidence: 72, suggestion: first },
    { text: "", confidence: 50, suggestion: second },
  ]);
  assert.equal(combined.suggestion.items.reduce((sum, item) => sum + Number(item.amount), 0), 1312);
  assert.equal(combined.suggestion.items.find((item) => item.name.includes("Brölée"))?.amount, "95.00");
});

test("iPhone preview chrome and margins are cropped before OCR", async () => {
  const screenshot = await sharp(Buffer.from(`<svg width="590" height="1280" xmlns="http://www.w3.org/2000/svg">
    <rect width="590" height="1280" fill="#fffdfd"/>
    <rect width="590" height="148" fill="#4b4b4b"/>
    <rect x="188" y="162" width="214" height="948" fill="#fff" stroke="#111" stroke-width="3"/>
    <text x="220" y="300" font-size="22" fill="#222">KVITTO</text>
    <text x="215" y="440" font-size="18" fill="#222">3x Dryck 261.00</text>
    <text x="215" y="500" font-size="18" fill="#222">TOTAL 261.00</text>
  </svg>`)).png().toBuffer();
  const prepared = await prepareReceiptImages(screenshot);
  assert.equal(prepared.crop.screenshotPreview, true);
  assert.ok(prepared.crop.left > 140);
  assert.ok(prepared.crop.width < 330);
  assert.ok(prepared.crop.top >= 140);
  const aiMetadata = await sharp(prepared.ai).metadata();
  assert.ok((aiMetadata.width || 0) <= 1024);
  assert.ok((aiMetadata.height || 0) <= 2048);
});

test("phone photos with OCR borders and decimal quantities preserve receipt rows", () => {
  const suggestion = parseReceiptText(`
    | Förhandsvisning |
    VASE230109 #23 : 21719 |
    Framsida
    tis 26 maj 26 18:10
    | 1.00 Chipspåse FS 49,00 |
    | 1.00 Valenciamandlar burk 80,00 |
    | 6.00 Heineken Draft (90.00) 540.00 |
    Total 669.00 |
    Moms% Moms ExMoms Total |
  `, new Date("2026-05-27T12:00:00Z"));
  assert.equal(suggestion.title, "Framsida");
  assert.equal(suggestion.amount, "669.00");
  assert.equal(suggestion.expenseDate, "2026-05-26");
  assert.deepEqual(suggestion.items, [
    { name: "Chipspåse FS", quantity: 1, amount: "49.00" },
    { name: "Valenciamandlar burk", quantity: 1, amount: "80.00" },
    { name: "Heineken Draft", quantity: 6, amount: "540.00" },
  ]);
});

test("wrapped receipt totals and OCR zero glyphs preserve a beer line", () => {
  const suggestion = parseReceiptText(`
    FRAMSIDAN
    1.OO Chipspåse 49.OO
    6.OO Heineken Draft (9O.OO)
    54O.OO
    Total 589.OO
  `);
  assert.deepEqual(suggestion.items, [
    { name: "Chipspåse", quantity: 1, amount: "49.00" },
    { name: "Heineken Draft", quantity: 6, amount: "540.00" },
  ]);
  assert.equal(suggestion.amount, "589.00");
});

test("local AI receipt output is validated and merged by exact öre", () => {
  const ai = parseOllamaReceipt({
    merchant: "Framsidan", date: "2026-05-26", total: 669,
    items: [{ name: "Heineken Draft", quantity: 6, amount: 540 }],
  }, new Date("2026-05-27T12:00:00Z"));
  assert.ok(ai);
  const tesseract = {
    text: "", confidence: 59,
    suggestion: {
      title: "Framsidan", amount: "669.00", expenseDate: "2026-05-26", category: "food",
      items: [
        { name: "Chipspåse FS", quantity: 1, amount: "49.00" },
        { name: "Valenciamandlar burk", quantity: 1, amount: "80.00" },
      ],
    },
  };
  const combined = combineReceiptPasses([ai, tesseract]);
  assert.equal(combined.suggestion.items.reduce((sum, item) => sum + Number(item.amount), 0), 669);
  assert.deepEqual(combined.suggestion.items.map((item) => item.name), ["Chipspåse FS", "Valenciamandlar burk", "Heineken Draft"]);
});

test("structured vision output keeps row totals, quantities and exact receipt total", () => {
  const ai = parseOllamaReceipt({
    merchant: "Restaurangen", date: "", total: 2400,
    items: [
      { name: "Friterade risottobollar", quantity: 1, amount: 80 },
      { name: "Ostron Flambadou", quantity: 2, amount: 110 },
      { name: "Rödräka Pil Pil", quantity: 1, amount: 89 },
      { name: "Saltgurka", quantity: 1, amount: 50 },
      { name: "Mixed Grill", quantity: 1, amount: 595 },
      { name: "Heineken", quantity: 1, amount: 130 },
      { name: "Flaska vin", quantity: 1, amount: 950 },
      { name: "Öl", quantity: 1, amount: 79 },
      { name: "Negroni", quantity: 1, amount: 149 },
      { name: "Extra", quantity: 1, amount: 168 },
    ],
  });
  assert.ok(ai);
  assert.equal(ai.suggestion.amount, "2400.00");
  assert.equal(ai.suggestion.items.reduce((sum, item) => sum + Number(item.amount), 0), 2400);
  assert.deepEqual(ai.suggestion.items[1], { name: "Ostron Flambadou", quantity: 2, amount: "110.00" });
});

test("receipt parser handles European dates and ignores headings as merchants", () => {
  const suggestion = parseReceiptText(`
    KASSAKVITTO
    ICA MAXI HÄGGVIK
    10/08/2026 14:02
    DELSUMMA 275,00
    ATT BETALA 299,00 SEK
  `, new Date("2026-08-11T12:00:00Z"));
  assert.equal(suggestion.title, "ICA MAXI HÄGGVIK");
  assert.equal(suggestion.amount, "299.00");
  assert.equal(suggestion.expenseDate, "2026-08-10");
  assert.equal(suggestion.category, "food");
});

test("invalid and future dates are not suggested", () => {
  const suggestion = parseReceiptText("HOTELL NORR\nDATUM 31/02/2026\nTOTAL 850,00", new Date("2026-01-10T12:00:00Z"));
  assert.equal(suggestion.title, "HOTELL NORR");
  assert.equal(suggestion.expenseDate, null);
  assert.equal(suggestion.category, "stay");
});

test("two bundled Swedish OCR workers can process receipts concurrently", { timeout: 30_000 }, async () => {
  try {
    const blankImage = await sharp({ create: { width: 320, height: 120, channels: 3, background: "white" } }).png().toBuffer();
    const results = await Promise.all([recognizeReceipt(blankImage), recognizeReceipt(blankImage)]);
    for (const result of results) {
      assert.equal(result.suggestion.amount, null);
      assert.equal(result.suggestion.category, "other");
    }
  } finally {
    await closeReceiptOcr();
  }
});
