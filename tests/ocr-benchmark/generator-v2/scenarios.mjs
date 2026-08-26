// Schema-v2's scenario matrix is deliberately explicit. A generated corpus is only useful when its
// coverage can be audited without opening individual receipts, especially for a sealed final set.
const scenario = (id, difficulty, tags, photo = {}, content = {}, expectedStatus = "readable") => ({
  id,
  difficulty,
  tags: Object.freeze([...tags].sort()),
  photo: Object.freeze({ ...photo }),
  content: Object.freeze({ ...content }),
  expectedStatus,
});

export const SCENARIO_MATRIX = Object.freeze([
  scenario("01_clean_standard", "clean", ["clean", "date-time", "card"], { frameFill: 0.9 }),
  scenario("02_rotated_90", "difficult", ["rotation-90", "quantity"], { rightAngle: 90 }, { quantityStyle: "x" }),
  scenario("03_rotated_180", "difficult", ["upside-down", "rotation-180", "discount"], { rightAngle: 180 }, { discount: true }),
  scenario("04_rotated_270", "difficult", ["rotation-270", "pant"], { rightAngle: 270 }, { pant: true }),
  scenario("05_perspective_left", "difficult", ["perspective", "angled-photo"], { perspective: "left", rotateDeg: -4 }),
  scenario("06_perspective_right", "difficult", ["perspective", "angled-photo", "quantity"], { perspective: "right", rotateDeg: 5 }, { quantityStyle: "star" }),
  scenario("07_perspective_steep", "pathological", ["perspective", "angled-photo", "tiny-receipt"], { perspective: "steep", frameFill: 0.46 }),
  scenario("08_blurry_motion", "difficult", ["blur", "motion-blur"], { motionBlur: 7 }),
  scenario("09_blurry_defocus", "pathological", ["blur", "defocus"], { blurSigma: 1.8 }),
  scenario("10_low_light", "difficult", ["low-light", "noise"], { exposure: 0.48, noise: 0.055 }),
  scenario("11_overexposed", "difficult", ["overexposure"], { exposure: 1.72, contrast: 0.78 }),
  scenario("12_hard_shadow", "pathological", ["shadow", "uneven-light"], { hardShadow: true, exposure: 0.82 }),
  scenario("13_crumpled", "pathological", ["crumpled", "uneven-light"], { crumple: true }),
  scenario("14_folded", "pathological", ["folded", "shadow"], { fold: true }),
  scenario("15_partial_receipt", "pathological", ["partial-receipt"], { cropBottom: 0.3 }, {}, "partial"),
  scenario("16_unreadable", "pathological", ["unreadable", "blur", "partial-receipt"], { cropBottom: 0.48, blurSigma: 4.2, exposure: 0.38 }, {}, "unreadable"),
  scenario("17_long_receipt", "difficult", ["long-receipt", "quantity", "discount"], { frameFill: 0.72 }, { long: true, quantityStyle: "x", discount: true }),
  scenario("18_tiny_in_frame", "pathological", ["tiny-receipt", "shadow"], { frameFill: 0.28, softShadow: true }),
  scenario("19_quantity_x", "normal", ["quantity", "quantity-x"], {}, { quantityStyle: "x" }),
  scenario("20_quantity_star", "normal", ["quantity", "quantity-star"], {}, { quantityStyle: "star" }),
  scenario("21_weight_kg", "normal", ["weight-based", "swedish-decimal"], {}, { weight: true }),
  scenario("22_multipack", "normal", ["multipack", "quantity"], {}, { multipack: true, quantityStyle: "x" }),
  scenario("23_item_discount", "normal", ["discount", "item-discount"], {}, { discount: true }),
  scenario("24_campaign_price", "difficult", ["discount", "campaign"], {}, { campaign: true }),
  scenario("25_pant", "normal", ["pant", "quantity"], {}, { pant: true, quantityStyle: "star" }),
  scenario("26_mixed_vat", "difficult", ["mixed-vat", "vat"], {}, { mixedVat: true }),
  scenario("27_duplicate_products", "difficult", ["duplicate-looking-products"], {}, { duplicateProducts: true }),
  scenario("28_cash_change", "normal", ["cash", "change", "payment-format"], {}, { payment: "cash" }),
  scenario("29_swish", "normal", ["swish", "payment-format"], {}, { payment: "swish" }),
  scenario("30_card_metadata", "normal", ["card", "payment-format", "receipt-number"], {}, { payment: "card-detailed" }),
  scenario("31_date_time_variants", "normal", ["date-time", "swedish-date", "receipt-number"], {}, { dateFormat: "swedish", timeFormat: "dot" }),
  scenario("32_mixed_semantics", "pathological", ["weight-based", "multipack", "discount", "campaign", "pant", "mixed-vat", "duplicate-looking-products", "long-receipt"], { perspective: "left", hardShadow: true }, { weight: true, multipack: true, discount: true, campaign: true, pant: true, mixedVat: true, duplicateProducts: true, long: true }),
]);

export const REQUIRED_SCENARIO_TAGS = Object.freeze([
  "clean", "rotation-90", "rotation-180", "rotation-270", "upside-down", "perspective",
  "angled-photo", "blur", "low-light", "overexposure", "shadow", "crumpled", "folded",
  "partial-receipt", "unreadable", "long-receipt", "tiny-receipt", "quantity", "weight-based",
  "multipack", "discount", "campaign", "pant", "mixed-vat", "duplicate-looking-products",
  "date-time", "payment-format",
]);

export function createScenarioPlan(kind) {
  if (kind !== "dev" && kind !== "sealed-final") throw new Error(`Unsupported corpus kind: ${kind}`);
  const entries = SCENARIO_MATRIX.map((entry, index) => ({
    fixtureId: kind === "sealed-final" ? `sealed_${String(index + 1).padStart(3, "0")}` : `dev_${String(index + 1).padStart(3, "0")}_${entry.id}`,
    variant: 1,
    scenario: entry,
  }));
  if (kind === "dev" || kind === "sealed-final") {
    for (let index = 0; index < 16; index += 1) {
      const entry = SCENARIO_MATRIX[index + 8];
      entries.push({
        fixtureId: kind === "sealed-final"
          ? `sealed_${String(entries.length + 1).padStart(3, "0")}`
          : `dev_${String(entries.length + 1).padStart(3, "0")}_${entry.id}_v2`,
        variant: 2,
        scenario: entry,
      });
    }
  }
  return entries.sort((left, right) => left.fixtureId.localeCompare(right.fixtureId, "en"));
}

export function scenarioCoverage(plan) {
  const byDifficulty = {};
  const byTag = {};
  for (const { scenario: entry } of plan) {
    byDifficulty[entry.difficulty] = (byDifficulty[entry.difficulty] ?? 0) + 1;
    for (const tag of entry.tags) byTag[tag] = (byTag[tag] ?? 0) + 1;
  }
  return {
    byDifficulty: Object.fromEntries(Object.entries(byDifficulty).sort()),
    byTag: Object.fromEntries(Object.entries(byTag).sort()),
  };
}
