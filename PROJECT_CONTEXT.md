# Kompis Split – levande projektkontext

Senast uppdaterad: 2026-08-13  
Appversion: 1.19.2
Databasschema: migration 9

Det här dokumentet är den korta tekniska minnesbilden för framtida utveckling. Det ska uppdateras i samma ändring när arkitektur, datamodell, drift, säkerhet, viktiga funktioner, releaser eller kända problem förändras. Lägg aldrig in lösenord, tokens, privata nycklar, riktiga telefonnummer, kvitton eller andra personuppgifter här.

## Produktmål

Kompis Split är en privat, självhostad app för en mindre vänkrets. Den ska göra det enkelt att:

- dela utgifter på resor och behålla en tillförlitlig historik över skulder och betalningar;
- bjuda in vänner och återanvända registrerade kontakter;
- använda snabbnota för att bocka av individuella kvittorader i realtid;
- läsa svenska kvitton lokalt med OCR och alltid låta användaren kontrollera förslagen;
- se enkel statistik utan att göra gränssnittet onödigt komplext.

Swish är ännu inte integrerat. Endast dokumenterade Swish-funktioner får införas, och ett öppnat Swish-flöde får aldrig räknas som bekräftad betalning.

## Nuvarande arkitektur

- Frontend: React 19, Vite och strikt TypeScript i `frontend/src/`, uppdelad i `api`, `components`, `features`, `types` och `utils`.
- Backend: Node.js 24 och TypeScript i `src/`.
- Databas: PostgreSQL 17, endast tillgänglig inne i Compose-nätverket.
- Databasåtkomst: `pg` med frågeadapter i `src/database.ts`.
- Migreringar: ordnade, framåtriktade migreringar i `src/migrations.ts`, registrerade i `schema_migrations`.
- OCR: lokal PaddleOCR-VL 1.6 GGUF via en intern pinnad llama.cpp CUDA-server, kompletterad med automatisk beskärning, perspektivuträtning och uppskalning i Sharp samt Tesseract.js med svensk språkmodell som oberoende reserv. AI startas parallellt men avbryts när den snabba lokala tolkningen redan summerar exakt. Matematiskt inkonsekventa AI-resultat får en adaptiv andra kontroll.
- Realtid: Server-Sent Events för snabbnota.
- Pakethanterare: pnpm 11.16.0.
- Produktion: Docker Compose på Unraid och publicerad image i GitHub Container Registry.
- Statisk leverans: Vite bygger hashade assets. Samma Node-process som tidigare serverar bygget, så port, reverse proxy, sessionscookies och appcontainer är oförändrade.

Bevara denna arkitektur om inte en större förändring uttryckligen har godkänts och motiverats.

## Produktionstopologi och betrott proxy-läge

Produktionstrafik går Cloudflare → Nginx Proxy Manager → appcontainern. Se
`DEPLOYMENT.md` för den fullständiga topologin och de operativa flödena
(uppdatering, backup, återställning, rollback).

- Klient-IP för rate limiting (inloggning, gäst-anslutning till Snabbnota,
  kvittoanalys) hämtas från `CF-Connecting-IP` när `TRUST_PROXY=true` —
  aldrig från `X-Forwarded-For`s första värde, eftersom både Cloudflare och
  Nginx lägger till i den headern och en klient fritt kan sätta ett eget
  förstaled. `CF-Connecting-IP` sätts av Cloudflares edge utifrån den
  faktiska anslutningen och går inte att förfalska av klienten.
- `X-Forwarded-Host`/`X-Forwarded-Proto` används fortfarande för
  absoluta inbjudningslänkar och Origin-verifiering; det förutsätter att
  Nginx Proxy Manager skriver över (inte bara vidarebefordrar) dessa
  headrar. `SameSite=Strict` på sessionscookien är det huvudsakliga
  CSRF-skyddet oavsett proxykonfiguration.

## Drift på Unraid

- Compose-stacken ligger i `compose.yaml`.
- App: `ghcr.io/victorgwidelund/kompis-split:latest`, port 8787.
- PostgreSQL: `postgres:17.10-alpine3.22`, utan publicerad host-port.
- Beständig databas: `/mnt/user/kompis_split/postgres`.
- Automatiska dump-backuper: `/mnt/user/kompis_split/backups`, normalt 14 dagars retention.
- Lokala PaddleOCR-modeller: `/mnt/user/kompis_split/paddleocr`; llama.cpp-tjänsten har ingen publicerad host-port och använder GTX 1080 Ti via Nvidia-runtime.
- Appcontainern är read-only, saknar Linux capabilities och använder `/tmp` som begränsad tmpfs.
- Produktionsåtkomst ska gå via HTTPS-reverse proxy. `COOKIE_SECURE=true` och `TRUST_PROXY=true` används när proxyn är korrekt konfigurerad.
- Hemligheter sätts i Unraid Compose Manager eller ignorerad `.env`, aldrig i Git.

Radera eller återskapa aldrig databasvolymen vid en vanlig uppdatering. En imageuppdatering ska normalt göras med Pull & Up i Compose Manager. Behåll föregående `sha-*`-tagg för rollback.

## Identitet och behörighet

- Vanliga appfunktioner kräver konto och en opaque, utgående HttpOnly-session.
- Servern kontrollerar adminroll, resmedlemskap och ägarroll för varje skyddad operation.
- Vanliga vän- och reseinbjudningar kräver registrering eller inloggning.
- Snabbnota har ett begränsat gästläge: namn och mobil-/Swishnummer räcker.
- En snabbnotegäst får en separat HttpOnly-session som endast gäller en bestämd snabbnota och inte ger åtkomst till dashboard, resor, statistik eller administration.
- Inbjudnings- och sessionstokens lagras hashade, inte i klartext.
- Snabbnotans ägare kan se gästens nummer; övriga deltagare ser endast namnet.
- `/api/users/search` returnerar aldrig telefonnummer — bara namn/e-post för att hitta rätt person att bjuda in. Telefonnummer blir synliga för andra användare först när man faktiskt delar en resa eller snabbnota (deltagarlistan), aldrig via fritextsök.
- Att spara någon som kontakt (`POST /api/contacts`) kräver att man redan delar en resa eller snabbnota med personen. Ett gissat eller uppräknat användar-ID räcker inte för att läsa ut någons e-post/Swish-nummer den vägen.

## Admin-only demoläge

- Endast en global admin kan gå in i demoläge (`POST /api/admin/demo/enter`), verifierat server-side. Ett vanligt konto får 403 även vid direkt API-anrop.
- Demoläget är bundet till sessionsraden i databasen (`sessions.demo_mode`, `sessions.demo_batch_id`), inte till något klientskickat fält och inte till `localStorage`. Klienten läser bara `demoMode` från `/api/session`.
- Vid första `enter` skapas en engångsuppsättning fiktiv data (två resor, en snabbnota) taggad med `is_demo = TRUE` och sessionens `demo_batch_id`, via samma tabeller, frågor och React-komponenter som vanliga resor — ingen parallell demo-frontend.
- Isoleringen upprätthålls på ett enda ställe per resurstyp: `requireAccess`, `quickTabAccess` och `loadTrip` jämför resans/snabbnotans `is_demo`-flagga mot sessionens aktuella läge (via request-scoped `AsyncLocalStorage`, samma mönster som transaktionshanteringen i `src/database.ts`) och nekar annars — en demo-session kan alltså aldrig läsa en riktig resa och en vanlig session kan aldrig läsa en demo-resa, oavsett `trip_access`. `dashboard`, `statistics` och listan över snabbnotor filtrerar på samma flagga. Riktiga kontakter returneras aldrig i dashboarden i demoläge.
- En liten uttrycklig nekningslista (samma ställe i `handleApi`) blockerar `/api/users/search`, `/api/contacts`, `/api/admin`, `/api/admin/users/:id` samt alla inbjudningsskapande endpoints medan `demo_mode` är sant — dessa data/åtgärder är antingen globala (inte resescopade) eller skulle exponera riktiga kontaktuppgifter.
- Resor/snabbnotor som skapas *under* pågående demoläge (t.ex. admin klickar "Skapa resa" för att visa flödet) taggas automatiskt med samma `is_demo`/`demo_batch_id` och städas bort tillsammans med resten.
- `POST /api/admin/demo/exit` raderar hela batchen (`DELETE FROM trips/quick_tabs WHERE demo_batch_id = ?`, kaskad tar hand om deltagare/utgifter/kvitton/claims) och återställer sessionen — riktig kontext är tillbaka omedelbart, ingen ny inloggning krävs. En bakgrundsstädning (var 60:e minut, plus vid start) tar bort demodata vars session gått ut, om en admin stänger fliken utan att klicka "Avsluta demoläge".
- Kategorier är globala, inte resescopade, så `POST/PATCH /api/categories` blockeras explicit i demoläge (den centrala nekningslistan räcker inte där eftersom `GET /api/categories` måste fungera för att demoresorna ska kunna visa kategorier).
- Frontend: en banderoll ("DEMOLÄGE – …") visas när `session.demoMode` är sant, och en "Demoläge"-knapp finns i adminvyn. Att gå in/ur laddar om sidan (`location.reload()`) i stället för att tråda `demoMode` genom varje komponent.

## Ekonomi och data

- Alla belopp lagras och beräknas som heltalsöre. Historiska kolumnnamn med `_cents` betyder fortfarande öre.
- Delningar måste vara deterministiska och summan av andelarna måste alltid vara exakt lika med originalbeloppet.
- Utgifter och betalningar är huvudboken. Saldon beräknas från den och lagras inte som separat sanning.
- Finansiella poster mjukraderas eller reverseras så att historiken bevaras.
- Resor kan arkiveras och mjukraderas. Kvittofiler kopplade till en borttagen resa tas bort enligt appens nuvarande dataskyddsbeteende.
- OCR-resultat är redigerbara förslag, aldrig en auktoritativ tolkning av kvittot. PaddleOCR-VL och Tesseract jämförs, radsummor valideras mot totalen och avvikelser markeras för extra kontroll.

## Databasmigreringar

Aktuell högsta version är 7:

1. Grundschema för användare, resor, utgifter, betalningar, åtkomst och audit-logg.
2. Global adminroll, möjlighet att inaktivera konton och frivilligt utgiftsdatum.
3. Resepapperskorg, kategorier, kvittofiler och väninbjudningar.
4. Fristående snabbnota med kvittorader, inbjudningar och registrerade deltagare.
5. Kontolösa snabbnotegäster och claims som kan tillhöra antingen användare eller gäster.
6. Antal per snabbnoterad och per deltagares val, utan att samma produkt behöver delas upp i flera rader.
7. Admin-only demoläge (`is_demo`/`demo_batch_id` på `trips` och `quick_tabs`, `demo_mode`/`demo_batch_id` på `sessions`) samt en korrigering av tre främmande nycklar mot `participants(id)` (`expense_shares.participant_id`, `expenses.payer_id`, `payments.from_id`/`to_id`) som saknade `ON DELETE CASCADE` — upptäcktes eftersom demolägets städning är första koden som någonsin hårdraderar en resa.

Nya schemaändringar ska få nästa migrationsnummer. Ändra inte en redan distribuerad migration och gör inga destruktiva volymoperationer.

## Viktiga nuvarande funktioner

- Svenska konton, sessionsinloggning och adminvy.
- Startsida med resor, utgifter och kontakter.
- Skapa, arkivera, återställa och mjukradera resor.
- Skapa och redigera utgifter med flera delningsmetoder.
- Kategorier, kvittouppladdning och statistik.
- Vän-, rese- och snabbnoteinbjudningar med länk och QR-kod.
- Svensk OCR för belopp, datum, handlare och kvittorader.
- Snabbnota med registrerade användare eller kontolösa gäster, individuella claims och realtidsuppdatering.
- Snabbnoter behåller produktmängder på en gemensam rad, låter varje deltagare välja antal och erbjuder förifylld Swish-betalning till skaparen.
- Kvittobilder komprimeras i webbläsaren (mål ~3200 px långsida, JPEG ~0,85) innan uppladdning och normaliseras igen med Sharp på servern innan lagring, oavsett vad klienten skickade.
- Admin-only demoläge: en admin kan gå in i en isolerad, fiktiv datauppsättning (två resor, en snabbnota) utan att någonsin kunna läsa eller ändra riktiga användares data, och lämna läget igen utan att logga ut.
- Synligt förenklat versionsnummer från `package.json`/`APP_VERSION`.

## Test- och releaseflöde

Krav före release:

1. `pnpm run typecheck`
2. `pnpm run lint`
3. `pnpm test`
4. `docker compose config --quiet` där Docker finns
5. Grön GitHub Actions-körning med PostgreSQL-integrationstest och containerbygge

En push till `main` bygger och publicerar `latest` samt en oföränderlig `sha-*`-tagg. Pull requests kör tester, bygger appcontainern och validerar Compose men publicerar inte produktionsimagen.

## Senaste utvecklingsstatus

- Version 1.19.2 lägger till två fristående PowerShell-skript i `scripts/`, på användarens begäran, inför framtida lösenordsåterställning via e-post (SMTP AUTH fasas ut från Exchange Online). Ingen backend-/frontend-kod, ingen databasändring, ingen ny appfunktion — skripten körs av användaren själv mot deras eget Microsoft 365/Azure-tenant, aldrig av mig. `scripts/setup-email-integration.ps1` använder Azure CLI (`az`) för att skapa/återanvända en app-registrering ("Kompis Split Mail"), lägga till Graph-behörigheten `Mail.Send` (application, GUID `b633e1c5-b582-4048-a93e-9f11b44c7e96`), begära admin-consent, skapa en klienthemlighet och skriva ut färdiga miljövariabler (`GRAPH_TENANT_ID`/`GRAPH_CLIENT_ID`/`GRAPH_CLIENT_SECRET`/`GRAPH_SENDER_EMAIL`) att klistra in i Compose-miljön. Körs säkert flera gånger (återanvänder befintlig app-registrering, skapar aldrig en ny klienthemlighet utan uttrycklig bekräftelse). `scripts/scope-email-sender.ps1` är ett rekommenderat andra steg: skapar en Exchange Online Application Access Policy (`New-ApplicationAccessPolicy`) så appen bara kan skicka som en vald avsändarmailbox i stället för valfri brevlåda i tenanten, vilket begränsar skadan om klienthemligheten någonsin läcker. Faktisk backend-integration mot Microsoft Graph (`sendMail`) och lösenordsåterställningsflödet är inte byggt än — det är nästa steg när användaren har kört skripten.
- Version 1.19.1 är en liten polerings-/kul-omgång, på användarens begäran. Statistik-ikonen (⌁, tvetydig) byttes till 📊 överallt den används; alla ikon-only-knappar i mobilhuvudet fick konsekventa `title`-attribut. Två rent kosmetiska easter eggs, aldrig kopplade till splitlogiken: (1) klicka logotypen fem gånger snabbt (inom 2,5 s) visar ett grönvitt Hammarby-tema-meddelande i 3,2 sekunder; (2) kvittorader i Snabbnota vars namn matchar öl-relaterade ord (öl, pilsner, lager, ipa, stout, porter, ale, beer) får en 🍺 bredvid namnet. Inget nytt API, ingen databasändring.
- Version 1.19.0 lägger till en inbyggd användarguide, på användarens begäran. Ny sida (`#guide`, länk "？ Användarguide" i sidomenyn och mobilhuvudet) med rena statiska förklaringstexter — inget nytt API, ingen databasändring. Täcker: när man ska använda Grupp kontra Snabbnota, steg-för-steg för båda flödena (inklusive den nya "Markera betald"-funktionen), tips för kvittofoto/OCR, vad statistiksidan visar, och hur man rapporterar en bugg. En extra sektion med adminfunktioner visas bara för administratörer.
- Version 1.18.0 lägger till inbyggd buggrapportering, på användarens begäran. Klicka "Rapportera en bugg" (sidopanelen, eller ikon i mobilhuvudet) → skriv vad som hände → valfri skärmbild (samma bildkomprimering/validering som kvittobilder). Rapporten bifogar automatiskt sidans URL, webbläsare, appversion och en kort "brödsmulesspår" av de senaste ~30 API-anropen (metod+sökväg+statuskod, aldrig request-/svarsinnehåll) — insamlat centralt i `frontend/src/api/client.ts` så ingen enskild komponent behöver instrumenteras. Ny tabell `bug_reports` (migration 9). Backend: `POST /api/bug-reports` (skapar rapporten, hastighetsbegränsad till 5/timme per användare), `POST /api/bug-reports/:id/screenshot` (bara rapportören själv får bifoga sin egen skärmbild, samma bildvalidering/normalisering som kvitton). Admin-panelen har en ny sektion "Buggrapporter": lista, visa fullständiga detaljer + skärmbild i en popup, markera löst/olöst, ta bort. Begränsat till inloggade användare (inte snabbnotegäster) eftersom gäster saknar en app-bred session att säkra uppföljningsanropet för skärmbilden mot. Tillagd i demoläges-denylistan för adminvyerna. Verifierat med nya integrationstester (rätt ägare krävs för skärmbild, endast admin kan lösa/ta bort, brödsmulor sparas korrekt) och manuellt i webbläsaren (helt flöde: skicka → visa i admin → markera löst → ta bort).
- Version 1.17.0 lägger till betalningsspårning för snabbnotor, efter en användarrapport ("går inte markera betalt efter man swishat på snabbnota") och en önskan om att se vilka som betalat. Undersökning visade att snabbnotor aldrig fick resornas motsvarande koncept (`payments`-tabellen, "Markera betald") — bara vem som bockat av vilken kvittorad, aldrig om pengarna faktiskt kommit fram. Swish exponerar ingen betalningsverifiering för en icke-handlare/privat app (kräver Swish Handel-avtal med certifikatbaserad integration), så precis som resornas befintliga betalningsflöde är detta tillitsbaserad rapportering, inte verifiering. Ny tabell `quick_tab_payments` (migration 8, samma användar/gäst-mönster som `quick_tab_claims`), ny `POST /api/quick-tabs/:id/payments` — bara ägaren (den som faktiskt tar emot Swishen) får markera någon som betald/obetald, eftersom ägaren är den enda som vet om pengarna kom fram. `personTotals` visar nu `paidAt` per person; ägaren ser en "Markera betald"-knapp per deltagare (utom sig själv), övriga ser en skrivskyddad "Betald"/"Obetald"-badge. Verifierat både med nya integrationstester (endast ägaren får markera, kaskaddata, gäst ser sin egen status) och manuellt i webbläsaren.
- Version 1.16.1 byter all synlig svensk text från "Resa"/"resor" till "Grupp"/"grupper" på användarens begäran (t.ex. "Ny resa" → "Ny grupp", "Aktiva resor" → "Aktiva grupper", felmeddelanden som "Resan finns inte" → "Gruppen finns inte"). Detta är **enbart en textändring**, inte en modell-/schemaomdöpning: `trips`-tabellen, `/api/trips`-rutterna, `tripId` och alla andra interna kodnamn är oförändrade avsiktligt, för att hålla risken låg — bara det som faktiskt syns för användaren ändrades. Expenskategorin "Resa" (🚆, menande reseutgifter/transport) är ett helt annat begrepp och lämnades orörd. Alla 10 berörda frontend-filer plus `src/server.ts` gicks igenom systematiskt med sökning efter ordgränsmatchningar (`resa|resor|resan|resorna|resans`), verifierat visuellt i webbläsare (dashboard, gruppvy, sidopanel, adminpanel).
- Version 1.16.0 är fyra separata UX-/funktionsfixar från direkt användarfeedback: (1) **Antal-fältet** för snabbnoterader var ett `type="number"`-fält som på mobilen kunde kräva nollutfyllda tvåsiffriga inmatningar (t.ex. "05") istället för att bara skriva "5" — bytt till `type="text" inputMode="numeric" pattern="[0-9]*"` (samma standardlösning som Stripe/Google använder för att undvika webbläsares inkonsekventa nummerinmatningsbeteende), verifierat manuellt i mobilemulerad webbläsare. (2) **"Bjud in"** visade QR-koden inbäddad längst ner i sidopanelen istället för tydligt fokuserad — flyttad till en riktig popup (`<dialog>`-baserad `Modal`, samma komponent som övriga dialoger använder). (3) **"Visa kvitto"** öppnade kvittobilden i en ny flik (`window.open`) — visas nu som en popup i appen, så man enkelt kommer tillbaka utan att lämna sidan. (4) **Admin-borttagning av snabbnotor**: fanns tidigare ingen väg att ta bort en snabbnota alls (inte ens för ägaren – bara stänga/öppna); ny `DELETE /api/admin/quick-tabs/:id`, admin-only (`requireAdmin`), riktig borttagning (inte papperskorg/återställning som resor har, eftersom snabbnotor är tänkta att vara kortlivade) — alla `quick_tab_*`-tabeller kaskaderar redan korrekt på `quick_tabs.id`. Ny sektion "Alla snabbnotor" i adminpanelen. Tillagd i demoläges-denylistan (kan aldrig nå riktiga snabbnotor från en demosession). Ny integrationstest täcker behörighet (endast admin, inte ens ägaren), 404 för obefintlig nota, kaskadborttagning och granskningsloggen.
- Version 1.15.7 rättar ytterligare ett kvittonamn-fel på samma Strandbryggan-kvitto, kvarstående även efter 1.15.6: `merchantName()`s poängsättning inom ett enskilt OCR-pass valde gatuadressen "Stranvägskajen 27" (14 bokstäver) före restaurangnamnet "Strandbryggan" (13 bokstäver) eftersom poängen i praktiken bara var antal bokstäver. Två strukturella signaler tillagda i stället för ett kvittospecifikt specialfall: (1) en kandidatrad som förekommer ordagrant mer än en gång bland raderna väger nu tyngre än ren bokstavslängd — ett företagsnamn skrivs ofta ut två gånger nära toppen av ett svenskt kvitto (rubrik + igen ovanför beställningsdetaljerna), medan en gatuadress bara står en gång; (2) varje siffra i kandidatraden ger nu ett litet poängavdrag, eftersom en gatuadress i princip alltid innehåller en siffra (gatunummer, postnummer) medan ett företagsnamn nästan aldrig gör det. "Strandbryggan" (skrivs ut två gånger, inga siffror) vinner nu tydligt över "Stranvägskajen 27" (en gång, två siffror).
- Version 1.15.6 rättar felaktigt kvittonamn, hittat direkt av användaren efter 1.15.5 (restaurangnamnet visades som "SAN = Servis IRS TRA SN ARS RASER VN" trots att alla kvittorader och totalsumman var helt korrekta). Orsak: `combineReceiptPasses()` valde titel genom att jämföra `merchantNameScore()` för samtliga OCR-pass (PaddleOCR-VL + den lokala Tesseract-reserven) oberoende av vilket pass som faktiskt vann på rader/totalsumma — och den poängen är i praktiken bara antal bokstäver, så en lång felläst rad från det mycket mindre tillförlitliga Tesseract-passet slog en kort korrekt "Strandbryggan" från PaddleOCR-VL. Titeln följer nu det vinnande passet, precis som belopp och datum redan gjorde (`firstValue("title")` i stället för en egen tvärgående omsortering). Bekräftat med loggarna för samma verkliga skanning (`rawText` visade korrekt "Strandbryggan" från PaddleOCR-VL) och ett nytt test.
- Version 1.15.5 rättar tre buggar som bara syntes med den nya opt-in-loggningen (`RECEIPT_OCR_DEBUG_LOG=true`) påslagen mot samma Strandbryggan-kvitto, hittade i den verkliga rå-OCR-texten från produktion (inte gissningar): (1) terminalkoden och dess registernummer stod på **samma** rad ("xCL_AT-150-E-18E #1 : 3564") med ett gement `x` i stället för separata rader som 1.15.4 antog — redan täckt av toleransen från 1.15.4, bekräftat med ett nytt test byggt på den exakta rå-texten. (2) `reuniteWrappedWords` hade ett verkligt hål: när namn och pris redan står ihop på samma rad och bara en enstaka bokstav radbryts till nästa rad ("1.00 Caesarsalla 285.00" följt av lösryckt "d"), lades bokstaven tidigare på tekniskt fel plats (efter priset) — raden slutade då inte längre på ett prisbelopp och hela kvittoraden (580 kr, "Caesarsallad" + "Tryffelpasta") föll bort helt i stället för att bara tappa en bokstav. Fragmentet klistras nu in före prisbeloppet när föregående rad redan har ett. (3) Kortterminalens dricks-rad ("Tip: 182,50 SEK") kändes inte igen som betalningsmetadata och blev en påhittad kvittorad — `tip`/`dricks`/`netto(belopp)`/`net amount` läggs nu till uteslutningslistan. Separat, orelaterad städning: loggfältet `source` var hårdkodat till `"ollama+tesseract"` även när PaddleOCR-VL faktiskt kördes (kvarleva från innan 1.12.0-bytet) — visar nu `"paddleocr+tesseract"` när PaddleOCR-VL är aktiv modell; frontend-jämförelsen som styr "lokal AI + OCR"-texten uppdaterad i samma ändring.
- Version 1.15.4 rättar den bugg 1.15.3 missade, hittad via ett verkligt kvitto (Strandbryggan, Stockholm) och docker-loggarna för samma skanning. Terminalkoden `XCL AT-150-E-18E #1` blev fortfarande en falsk kvittorad ("Cl AT-150-E-18E 41", 35,64 kr) trots `looksLikeSystemCode`-filtret från 1.15.2, eftersom PaddleOCR-VL tappade `#`-tecknet och läste en enda bokstav som gemen — filtret krävde noll gemener och gav upp helt på en enda felläst bokstav. `looksLikeSystemCode` tolererar nu upp till 25 % gemener i stället för att kräva perfekt versalläge (bekräftat reproducerbart deterministiskt, inte en gissning). Samtidigt hittades och stängdes en andra, bredare brist: en fristående 3–5-siffrig rad (t.ex. terminalkodens radnummer "3564") gjordes tidigare ovillkorligen om till ett SEK-belopp ("35,64") av `normalizeNumericGlyphs`, oavsett var på kvittot den stod — nu hoppas den omvandlingen över när raden precis ovanför ser ut som en terminal-/registerkod. Radbrytningen av "Caesarsallad"/"Tryffelpasta" på samma kvitto visade sig redan fungera korrekt (verifierat, inte antaget). Ny opt-in loggning: `RECEIPT_OCR_DEBUG_LOG=true` inkluderar en trunkerad rå-OCR-textsnutt i `ai`/`ai_verify`-raderna i `docker compose logs` för framtida felsökning utan gissningar — av som standard, eftersom kvittoinnehåll aldrig loggats sedan 1.9.0 och det förblir den avsiktliga standarden.
- Version 1.15.3 är en arkitekturgenomgång av kvittoparsern, inte ännu en enskild bugfix. Bakgrund: 1.15.1 och 1.15.2 lappade individuella metadata-mönster (bordsnummer, terminalkoder) ett i taget, men användaren fortsatte hitta nya varianter — ett tecken på att parsern saknade en grundläggande förståelse av kvittots struktur. Historikgenomgång bekräftade att AI-anropet (PaddleOCR-VL:s odekorerade `OCR:`-kommando utan tvingat JSON-schema, se v1.12.0) redan var en medveten, väl motiverad avvägning — en tidigare version körde strukturerad JSON-extraktion med Qwen3-VL (v1.5–1.11) och bytte medvetet bort från det när modellen byttes, eftersom PaddleOCR-VL är en renodlad OCR-modell och inte tränad för schemabunden strukturerad utdata. Problemet satt istället i den lokala textparsern (`src/receipt-ocr.ts`), som klassificerade rader ett mönster i taget istället för att förstå att ett kvitto alltid har samma uppbyggnad: header (butik/bord/terminal) → varor → moms/delsumma → total → betalningsdetaljer. Ny funktion `itemsSectionBounds()` hittar varusektionen strukturellt (första raden med ett kvantitetsprefixat namn eller ett prisbelopp, till första `totalWords`-träffen) och begränsar de riskfyllda korsrads-sammanslagningarna (där ett namn på en rad kan plocka upp fel pris från en närliggande rad) till den sektionen. Rader med namn+pris komplett på samma rad påverkas inte — det var aldrig den sortens rad som orsakade buggarna. Ett nytt test bevisar generaliseringen: ett helt påhittat, aldrig tidigare sett header-fält ("Löpnummer 88213-A") utesluts korrekt utan att finnas i någon nyckelordslista. Prestandaeffekt: eftersom sektionsmedvetenheten minskar antalet felklassificerade rader redan i första AI-passet, bör färre kvitton behöva den dyra andra AI-verifieringsomgången (`PADDLEOCR_ACCURATE_RETRY`) — mätbart via befintlig loggning (`aiRetried`, `balanced`, `durationMs`) i `docker compose logs`, ingen kod ändrades i själva AI-anropet eller reservvägarna.
- Version 1.15.2 förbättrar kvittotolkningen igen efter ytterligare ett verkligt kvittoexempel från användaren (Strandbryggan, Stockholm): (1) ett långt rätt-namn som radbryts på det smala kvittopapperet ("Caesarsalla" + lösryckt "d" på nästa rad, "Tryffelpast" + "a") tappade tidigare sin sista bokstav eller föll bort helt — en ny textåterföreningsfunktion (`reuniteWrappedWords`) återförenar ett kort (1–3 tecken) gement bokstavsfragment med föregående rad, oavsett om prisbeloppet hamnar ihop med fragmentet eller på en egen rad. (2) En kassaterminal-/registerkod ("XCL AT-150-E-18E #1") kunde bli en falsk kvittorad på samma sätt som "Bord 17" tidigare — filtreras nu bort via `looksLikeSystemCode` (versaler+bindestreck, inga gemener, ett mönster ingen svensk rätt har). En tidigare misstänkt bugg ("Extra" som kvittorad) visade sig vid närmare granskning vara korrekt, avsiktligt beteende (bekräftat av ett redan existerande test) och lämnades orörd.
- Version 1.15.1 rättar en kvarvarande Snabbnota-inbjudningsbugg som 1.15.0:s fix missade: varje `POST /api/quick-tabs/:id/invitations` (klick på "Bjud in") återkallade **alla** tidigare inbjudningar för notan, oavsett om de fortfarande var giltiga och oanvända. Eftersom en snabbnoteinbjudan tillåter upp till 30 användningar (`max_uses`) fanns ingen anledning att göra det — konsekvensen var att den allra första QR-koden/länken (skapad automatiskt när notan skapas, den som oftast delas direkt i en gruppchatt) slutade fungera så fort ägaren öppnade notan igen och klickade "Bjud in", även om ingen hunnit använda den än. Nu skapar varje klick bara en *ytterligare* giltig inbjudan; gamla länkar fortsätter fungera tills de går ut (14 dagar), precis som reseinbjudningar redan gjorde. Hittades genom att felsöka en verklig felrapport, inte genom kodgranskning.
- Version 1.15.0 rättar Snabbnota-återinbjudan, verifierar svensk teckenhantering, bygger klient- och serversidig kvittokomprimering, förbättrar OCR-tolkningen och lägger till ett admin-only demoläge. Ingen arkitektur byttes ut.
  - **Snabbnota igen:** ägaren kunde inte se "Bjud in"-knappen efter att ha avslutat en snabbnota (`!tab.closedAt`-villkoret dolde den helt trots att backend redan tillät en ny inbjudan när som helst) — fixat genom att ta bort villkoret. Gäster som öppnade samma inbjudningslänk igen (t.ex. efter att ha stängt fliken) skapade tidigare en helt ny `quick_tab_guests`-rad varje gång; `/api/quick-tabs/guest-join` känner nu igen en befintlig giltig gästsession för samma snabbnota och återansluter i stället för att duplicera.
  - **Svenska tecken:** verifierad end-to-end (deltagarnamn, utgiftstitlar, snabbnotenamn/produkter, `/api/users/search`) med nya regressionstester som använder Köttbullar/Räksmörgås/Öl/Blåbärspaj/Ångbåtsbryggan. Inget ASCII-filter hittades — databas, API och OCR-parsern hanterade redan å/ä/ö korrekt, men saknade testtäckning.
  - **Kvittobilder:** klienten läser bilden med `createImageBitmap` (EXIF-medveten), skalar ner till max ~3200 px långsida och komprimerar till JPEG ~0,85 innan uppladdning, med tydliga statusar ("Förbereder bild…", "Komprimerar kvitto…"). Originalbilder tillåts upp till 50 MB innan komprimering; appens hårda gräns för själva uppladdningen höjdes från 8 till 20 MB (`receiptMaximumBytes`). HEIC/HEIF upptäcks och avvisas med tydligt felmeddelande i stället för att tystnadigt misslyckas. Servern litar aldrig på klientens komprimering: varje bildkvitto normaliseras igen med Sharp (autorotation, cap vid 3000 px långsida, JPEG-kvalitet 90, metadata bortstruken) innan det lagras — detta upptäckte och stängde även en tidigare lucka där `/api/expenses/:id/receipts` inte validerade bildmått alls. Se `DEPLOYMENT.md` för Nginx/Cloudflare-gränser.
  - **OCR-tolkning:** kvittometadata som `Bord 17`, `Kassör`, `Beställning`, `Referens`, `Gäster`/`Antal gäster` och `Swish` blir inte längre kvittorader, inklusive fallet där en orelaterad summa OCR-mässigt hussamnar direkt efter en sådan rad. Rabatt-/kupongrader räknas inte längre som köpta artiklar. Nya syntetiska testkvitton (restaurang, mataffär, bar, "svår OCR") i `tests/receipt-ocr.test.mjs`.
  - **Admin-only demoläge:** ny arkitektur, se separat avsnitt nedan.
- Version 1.14.0 är en produktionshärdningsgenomgång efter React-migreringen, inriktad på säkerhet, finansiell korrekthet och drift bakom Cloudflare + Nginx Proxy Manager. Ingen arkitektur byttes ut. Ändringar: klient-IP för rate limiting läses från `CF-Connecting-IP` i stället för `X-Forwarded-For`s förstaled (det gamla sättet gick att kringgå och gjorde inloggningsspärren verkningslös bakom en proxykedja som lägger till i headern); `/api/users/search` läcker inte längre telefonnummer och `POST /api/contacts` kräver en delad resa/snabbnota; det generiska felsvaret läcker inte längre interna undantagsmeddelanden för oväntade fel; CSP:s `img-src` tillåter `blob:` (kvittoförhandsvisningen i "Ny utgift" använder `URL.createObjectURL` och blockerades annars av den strikta policyn); kvittoräkningen per utgift är nu låst i en transaktion så samtidiga uppladdningar inte kan tränga förbi femgränsen; `loadTrip` hämtar delningar/kvitton för hela resan i två frågor i stället för två frågor per utgift. Nya IDOR- och autentiseringstester lades till i `tests/server.integration.test.mjs` (utomstående användare nekas trip/kvitto/snabbnota-åtkomst, inloggningsspärren testas end-to-end, betalningsflödet har nu testtäckning) samt namngivna finansiella gränsfall i `tests/split.test.mjs`. Frontend: redigering av en procent-/andelsdelad utgift tappade tidigare tyst delningstypen (belopp förblev korrekta men metoden byttes till "exakt") — fixat; formulär för utgift/resa/betalning/snabbnota/person visar nu ett spärrat "sparar…"-läge under insändning för att undvika dubbletter vid dåligt mobilnät; snabbnotagäster vars session gått ut fastnade tidigare utan väg tillbaka efter ett 401-svar — fixat; sökracet i deltagarsök (stale response kunde skriva över ett nyare sökresultat) fixat med en request-räknare. Ny `DEPLOYMENT.md` (topologi, proxy-tillitsmodell, uppdatering/backup/återställning/rollback) och `PUBLIC_LAUNCH_CHECKLIST.md` (vad som saknas före en bredare lansering).
- Version 1.13.0 ersätter den tidigare globala vanilla-JavaScript-klienten med React 19, Vite och strikt TypeScript. Alla befintliga arbetsflöden använder samma server-API: konton och inbjudningar, dashboard och vänner, resor, deltagare, utgifter och fyra delningssätt, kategorier, kvitton/OCR, saldon och betalningar, snabbnota med gästläge/SSE/Swish-länk, statistik, administration och versionsvisning. Docker bygger frontend och backend i samma build stage och slutcontainern är fortfarande en enda read-only Node-app. Databasschema, OCR-tjänster, Compose-portar, volymer och miljövariabler ändrades inte.
- Version 1.12.0 byter den lokala dokumentmodellen till PaddleOCR-VL 1.6 via dess officiella GGUF-distribution och en intern, versionspinnad llama.cpp CUDA-server. Modellen använder det dokumenterade `OCR:`-kommandot utan framtvingat JSON-schema. Parsern hanterar både traditionella artikelrader och PaddleOCR-resultat där flera produktnamn följs av ett separat prisblock, samt totalrubrik och totalbelopp på skilda rader. Modellfilerna hämtas atomiskt till en beständig Unraid-katalog. Tesseract och alla säkra reservvägar behålls.
- Version 1.11.0 byter till den officiella `qwen3-vl:4b-instruct-q4_K_M`, eftersom thinking-varianten kan returnera hundratals tokens i `message.thinking` men lämna `message.content` tomt för bilder. Reserv-OCR använder en naturligare gråskalebild och behandlar inte längre största artikelpriset som totalsumma när en oläslig totalrad faktiskt finns. `thinking_only` loggas separat utan att modellens resonemang eller kvittodata sparas.
- Version 1.10.0 begränsar Qwen3-VL:s kvittosvar till 768 tokens, stänger uttryckligen av thinking-läge och skickar en mindre AI-bild utan att minska Tesseracts upplösning. Detta förhindrar minutlånga svar som annars fortsatte till timeout. Säkra loggar visar nu avslutsorsak, prompt- och svarstokens samt modellens laddnings- och inferenstid utan att logga kvittodata.
- Version 1.9.0 rätar ut fotograferade papperskvitton mot mörk bakgrund och kombinerar alternativa läsningar genom att välja radbelopp som får kvittot att summera exakt. Heltalsbelopp före `SEK`, prioriterade beställningsdatum, OCR-varianter av antalmarkören `x` och styckpris gånger antal hanteras deterministiskt. En exakt lokal tolkning avbryter den långsamma AI-körningen. Säkra loggar och klientstatus visar om Ollama användes, tog timeout, saknade modell, inte kunde nås eller returnerade ogiltigt svar; kvittobild och OCR-text loggas aldrig.
- Version 1.8.0 byter huvudmodell från GLM-OCR 0,9B till Qwen3-VL 4B Q4_K_M. Modellen returnerar ett validerat kvittoschema och använder 8K kontext. Tesseract kör fortfarande parallellt, medan ofullständiga eller matematiskt inkonsekventa AI-resultat automatiskt får en andra kontroll. GTX 1080 Ti har 11 GB VRAM; Compose tillåter därför två samtidiga modellförfrågningar med Flash Attention och q8-KV-cache, medan två Tesseract-arbetare nyttjar CPU:n utan en global kö. Modellen är cirka 3,3 GB; första modellhämtningen tar därför längre tid än tidigare.
- Version 1.7.0 beskär automatiskt bort iPhone-förhandsvisning, verktygsfält och tomma bildmarginaler innan kvittot skalas upp. GLM-OCR använder modellens dokumenterade textigenkänningsläge och kör parallellt med Tesseract, med 45 sekunders konfigurerbar timeout (`OLLAMA_OCR_TIMEOUT_MS`). Parsern bevarar kompakta antal som `3x` och `7x` och filtrerar betalningsrader.
- Version 1.6.0 lägger till antalval på snabbnoter, deterministisk öresfördelning per vald mängd och en Swish-knapp till snabbnotans skapare. Befintliga rader migreras säkert som antal 1.
- Compose använder `runtime: nvidia` för kompatibilitet med Unraid Compose Manager i stället för det nyare `gpus`-fältet.
- Version 1.5.0 lägger till helt lokal GLM-OCR via Ollama, adaptiv flerpass-OCR, bildnormalisering och bättre hantering av radbrytningar och teckenfel i belopp.
- Kamera och bildbibliotek har separata knappar så att användaren alltid kan välja en befintlig bild om Chrome-kameran inte fungerar på enheten.
- PaddleOCR körs endast på det interna Compose-nätverket med `ghcr.io/ggml-org/llama.cpp:server-cuda-b9570`; appen faller automatiskt tillbaka till Tesseract om modellen inte är tillgänglig.
- Version 1.4.0 innehåller förbättrad svensk kvittoradstolkning och kontolösa snabbnotegäster.
- Setup-sessionens HTTP-svar skickas först efter att PostgreSQL-transaktionen har committats, vilket förhindrar en sporadisk 401 direkt efter första installationen.
- PostgreSQL-integrationstest, TypeScript, lint och övriga tester är gröna för denna version.
- Docker Compose ändrades inte i version 1.4.0.

## Regler för löpande uppdatering

Uppdatera detta dokument när någon av följande saker ändras:

- appversion eller högsta migrationsnummer;
- tjänster, images, portar, volymer, backuper eller Unraid-instruktioner;
- autentisering, roller, inbjudningar eller åtkomstmodell;
- ekonomiska beräkningar eller datalivscykel;
- större funktioner, borttagna funktioner eller kända begränsningar;
- test-, CI-, release- eller rollbackflöde.

Skriv bara verifierade fakta om det aktuella repot. Kortlivade arbetsanteckningar och spekulationer hör inte hemma här.
