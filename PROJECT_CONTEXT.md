# Kompis Split – levande projektkontext

Senast uppdaterad: 2026-08-11  
Appversion: 1.13.0
Databasschema: migration 6

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

## Ekonomi och data

- Alla belopp lagras och beräknas som heltalsöre. Historiska kolumnnamn med `_cents` betyder fortfarande öre.
- Delningar måste vara deterministiska och summan av andelarna måste alltid vara exakt lika med originalbeloppet.
- Utgifter och betalningar är huvudboken. Saldon beräknas från den och lagras inte som separat sanning.
- Finansiella poster mjukraderas eller reverseras så att historiken bevaras.
- Resor kan arkiveras och mjukraderas. Kvittofiler kopplade till en borttagen resa tas bort enligt appens nuvarande dataskyddsbeteende.
- OCR-resultat är redigerbara förslag, aldrig en auktoritativ tolkning av kvittot. PaddleOCR-VL och Tesseract jämförs, radsummor valideras mot totalen och avvikelser markeras för extra kontroll.

## Databasmigreringar

Aktuell högsta version är 6:

1. Grundschema för användare, resor, utgifter, betalningar, åtkomst och audit-logg.
2. Global adminroll, möjlighet att inaktivera konton och frivilligt utgiftsdatum.
3. Resepapperskorg, kategorier, kvittofiler och väninbjudningar.
4. Fristående snabbnota med kvittorader, inbjudningar och registrerade deltagare.
5. Kontolösa snabbnotegäster och claims som kan tillhöra antingen användare eller gäster.
6. Antal per snabbnoterad och per deltagares val, utan att samma produkt behöver delas upp i flera rader.

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
