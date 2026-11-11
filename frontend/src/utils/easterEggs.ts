// Small hidden nods for the friend group. Purely decorative: nothing here may change amounts,
// splits or what gets saved.
const bajenPattern = /bajen|hammarby|söder/i;
const beerPattern = /öl|\b(pilsner|lager|ipa|stout|porter|ale|beer)\b/i;

export const isBajen = (text: string) => bajenPattern.test(text);
export const isBeer = (text: string) => beerPattern.test(text);

/** A tab counts as a beer tab when at least half of its (two or more) rows are beer. */
export const isBeerTab = (names: string[]) => names.length >= 2 && names.filter(isBeer).length * 2 >= names.length;

export const hammarbyMessages = [
  "Hej Bajare! 💚🤍 Kom igen Hammarby!",
  "Dags för en kall öl? 🍺",
  "Håll ut! ✊💚",
  "Grönvitt hjärta, delade notor 💚🤍",
  "Bajen i hjärtat, jämnt i plånboken 💚",
  "Söder är grönvitt idag 💚🤍",
  "Notan delas lika, glädjen dubbelt 💚",
  "Det regnar pengar på Söder 💸",
  "En öl per mål? Då blir det dyrt ikväll 🍺",
];

export const randomFrom = <T,>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)]!;

export type RainDrop = { piece: string; left: number; delay: number; duration: number; size: number; spin: number };
export const makeRainDrops = (pieces: readonly string[], count = 36): RainDrop[] => Array.from({ length: count }, (_, index) => ({
  piece: pieces[index % pieces.length]!,
  left: Math.random() * 100,
  delay: Math.random() * 0.9,
  duration: 1.8 + Math.random() * 1.2,
  size: 18 + Math.random() * 14,
  spin: (Math.random() - 0.5) * 720,
}));
