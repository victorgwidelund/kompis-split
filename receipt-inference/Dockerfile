FROM python:3.12.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    RAPIDOCR_LOG_LEVEL=error \
    ORT_DISABLE_TELEMETRY=1 \
    OMP_NUM_THREADS=4 \
    OPENBLAS_NUM_THREADS=4

WORKDIR /service
RUN apt-get update \
    && apt-get install --yes --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY receipt-inference/requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir --no-deps --requirement requirements.txt \
    && python -c "from pathlib import Path; import hashlib,rapidocr,requests; url='https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv5/rec/latin_PP-OCRv5_rec_mobile.onnx'; response=requests.get(url,timeout=120); response.raise_for_status(); data=response.content; expected='b20bd37c168a570f583afbc8cd7925603890efbcdc000a59e22c269d160b5f5a'; actual=hashlib.sha256(data).hexdigest(); assert actual==expected, f'Latin OCR model checksum mismatch: {actual}'; (Path(rapidocr.__file__).resolve().parent/'models'/'latin_PP-OCRv5_rec_mobile.onnx').write_bytes(data)" \
    && python -c "from pathlib import Path; import rapidocr; root=Path(rapidocr.__file__).resolve().parent/'models'; keep={'PP-OCRv6_det_small.onnx','latin_PP-OCRv5_rec_mobile.onnx','ch_ppocr_mobile_v2.0_cls_mobile.onnx'}; [path.unlink() for path in root.glob('*.onnx') if path.name not in keep]" \
    && useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin receipt-ocr
COPY receipt-inference/app.py ./app.py
COPY receipt-inference/THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md

USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=4 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/ready', timeout=2)"]
ENTRYPOINT ["python", "/service/app.py"]
