# Kompis Split

En liten självhostad app för att dela resekostnader med vänner. Frontend är React 19, Vite och strikt TypeScript. Backend är Node.js 24 med TypeScript och PostgreSQL 17. Alla pengar lagras som heltalsöre.

## Funktioner

- Personliga konton, hashade lösenord och utgående serverlagrade sessioner
- Hashade inbjudningstoken med 14 dagars giltighet
- Väninbjudningar utan resa samt lokalt genererade QR-koder för vän- och reseinbjudningar
- Serverkontrollerad åtkomst per resa: ägare, administratör eller medlem
- Sökbara användare, kontakter och gästdeltagare
- Vänner direkt på startsidan
- Globalt adminläge för alla användare, resor, kontostatusar och senaste aktivitet
- Admin-only demoläge: visa appen med fiktiva exempeldata utan att röra riktiga konton, resor eller kontakter
- Aktiva och arkiverade resor samt återställningsbar papperskorg utan att ekonomiska poster försvinner
- Lika, procentuell, exakt och viktad deterministisk fördelning
- Mjuk radering, beständig audit-logg och versionsstyrda databasmigreringar
- Frivilliga datum för både resor och utgifter
- Egna, arkiverbara utgiftskategorier samt kvitton direkt under utgiften
- Helt lokal svensk kvittoavläsning med en persistent RapidOCR/ONNX-tjänst, kvittospecifik parser, öresvalidering och Tesseract-reserv
- Mobilanpassade formulärfält som inte automatiskt zoomar in på iPhone
- Egen statistikvy för kategorier, restauranger/platser, betalare och månadsutveckling
- Fristående Snabbnota: skanna kvittorader, dela en säker länk och låt alla bocka av mat och dryck i realtid
- Snabbnotans mängder ligger kvar på samma rad, så varje deltagare kan välja exempelvis 0–6 öl och sedan öppna en förifylld Swish-betalning till skaparen
- PostgreSQL-healthcheck och dagliga komprimerade `pg_dump`-backuper

## Installation på Unraid

Node.js och PostgreSQL behöver inte installeras på Unraid; allt körs i Compose.

1. Lägg repot/stackfilen i `/mnt/user/kompis_split/app/`.
2. Skapa dessa miljövariabler i Compose Manager (GPU eller Nvidia-plugin behövs inte):

   ```dotenv
   APP_PASSWORD=ett-långt-slumpmässigt-installationslösenord
   COOKIE_SECRET=minst-32-slumpmässiga-tecken
   POSTGRES_PASSWORD=ett-annat-långt-slumpmässigt-lösenord
   COOKIE_SECURE=false
   TRUST_PROXY=false
   SESSION_DAYS=30
   BACKUP_RETENTION_DAYS=14
   RECEIPT_INFERENCE_TIMEOUT_MS=15000
   OCR_INTRA_OP_THREADS=8
   OCR_QUEUE_CAPACITY=4
   OCR_MEMORY_LIMIT=1g
   OCR_CPU_LIMIT=8
   RECEIPT_OCR_WORKERS=1
   ```

3. Välj **Pull & Up**. OCR-modellerna (17,6 MiB) finns redan checksummekontrollerade i den publicerade inference-imagen; ingen modell laddas ned vid körning.
4. Öppna `http://DIN-UNRAID-IP:8787` och skapa första administratören med `APP_PASSWORD`.

PostgreSQL publicerar ingen port på Unraid. Endast appen finns på port 8787. Beständig data och backup ligger utanför containrarna:

```text
/mnt/user/kompis_split/postgres/
/mnt/user/kompis_split/backups/
```

Den gamla demo-SQLite-filen under `/mnt/user/kompis_split/data/` används inte längre och kan ligga kvar tills du själv väljer att ta bort den.

## Uppdatering via GitHub

En push eller pull request kör TypeScript-kontroll, finansiella tester, API-test mot PostgreSQL, ett riktigt containerbygge och Compose-validering. Efter en godkänd push till `main` byggs multi-arch-images i GHCR.

Produktionsstacken följer den publicerade `latest`-imagen. När workflowen är grön väljer du bara **Pull & Up** i Compose Manager; Compose-filen behöver inte redigeras. Varje publicering får även en oföränderlig `sha-<commit>`-tagg. Spara föregående fungerande tagg så att du vid behov kan använda den tillfälligt för rollback; databasvolymen påverkas inte av imagebytet.

Appen visar ett enkelt releasenummer, exempelvis `Version 1.1`. Funktionsreleaser höjs stegvis till `1.2`, `1.3` och så vidare via `version` i `package.json`. Commit-taggarna används fortfarande i bakgrunden för exakt rollback.

## Snabbnota

Snabbnota är separat från resor och passar en restaurangnota där alla vill välja exakt vad de åt eller drack. Skaparen fotograferar kvittot, granskar de OCR-avlästa raderna och delar en tidsbegränsad länk eller QR-kod. Inloggade deltagare väljer sitt antal på varje rad och ser varandras val via en realtidsanslutning till samma server. En rad med sex öl ligger alltså kvar som en rad där gruppen tillsammans kan välja högst sex. Belopp och eventuella restören fördelas deterministiskt. Skaparen kan avsluta och återöppna notan; data och kvittobild ligger i PostgreSQL och följer med i ordinarie backup.

OCR kan misstolka en kvittorad. Skaparen måste därför alltid kontrollera namn, antal, radsummor och totalsumma innan snabbnotan skapas. Skillnaden mellan kvittots total och de avlästa raderna visas tydligt som ej fördelad.

Varje analys visar om den lokala inference-tjänsten användes eller om Tesseract-reserven behövdes. Säker strukturerad diagnostik och tidsmätning skrivs utan kvittobild, OCR-text, namn eller andra kvittouppgifter. Visa den med:

```sh
docker compose logs --tail=200 kompis-split receipt-inference
```

## Reverse proxy och HTTPS

Exponera inte port 8787 direkt mot internet. Använd VPN eller en HTTPS-reverse-proxy. Bakom en betrodd proxy:

```dotenv
COOKIE_SECURE=true
TRUST_PROXY=true
```

Proxyn ska vidarebefordra `Host` eller `X-Forwarded-Host`. `TRUST_PROXY=true` får bara användas när all trafik kommer genom din betrodda proxy.

Se [DEPLOYMENT.md](DEPLOYMENT.md) för produktionstopologi, den strikta integritetsgränsen för kvittobilder, proxy-tillit, uppdatering, backup och rollback. Se [QUICK_SCAN_ARCHITECTURE.md](QUICK_SCAN_ARCHITECTURE.md) för OCR-arkitektur och mätresultat.

## Backup och återställning

`postgres-backup` gör omedelbart och därefter dagligen en PostgreSQL custom-format-backup. Retention styrs av `BACKUP_RETENTION_DAYS`. Kopiera även `/mnt/user/kompis_split/backups` till en annan disk eller maskin via ditt vanliga Unraid-backupflöde.

Kvitton lagras i PostgreSQL och följer därför med i samma backup. JPG, PNG, WebP och PDF stöds, högst 20 MB per fil (efter eventuell komprimering i webbläsaren) och fem filer per utgift. När en arkiverad resa flyttas till papperskorgen raderas dess kvittofiler permanent; utgifter, betalningar och audit-logg behålls så att den ekonomiska historiken fortfarande kan granskas och resan återställas.

När en ny utgift skapas kan ett JPG-, PNG- eller WebP-kvitto fotograferas eller väljas. Stora foton (upp till 50 MB original) komprimeras i webbläsaren till ungefär 3200 px långsida och JPEG-kvalitet 0,85. Servern validerar bilden själv, tar bort metadata och begränsar dimensionerna. Originalorienteringen bevaras som OCR-underlag; ONNX-tjänsten provar evidensbaserad läsordning/orientering och den deterministiska parsern skiljer artiklar från rabatt, pant, moms, total och betalningsrader. Alla belopp representeras som heltalsöre och avstäms mot totalsumman. Inference-tjänsten saknar publik port och ligger på ett internt Docker-nät. Ingen bild eller text skickas till tredje part, och skanning fungerar utan internet efter image-installation. Om tjänsten är otillgänglig används Tesseract lokalt. Kontrollera alltid markerade avvikelser före sparande. PDF-kvitton kan bifogas men avläses inte automatiskt.

Testa återställning på en separat databas:

```sh
createdb -h SERVER -U kompis_split kompis_split_restore_test
pg_restore -h SERVER -U kompis_split --dbname=kompis_split_restore_test --clean --if-exists /path/to/kompis-split-TIMESTAMP.dump
```

Kontrollera sedan tabeller, antal resor/utgifter och saldon innan en produktionsåterställning. Återställ aldrig över en databas som används. Stoppa appen, ta en ny backup av nuvarande läge och återställ först därefter.

## Swish

Nuvarande funktion öppnar Swish app-to-app och räknar aldrig en öppnad länk som betalningsbevis. Resebetalningar registreras manuellt efteråt; snabbnotans knapp förifyller bara deltagarens aktuella belopp till skaparen. Detta är inte Swish Commerce API; framtida certifikat och nycklar ska endast ligga på servern och bara använda dokumenterad Swish-funktionalitet.

## Inbjudningar och QR-koder

Reseinbjudningar kan användas av flera vänner enligt serverns gräns och ger åtkomst till den valda resan. En vanlig väninbjudan från startsidan är inte kopplad till någon resa, kan användas en gång och sparar båda användarna som kontakter. Båda typerna gäller i 14 dagar. QR-koden skapas på den egna servern från samma inbjudningslänk; ingen länk eller token skickas till en extern QR-tjänst.

## Konfiguration

| Variabel | Standard | Syfte |
| --- | --- | --- |
| `PORT` | `8787` | Appens HTTP-port |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | satta av Compose | PostgreSQL-anslutning |
| `DATABASE_URL` | tom | Alternativ anslutningssträng för lokal utveckling/test |
| `DB_POOL_SIZE` | `10` | Max antal anslutningar från appen |
| `APP_PASSWORD` | obligatorisk i Compose | Skyddar skapandet av första kontot |
| `COOKIE_SECRET` | obligatorisk i Compose | HMAC-nyckel för sessions-ID |
| `COOKIE_SECURE` | `false` | Ska vara `true` bakom publik HTTPS |
| `TRUST_PROXY` | `false` | Ska bara vara `true` bakom betrodd proxy |
| `SESSION_DAYS` | `30` | Sessionernas livslängd |
| `BACKUP_RETENTION_DAYS` | `14` | Retention för dagliga dumpfiler |
| `RECEIPT_INFERENCE_URL` | `http://receipt-inference:8080` i Compose | Intern RapidOCR-adress; bara uttryckligen tillåtna interna HTTP-värdar accepteras |
| `RECEIPT_INFERENCE_TIMEOUT_MS` | `15000` | Total tidsgräns för lokal OCR innan Tesseract-reserven används |
| `OCR_INTRA_OP_THREADS` | `8` | ONNX/OpenMP-trådar per aktiv OCR-körning |
| `OCR_QUEUE_CAPACITY` | `4` | Hård kögräns; överlast avvisas snabbt i stället för att bygga en obegränsad kö |
| `OCR_MEMORY_LIMIT` | `1g` | Compose-minnesgräns för inference-tjänsten |
| `OCR_CPU_LIMIT` | `8` | Compose CPU-gräns för inference-tjänsten |
| `RECEIPT_OCR_WORKERS` | `1` | Tesseract-arbetare i den lokala reservvägen |

## Lokal utveckling

Kräver Node.js 24, pnpm 11 och en PostgreSQL-databas:

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm test
DATABASE_URL=postgresql://user:password@localhost:5432/kompis_split pnpm dev
```

Starta `pnpm dev:frontend` i en andra terminal för Vites utvecklingsserver på port 5173; `/api` och `/health` proxas då till backend på port 8787. `pnpm build` bygger både backend och React-frontenden. Node-servern serverar det färdiga Vite-bygget, så produktionen använder fortfarande en enda appcontainer och samma port.
