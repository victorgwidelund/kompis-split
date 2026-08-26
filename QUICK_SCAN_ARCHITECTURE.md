# Quick Scan / Snabbskanning — self-hosted architecture

Decision date: 2026-08-26. Production path: CPU-first local OCR plus deterministic receipt
understanding and validation. No hosted OCR, AI, vision, telemetry or document API is used.

## Existing architecture and baseline

Before this change the browser compressed a camera image, the Node app created several Sharp variants,
ran two Tesseract passes, and speculatively called PaddleOCR-VL 1.6 through a CUDA llama.cpp container.
Several pass scores were merged into the legacy `{title, amount, date, category, items}` suggestion.
The VLM could be retried when arithmetic did not reconcile. The deployment assumed an Nvidia GTX 1080
Ti and downloaded about 1.7 GB of weights on startup. Parsing was regex-based, confidence was mostly a
model/pass score, only an exact item-sum comparison was exposed, and cancellation stopped the client
request without reliably stopping inference.

The original committed 80-image corpus contains 48 development and 32 historical images. Its old
"holdout" had already been inspected during prior tuning, so it is now named `legacy_regression` and is
not presented as independent evidence. Frozen Tesseract baseline over those 80 images: merchant 82.5%,
date 73.8%, total 81.3%, item F1 77.6%, line-price 68.9%, quantity 73.3%, exact reconciliation 55.0%,
median 1,062 ms and P95 1,745 ms. Parser-only performance was approximately 100%, locating the main
loss in recognition/layout rather than basic Swedish money parsing.

## Alternatives investigated

| Architecture | Concrete implementation/evidence | Decision |
| --- | --- | --- |
| OCR + deterministic parser | Tesseract; RapidOCR PP-OCRv6 small/medium detector with PP-OCRv5 Latin recognizer; typed parser and arithmetic validation | Selected with the small detector and Latin recognizer |
| OCR + local document/VLM fallback | Fast OCR first, PaddleOCR-VL 1.6 on low evidence, then reconciliation | Rejected: a CPU trial took about 100 s for one hard image without improving it; target Pascal GPU is not supported by the practical current serving stacks |
| Local VLM directly to JSON | Qwen/InternVL/Phi/SmolVLM-class local models, schema validation afterward | Rejected for production: substantially larger memory/startup/latency, weaker deterministic provenance, and no measured advantage that justified always-on inference |
| Parallel OCR + VLM hybrid | Run both on every image and reconcile | Rejected: doubles work on the common clean path and inherits VLM deployment cost |
| Fast OCR + normalized retry | Original OCR, retry a thresholded/normalized variant only on low evidence | Implemented diagnostically but disabled by default: dev F1 fell 91.3% → 89.9% and P95 rose 1.41 s → 4.10 s |

Controlled OCR measurements on 48 public development receipts used the same parser and images:

| OCR engine | Item F1 | Line-price | Quantity | Median | P95 | Peak working set |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Tesseract.js (`swe`) | 79.3% | 70.1% | 75.7% | ~1.06 s | ~1.75 s | ~470 MiB |
| PP-OCRv6 small detector + PP-OCRv6 small recognizer | 99.1% | 98.2% | 96.7% | 1.06 s | 2.33 s | ~332 MiB |
| PP-OCRv6 small detector + PP-OCRv5 Latin mobile recognizer | **99.5%** | **98.5%** | **98.5%** | **0.74 s** | **1.45 s** | ~332 MiB |
| PP-OCRv6 medium detector + Latin recognizer | 99.5% | 98.5% | 98.5% | ~2.0 s | ~3.9 s | ~396 MiB |

An additional 44-image hard-transform comparison produced item F1 53.8% and total 61.4% for
Tesseract versus item F1 93.3% and total 95.5% for the selected RapidOCR configuration. Blind classic
normalization reduced the selected engine to 87.7% item F1, so the original normalized color image is
the production input.

## Selected production flow

```text
camera/file
  → EXIF-aware browser resize and cancellable upload
  → server MIME/dimension validation, autorotation and metadata stripping
  → internal raw-byte HTTP request with 15 s deadline
  → persistent RapidOCR/ONNX service
      PP-OCRv6 small detector
      + direction classifier
      + PP-OCRv5 Latin mobile recognizer
      + bounding boxes and OCR confidences
  → geometry-aware reading order
  → Swedish receipt parser
  → typed receipt/evidence
  → deterministic öre arithmetic and evidence-based review decision
  → editable user suggestion
```

The browser aborts scans when a dialog closes or a newer scan supersedes them. The abort propagates
through Node to the inference HTTP request. The inference process loads models once, serializes access
to the engine, permits a bounded queue, and returns 429 when saturated. Tesseract remains an entirely
local outage fallback. A speculative legacy VLM is never started when `RECEIPT_INFERENCE_URL` is
configured, as it is in Compose.

The internal schema uses integer öre and explicit nulls: receipt merchant/date/time/number/currency,
items, subtotal, discounts, VAT, pant, payments and total; items retain raw/normalized name, kind,
quantity/unit, unit price, line total, weight, multipack, discount, pant, OCR confidence and source-line
evidence. Validation signals include missing total/items, OCR weakness, duplicate rows and arithmetic
mismatch. Unknown values remain null rather than being inferred.

## Development and sealed evaluation

Schema-v2 development (48 images after all development changes): scan success 100%, merchant 89.6%,
total 87.5%, item precision 99.3%, recall 84.5%, F1 91.3%, exact name 73.1%, line total 83.9%, unit
price 80.6%, quantity 79.6%, discount 100%, two hallucinated rows, median 724 ms and P95 1,313 ms.
Pathological cases remain much weaker (F1 79.4%, total 62.5%) than clean/normal cases (F1 100%, total
100%).

A fresh final corpus was generated externally from a new secret and committed before either candidate
ran (`c2a6fa7a600bbe812419b8ef1f02e8d786a49a96caf33f1331cbd50ad0de6060`). Its 48 images/truth were
never inspected; the aggregate-only runner allowed one evaluation of frozen commit `4156cb0` and one
of the final candidate. An earlier pilot corpus was invalidated before final evaluation when public
development review found truth fields that were not visibly rendered; none of its numbers were used.

| Metric | Existing | New | Change |
| --- | ---: | ---: | ---: |
| Successful scans | 48/48 | 48/48 | — |
| Merchant accuracy | 60.4% | 89.6% | +29.2 pp |
| Total accuracy | 58.3% | 89.6% | +31.3 pp |
| Line-item precision | 76.8% | 99.3% | +22.4 pp |
| Line-item recall | 47.3% | 85.2% | +37.9 pp |
| Line-item F1 | 58.5% | 91.7% | +33.1 pp |
| Item-name exact accuracy | 30.6% | 73.6% | +43.0 pp |
| Item line-total accuracy | 40.6% | 83.9% | +43.3 pp |
| Unit-price accuracy | not represented | 66.7% | new typed field |
| Quantity accuracy | 40.6% | 79.1% | +38.5 pp |
| Discount accuracy | not represented | 88.9% | new typed field |
| Hallucinated items | 47 | 2 | -45 |
| Duplicate items | 0 | 0 | — |
| Parsing/inference failures | 0 | 0 | — |
| Median latency | 1,119 ms | 846 ms | -24.4% |
| P95 latency | 1,969 ms | 1,841 ms | -6.5% |

By difficulty, item F1 changed clean 100%→100%, normal 92.8%→97.2%, difficult 65.2%→98.9%, and
pathological 19.4%→78.4%. Total accuracy changed clean 100%→100%, normal 100%→100%, difficult
56.3%→100%, and pathological 18.8%→68.8%.

## Runtime, storage and observability

Measurements below are from the available Windows ARM64 development host, not the target Unraid CPU;
production should remeasure after deployment. The production service is CPU-only and allocates no
VRAM.

| Resource | Measured/configured result |
| --- | ---: |
| Selected model files | 17.6 MiB |
| Model startup | ~0.50–0.66 s |
| Idle working set | ~191 MiB |
| Post-scan working set | ~214 MiB |
| Observed benchmark peak | ~332 MiB |
| Compose memory limit | 1 GiB |
| GPU / VRAM | 0 / 0 |
| Single-scan CPU | ~3.36 cores average in one measured 637 ms scan |
| Default CPU limit | 8 cores |

`receipt-inference` exposes internal `/health`, strict `/ready`, and Prometheus-text `/metrics` with
request, rejection, failure, active-job, queue and inference aggregates. Neither service logs images,
OCR text, merchant, items or other receipt content. The app's `/ready` reports the configured inference
dependency separately from liveness.

## Docker, models, licenses and offline operation

Compose adds one read-only, non-root `receipt-inference` container on an `internal: true` network. It
has no host port, drops all capabilities, sets `no-new-privileges`, uses a bounded tmpfs and has explicit
CPU/RAM limits. CI builds the app and inference images and starts the latter with `--network none` for
an OCR smoke test.

Pinned production components:

- RapidOCR 3.9.2 and its selected PP-OCR ONNX files (Apache-2.0).
- ONNX Runtime 1.29.0 (MIT).
- PP-OCRv6 small detector, PP-OCRv5 Latin mobile recognizer and direction classifier; exact SHA-256
  values are enforced by `receipt-inference/app.py` before readiness.
- Tesseract.js remains the Apache-2.0 local fallback already shipped in the app image.

No model weights are stored separately in the Git repository. They are installed in the versioned
inference image layer, so initial `docker compose pull` is the only network-dependent setup step. With
both images present, `pull_policy: missing` permits offline restart and the complete scan path has no
DNS, model registry, hosted inference or third-party processing dependency. ONNX Runtime telemetry is
disabled before import (`ORT_DISABLE_TELEMETRY=1`). For receipt
content to remain local end-to-end, access the app through owned Nginx over LAN/VPN or DNS-only, not a
CDN/content proxy.

## Remaining weaknesses

- Severe crop, very small receipts, overexposure and blur still lose lines; pathological final total
  accuracy is 68.8% and item recall 65.6%.
- Weight accuracy was 16.7% on the small final eligible subset. The system leaves uncertain values null
  or requests review, but weight parsing needs broader real Swedish data.
- Payment amount extraction is intentionally conservative and only 8.3% accurate; payment rows are not
  used as purchased items or as authoritative receipt totals.
- The synthetic corpus is broad but not a substitute for a consented, licensed real Swedish receipt
  corpus. Production drift should be monitored with content-free metrics and opt-in labeled examples.
- Docker/Unraid performance must be measured on the actual server; local validation could not exercise
  Docker because no daemon was available on the development host.
