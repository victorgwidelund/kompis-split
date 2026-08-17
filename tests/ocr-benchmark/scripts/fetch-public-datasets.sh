#!/usr/bin/env bash
# Documents how to fetch the public datasets described in tests/ocr-benchmark/SOURCES.md, for anyone
# who wants to extend this benchmark with real-world, non-Swedish robustness data later.
#
# This script does NOT run any of these steps automatically -- it is reference documentation you copy
# commands out of, not a one-shot downloader. Re-check each dataset's current license/terms before
# using it; they are not re-verified by running this file.
set -euo pipefail

cat <<'EOF'
This script is intentionally inert. It documents, but does not perform, how to fetch the public
receipt-OCR datasets referenced in SOURCES.md:

SROIE (ICDAR 2019 scanned receipts, ~1000 images, Malaysian retail):
  1. Register at https://rrc.cvc.uab.es/?ch=13
  2. Download the Task 1-3 training/test archives from the portal's Downloads tab.
  3. Re-read the portal's current terms before redistributing anything -- they were not verified by
     this project and may require research-only use or forbid redistribution.
  4. Extract into tests/ocr-benchmark/corpus/holdout/external/sroie/ if you choose to use it, keeping
     its own LICENSE/terms file alongside the images.

CORD (Consolidated Receipt Dataset, Clova AI/NAVER, CC BY 4.0, ~1000 published Indonesian receipts):
  1. pip install datasets
  2. python3 -c "from datasets import load_dataset; load_dataset('naver-clova-ix/cord-v2')"
     (or use the Google Drive link in https://github.com/clovaai/cord for the v0 sample)
  3. Export a subset of images into tests/ocr-benchmark/corpus/holdout/external/cord/, with a note that
     they are CC BY 4.0 Clova AI/NAVER Corp. and must keep attribution if redistributed further.

Neither dataset is Swedish. Their value here is generic image-quality/layout robustness testing, not
Swedish vocabulary/diacritics/terminology coverage -- the synthetic Swedish corpus is what actually
exercises this app's real failure modes and is the benchmark's primary corpus.
EOF
