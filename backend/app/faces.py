"""Face check: is the face in the crash footage similar to the photo the toll booth took for the record the PLATE found?

One-to-one only. The plate picks the record; the face is a second check on that record, for an officer to weigh. It never
searches the database by face, never names anyone, and a "similar" result is a lead for authorised follow-up, not an
identification. Low-resolution CCTV often has no usable face at all, and the result says so.

Models: OpenCV Zoo YuNet (detection) and SFace (recognition), Apache-2.0, run locally on the CPU. SFace's published
threshold for "same person" is a cosine similarity of 0.363 on aligned faces; anything from footage this coarse should be
read with a wide margin, so results within 0.07 of it are reported as inconclusive."""
import json
from pathlib import Path

import cv2
import numpy as np

cv2.utils.logging.setLogLevel(cv2.utils.logging.LOG_LEVEL_ERROR)

ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / "data" / "models" / "faces"
DETECTOR = MODELS / "face_detection_yunet_2023mar.onnx"
RECOGNIZER = MODELS / "face_recognition_sface_2021dec.onnx"
SAME_COSINE = 0.363
MARGIN = 0.07
MIN_FACE_PX = 28
MIN_SCORE = 0.9
SAMPLE_EVERY_S = 0.25
KEEP_PER_TRACK = 3
IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".bmp")
VIDEO_EXT = (".mp4", ".mov", ".avi", ".mkv", ".webm")


def sources(case_dir: Path) -> list[Path]:
    ev = case_dir / "evidence"
    out = [ev / "cctv.mp4"] if (ev / "cctv.mp4").exists() else []
    return out + sorted(p for p in ev.glob("face_source_*") if p.suffix.lower() in IMAGE_EXT + VIDEO_EXT)


def available() -> bool:
    return DETECTOR.exists() and RECOGNIZER.exists()


def _detector(w: int, h: int):
    d = cv2.FaceDetectorYN.create(str(DETECTOR), "", (w, h), MIN_SCORE, 0.3, 50)
    d.setInputSize((w, h))
    return d


def _recognizer():
    return cv2.FaceRecognizerSF.create(str(RECOGNIZER), "")


def _faces(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    scale = 1.0 if max(w, h) >= 640 else 640 / max(w, h)  # small frames: upscale so small faces reach the detector's minimum
    big = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC) if scale != 1 else img
    _, found = _detector(big.shape[1], big.shape[0]).detect(big)
    if found is None:
        return np.zeros((0, 15)), big
    return found, big


def _owner(box, t: float, tracks: list[dict]) -> str | None:
    """The tracked road user whose box contains this face at this moment."""
    cx, cy = box[0] + box[2] / 2, box[1] + box[3] / 2
    best, area = None, 1e18
    for tr in tracks:
        q = min(tr["points"], key=lambda q: abs(q["t"] - t))
        if abs(q["t"] - t) > 0.15:
            continue
        b = q["box"]
        if b[0] <= cx <= b[2] and b[1] <= cy <= b[3] and (b[2] - b[0]) * (b[3] - b[1]) < area:
            best, area = tr["id"], (b[2] - b[0]) * (b[3] - b[1])
    return best


def scan(case_dir: Path) -> dict:
    """Detect faces through the clip, keep the clearest few per road user, store their features."""
    out_dir = case_dir / "faces"
    out_dir.mkdir(exist_ok=True)
    case = json.loads((case_dir / "case.json").read_text(encoding="utf-8"))
    ui = json.loads((case_dir / "tracks_ui.json").read_text()) if (case_dir / "tracks_ui.json").exists() else {"tracks": []}
    rec = _recognizer()
    found, scanned = [], 0

    def take(img, source, idx, t, tracks):
        faces, big = _faces(img)
        k = big.shape[1] / img.shape[1]
        for f in faces:
            size = min(f[2], f[3]) / k
            if f[14] < MIN_SCORE or size < MIN_FACE_PX:
                continue
            aligned = rec.alignCrop(big, f)
            found.append({"t": round(t, 2) if t is not None else None, "frame": idx, "source": source, "score": round(float(f[14]), 3), "size_px": round(float(size), 1),
                          "box": [round(float(v / k), 1) for v in f[:4]], "track": _owner([v / k for v in f[:4]], t, tracks) if tracks and t is not None else None,
                          "_feat": rec.feature(aligned).flatten().tolist(), "_crop": aligned})

    for src in sources(case_dir):
        if src.suffix.lower() in IMAGE_EXT:
            img = cv2.imread(str(src))
            if img is not None:
                scanned += 1
                take(img, src.name, 0, None, None)
            continue
        cctv = src.name == "cctv.mp4"
        cap = cv2.VideoCapture(str(src))
        fps, total = cap.get(cv2.CAP_PROP_FPS) or 25, int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        for idx in range(0, total, max(1, int(fps * SAMPLE_EVERY_S))):
            cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ok, img = cap.read()
            if not ok:
                continue
            scanned += 1
            take(img, src.name, idx, idx / fps - case["t0_video_s"] if cctv else idx / fps, ui["tracks"] if cctv else None)
        cap.release()
    # The clearest views per person (by size and detector score); untracked faces are grouped on their own.
    by = {}
    for f in found:
        by.setdefault(f["track"] or f"{Path(f['source']).stem}_{f['frame']}", []).append(f)
    kept = []
    for owner, fs in by.items():
        for n, f in enumerate(sorted(fs, key=lambda f: -(f["size_px"] * f["score"]))[:KEEP_PER_TRACK]):
            name = f"face_{owner}_{n}.jpg"
            cv2.imwrite(str(out_dir / name), f.pop("_crop"), [cv2.IMWRITE_JPEG_QUALITY, 92])
            f["file"], f["id"] = name, f"{owner}#{n}"
            kept.append(f)
    feats = {f["id"]: f.pop("_feat") for f in kept}
    (out_dir / "features.json").write_text(json.dumps(feats))
    res = {"faces": kept, "frames_scanned": scanned, "usable": len(kept), "sources": [p.name for p in sources(case_dir)],
           "model": "OpenCV Zoo YuNet + SFace", "note": "Faces smaller than 28 px or below 0.9 detector confidence are skipped as unusable."}
    (case_dir / "faces.json").write_text(json.dumps(res, indent=1))
    return res


def booth_feature(photo: Path) -> tuple[list | None, str]:
    img = cv2.imread(str(photo)) if photo.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp", ".bmp") else None
    if img is None:
        return None, "The booth photo is a drawn placeholder, so there's no face to compare. Upload a real, consented photo to this record."
    faces, big = _faces(img)
    if not len(faces):
        return None, "No face could be found in the booth photo."
    f = max(faces, key=lambda f: f[2] * f[3] * f[14])
    rec = _recognizer()
    return rec.feature(rec.alignCrop(big, f)).flatten().tolist(), ""


def compare(case_dir: Path, photo: Path, track: str | None = None) -> dict:
    """One booth photo against the faces this case's footage holds, optionally only those on one road user."""
    if not available():
        return {"status": "unavailable", "reason": "Face models aren't installed."}
    fj = case_dir / "faces.json"
    faces = json.loads(fj.read_text()) if fj.exists() else scan(case_dir)
    feats = json.loads((case_dir / "faces" / "features.json").read_text())
    pool = [f for f in faces["faces"] if track is None or f["track"] == track]
    booth, why = booth_feature(photo)
    if booth is None:
        return {"status": "not_comparable", "reason": why, "faces_in_footage": len(faces["faces"])}
    if not pool:
        return {"status": "not_comparable", "reason": "Your photo has a usable face, but this case's footage has none clear enough to compare" + (" on that road user" if track else "") + ". Add a frame or clip where the face is visible (dashcam, phone, toll camera) and check again.",
                "faces_in_footage": len(faces["faces"])}
    rec, b = _recognizer(), np.float32(booth).reshape(1, -1)
    scored = sorted(({**f, "similarity": round(float(rec.match(b, np.float32(feats[f["id"]]).reshape(1, -1), cv2.FaceRecognizerSF_FR_COSINE)), 3)} for f in pool), key=lambda f: -f["similarity"])
    top = scored[0]
    s = top["similarity"]
    status = "similar" if s >= SAME_COSINE + MARGIN else "not_similar" if s < SAME_COSINE - MARGIN else "inconclusive"
    return {"status": status, "best": top, "compared": len(scored), "threshold": SAME_COSINE, "margin": MARGIN, "ranked": scored[:5],
            "reason": {"similar": "The closest face in the footage is similar to the booth photo. A lead for an officer to check, not an identification.",
                       "not_similar": "No face in the footage is similar to the booth photo. That doesn't clear anyone: the driver may not be visible.",
                       "inconclusive": "Too close to the model's threshold to say either way."}[status]}
