"""OWNER: P1. Plate detection + OCR + multi-frame vote -> plates.json.

TODO
- plate detector (subash9940/indian-number-plate-recognition or HF plate YOLO) on involved tracks
- OCR each crop (TrOCR / Awiros anpr-ocr); keep every per-frame reading
- vote(): character-wise majority over readings of equal length; confidence = agreeing reads / total
"""
from collections import Counter


def vote(readings: list[str]) -> dict:
    """Character-wise majority over readings. Keeps the competing reads for the UI."""
    if not readings:
        return {"plate": None, "confidence": 0.0, "reads": []}
    n = Counter(len(r) for r in readings).most_common(1)[0][0]
    same = [r for r in readings if len(r) == n]
    plate = "".join(Counter(r[i] for r in same).most_common(1)[0][0] for i in range(n))
    agree = sum(r == plate for r in readings)
    return {"plate": plate, "confidence": round(agree / len(readings), 2), "reads": readings}
