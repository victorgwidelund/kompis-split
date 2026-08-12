# Kompis Split – levande projektkontext

Senast uppdaterad: 2026-08-12  
Appversion: 1.15.2
Databasschema: migration 7

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
