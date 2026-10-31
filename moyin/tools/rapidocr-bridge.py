#!/usr/bin/env python3
"""Offline RapidOCR bridge. Reads image bytes from stdin and emits one JSON document."""

import argparse
import json
import sys
from pathlib import Path


def polygon_box(value):
    points = value.tolist() if hasattr(value, "tolist") else value
    return [[int(round(float(point[0]))), int(round(float(point[1])))] for point in points]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", required=True)
    parser.add_argument("--input")
    args = parser.parse_args()

    model_dir = Path(args.models).resolve()
    paths = {
        "det": model_dir / "PP-OCRv6_det_small.onnx",
        "rec": model_dir / "PP-OCRv6_rec_small.onnx",
        "cls": model_dir / "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
    }
    for value in paths.values():
        if not value.is_file():
            raise FileNotFoundError(f"model missing: {value.name}")

    image = Path(args.input).read_bytes() if args.input else sys.stdin.buffer.read()
    if not image:
        raise ValueError("empty image")

    import cv2
    import numpy as np
    from rapidocr import RapidOCR

    decoded = cv2.imdecode(np.frombuffer(image, dtype=np.uint8), cv2.IMREAD_COLOR)
    if decoded is None:
        raise ValueError("image decode failed")
    height, width = decoded.shape[:2]

    engine = RapidOCR(params={
        "Global.log_level": "ERROR",
        "Global.return_word_box": True,
        "Det.model_path": str(paths["det"]),
        "Cls.model_path": str(paths["cls"]),
        "Rec.model_path": str(paths["rec"]),
    })
    result = engine(image, return_word_box=True)
    lines = []
    words = []
    if result.boxes is not None and result.txts is not None and result.scores is not None:
        word_results = result.word_results or ()
        for index, (box, text, score) in enumerate(zip(result.boxes, result.txts, result.scores)):
            line = {"text": str(text), "confidence": float(score), "box": polygon_box(box)}
            lines.append(line)
            line_words = word_results[index] if index < len(word_results) else None
            if line_words:
                for item in line_words:
                    if len(item) == 3 and item[2] is not None:
                        words.append({"text": str(item[0]), "confidence": float(item[1]), "box": polygon_box(item[2])})
            if not line_words:
                words.append(line)

    payload = {
        "format": "VEILFORGE_RAPIDOCR_RESULT_V1",
        "width": int(width),
        "height": int(height),
        "lines": lines,
        "words": words,
        "elapsedSeconds": float(getattr(result, "elapse", 0.0) or 0.0),
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write(json.dumps({"error": type(error).__name__, "message": str(error)}, ensure_ascii=False))
        sys.exit(1)
