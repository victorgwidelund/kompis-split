import { adaptLegacyPredictionToV2 } from "../../dist/ocr-benchmark.js";

export function typedScanResult(result, elapsedMs) {
  if (!result?.receipt || !result?.validation) return adaptLegacyPredictionToV2(result?.suggestion ?? { title: null, amount: null, expenseDate: null, category: "other", items: [] }, elapsedMs, result?.needsReview ?? null);
  const receipt = result.receipt;
  return {
    schemaVersion: 2, status: "success", source: result.source ?? null, needsReview: result.validation.needsReview,
    failureStage: null, failureCode: null, latencyMs: elapsedMs, stageLatencyMs: {
      preprocessing: result.timings?.preprocessingMs ?? null, ocr: result.timings?.ocrMs ?? null,
      parsing: result.timings?.parsingAndValidationMs ?? null, validation: null,
    },
    receipt: {
      merchant: receipt.merchant, date: receipt.date, time: receipt.time, receiptNumber: receipt.receiptNumber,
      currency: receipt.currency,
      items: receipt.items.map((item, index) => ({
        id: `prediction-${index}`, rawName: item.rawName, normalizedName: item.normalizedName, kind: item.kind,
        quantity: item.quantity, unit: item.unit, unitPriceOre: item.unitPriceOre, lineTotalOre: item.lineTotalOre,
        weightGrams: item.weightGrams, multipack: item.multipack, discountOre: item.discountOre, pantOre: item.pantOre,
      })),
      subtotalOre: receipt.subtotalOre,
      discounts: receipt.discounts.map((discount, index) => ({ id: `prediction-discount-${index}`, label: discount.label, amountOre: discount.amountOre, itemId: null })),
      vat: receipt.vat.map((line) => ({ rateBasisPoints: line.rateBasisPoints, netOre: line.netOre, vatOre: line.vatOre, grossOre: line.grossOre })),
      totalOre: receipt.totalOre, pantTotalOre: receipt.pantTotalOre,
      payments: receipt.payments.map((payment) => ({ method: payment.method, amountOre: payment.amountOre })),
    },
  };
}
