// Mirrors suggestedCategory() in src/receipt-ocr.ts (used server-side to guess a category from
// scanned receipt text). Duplicated here, not called over the network, so a category can be
// suggested live as the user types an expense title -- keep the two in sync if either changes.
const categoryKeywords: Array<[RegExp, string]> = [
  [/restaurang|restaurant|café|cafe|espresso|pizza|burger|sushi|mat|livs|ica|coop|willys|hemköp|chips|mandel|heineken|öl|beer|lager|vin|drink|bar\b/i, "food"],
  [/hotell|hotel|hostel|vandrarhem|boende/i, "stay"],
  [/taxi|uber|bolt|sj\b|tåg|buss|biljett|parkering|bensin|diesel/i, "travel"],
  [/bio|cinema|museum|entré|aktivitet|bowling|konsert/i, "fun"],
];

export function suggestCategoryFromText(text: string): string {
  for (const [pattern, slug] of categoryKeywords) if (pattern.test(text)) return slug;
  return "other";
}
