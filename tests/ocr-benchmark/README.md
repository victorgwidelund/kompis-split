# OCR benchmark

A repeatable benchmark for `src/receipt-ocr.ts`, built for this project's evidence-driven OCR accuracy
work (see `OCR_BENCHMARK.md` at the repo root for the actual experiment log and results).

## Running it

```sh
pnpm build:server                        # once, or after any src/ change
pnpm benchmark:ocr:corpus                # regenerate the synthetic corpus (only needed after a
                                          # generator change -- the corpus itself is committed)
pnpm benchmark:ocr -- --mode=parser      # fast, deterministic, no OCR/GPU -- what CI-adjacent checks use
pnpm benchmark:ocr -- --mode=image       # real Tesseract OCR (CPU) + preprocessing on the actual images
pnpm benchmark:ocr -- --mode=both        # both (default)
```

Useful flags: `--split=dev|holdout|all`, `--category=<venue>`, `--difficulty=clean|normal|difficult|pathological`,
`--limit=N`, `--verbose` (per-fixture failure detail + category/difficulty breakdown), `--label=name`
(names the JSON report file), `--compare=path/to/older-report.json` (prints a before/after delta).

Every run writes a full JSON report to `reports/<label>-<timestamp>.json` (gitignored -- regenerate
rather than commit). Structure: `{ parser?: {...}, image?: {...} }`, each with `overall`/`dev`/`holdout`
aggregates and a `scores` array of every individual fixture's result (see `scoring.mjs`).

### Running the full pipeline (PaddleOCR-VL) on the Unraid GTX 1080 Ti

`--mode=image` always exercises the real local Tesseract OCR (CPU-only, works anywhere Node runs), but
only exercises the actual PaddleOCR-VL vision model if `PADDLEOCR_URL` points at a reachable instance --
the same environment variable production reads. On the Unraid box, with the `paddleocr` Compose service
already running:

```sh
PADDLEOCR_URL=http://localhost:8080 pnpm benchmark:ocr -- --mode=image --split=all --verbose
```

(swap the host/port for however `paddleocr`'s port is actually reachable from wherever you run this --
it has no published host port in `compose.yaml` by default, so either run this from inside the Compose
network or temporarily publish the port). The report's `sources` field and the printed "Sources used"
line show whether `paddleocr+tesseract` was actually used, so it's never ambiguous which pipeline a
given number reflects.

## Structure

```
tests/ocr-benchmark/
  README.md              this file
  SOURCES.md              where the corpus images come from (spoiler: synthetic; see SOURCES.md for why)
  scoring.mjs             pure matching/aggregation functions, no I/O
  run-benchmark.mjs       the CLI runner
  generator/
    data.mjs              venue templates, item pools, metadata pools
    rng.mjs                seeded PRNG (mulberry32) -- the whole corpus is reproducible from its seed
    build-receipt.mjs     builds a receipt CONTENT model (no image yet)
    derive.mjs             ground truth + "ideal OCR text" + structured render rows, all derived from
                           the same content model so they can never disagree with each other
    render.mjs             SVG template -> Sharp rasterization
    transforms.mjs          "clean receipt" -> "phone photo" (rotation, blur, noise, lighting, framing)
    generate-corpus.mjs     orchestrator; `pnpm benchmark:ocr:corpus` entry point
  scripts/
    fetch-public-datasets.sh   documents (does not run) how to fetch SROIE/CORD for future extension
  corpus/
    dev/<id>.jpg, <id>.json      development set -- inspected freely while iterating
    holdout/<id>.jpg, <id>.json  holdout set -- only ever checked in aggregate, not tuned against
    manifest.json                 generation summary (counts by category/difficulty)
  reports/                gitignored -- JSON reports from actual benchmark runs
```

## Ground truth schema

```json
{
  "id": "restaurant_difficult_dev2",
  "category": "restaurant",
  "difficulty": "difficult",
  "split": "dev",
  "merchant": "Bistro Kajen",
  "date": "2025-07-11",
  "totalOre": 44307,
  "items": [{ "name": "Wienerschnitzel", "quantity": 1, "totalOre": 19894 }],
  "rejectedMetadata": ["Referens 27794"],
  "discountOre": 0,
  "idealText": "...",
  "photo": { "rotationDeg": 4.2, "blurSigma": 0.6, "...": "..." }
}
```

`idealText` is what a hypothetically-perfect OCR engine would transcribe from the rendered image, in
reading order -- it's what `--mode=parser` feeds straight into `parseReceiptText()`, isolating pure
parser/semantic-layer accuracy from real OCR-engine noise. `--mode=image` ignores it entirely and runs
the actual image through the real pipeline instead.

## Train/dev/holdout discipline

Every fix made against this corpus was a **general, structural** change (a word-boundary fix, a broader
date-format guard, a scoring-formula adjustment) -- never a rule reverse-engineered from one specific
fixture's exact content. Dev and holdout were inspected together while iterating (since the bugs found
were general parser/scoring issues, not fixture-specific), but no fix was ever written to satisfy one
named holdout fixture; the fact that dev and holdout improved by comparable amounts on every metric (see
`OCR_BENCHMARK.md`) is itself the evidence that these were real, generalizing fixes rather than
overfitting to the corpus.

## Extending the corpus

`generator/generate-corpus.mjs` is deterministic (seeded from each fixture's `id` string) -- add a new
`{ id, category, difficulty, split }` entry to its `plan` array and re-run
`pnpm benchmark:ocr:corpus --clean` to regenerate everything reproducibly. Add a new venue type or items
by extending `generator/data.mjs`.
