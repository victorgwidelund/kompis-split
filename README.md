# Kompis Split

A small, self-hosted expense splitter for trips with friends. It keeps data in a local SQLite file, handles rounding down to the öre, simplifies repayments, and opens Swish with payment details filled in.

## What is included

- Multiple trips with dates and participants
- Swish number per participant
- Equal, percentage, exact-amount, and weighted-share splits
- Integer öre accounting so totals always reconcile
- Simplified settlement suggestions
- One-tap Swish app-to-app payment links and copied payment details as a fallback
- Recorded repayments that immediately recalculate balances
- Shared-password protection
- Responsive phone and desktop interface
- SQLite persistence and a health endpoint
- Docker and Docker Compose configuration for Unraid

## Run on Unraid with Compose

Node.js does **not** need to be installed on Unraid. Docker builds the app from the official `node:24-alpine` image, which already contains Node.js.

1. Extract the ZIP so this app folder is located at `/mnt/user/kompis_split/app`.
2. Edit `/mnt/user/kompis_split/app/compose.yaml` and replace `change-this-password` with a long, private password.
3. Open the Unraid terminal and run:

   ```sh
   cd /mnt/user/kompis_split/app
   docker compose up -d --build
   ```

4. Open `http://YOUR-UNRAID-IP:8787`.

The database is stored at `/mnt/user/kompis_split/data/kompis-split.db` on the Unraid host. Back up that file together with its `-wal` and `-shm` companions while the container is stopped, or back up the whole `kompis_split` share using your usual Unraid backup workflow.

## Automatic updates from GitHub

Every push to `main` runs the tests and publishes a fresh multi-platform image to `ghcr.io/victorgwidelund/kompis-split:latest`. The included `compose.yaml` pulls that image instead of rebuilding source code on Unraid.

In Compose Manager, set these values in the stack's **Environment** tab instead of writing secrets into the Compose file:

```dotenv
APP_PASSWORD=your-private-login-password
COOKIE_SECRET=a-long-random-secret-value
COOKIE_SECURE=false
```

To update after a new image finishes building, choose **Force Update** or **Pull & Up** in Compose Manager. The SQLite database is mounted separately and is not replaced by container updates.

If `docker compose` is not available in your Unraid terminal, install the **Docker Compose Manager** plugin from Community Applications, add `/mnt/user/kompis_split/app/compose.yaml` as a stack, and choose **Compose Up**.

## Reverse proxy and HTTPS

If friends will use the app away from your home network, put it behind your existing Unraid reverse proxy, use HTTPS, and set this in `compose.yaml`:

```yaml
COOKIE_SECURE: "true"
```

Do not expose port 8787 directly to the public internet. A VPN such as Tailscale is the simplest private-access option. The shared password is intentionally lightweight access control for a trusted friend group, not a multi-user identity system.

## Swish integration

This version uses Swish's app-to-app payment flow for person-to-person settlement. When the recipient has a Swish number saved, **Open Swish** launches the mobile app with recipient, amount, and trip name prefilled. The sender still reviews and approves the payment inside Swish. On devices where the Swish URL cannot open, the app copies human-readable payment details instead.

This is deliberately different from the Swish Commerce API. Automated payment-status callbacks require a business Swish Commerce agreement, merchant number, client certificate, and a public HTTPS callback endpoint. Those credentials should never be placed in the browser. A Commerce adapter can be added to the server later if you obtain that agreement.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port inside the container |
| `DB_PATH` | `./data/kompis-split.db` | SQLite database location |
| `APP_PASSWORD` | empty | Shared app password; always set this on Unraid |
| `COOKIE_SECRET` | derived | Optional stable secret for session signing |
| `COOKIE_SECURE` | `false` | Set to `true` when the public URL uses HTTPS |

## Local development

Node.js 24 or newer is the only requirement. No third-party packages are needed.

```sh
APP_PASSWORD=dev-password node src/server.mjs
```

Open `http://localhost:8787`. Run the split-engine tests with:

```sh
node --test
```

## Data model

Trips contain participants, expenses, each expense's individual shares, and recorded payments. Money is stored as integer öre. Settlement suggestions are derived from the complete ledger each time a trip is loaded, so deleting an expense or undoing a payment safely recalculates the result.
