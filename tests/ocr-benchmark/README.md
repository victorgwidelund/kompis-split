# OCR benchmark

This directory contains two deliberately separate evaluation systems for `src/receipt-ocr.ts`.
`OCR_BENCHMARK.md` records the experiment results and `QUICK_SCAN_ARCHITECTURE.md` records the
production decision.

## Public regression corpus (schema v1)

The committed corpus has 48 public development fixtures and 32 historical fixtures in
`corpus/legacy_regression`. The latter used to be called holdout, but was inspected during earlier
tuning and is therefore explicitly not an independent holdout anymore.

```sh
pnpm build:server
pnpm benchmark:ocr -- --mode=parser --split=dev
pnpm benchmark:ocr -- --mode=image --split=dev
pnpm benchmark:ocr -- --mode=image --split=legacy
```

Public CLI splits are only `dev`, `legacy`, and `all-public`; the default is `dev`. The admin endpoint
only runs public development fixtures and the production image contains no legacy or sealed truth.

## Development corpus v2

Schema v2 measures nullable metadata, unit price, weight, multipack, pant, VAT, payments, discounts,
one-to-one item matching, duplicate/hallucinated rows, review calibration, failure stage and per-stage
latency. It also covers rotations, perspective, blur, exposure, shadows, folds, crumpling, partial and
long receipts, and tiny receipts in a large photo. Generate it only into an explicit directory; an
external path is recommended.

```sh
pnpm benchmark:ocr:corpus-v2 -- --kind=dev --output=/absolute/path/receipt-dev-v2 --replace
pnpm build:server
RECEIPT_INFERENCE_URL=http://127.0.0.1:8080 \
RECEIPT_INFERENCE_ALLOWED_HOSTS=127.0.0.1 \
pnpm benchmark:ocr:dev-v2 -- --bundle=/absolute/path/receipt-dev-v2 \
  --candidate-module=/absolute/path/repo/dist/receipt-ocr.js --label=my-candidate
```

`--detailed` is allowed only on the development runner. Reports go to the gitignored `reports/`
directory.

## Real final holdout

The final corpus is generated outside the repository using a random secret stored separately. Its
manifest is committed by SHA-256 and the evaluator emits aggregate metrics only. It never writes or
prints fixture ids, OCR text, predictions, truth, or per-case scores. An exclusive ledger permits one
run for each stable candidate id and corpus commitment.

```sh
node tests/ocr-benchmark/generator-v2/create-secret.mjs --output=/external/final.secret
pnpm benchmark:ocr:corpus-v2 -- --kind=sealed-final \
  --output=/external/final-bundle --secret-file=/external/final.secret
pnpm benchmark:ocr:sealed -- --bundle=/external/final-bundle \
  --candidate-module=/absolute/path/candidate.js --candidate-id=frozen-candidate \
  --ledger=/external/final-ledger.json
```

Never inspect final images, truth, per-case behavior, or individual failures. Never reuse final results
to change the parser. If the corpus generator or truth schema is found defective, invalidate that
entire corpus commitment, fix it using development data, generate a fresh secret and final bundle, and
start a new ledger. This is what the tooling's policy tests enforce.

## Structure

```text
tests/ocr-benchmark/
  corpus/dev/                 public development fixtures (v1)
  corpus/legacy_regression/   historical, already-inspected regression fixtures
  generator/                  deterministic v1 content/render pipeline
  generator-v2/               schema-v2 scenarios, transforms, integrity and sealing
  run-benchmark.mjs           public v1 CLI
  run-v2-dev.mjs              public schema-v2 development runner
  run-sealed.mjs              aggregate-only, one-run final evaluator
  v2-adapter.mjs              typed candidate adapter
  reports/                    generated and gitignored
```

The canonical scorer and Hungarian one-to-one matcher live in `src/ocr-benchmark.ts`. Test and admin
code import that implementation; do not create a second scorer.

## Extending evaluation

Add general scenarios in `generator-v2/scenarios.mjs`, then validate their visible truth on development
fixtures. Do not add merchant- or filename-specific parser rules. Public dataset provenance and license
notes are in `SOURCES.md`.
