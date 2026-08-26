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
COPY receipt-inference/requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir --no-deps --requirement requirements.txt \
    && python -c "from pathlib import Path; import rapidocr; root=Path(rapidocr.__file__).resolve().parent/'models'; keep={'PP-OCRv6_det_small.onnx','latin_PP-OCRv5_rec_mobile.onnx','ch_ppocr_mobile_v2.0_cls_mobile.onnx'}; [path.unlink() for path in root.glob('*.onnx') if path.name not in keep]" \
    && useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin receipt-ocr
COPY receipt-inference/app.py ./app.py
COPY receipt-inference/THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md

USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=4 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/ready', timeout=2)"]
ENTRYPOINT ["python", "/service/app.py"]
