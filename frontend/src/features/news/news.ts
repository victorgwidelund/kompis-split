// User-facing release notes, newest first. Add an entry here in the same change as any release
// people will notice -- the dialog opens once by itself whenever the newest entry is one they haven't
// seen. Write for the friends using the app, not for developers: what changed for them, in Swedish.
export interface NewsEntry { id: string; date: string; title: string; items: string[] }

export const newsEntries: NewsEntry[] = [
  {
    id: "2026-11-11-pengaregn",
    date: "11 november 2026",
    title: "Ny logga – och lite hemligheter 💚🤍",
    items: [
      "Kompis Split har fått en ny logga: två skålande grönvita glas medan det regnar pengar. Lägg till appen på hemskärmen igen så får du den nya ikonen.",
      "Det har gömts ett par Bajen- och ölöverraskningar i appen. Vi säger inte var. 🍻",
    ],
  },
  {
    id: "2026-11-11-kvittoraderna",
    date: "11 november 2026",
    title: "Smartare kvittoläsning",
    items: [
      "Inget under \"Totalt\" blir längre en rad – butiksnummer, telefonnummer, moms och kortinfo hålls borta.",
      "Rätt namn på rätt pris även när kvittot är böjt eller fotat snett.",
      "Antal läses rätt i fler format, till exempel \"2st 55 kr\" och \"(2 89,00)\".",
      "Notan får restaurangens namn i stället för staden från adressraden.",
    ],
  },
  {
    id: "2026-11-11-snabbnota",
    date: "11 november 2026",
    title: "Kvittoskanningen fungerar på riktigt",
    items: [
      "Att skanna ett kvitto i Snabbnota eller på en utgift tar nu ett par sekunder i stället för att hänga sig och ge upp efter 30 sekunder.",
      "Felet låg i servern: kvittoläsaren fick för lite minne för riktiga mobilfoton och startades om mitt i varje skanning.",
      "Om något ändå går fel får du ett begripligt meddelande i stället för \"Fetch is aborted\".",
    ],
  },
  {
    id: "2026-11-11",
    date: "11 november 2026",
    title: "Nyheter, enklare att lägga till vänner och era buggrapporter",
    items: [
      "Den här rutan! Här ser du vad som är nytt. Du hittar den alltid under Mer → Nyheter.",
      "Lägg till vänner i en grupp: välj Registrerad användare eller Gäst högst upp, och listan får hela skärmen i stället för en liten ruta.",
      "Bara den som betalar, den som tar emot eller gruppens admin kan markera en betalning som betald.",
      "Öppnar du en utgift som är fördelad i procent eller andelar ser du procenten/andelarna igen, inte kronor.",
      "Datumet ligger kvar när du redigerar en utgift.",
    ],
  },
  {
    id: "2026-09-17",
    date: "september 2026",
    title: "Push-notiser och påminnelser per grupp",
    items: [
      "Push-notiser när du läggs till i en grupp, när någon lägger till en utgift du är med i, när en betalning markeras och när någon påminner dig. Slå av och på under Mer.",
      "Påminn om obetalt i en enskild grupp under fliken Gör upp – påminnelsen går både som mail och push.",
      "Appen hämtar nya utgifter automatiskt när du går tillbaka till den.",
      "Filtret Jag är med och Din andel visar direkt vilka utgifter du är med på.",
      "Snabbnotor har fått en betalningshistorik, och personvyn visar vad någon har betalat till andra.",
      "Den nedre menyn ligger still på iPhone.",
    ],
  },
  {
    id: "2026-08-31",
    date: "augusti 2026",
    title: "Profilbilder, kategoriförslag och kommentarer",
    items: [
      "Lägg till en profilbild under Mer.",
      "Kategorin föreslås utifrån vad du skriver, till exempel blir ICA Mat och dryck.",
      "Kommentera utgifter och tryck på en utgift för att se hela fördelningen.",
      "Tryck på en person i en grupp för att se vilka utgifter hen har betalat.",
    ],
  },
];

const seenKey = "kompis-news-seen";
const latestId = newsEntries[0]?.id ?? "";

// Remembered per browser. Storage can throw (private browsing, blocked site data): unreadable counts
// as seen so it never pops up on every load, and a failed write just means it shows once more.
export function hasUnseenNews(): boolean {
  try { return localStorage.getItem(seenKey) !== latestId; } catch { return false; }
}
export function markNewsSeen() {
  try { localStorage.setItem(seenKey, latestId); } catch { /* see hasUnseenNews */ }
}
