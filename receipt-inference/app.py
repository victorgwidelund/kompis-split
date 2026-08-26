"""Persistent, offline-only Swedish receipt OCR service.

The service intentionally exposes OCR evidence rather than attempting receipt semantics. The Node
application owns parsing and deterministic validation. Images and recognized text are never logged.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import signal
import threading
import time
import warnings
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

# Official ONNX Runtime builds may enable cross-platform telemetry. This must be set before RapidOCR
# imports ONNX Runtime so no uploader, event, or persistent telemetry identifier is created.
os.environ["ORT_DISABLE_TELEMETRY"] = "1"

import numpy as np
from PIL import Image, ImageOps
from rapidocr import LangRec, ModelType, OCRVersion, RapidOCR

SERVICE_VERSION = "1.0.0"
ENGINE_NAME = "rapidocr-3.9.2/pp-ocrv6-det-small+pp-ocrv5-latin-rec"
MAX_BODY_BYTES = min(30 * 1024 * 1024, max(1, int(os.getenv("OCR_MAX_BODY_BYTES", str(20 * 1024 * 1024)))))
MAX_IMAGE_PIXELS = min(100_000_000, max(1_000_000, int(os.getenv("OCR_MAX_IMAGE_PIXELS", "50000000"))))
QUEUE_CAPACITY = min(16, max(0, int(os.getenv("OCR_QUEUE_CAPACITY", "4"))))
PORT = int(os.getenv("PORT", "8080"))
MAX_OUTPUT_LINES = 1_000
MAX_TEXT_CHARS = 500

MODEL_HASHES = {
    "PP-OCRv6_det_small.onnx": "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f",
    "latin_PP-OCRv5_rec_mobile.onnx": "b20bd37c168a570f583afbc8cd7925603890efbcdc000a59e22c269d160b5f5a",
    "ch_ppocr_mobile_v2.0_cls_mobile.onnx": "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c",
}

_metrics_lock = threading.Lock()
_metrics: dict[str, float] = {
    "requests_total": 0,
    "requests_failed_total": 0,
    "requests_rejected_total": 0,
    "inference_seconds_total": 0,
    "queue_seconds_total": 0,
    "active_requests": 0,
}
_slots = threading.BoundedSemaphore(QUEUE_CAPACITY + 1)
_engine_lock = threading.Lock()
_ready = False
_engine: RapidOCR | None = None
_startup_ms = 0.0


def _model_paths() -> dict[str, Path]:
    import rapidocr

    root = Path(rapidocr.__file__).resolve().parent / "models"
    paths = {name: root / name for name in MODEL_HASHES}
    for name, path in paths.items():
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != MODEL_HASHES[name]:
            raise RuntimeError(f"Pinned OCR model integrity check failed: {name}")
    return paths


def _create_engine() -> RapidOCR:
    paths = _model_paths()
    threads = min(32, max(1, int(os.getenv("OCR_INTRA_OP_THREADS", "4"))))
    return RapidOCR(params={
        "Global.log_level": "error",
        "Global.max_side_len": 3000,
        "EngineConfig.onnxruntime.intra_op_num_threads": threads,
        "EngineConfig.onnxruntime.inter_op_num_threads": 1,
        "Det.ocr_version": OCRVersion.PPOCRV6,
        "Det.model_type": ModelType.SMALL,
        "Det.lang_type": "sv",
        "Det.model_path": str(paths["PP-OCRv6_det_small.onnx"]),
        "Cls.model_path": str(paths["ch_ppocr_mobile_v2.0_cls_mobile.onnx"]),
        "Rec.ocr_version": OCRVersion.PPOCRV5,
        "Rec.model_type": ModelType.MOBILE,
        "Rec.lang_type": LangRec.LATIN,
        "Rec.model_path": str(paths["latin_PP-OCRv5_rec_mobile.onnx"]),
    })


def _image_from_bytes(body: bytes) -> np.ndarray:
    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    with warnings.catch_warnings():
        # The explicit dimension check happens before decoding; avoid logging Pillow's warning for an
        # input that is rejected immediately. Pillow's higher decompression-bomb error remains active.
        warnings.simplefilter("ignore", Image.DecompressionBombWarning)
        with Image.open(io.BytesIO(body)) as opened:
            width, height = opened.size
            if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
                raise ValueError("image_dimensions_invalid")
            normalized = ImageOps.exif_transpose(opened).convert("RGB")
            return np.asarray(normalized)[:, :, ::-1].copy()


def _recognize(body: bytes) -> dict[str, Any]:
    if _engine is None:
        raise RuntimeError("engine_not_ready")
    image = _image_from_bytes(body)
    height, width = image.shape[:2]
    started = time.perf_counter()
    result = _engine(image)
    inference_ms = (time.perf_counter() - started) * 1000
    lines: list[dict[str, Any]] = []
    if result.boxes is not None and result.txts is not None and result.scores is not None:
        for box, text, score in zip(result.boxes, result.txts, result.scores, strict=True):
            if len(lines) >= MAX_OUTPUT_LINES:
                break
            lines.append({
                "box": [[round(float(point[0]), 2), round(float(point[1]), 2)] for point in box],
                "text": str(text)[:MAX_TEXT_CHARS],
                "confidence": round(float(score), 6),
            })
    return {"engine": ENGINE_NAME, "width": width, "height": height, "inferenceMs": round(inference_ms, 3), "lines": lines}


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "KompisReceiptOCR/1"

    def log_message(self, format_string: str, *args: Any) -> None:
        # Only method/path/status/size from BaseHTTPRequestHandler; never request bodies or OCR text.
        super().log_message(format_string, *args)

    def _send_json(self, status: HTTPStatus, value: Any) -> None:
        body = _json_bytes(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send_json(HTTPStatus.OK, {"status": "ok", "version": SERVICE_VERSION})
            return
        if self.path == "/ready":
            self._send_json(HTTPStatus.OK if _ready else HTTPStatus.SERVICE_UNAVAILABLE, {
                "status": "ready" if _ready else "starting", "engine": ENGINE_NAME, "startupMs": round(_startup_ms, 3),
            })
            return
        if self.path == "/metrics":
            with _metrics_lock:
                snapshot = dict(_metrics)
            lines = [
                "# TYPE receipt_ocr_requests_total counter",
                f"receipt_ocr_requests_total {snapshot['requests_total']}",
                f"receipt_ocr_requests_failed_total {snapshot['requests_failed_total']}",
                f"receipt_ocr_requests_rejected_total {snapshot['requests_rejected_total']}",
                f"receipt_ocr_inference_seconds_total {snapshot['inference_seconds_total']}",
                f"receipt_ocr_queue_seconds_total {snapshot['queue_seconds_total']}",
                f"receipt_ocr_active_requests {snapshot['active_requests']}",
            ]
            body = ("\n".join(lines) + "\n").encode()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/plain; version=0.0.4")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/ocr":
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        if not _ready:
            self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "not_ready"})
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length <= 0 or length > MAX_BODY_BYTES or self.headers.get("Content-Type", "").split(";", 1)[0] != "application/octet-stream":
            self._send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE if length > MAX_BODY_BYTES else HTTPStatus.BAD_REQUEST, {"error": "invalid_image_request"})
            return
        if not _slots.acquire(blocking=False):
            with _metrics_lock:
                _metrics["requests_rejected_total"] += 1
            self._send_json(HTTPStatus.TOO_MANY_REQUESTS, {"error": "queue_full"})
            return
        total_started = time.perf_counter()
        with _metrics_lock:
            _metrics["requests_total"] += 1
            _metrics["active_requests"] += 1
        try:
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError("incomplete_body")
            queue_started = time.perf_counter()
            with _engine_lock:
                queue_ms = (time.perf_counter() - queue_started) * 1000
                payload = _recognize(body)
            payload["queueMs"] = round(queue_ms, 3)
            payload["totalMs"] = round((time.perf_counter() - total_started) * 1000, 3)
            with _metrics_lock:
                _metrics["queue_seconds_total"] += queue_ms / 1000
                _metrics["inference_seconds_total"] += payload["inferenceMs"] / 1000
            self._send_json(HTTPStatus.OK, payload)
        except (ValueError, Image.DecompressionBombError, OSError):
            with _metrics_lock:
                _metrics["requests_failed_total"] += 1
            self._send_json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": "unreadable_image"})
        except Exception:
            with _metrics_lock:
                _metrics["requests_failed_total"] += 1
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "ocr_failed"})
        finally:
            with _metrics_lock:
                _metrics["active_requests"] -= 1
            _slots.release()


def main() -> None:
    global _engine, _ready, _startup_ms
    started = time.perf_counter()
    _engine = _create_engine()
    _startup_ms = (time.perf_counter() - started) * 1000
    _ready = True
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    print(json.dumps({"event": "receipt_ocr_ready", "engine": ENGINE_NAME, "startupMs": round(_startup_ms, 3)}), flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
