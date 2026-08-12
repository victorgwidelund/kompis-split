# Deployment — Kompis Split på Unraid

Det här dokumentet beskriver produktionstopologin, vilka antaganden appen gör om
sin reverse proxy, och de operativa procedurerna för uppdatering, backup,
återställning och rollback. Det kompletterar `README.md` (installation) och
`PROJECT_CONTEXT.md` (arkitektur och historik).

## Topologi

```
Internet
  │
  ▼
Cloudflare (DNS-proxy/CDN, TLS mot klienten)
  │  HTTPS
  ▼
Nginx Proxy Manager (på Unraid, terminerar/vidarebefordrar HTTPS)
  │  HTTP, internt nätverk
  ▼
kompis-split-appcontainern (port 8787)
  │
  ├──▶ PostgreSQL (internt Compose-nätverk, ingen publicerad host-port)
  └──▶ paddleocr / paddleocr-model (internt Compose-nätverk, ingen publicerad host-port)
```

Två separata interna anrop, båda utan publik exponering:

```
kompis-split  ──▶  PostgreSQL       (databas, aldrig publik port)
kompis-split  ──▶  paddleocr (llama.cpp)  (lokal AI-OCR, aldrig publik port)
```

**Får aldrig exponeras direkt mot internet:** PostgreSQL, `paddleocr`/`paddleocr-model`.
Endast appcontainerns port 8787 ska nås — och det ska ske via Nginx Proxy
Manager, inte direkt.

## Betrott proxy-läge (`TRUST_PROXY`)

Appen litar bara på klient-IP-headrar när `TRUST_PROXY=true`, och gör det på
ett sätt som är medvetet om att det står två hopp (Cloudflare, sedan Nginx
Proxy Manager) mellan klienten och Node-processen:

- **Klient-IP för rate limiting** (`CF-Connecting-IP`): Cloudflare sätter den
  här headern utifrån den faktiska TCP-anslutningen och skriver alltid över
  ett klientskickat värde med samma namn — den går inte att förfalska så
  länge trafiken faktiskt går via Cloudflare. Appen använder **bara** den här
  headern för klient-IP när `TRUST_PROXY=true`, aldrig `X-Forwarded-For`s
  första värde (den kan en klient fylla i fritt, och eftersom både Cloudflare
  och Nginx *lägger till* i kedjan är det fel hopp att lita på).
- **Host/protokoll för länkar och Origin-kontroll** (`X-Forwarded-Host`,
  `X-Forwarded-Proto`): används för att bygga korrekta absoluta
  inbjudningslänkar och för CSRF-skyddets Origin-jämförelse. Det här
  förutsätter att Nginx Proxy Manager sätter (skriver över) dessa headrar
  till det faktiska publika värdet, inte bara vidarebefordrar vad klienten
  skickade in. Standard-NPM-konfiguration gör detta korrekt, men **kontrollera
  din proxy host-konfiguration** om du ser oväntade 403 på skrivande anrop.

**Viktigt:** `TRUST_PROXY=true` får bara sättas när all trafik garanterat
passerar din betrodda proxykedja (dvs. port 8787 är inte nåbar på något annat
sätt). Om `TRUST_PROXY=false` littar appen bara på TCP-sockets faktiska
avsändaradress, vilket är säkert men ger fel IP bakom en proxy (alla
requests ser ut att komma från Nginx).

Sessionscookien är `SameSite=Strict`, vilket är det huvudsakliga CSRF-skyddet
oavsett proxy-inställning — Origin-kontrollen är ett extra lager, inte den
enda spärren.

## Secure cookies genom Cloudflare + Nginx

Sätt båda dessa när HTTPS termineras korrekt hela vägen till klienten:

```dotenv
COOKIE_SECURE=true
TRUST_PROXY=true
```

`COOKIE_SECURE=true` gör sessionscookien `Secure` (skickas bara över HTTPS).
Om du sätter `COOKIE_SECURE=true` men trafiken faktiskt går över HTTP mellan
Nginx och appcontainern (vanligt internt), spelar det ingen roll — det är
protokollet mellan *klient och Cloudflare/Nginx* som avgör om webbläsaren
respekterar `Secure`, inte det interna hoppet.

## Kvittouppladdning och request-storlek genom proxyn

Kvittobilder komprimeras i webbläsaren innan uppladdning (mål: max ~3200 px
långsida, JPEG-kvalitet ~0,85), så de flesta uppladdningar blir en bit under
appens egen hårda gräns på 20 MB per fil (`receiptMaximumBytes` i
`src/server.ts`, delad mellan bildkvitton och PDF-kvitton). Klientkomprimeringen
är bara en optimering — appen litar aldrig på den och normaliserar varje
bildkvitto igen med Sharp innan det lagras, oavsett vad webbläsaren redan
gjort. Om komprimeringen misslyckas (gammal webbläsare, trasig bild) tillåts
originalfilen upp till 50 MB genom validering innan uppladdning; appens
20 MB-gräns gäller ändå för själva request-kroppen.

**Kontrollera att din reverse proxy inte stoppar detta innan det når appen:**

- **Nginx Proxy Manager**: standardgränsen för `client_max_body_size` i det
  underliggande Nginx är ofta bara 1 MB om inget annat är satt. Lägg till i
  proxy host-inställningens "Custom Nginx Configuration"-fält:

  ```nginx
  client_max_body_size 20m;
  ```

- **Cloudflare**: gratis/pro-planer tillåter normalt betydligt mer än 20 MB
  per request (ofta 100 MB), så det är sällan en begränsande faktor här —
  men kontrollera din plans gräns om stora kvitton börjar avvisas utan att
  appens egna felmeddelande visas (det tyder på att Cloudflare eller Nginx
  stoppade requesten innan den nådde appen).

## Server-Sent Events (Snabbnota)

Snabbnotans realtidsuppdateringar går via SSE (`/api/quick-tabs/:id/events`).
Servern sätter redan:

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-store
Connection: keep-alive
X-Accel-Buffering: no
```

`X-Accel-Buffering: no` är kritisk genom Nginx — utan den buffrar Nginx hela
svaret och realtidsuppdateringar levereras aldrig förrän anslutningen stängs.
Servern skickar också en `: ping`-kommentar var 20:e sekund som håller
anslutningen vid liv genom proxytimeouts, och städar bort lyssnaren när
klienten kopplar från (`request.on("close", …)`), så en trasig eller
avbruten anslutning läcker inte minne. Autentisering kontrolleras innan
strömmen öppnas (samma behörighetskontroll som för notans övriga endpoints),
så en obehörig klient kan aldrig prenumerera på en annan snabbnotas
uppdateringar.

Om Nginx Proxy Manager har en egen "custom Nginx configuration"-ruta för den
här värden, kontrollera att den inte lägger till `proxy_buffering on` eller
en kort `proxy_read_timeout` som stänger anslutningen i förtid.

## Miljövariabler

Se `.env.example` för fullständig lista med standardvärden. De som är
direkt kopplade till proxytopologin:

| Variabel | Produktionsvärde (bakom Cloudflare + Nginx) | Effekt |
| --- | --- | --- |
| `TRUST_PROXY` | `true` | Litar på `CF-Connecting-IP` och `X-Forwarded-*` från proxykedjan |
| `COOKIE_SECURE` | `true` | Sessionscookien får `Secure`-flaggan |
| `PORT` | `8787` | Porten appen lyssnar på internt |

## Uppdateringsflöde

1. En push till `main` bygger och publicerar `ghcr.io/victorgwidelund/kompis-split:latest`
   samt en oföränderlig `sha-<commit>`-tagg, efter att CI (typecheck, lint,
   test, containerbygge, `docker compose config`) är grönt.
2. På Unraid: **Compose Manager → Pull & Up**. Compose-filen behöver inte
   redigeras eftersom stacken redan följer `latest`.
3. Databasvolymen (`/mnt/user/kompis_split/postgres`) och backup-volymen
   påverkas aldrig av en imageuppdatering.
4. Notera vilken `sha-*`-tagg som var igång innan uppdateringen (synlig i
   GHCR eller i det gamla containerloggens startrad) för eventuell rollback.

## Rollback

1. I Compose Manager, byt `image:`-raden för `kompis-split` tillfälligt från
   `:latest` till den tidigare fungerande `sha-<commit>`-taggen.
2. **Up** för att starta om med den gamla imagen. Databasvolymen rörs inte.
3. Om en migration mellan de två versionerna lade till kolumner/tabeller
   (framåtriktade migreringar, se `src/migrations.ts`) är det normalt säkert
   att köra en äldre appversion mot en nyare databasstruktur så länge
   migrationen bara *lade till* — appen läser/skriver bara de kolumner den
   känner till. En rollback är **inte** säker om migrationen tog bort eller
   ändrade en befintlig kolumn/tabell som den äldre versionen förväntar sig;
   det förekommer inte i den här kodbasen (migreringarna är additiva), men
   kontrollera changeloggen mellan de två versionerna innan du litar blint
   på det.
4. Byt tillbaka till `:latest` (eller en nyare fungerande tagg) när
   grundorsaken är åtgärdad.

## Backup och återställning

- `postgres-backup`-tjänsten tar en `pg_dump --format=custom` omedelbart vid
  start och därefter en gång per dygn, till `/mnt/user/kompis_split/backups`.
  Retention styrs av `BACKUP_RETENTION_DAYS` (standard 14 dagar).
- Kvittobilder ligger i PostgreSQL (`expense_receipts.content`,
  `quick_tabs.receipt_content`) och följer alltså automatiskt med i samma
  dump — ingen separat filbackup behövs för kvitton.
- Dumpfilerna innehåller inga hemligheter (lösenordshashar är saltade och
  engångsriktade, `COOKIE_SECRET`/`APP_PASSWORD` ligger aldrig i databasen).
- **Testa återställning på en separat databas, aldrig över produktionen:**

  ```sh
  createdb -h SERVER -U kompis_split kompis_split_restore_test
  pg_restore -h SERVER -U kompis_split --dbname=kompis_split_restore_test --clean --if-exists /path/to/kompis-split-TIMESTAMP.dump
  ```

  Kontrollera sedan tabellinnehåll (`SELECT COUNT(*) FROM trips`, `expenses`,
  `payments` osv.) innan en eventuell produktionsåterställning. Om en
  produktionsåterställning verkligen krävs: stoppa appcontainern, ta en ny
  backup av det aktuella (trasiga) läget för säkerhets skull, återställ,
  starta om appen.
- Kopiera `/mnt/user/kompis_split/backups` till en annan disk eller maskin
  via ditt vanliga Unraid-backupflöde — en lokal dump på samma fysiska disk
  som produktionsdatabasen skyddar inte mot diskfel.

## OCR-tjänsten (PaddleOCR / llama.cpp)

- Modellfilerna hämtas en gång till `/mnt/user/kompis_split/paddleocr` och
  checksummeras (`sha256sum`) innan de används — en trasig eller ofullständig
  nedladdning läses aldrig som klar. De laddas **inte** om vid varje
  omstart så länge filerna redan finns och matchar checksumman.
- `paddleocr`-tjänsten publicerar ingen host-port; den nås bara från
  `kompis-split` via det interna Compose-nätverket (`PADDLEOCR_URL=http://paddleocr:8080`).
- Kräver Unraids Nvidia Driver-plugin och att GTX 1080 Ti är synlig för
  Docker (`runtime: nvidia`).
- Om GPU:n eller `paddleocr`-tjänsten är otillgänglig faller appen
  automatiskt tillbaka till Tesseract — det påverkar inte appens
  tillgänglighet, bara OCR-kvaliteten.

## Manuell kontroll efter en säkerhetsuppdatering

Efter att den här ändringen (`security/production-hardening-audit`) är
driftsatt, kontrollera särskilt:

1. Att Snabbnota fortfarande uppdateras i realtid mellan två öppna flikar
   (verifierar att `X-Accel-Buffering: no` respekteras av din Nginx-config).
2. Att inloggning fortfarande fungerar normalt, och att 8 felaktiga
   inloggningsförsök i rad ger en tydlig "vänta"-spärr (verifierar att
   `CF-Connecting-IP` faktiskt når appen — om spärren aldrig löser ut alls,
   eller löser ut efter bara något enstaka försök oavsett vem som loggar in,
   tyder det på att `CF-Connecting-IP` inte skickas korrekt genom din
   Nginx-konfiguration).
3. Att kvittoförhandsvisningen i "Ny utgift"-dialogen visas innan den laddas
   upp (verifierar att den uppdaterade CSP:n `img-src`-direktivet fungerar).
