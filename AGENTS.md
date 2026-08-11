# Kompis Split – permanent project rules

## Infrastructure

- The app is self-hosted on Unraid with Docker Compose Manager. Preserve the existing Compose workflow, `/mnt/user/kompis_split` paths, ports, labels, and environment interface unless a change is explicitly justified.
- Persistent data must live outside containers. Never delete, recreate, rename, or overwrite a production volume or database during a routine update.
- The Unraid Compose stack intentionally follows the published `latest` app image so routine updates do not require editing Compose. Keep the generated `sha-*` tags available and document the previous working tag for rollback.
- Keep the backend suitable for an HTTPS reverse proxy. Port 8787 is for trusted LAN/proxy access, not direct public exposure.
- Do not expose PostgreSQL or any other database port publicly.
- Healthchecks must verify application and database readiness without mutating user data.
- Backups must be automatic, documented, restorable, and supplemented by an external Unraid backup.

## Architecture

- The frontend is React 19 with Vite and strict TypeScript under `frontend/`. Keep UI functionality split into typed pages, features, components, hooks, API, and utility modules rather than rebuilding a global DOM script.
- The Node.js TypeScript backend serves the generated Vite assets in production. Preserve the single app-container deployment and the existing API contracts unless a change is explicitly justified.
- If a separate native mobile frontend is approved later, use React Native, Expo, and TypeScript. Never place secrets or privileged operations in any client.
- The backend is TypeScript and must pass strict typechecking before release.
- The current database is PostgreSQL. Every schema change uses ordered, forward-only migrations recorded in `schema_migrations`.
- Preserve existing infrastructure instead of replacing it for novelty. Explain the need, data impact, migration stages, and rollback before major architecture changes.

## Financial correctness

- Store and calculate SEK as integers in öre. Existing `*_cents` names are historical but represent öre.
- Expense splitting and settlement tie-breaking must be deterministic.
- Every split must conserve the original amount exactly.
- The durable expense/payment ledger is the source of truth. Balances are derived, never authoritative stored totals.
- Financial records are voided/reversed or archived rather than physically deleted.
- Every financial-calculation change requires automated tests for conservation, rounding, invalid input, payments, and deterministic ties.

## Security and privacy

- Authenticate and authorize every protected read and write on the server. Client visibility is not authorization.
- Use per-user accounts, expiring opaque sessions, trip membership, and role checks. Invitation tokens must be random, expiring, revocable, and stored only as hashes.
- Never put passwords, cookie secrets, Swish credentials, private keys, certificates, or tokens in client code, Git, Docker images, examples, or logs.
- Real configuration belongs in Compose Manager or an ignored `.env`; `.env.example` contains names and safe placeholders only.
- Use only documented Swish functionality. Swish Commerce certificates and credentials stay server-side. Opening Swish is never proof of payment.
- Retain security headers, origin protection, rate limiting, secure cookies behind HTTPS, input validation, and generic internal-error responses.

## Change discipline

- Preserve backwards compatibility and user data by default.
- Do not implement destructive migrations. Take and verify a backup before deploying schema changes.
- Run syntax/lint checks, financial and integration tests, migration-upgrade tests, Compose validation, and the container healthcheck before release.
- Treat `PROJECT_CONTEXT.md` as the living technical memory for this repository. Read it before material work and update it in the same change whenever the app version, architecture, schema, deployment, security model, major features, known limitations, or release process changes. Never place secrets or personal data in it.
