"""Smoke test run INSIDE the receipt-inference container (see .github/workflows/container.yml).

The original smoke test only sent one ~40 KB synthetic corpus image. Real phone photos arrive at up to
~3000 px on the long side and need roughly 1.2 GB per scan (measured on production photos in
v1.32.1), so a 1 GiB memory limit OOM-killed the service on every real scan while this test stayed
green. This sends phone-sized images repeatedly, which is what actually exercises the memory limit.
"""
import io
import json
import sys
import urllib.request

from PIL import Image

source = sys.argv[1]
rounds = int(sys.argv[2]) if len(sys.argv) > 2 else 4

with Image.open(source) as opened:
    receipt = opened.convert("RGB")
# Fill a 2250x3000 frame the way a phone photo of a receipt does, so detection runs at full size.
photo = receipt.resize((2250, 3000), Image.Resampling.LANCZOS)
buffer = io.BytesIO()
photo.save(buffer, format="JPEG", quality=90)
payload = buffer.getvalue()

for attempt in range(1, rounds + 1):
    request = urllib.request.Request("http://127.0.0.1:8080/v1/ocr", data=payload, headers={"Content-Type": "application/octet-stream"})
    result = json.load(urllib.request.urlopen(request, timeout=60))
    assert result["engine"].startswith("rapidocr-3.9.2/"), result.get("engine")
    assert result["width"] == 2250 and result["height"] == 3000, (result["width"], result["height"])
    assert len(result["lines"]) > 0, "no text found in a phone-sized receipt"
    print(f"phone-sized scan {attempt}/{rounds}: {len(result['lines'])} lines in {result['inferenceMs']:.0f} ms", flush=True)
