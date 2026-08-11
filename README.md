# Kompis Split

En liten självhostad app för att dela resekostnader med vänner. Frontend är vanlig HTML/CSS/JavaScript. Backend är Node.js 24 med TypeScript och PostgreSQL 17. Alla pengar lagras som heltalsöre.

## Funktioner

- Personliga konton, hashade lösenord och utgående serverlagrade sessioner
- Hashade inbjudningstoken med 14 dagars giltighet
- Serverkontrollerad åtkomst per resa: ägare, administratör eller medlem
- Sökbara användare, kontakter och gästdeltagare
- Vänner direkt på startsidan
- Globalt adminläge för alla användare, resor, kontostatusar och senaste aktivitet
- Aktiva och arkiverade resor samt återställningsbar papperskorg utan att ekonomiska poster försvinner
- Lika, procentuell, exakt och viktad deterministisk fördelning
- Mjuk radering, beständig audit-logg och versionsstyrda databasmigreringar
- Frivilliga datum för både resor och utgifter
- Egna, arkiverbara utgiftskategorier samt kvitton direkt under utgiften
- PostgreSQL-healthcheck och dagliga komprimerade `pg_dump`-backuper

## Installation på Unraid

Node.js och PostgreSQL behöver inte installeras på Unraid; allt körs i Compose.

1. Lägg repot/stackfilen i `/mnt/user/kompis_split/app/`.
2. Skapa dessa miljövariabler i Compose Manager:

   ```dotenv
   APP_PASSWORD=ett-långt-slumpmässigt-installationslösenord
   COOKIE_SECRET=minst-32-slumpmässiga-tecken
   POSTGRES_PASSWORD=ett-annat-långt-slumpmässigt-lösenord
   COOKIE_SECURE=false
   TRUST_PROXY=false
   SESSION_DAYS=30
   BACKUP_RETENTION_DAYS=14
   ```

3. Välj **Compose Up** och öppna `http://DIN-UNRAID-IP:8787`.
4. Skapa första administratören med `APP_PASSWORD`.

PostgreSQL publicerar ingen port på Unraid. Endast appen finns på port 8787. Beständig data och backup ligger utanför containrarna:

```text
/mnt/user/kompis_split/postgres/
/mnt/user/kompis_split/backups/
```

Den gamla demo-SQLite-filen under `/mnt/user/kompis_split/data/` används inte längre och kan ligga kvar tills du själv väljer att ta bort den.

## Uppdatering via GitHub

En push till `main` kör TypeScript-kontroll, finansiella tester, API-test mot PostgreSQL och Compose-validering. Därefter byggs multi-arch-images i GHCR.

Produktionsstacken följer den publicerade `latest`-imagen. När workflowen är grön väljer du bara **Pull & Up** i Compose Manager; Compose-filen behöver inte redigeras. Varje publicering får även en oföränderlig `sha-<commit>`-tagg. Spara föregående fungerande tagg så att du vid behov kan använda den tillfälligt för rollback; databasvolymen påverkas inte av imagebytet.

Appen visar ett enkelt releasenummer, exempelvis `Version 1.1`. Funktionsreleaser höjs stegvis till `1.2`, `1.3` och så vidare via `version` i `package.json`. Commit-taggarna används fortfarande i bakgrunden för exakt rollback.

## Reverse proxy och HTTPS

Exponera inte port 8787 direkt mot internet. Använd VPN eller en HTTPS-reverse-proxy. Bakom en betrodd proxy:

```dotenv
COOKIE_SECURE=true
TRUST_PROXY=true
```

Proxyn ska vidarebefordra `Host` eller `X-Forwarded-Host`. `TRUST_PROXY=true` får bara användas när all trafik kommer genom din betrodda proxy.

## Backup och återställning

`postgres-backup` gör omedelbart och därefter dagligen en PostgreSQL custom-format-backup. Retention styrs av `BACKUP_RETENTION_DAYS`. Kopiera även `/mnt/user/kompis_split/backups` till en annan disk eller maskin via ditt vanliga Unraid-backupflöde.

Kvitton lagras i PostgreSQL och följer därför med i samma backup. JPG, PNG, WebP och PDF stöds, högst 8 MB per fil och fem filer per utgift. När en arkiverad resa flyttas till papperskorgen raderas dess kvittofiler permanent; utgifter, betalningar och audit-logg behålls så att den ekonomiska historiken fortfarande kan granskas och resan återställas.

Testa återställning på en separat databas:

```sh
createdb -h SERVER -U kompis_split kompis_split_restore_test
pg_restore -h SERVER -U kompis_split --dbname=kompis_split_restore_test --clean --if-exists /path/to/kompis-split-TIMESTAMP.dump
```

Kontrollera sedan tabeller, antal resor/utgifter och saldon innan en produktionsåterställning. Återställ aldrig över en databas som används. Stoppa appen, ta en ny backup av nuvarande läge och återställ först därefter.

## Swish

Nuvarande funktion öppnar Swish app-to-app och räknar aldrig en öppnad länk som betalningsbevis. Användaren registrerar betalningen manuellt efteråt. Detta är inte Swish Commerce API; framtida certifikat och nycklar ska endast ligga på servern och bara använda dokumenterad Swish-funktionalitet.

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

## Lokal utveckling

Kräver Node.js 24, pnpm 11 och en PostgreSQL-databas:

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
DATABASE_URL=postgresql://user:password@localhost:5432/kompis_split pnpm dev
```
