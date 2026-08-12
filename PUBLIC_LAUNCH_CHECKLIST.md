# Offentlig lansering — checklista

Kompis Split är idag en privat, självhostad app för en mindre vänkrets med en
enda admin-skapad installation (`APP_PASSWORD`-skyddad förstakontosättning).
Det här dokumentet listar vad som **saknas** innan appen rimligen kan öppnas
för okända, externa användare — inte vad som redan är byggt. Punkter är
grupperade efter när de blir ett blockerande krav.

Detta är en teknisk/produktbedömning, inte juridisk rådgivning. Rådfråga en
jurist för de GDPR/avtalsrelaterade punkterna innan en verklig publik
lansering.

## Redan på plats (bra utgångsläge)

- Hashade lösenord (scrypt) och saltade, engångsriktade sessionstokens.
- Server-side auktorisering på varje skyddad läs/skriv-operation, verifierad
  med IDOR-tester (se `tests/server.integration.test.mjs`).
- Deterministisk, testad ekonomisk uppdelning (`src/split.ts`) som alltid
  bevarar totalbeloppet exakt.
- Mjuk radering/reversering av finansiella poster — historik försvinner
  aldrig tyst.
- Rate limiting på inloggning, gästanslutning till Snabbnota och
  kvittoanalys, med IP-härledning som fungerar korrekt bakom Cloudflare.
- Säkerhetsheaders (CSP, HSTS när aktuellt, X-Frame-Options, osv.),
  `SameSite=Strict`-cookies och Origin-verifiering mot CSRF.
- Automatiska, komprimerade, tidsbegränsade databasbackuper.
- Lokal OCR som aldrig skickar kvittobilder till en extern tjänst.

## Krävs innan en privat betaperiod (fler personer utanför den ursprungliga vänkretsen, fortfarande inbjudan-only)

- [ ] **Lösenordsåterställning.** Idag finns inget "glömt lösenord"-flöde;
  en låst användare måste be en admin. Behövs ett e-postutskickssystem
  (se nedan) innan detta är rimligt att bygga.
- [ ] **Grundläggande drifts-/felövervakning utöver containerloggar** —
  t.ex. ett enkelt sätt att bli varskodd om appen är nere eller databasen
  inte svarar (idag måste man aktivt kolla `docker compose logs`/`/health`).
- [ ] **Definierad supportväg** — en tydlig e-post/kanal dit nya användare
  kan höra av sig vid problem.
- [ ] Genomgång av `AGENTS.md`/`PROJECT_CONTEXT.md`-reglerna med fler
  betatestare i åtanke — särskilt gränsen `max_uses` på inbjudningar och
  Snabbnota-gränsen på 100 samtidiga SSE-lyssnare per nota.

## Krävs innan en öppen publik beta (självregistrering utan inbjudan)

- [ ] **E-postverifiering vid registrering.** Idag valideras bara
  e-postformatet, inget verifieringsmail skickas — vem som helst kan skapa
  ett konto med en e-postadress de inte äger.
- [ ] **Applikations-e-post** (transaktionella mail: verifiering,
  lösenordsåterställning, viktiga säkerhetshändelser). Kräver en
  e-posttjänst (t.ex. via SMTP-relä) och mallar.
- [ ] **Missbruksskydd bortom rate limiting** — idag är
  rate limiting timme-/IP-baserad; en öppen registrering behöver även
  spärrar mot massregistrering, CAPTCHA eller liknande på
  registrerings-/inbjudningsflöden.
- [ ] **Publik integritetspolicy och användarvillkor**, skrivna för verkliga
  externa användare (inte bara den interna kommentaren i
  `PROJECT_CONTEXT.md`).
- [ ] **Kontoradering (self-service).** Idag finns ingen väg för en
  användare att själv radera sitt konto. Se avsnittet om kontoradering
  nedan för den datamodell som redan finns att utgå från.
- [ ] **Dataexport (self-service).** Ingen "exportera mina uppgifter"-funktion
  finns idag.
- [ ] **Definierad lagringspolicy** — hur länge sparas mjukraderade resor,
  audit-loggen, kvittobilder för en användare som är inaktiv/borta.
- [ ] **Formell säkerhetsgranskning** (extern eller strukturerad
  självgranskning bortom den här sessionens audit) innan okända användares
  betalningsrelaterade data hanteras i skarpt läge.
- [ ] **Beroendesårbarhetshantering** — en löpande process (t.ex.
  `pnpm audit`/Dependabot) för att upptäcka kända sårbarheter i
  npm-beroenden, inte bara en engångsgenomgång.

## Krävs innan en bred/allmän produktionslansering

- [ ] **Skalbar objektlagring för kvitton.** Kvitton lagras idag som `BYTEA`
  direkt i PostgreSQL. Det fungerar utmärkt för en vänkrets storleksordning
  men blir en flaskhals (databasstorlek, backup-tid, minnesanvändning vid
  läsning) vid betydligt fler användare. Migrering till t.ex. S3-kompatibel
  lagring (MinIO på egen hårdvara, eller en molntjänst) med en
  metadata-referens kvar i PostgreSQL är den naturliga vägen — kräver en
  egen migreringsplan, inte en engångsändring.
- [ ] **Hanterad/replikerad databasdrift.** En enskild PostgreSQL-instans på
  en hemmaserver (nuvarande Unraid-upplägg) saknar failover. En publik
  tjänst med verkliga betalningsuppgifter bör ha åtminstone replikering
  och ett dokumenterat failover-flöde, eller en hanterad databastjänst.
- [ ] **Hemlighetshantering bortom `.env`/Compose Manager** — t.ex. ett
  riktigt secrets-verktyg (Vault, molnleverantörens secrets manager) när
  fler personer/system behöver åtkomst till driftsmiljön.
- [ ] **Monitorering och alarmering** i produktionsklass (t.ex.
  Prometheus/Grafana eller en hanterad tjänst), inte bara containerloggar.
- [ ] **Dokumenterad katastrofåterställning** bortom "återställ dumpen
  manuellt" — definierat RPO/RTO, regelbundet testad återställning.
- [ ] **Penetrationstest** av en oberoende part.
- [ ] **Swish Commerce-integration** (om verklig betalningsbekräftelse ska
  visas i appen) — kräver certifikat, avtal med Swish/banken, och en
  serverisolerad integration enligt reglerna i `AGENTS.md`. Nuvarande
  Swish-knapp öppnar bara Swish-appen och är uttryckligen inte ett
  betalningsbevis; det förblir sant tills detta är byggt.
- [ ] **Formell GDPR-bedömning** med jurist: registerförteckning,
  personuppgiftsbiträdesavtal om molntjänster används, rutin för
  registerutdrag/radering inom lagstadgad tid.

## Kontoradering — vad som redan finns att bygga vidare på

Ingen automatisk självbetjänad kontoradering är byggd, men datamodellen är
redan förberedd för det på ett sätt som skyddar den ekonomiska historiken:

- Utgifter och betalningar har `created_by`/`payer_id`/`from_id`/`to_id` som
  referenser till `users.id`, men den *ekonomiska sanningen* ligger i
  `expenses`/`expense_shares`/`payments`, inte i användarposten. En borttagen
  användare kan alltså anonymiseras (`display_name` → "Borttagen användare",
  `email`/`swish_phone`/lösenordsfält nollställda) utan att en enda kolumn i
  huvudboken behöver ändras.
- `participants.user_id` kan sättas till `NULL` (kolumnen tillåter redan
  det) för att koppla loss en borttagen användare från sina historiska
  resedeltaganden, medan `participants.name` behåller det namn som stod på
  utgifterna vid tillfället.
- Rekommenderad ordning vid en framtida implementation: (1) anonymisera
  `users`-raden i stället för att radera den, (2) ta bort `sessions`,
  `contacts` och väninbjudningar kopplade till användaren, (3) lämna
  `expenses`/`payments`/`audit_log` orörda, (4) hantera resor där personen
  var ensam ägare separat (antingen kräv en ägarbytesåtgärd innan radering
  tillåts, eller överför ägarskapet automatiskt till nästa admin/medlem).
- En riktig "radera mitt konto"-knapp kräver alltså en ny, uttryckligen
  granskad migration och en ny endpoint — inte bara ett `DELETE FROM users`.

## Prioritering

| Fas | Krav |
| --- | --- |
| Privat betaperiod | Lösenordsåterställning, grundövervakning, supportväg |
| Öppen publik beta | E-postverifiering, applikations-e-post, missbruksskydd, policy-dokument, kontoradering, dataexport, säkerhetsgranskning, beroendehantering |
| Bred produktionslansering | Objektlagring, databasresiliens, secrets-hantering, monitorering, katastrofåterställning, pentest, ev. Swish Commerce, formell GDPR-bedömning |
