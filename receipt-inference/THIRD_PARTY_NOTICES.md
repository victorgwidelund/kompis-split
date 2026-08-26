# Receipt inference third-party notices

The container redistributes Python packages listed in `requirements.txt` and three ONNX OCR model
files installed by RapidOCR 3.9.2. Package wheels retain their own `*.dist-info` license metadata.

| Component/artifact | Version / SHA-256 | Upstream | License |
| --- | --- | --- | --- |
| RapidOCR | 3.9.2 | https://github.com/RapidAI/RapidOCR | Apache-2.0 |
| PaddleOCR model family | PP-OCRv6 / PP-OCRv5 | https://github.com/PaddlePaddle/PaddleOCR | Apache-2.0 |
| `PP-OCRv6_det_small.onnx` | `090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f` | bundled by RapidOCR | Apache-2.0 |
| `latin_PP-OCRv5_rec_mobile.onnx` | `b20bd37c168a570f583afbc8cd7925603890efbcdc000a59e22c269d160b5f5a` | bundled by RapidOCR | Apache-2.0 |
| `ch_ppocr_mobile_v2.0_cls_mobile.onnx` | `e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c` | bundled by RapidOCR | Apache-2.0 |
| ONNX Runtime | 1.29.0 | https://github.com/microsoft/onnxruntime | MIT |
| OpenCV | 5.0.0.93 Python headless wheel | https://github.com/opencv/opencv-python | MIT package; Apache-2.0 OpenCV |

The complete upstream license texts and notices remain authoritative. No model is downloaded from a
hosted inference endpoint at runtime. Model digests are checked before the service becomes ready.
