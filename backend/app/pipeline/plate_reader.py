"""A2 · Automatic number-plate recognition for every tracked vehicle -> plates_all.json (+ plates.json, plate crops).

Real ANPR only: a plate is reported only when it was actually read. Nothing is assigned or guessed.
Approach (after ankandrew/fast-alpr and the Indian ANPR pipelines subash9940/indian-number-plate-recognition
and ayannotfound/Sentry):
  1. For each vehicle track, take its sharpest, largest boxes (up to MAX_SAMPLES frames). A Laplacian blur
     gate drops smeared frames.
  2. Crop the vehicle (+10% margin), upscale small crops, run plate DETECTION + OCR on the crop
     (fast-alpr: YOLO-v9 plate detector + fast-plate-ocr global model; fallback easyocr on the lower half).
  3. Clean every read to the Indian format (state letters, district digits, series letters, 4 digits), fixing
     position-wise OCR confusions (O/0, I/1, S/5, B/8 …). Reads that do not fit the format are dropped.
  4. Confidence-weighted vote per character across frames. The best plate crop is saved as evidence
     (evidence/plate_<track>.jpg) so the website shows the actual pixels behind every number.
  5. Optional close-up evidence: evidence/plates/<track>.jpg (or suspect.jpg / victim.jpg) is read with
     the same models when the CCTV is too coarse (a common real-world case).
A track with no legible plate is reported as such ("not legible"), never filled in."""
import json
import re
from collections import defaultdict
from pathlib import Path

from .. import ts_police_db as db

VEHICLE = {"car", "bus", "truck", "motorcycle", "bicycle", "auto"}
MAX_SAMPLES = 16
MIN_SHARPNESS = 15.0
from .anpr_result import (STATUS_LABEL, LEVEL, alnum, candidates, direction, is_standard, normalise, plate_info,  # noqa: E402
                          status_for, ts, vote)


def clean(text: str) -> str | None:  # kept for compatibility: a full, standard-format plate or None
    c = normalise(text)
    return c if is_standard(c) else None


# ---------------- plate localisation ----------------
def prep(img, target_h: int = 96):
    """Upscale to a readable height and sharpen (unsharp mask)."""
    import cv2
    f = target_h / max(img.shape[0], 1)
    if f > 1:
        img = cv2.resize(img, None, fx=f, fy=f, interpolation=cv2.INTER_CUBIC)
    blur = cv2.GaussianBlur(img, (0, 0), 2)
    return cv2.addWeighted(img, 1.6, blur, -0.6, 0)


def split_lines(plate):
    """Two-line plate -> [top, bottom] at the emptiest row near the middle; single-line plate -> [plate]."""
    import cv2
    import numpy as np
    h, w = plate.shape[:2]
    if h < 8 or w / h > 2.6:
        return [plate]
    g = cv2.cvtColor(plate, cv2.COLOR_BGR2GRAY)
    ink = (g < 0.6 * np.median(g)).sum(axis=1).astype(float)
    lo, hi = int(0.35 * h), int(0.65 * h)
    cut = lo + int(np.argmin(ink[lo:hi]))
    return [plate[:cut], plate[cut:]]


def colour_candidates(frame, box, top: float, max_n: int = 2, min_ar: float = 1.1):
    """Plate-coloured rectangles (yellow = commercial, white = private) in the plate zone of a vehicle box,
    with dark character strokes inside. Returns [(score, kind, [x1,y1,x2,y2] in frame px)]."""
    import cv2
    import numpy as np
    H, W = frame.shape[:2]
    x1, y1, x2, y2 = (int(v) for v in box)
    h = y2 - y1
    ry1 = y1 + int(top * h)
    reg = frame[max(0, ry1):min(H, y2), max(0, x1):min(W, x2)]
    if reg.size == 0:
        return []
    up = 4
    big = cv2.resize(reg, None, fx=up, fy=up, interpolation=cv2.INTER_CUBIC)
    hsv = cv2.cvtColor(big, cv2.COLOR_BGR2HSV)
    out = []
    for kind, m in (("yellow", cv2.inRange(hsv, (12, 90, 120), (38, 255, 255))), ("white", cv2.inRange(hsv, (0, 0, 175), (180, 55, 255)))):
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 9), np.uint8))
        for c in cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
            bx, by, bw, bh = cv2.boundingRect(c)
            area = bw * bh
            # plate-sized: >= 7 px tall in the footage, at most 60% of the vehicle's width
            if not (min_ar <= bw / max(bh, 1) <= 6.5) or area < 0.004 * big.shape[0] * big.shape[1] or bh < 28 or bw / up > 0.6 * (x2 - x1):
                continue
            fill = cv2.contourArea(c) / area
            g = cv2.cvtColor(big[by:by + bh, bx:bx + bw], cv2.COLOR_BGR2GRAY)
            dark = float((g < 0.6 * np.median(g)).mean())
            if fill < 0.55 or not 0.04 <= dark <= 0.6:
                continue
            out.append((fill * min(dark / 0.2, 1.0) * (1.3 if kind == "yellow" else 1.0), kind,
                        [x1 + bx / up, ry1 + by / up, x1 + (bx + bw) / up, ry1 + (by + bh) / up]))
    return sorted(out, key=lambda x: -x[0])[:max_n]


def fuse_plates(crops: list, size=(240, 150), max_n: int = 150):
    """Multi-frame fusion: align every located plate crop of one vehicle to the sharpest (ECC affine) and average.
    Noise and compression blocks cancel, characters stay. Returns (fused BGR image, frames used)."""
    import cv2
    import numpy as np
    if len(crops) < 3:
        return None, 0
    step = max(1, len(crops) // max_n)
    imgs = [cv2.resize(c, size, interpolation=cv2.INTER_CUBIC).astype(np.float32) for c in crops[::step] if c is not None and c.size]
    grays = [cv2.cvtColor(i.astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32) for i in imgs]
    ref = int(np.argmax([cv2.Laplacian(g, cv2.CV_32F).var() for g in grays]))
    acc, n = np.zeros_like(imgs[0]), 0
    for img, g in zip(imgs, grays):
        W = np.eye(2, 3, dtype=np.float32)
        try:
            cc, W = cv2.findTransformECC(grays[ref], g, W, cv2.MOTION_AFFINE, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 60, 1e-5), None, 5)
        except cv2.error:
            continue
        if cc < 0.6:
            continue
        acc += cv2.warpAffine(img, W, size, flags=cv2.INTER_LINEAR + cv2.WARP_INVERSE_MAP)
        n += 1
    if n < 3:
        return None, n
    fused = (acc / n).astype(np.uint8)
    blur = cv2.GaussianBlur(fused, (0, 0), 3)
    return cv2.addWeighted(fused, 1.7, blur, -0.7, 0), n


def crop_box(frame, fb, pad: float = 0.12):
    x1, y1, x2, y2 = fb
    w, h = x2 - x1, y2 - y1
    return frame[int(max(0, y1 - pad * h)):int(min(frame.shape[0], y2 + pad * h)), int(max(0, x1 - pad * w)):int(min(frame.shape[1], x2 + pad * w))]


# ---------------- engines ----------------
ERRORS: list[str] = []


def _fast_alpr():
    try:
        from fast_alpr import ALPR  # type: ignore
    except Exception as e:
        ERRORS.append(f"import fast_alpr: {type(e).__name__}: {e}")
        return None
    for det in ("yolo-v9-s-608-license-plate-end2end", "yolo-v9-t-384-license-plate-end2end"):
        for ocr in ("cct-s-v2-global-model", "cct-xs-v2-global-model", "cct-s-v1-global-model", "cct-xs-v1-global-model"):
            try:
                alpr = ALPR(detector_model=det, ocr_model=ocr)
            except Exception as e:
                ERRORS.append(f"ALPR({det}, {ocr}): {type(e).__name__}: {str(e)[:200]}")
                continue

            def run(img, alpr=alpr):
                out = []
                for r in alpr.predict(img) or []:
                    o = getattr(r, "ocr", None)
                    if not o or not getattr(o, "text", None):
                        continue
                    c = o.confidence
                    c = float(sum(c) / len(c)) if isinstance(c, (list, tuple)) and c else float(c or 0)
                    b = r.detection.bounding_box
                    out.append((o.text, c * float(getattr(r.detection, "confidence", 1.0)), [b.x1, b.y1, b.x2, b.y2]))
                return out
            return f"fast-alpr ({det} + {ocr})", run
    return None


def _easyocr():
    try:
        import easyocr  # type: ignore
        rd = easyocr.Reader(["en"], gpu=False, verbose=False)
    except Exception as e:
        ERRORS.append(f"easyocr: {type(e).__name__}: {str(e)[:200]}")
        return None

    def run(img):
        h = img.shape[0]
        lower = img[h // 2:, :]
        res = rd.readtext(lower, allowlist="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", detail=1)
        if not res:
            return []
        txt = "".join(x[1] for x in res)
        conf = sum(x[2] for x in res) / len(res)
        xs = [p[0] for x in res for p in x[0]]
        ys = [p[1] + h // 2 for x in res for p in x[0]]
        return [(txt, float(conf), [min(xs), min(ys), max(xs), max(ys)])]
    return "easyocr (lower half of vehicle)", run


def _trocr():
    """subash1652007/indian-plate-ocr: YOLO plate detector (yolo_best.pt) + TrOCR-small fine-tuned on Indian plates
    (67% exact match on held-out crops vs 22% for raw EasyOCR). Returns per-character confidences from the decoder."""
    try:
        import cv2
        import torch
        from huggingface_hub import snapshot_download  # noqa: F401
        from PIL import Image
        from transformers import TrOCRProcessor, VisionEncoderDecoderModel
        from ultralytics import YOLO
        path = snapshot_download("subash1652007/indian-plate-ocr")
        try:
            import easyocr  # type: ignore
            easy = easyocr.Reader(["en"], gpu=False, verbose=False)
        except Exception as e:
            ERRORS.append(f"easyocr (optional line reader): {type(e).__name__}: {str(e)[:160]}")
            easy = None
        det = YOLO(f"{path}/yolo_best.pt")
        proc = TrOCRProcessor.from_pretrained(f"{path}/trocr_plate")
        model = VisionEncoderDecoderModel.from_pretrained(f"{path}/trocr_plate").eval()
    except Exception as e:
        ERRORS.append(f"TrOCR engine: {type(e).__name__}: {str(e)[:240]}")
        return None

    def read_plate(pc):
        pil = Image.fromarray(cv2.cvtColor(pc, cv2.COLOR_BGR2RGB))
        with torch.no_grad():
            g = model.generate(proc(pil, return_tensors="pt").pixel_values, max_length=20, num_beams=3,
                               output_scores=True, return_dict_in_generate=True)
        text = proc.batch_decode(g.sequences, skip_special_tokens=True)[0]
        chars = []
        try:
            ts = model.compute_transition_scores(g.sequences, g.scores, getattr(g, "beam_indices", None), normalize_logits=True)[0]
            for tok, sc in zip(g.sequences[0][1:], ts):
                piece = re.sub(r"[^A-Za-z0-9]", "", proc.tokenizer.decode([int(tok)], skip_special_tokens=True))
                chars += [float(torch.exp(sc))] * len(piece)
        except Exception:
            chars = []
        seq_conf = float(torch.exp(g.sequences_scores[0])) if getattr(g, "sequences_scores", None) is not None else (sum(chars) / len(chars) if chars else 0.5)
        return text, seq_conf, chars

    def run(img):  # generic interface (close-up photos): detect + read
        out = []
        res = det(img, conf=0.15, imgsz=640, verbose=False)[0]
        for b, c in zip(res.boxes.xyxy.tolist(), res.boxes.conf.tolist()):
            x1, y1, x2, y2 = (int(v) for v in b)
            pc = img[max(0, y1):y2, max(0, x1):x2]
            if pc.size == 0 or pc.shape[1] < 12:
                continue
            text, conf, chars, _ = read_lines(prep(pc))
            out.append((text, conf * float(c), [x1, y1, x2, y2], chars))
        return out

    def variants(img):
        """Preprocessing ensemble (as in Indian ANPR pipelines): sharpened colour, CLAHE grey, Otsu black-on-white."""
        g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        cl = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(4, 8)).apply(g)
        _, bw = cv2.threshold(cv2.GaussianBlur(cl, (3, 3), 0), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        if (bw < 128).mean() > 0.5:  # make text dark on light
            bw = 255 - bw
        return [("colour", img), ("clahe", cv2.cvtColor(cl, cv2.COLOR_GRAY2BGR)), ("binary", cv2.cvtColor(bw, cv2.COLOR_GRAY2BGR))]

    def best_of(img):
        reads = []
        for name, v in variants(img)[:1]:
            t, c, ch = read_plate(v)
            t2 = alnum(t)
            reads.append((t2, c * (1.0 if t2 else 0.0), ch if len(ch) == len(t2) else [c] * len(t2), name))
        return max(reads, key=lambda r: (r[1] > 0, len(r[0]) >= 2, r[1]))

    def easy_read(plate):
        """EasyOCR finds each text line itself (good for two-line plates); lines joined top-to-bottom."""
        best = ("", 0.0, [], 1)
        for name, v in variants(plate):
            res = easy.readtext(v, allowlist="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", detail=1, paragraph=False)
            res = [r for r in res if r[1]]
            if not res:
                continue
            res.sort(key=lambda r: (round(min(p[1] for p in r[0]) / max(8, plate.shape[0] / 4)), min(p[0] for p in r[0])))
            text = alnum("".join(r[1] for r in res))
            conf = sum(r[2] for r in res) / len(res)
            rows = len({round(min(p[1] for p in r[0]) / max(8, plate.shape[0] / 4)) for r in res})
            if (len(text) >= 3, conf) > (len(best[0]) >= 3, best[1]):
                best = (text, conf, [], min(rows, 2))
        return best

    def read_lines(plate):
        """EasyOCR first (line-aware); if it finds fewer than 3 characters, TrOCR line by line."""
        if easy is not None:
            e = easy_read(plate)
            if len(e[0]) >= 3:
                return e
        parts = split_lines(plate)
        whole = best_of(plate)
        if len(parts) == 1:
            return whole[0], whole[1], whole[2], 1
        lines = [best_of(prep(p)) for p in parts]
        joined = ("".join(l[0] for l in lines), min(l[1] for l in lines), sum((l[2] for l in lines), []))
        pick = max([(joined, 2), ((whole[0], whole[1], whole[2]), 1)], key=lambda x: (len(x[0][0]) >= 6, x[0][1]))
        return pick[0][0], pick[0][1], pick[0][2], pick[1]

    def detect(img):
        res = det(img, conf=0.12, imgsz=640, verbose=False)[0]
        return [(list(map(float, b)), float(c)) for b, c in zip(res.boxes.xyxy.tolist(), res.boxes.conf.tolist())]

    run.read_lines, run.detect = read_lines, detect
    return ("YOLO plate detector + colour plate locator · " + ("EasyOCR line reader (TrOCR fallback)" if easy else "TrOCR (indian-plate-ocr)")), run


def engine():
    return _trocr() or _fast_alpr() or _easyocr()


# ---------------- inputs ----------------
def _tracks(case_dir: Path) -> list[dict]:
    p = case_dir / "tracks.json"
    if p.exists():
        t = json.loads(p.read_text(encoding="utf-8"))
        tr = t.get("tracks", t)
        if isinstance(tr, dict):
            return [{"id": k, "class": v.get("class"), "colour": v.get("colour"), "points": v.get("points", [])} for k, v in tr.items()]
        return [{"id": v["id"], "class": v.get("class"), "colour": v.get("colour"), "points": v.get("points", [])} for v in tr]
    return []


def _entities(case_dir: Path) -> dict:
    p = case_dir / "analysis.json"
    a = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    return a.get("entities") or {}


def vehicle_type(track: dict, names: dict) -> str:
    name = (names.get(track["id"]) or "").lower()
    for k in ("bus", "truck", "auto", "motorcycle", "bicycle"):
        if k in name:
            return k
    return track.get("class") or "car"


def _video(case_dir: Path) -> Path | None:
    case = json.loads((case_dir / "case.json").read_text(encoding="utf-8")) if (case_dir / "case.json").exists() else {}
    for e in case.get("evidence", []):
        if e.get("type") == "video" and (case_dir / "evidence" / e["file"]).exists():
            return case_dir / "evidence" / e["file"]
    return None


def read_real(case_dir: Path, tracks: list[dict], roles: dict[str, str], log=print, involved: list[str] | None = None) -> tuple[str | None, dict[str, dict]]:
    """Returns (engine name, {track_id: result}). Never raises."""
    eng = engine()
    if not eng:
        log("no ANPR engine installed (pip install fast-alpr[onnx] or easyocr)")
        return None, {}
    name, ocr = eng
    try:
        import cv2
    except Exception:
        return name, {}
    results: dict[str, dict] = {}

    def read_crop(img, tid, f, ox=0, oy=0, scale=1.0):
        out = []
        for item in ocr(img):
            txt, conf, box = item[0], item[1], item[2]
            chars = item[3] if len(item) > 3 else None
            c = normalise(txt)
            log(f"  {tid} f{f}: raw '{txt}' conf {conf:.2f} -> {c or 'rejected (not 7-10 chars)'}")
            if c:
                bx = [ox + box[0] / scale, oy + box[1] / scale, ox + box[2] / scale, oy + box[3] / scale]
                out.append((c, conf, bx, img[max(0, int(box[1])):int(box[3]), max(0, int(box[0])):int(box[2])].copy(), chars))
        return out

    # close-up plate photos supplied as evidence (same models)
    shots = case_dir / "evidence" / "plates"
    if shots.is_dir():
        for p in sorted(shots.glob("*.*")):
            key = p.stem
            tid = next((t for t, r in roles.items() if r == key), key)
            img = cv2.imread(str(p))
            if img is None:
                continue
            reads = read_crop(img, tid, "photo")
            if reads:
                v = vote([(r, c, ch) for r, c, _, _, ch in reads])
                best = max(reads, key=lambda x: x[1])
                cv2.imwrite(str(case_dir / "evidence" / f"plate_{tid}.jpg"), best[3] if best[3].size else img)
                results[tid] = v | {"frames": ["photo"], "method": f"{name} on close-up photo ({p.name})", "plate_box": None,
                                    "crop": f"plate_{tid}.jpg", "frame": None}

    video = _video(case_dir)
    if not video:
        return name, results
    wanted: dict[int, list[tuple[str, list[float]]]] = defaultdict(list)
    for t in tracks:
        if t["id"] in results:
            continue
        pts = [p for p in t["points"] if p.get("box")]
        n = 20 if t["id"] in (involved or []) else 3   # involved vehicles: many frames to vote over; others: a quick look
        pts = sorted(pts, key=lambda p: -(p["box"][2] - p["box"][0]) * (p["box"][3] - p["box"][1]))[:n * 2][::2]
        ocr_frames = {p["f"] for p in pts}
        # involved vehicles: locate the plate in EVERY frame (cheap) for multi-frame fusion; OCR only on the sampled ones
        for p in ([q for q in t["points"] if q.get("box")] if t["id"] in (involved or []) else pts):
            wanted[p["f"]].append((t["id"], p["box"], p["f"] in ocr_frames))
    reads: dict[str, list] = defaultdict(list)
    meta: dict[str, list] = defaultdict(list)
    plate_crops: dict[str, list] = defaultdict(list)
    located: dict[str, tuple] = {}
    trocr = hasattr(ocr, "read_lines")
    two_wheel = {t["id"] for t in tracks if (t.get("class") or "") in ("motorcycle", "bicycle")}
    cap = cv2.VideoCapture(str(video))
    W, H = int(cap.get(3)), int(cap.get(4))
    f, last = 0, max(wanted) if wanted else -1
    while f <= last:
        ok, frame = cap.read()
        if not ok:
            break
        for tid, box, do_ocr in wanted.get(f, []):
            if not trocr and not do_ocr:
                continue
            if not trocr:  # generic engines: whole vehicle crop
                x1, y1, x2, y2 = box
                mx, my = (x2 - x1) * 0.1, (y2 - y1) * 0.1
                x1, y1, x2, y2 = int(max(0, x1 - mx)), int(max(0, y1 - my)), int(min(W, x2 + mx)), int(min(H, y2 + my))
                crop = frame[y1:y2, x1:x2]
                if crop.size == 0:
                    continue
                scale = max(1.0, min(4.0, 640 / max(crop.shape[:2])))
                img = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC) if scale > 1 else crop
                try:
                    for r in read_crop(img, tid, f, x1, y1, scale):
                        reads[tid].append((f,) + r)
                except Exception as e:
                    log(f"  {tid} f{f}: OCR error {type(e).__name__}")
                continue
            # 1) where is the plate? colour finder + YOLO plate detector, both limited to the plate zone
            top = 0.30 if tid in two_wheel else 0.45
            min_ar = 1.8 if tid in two_wheel else 1.1   # two-wheeler front plates are wide single-line plates
            cands = [(sc, kind, fb) for sc, kind, fb in colour_candidates(frame, box, top, min_ar=min_ar)]
            x1, y1, x2, y2 = (int(v) for v in box)
            veh = frame[max(0, y1):min(H, y2), max(0, x1):min(W, x2)]
            if veh.size and do_ocr:  # the YOLO plate detector only on OCR frames (speed); colour locator on all
                up = max(1.0, min(4.0, 480 / max(veh.shape[:2])))
                big = cv2.resize(veh, None, fx=up, fy=up, interpolation=cv2.INTER_CUBIC)
                try:
                    for b, c in ocr.detect(big):
                        fb = [x1 + b[0] / up, y1 + b[1] / up, x1 + b[2] / up, y1 + b[3] / up]
                        cy, bw, bh = (fb[1] + fb[3]) / 2, fb[2] - fb[0], fb[3] - fb[1]
                        if cy >= y1 + top * (y2 - y1) and min_ar <= bw / max(bh, 1e-6) <= 6.5:  # skip boards / signs above the bumper
                            cands.append((0.8 * c, "yolo", fb))
                except Exception as e:
                    log(f"  {tid} f{f}: detector error {type(e).__name__}")
            cands.sort(key=lambda x: -x[0])
            if not cands:
                continue
            fb0 = cands[0][2]
            if cands[0][1] in ("yellow", "white"):
                plate_crops[tid].append((cands[0][1], cands[0][0], crop_box(frame, fb0, pad=0.15).copy()))
            if tid not in located or cands[0][0] > located[tid][0]:
                located[tid] = (cands[0][0], fb0, crop_box(frame, fb0).copy(), f)
            if not do_ocr:
                continue
            # 2) read it (two-line plates line by line)
            for sc, kind, fb in cands[:2 if tid in (involved or []) else 1]:
                pc = crop_box(frame, fb)
                if pc.size == 0:
                    continue
                try:
                    text, conf, chars, nlines = ocr.read_lines(prep(pc))
                except Exception as e:
                    log(f"  {tid} f{f}: OCR error {type(e).__name__}: {e}")
                    continue
                c = normalise(text)
                log(f"  {tid} f{f} [{kind} {int(fb[2] - fb[0])}x{int(fb[3] - fb[1])}px, {nlines} line(s)]: raw '{text}' conf {conf:.2f} -> {c or 'empty'}")
                if c and len(c) >= 3:  # raw readings of any format are kept (non-standard / temporary / partial plates)
                    reads[tid].append((f, c, conf * min(1.0, 0.5 + sc), fb, prep(pc), chars if len(chars) == len(c) else None))
                    meta[tid].append((kind, nlines))
        f += 1
    cap.release()
    fused_info: dict[str, dict] = {}
    for tid, items in plate_crops.items():  # multi-frame fusion + OCR on the fused plate (weighted above single frames)
        kinds = [k for k, _, _ in items]
        kind = max(set(kinds), key=kinds.count)
        top = max(sc for k, sc, _ in items if k == kind)
        crops = [c for k, sc, c in items if k == kind and sc >= 0.6 * top]  # same plate, strongly located
        fused, n = fuse_plates(crops)
        if fused is None:
            continue
        fname = f"plate_{tid}_fused.jpg"
        cv2.imwrite(str(case_dir / "evidence" / fname), fused)
        fused_info[tid] = {"file": fname, "frames": n}
        try:
            text, conf, chars, nlines = ocr.read_lines(fused)
        except Exception as e:
            log(f"  {tid} fused: OCR error {type(e).__name__}: {e}")
            continue
        c = normalise(text)
        log(f"  {tid} FUSED ({n} frames, {nlines} line(s)): raw '{text}' conf {conf:.2f} -> {c or 'empty'}")
        if c and len(c) >= 3:
            for _ in range(3):  # a fused read counts as three frames of evidence
                reads[tid].append((-1, c, conf, located.get(tid, (0, [0, 0, 0, 0]))[1], fused, chars if len(chars) == len(c) else None))
            meta[tid].append(("fused", nlines))
    for tid, (sc, fb, crop, fr) in located.items():  # plate found but no character could be trusted: say so, show it
        if tid not in reads:
            name_ = f"plate_{tid}.jpg"
            cv2.imwrite(str(case_dir / "evidence" / name_), prep(crop, 120))
            results[tid] = {"plate": None, "confidence": 0.0, "reads": [], "partial": False, "known": 0, "frames": [fr],
                            "method": f"plate located ({int(fb[2] - fb[0])}x{int(fb[3] - fb[1])} px in the footage) but too small / blurred to read any character",
                            "plate_box": [round(x, 1) for x in fb], "crop": name_, "frame": fr, "located_only": True,
                            "fused": fused_info.get(tid)}
    for tid, rs in reads.items():
        v = vote([(r, c, ch) for _, r, c, _, _, ch in rs])
        kinds = [k for k, _ in meta.get(tid, []) if k in ("yellow", "white")]
        v["plate_colour"] = max(set(kinds), key=kinds.count) if kinds else None
        nl = [n for _, n in meta.get(tid, [])]
        v["lines"] = max(set(nl), key=nl.count) if nl else None
        v["candidates"] = candidates(v["plate"], v.get("alternatives", {}))
        if not v["plate"] or v["known"] < 3:  # fewer than 3 characters agreed: report as unread, not as a guess
            log(f"  {tid}: only {v['known']} confident character(s); not reported")
            if tid in located:
                sc, fb, crop, fr = located[tid]
                cv2.imwrite(str(case_dir / "evidence" / f"plate_{tid}.jpg"), prep(crop, 120))
                results[tid] = {"plate": None, "confidence": 0.0, "reads": v["reads"], "partial": False, "known": v["known"], "frames": [fr],
                                "method": f"plate located ({int(fb[2] - fb[0])}x{int(fb[3] - fb[1])} px) but no character was consistent across frames",
                                "plate_box": [round(x, 1) for x in fb], "crop": f"plate_{tid}.jpg", "frame": fr, "located_only": True,
                                "fused": fused_info.get(tid)}
            continue
        best = max([x for x in rs if x[0] >= 0] or rs, key=lambda x: x[2])
        crop_name = f"plate_{tid}.jpg"
        if best[4] is not None and best[4].size:
            cv2.imwrite(str(case_dir / "evidence" / crop_name), cv2.resize(best[4], None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC))
        v["fused"] = fused_info.get(tid)
        results[tid] = v | {"frames": [x[0] for x in rs], "method": f"{name} · {len(rs)} read(s) voted{' · partial: ? = uncertain character' if v['partial'] else ''}", "plate_box": [round(x, 1) for x in best[3]],
                            "crop": crop_name if best[4] is not None and best[4].size else None, "frame": best[0]}
    return name, results


def _evidence(case_dir: Path, track: dict, video: Path | None) -> dict:
    """Best vehicle crop + 3 representative frames (first / clearest / last sighting) with timestamps (OBSERVED)."""
    pts = [p for p in track["points"] if p.get("box")]
    if not pts or not video:
        return {"vehicle_crop": None, "representative_frames": [], "first_seen": None, "last_seen": None, "video_timestamp": None}
    import cv2
    area = lambda p: (p["box"][2] - p["box"][0]) * (p["box"][3] - p["box"][1])
    best = max(pts, key=area)
    picks = {"first": pts[0], "clearest": best, "last": pts[-1]}
    cap = cv2.VideoCapture(str(video))
    frames = []
    for label, p in picks.items():
        cap.set(cv2.CAP_PROP_POS_FRAMES, p["f"])
        ok, fr = cap.read()
        if not ok:
            continue
        x1, y1, x2, y2 = (int(v) for v in p["box"])
        mx, my = int(0.08 * (x2 - x1)), int(0.08 * (y2 - y1))
        crop = fr[max(0, y1 - my):y2 + my, max(0, x1 - mx):x2 + mx]
        if crop.size == 0:
            continue
        name = f"veh_{track['id']}_{label}.jpg"
        cv2.imwrite(str(case_dir / "evidence" / name), crop)
        frames.append({"label": label, "file": name, "frame": p["f"], "timestamp": ts(p.get("t")), "size_px": [x2 - x1, y2 - y1]})
    cap.release()
    return {"vehicle_crop": next((f["file"] for f in frames if f["label"] == "clearest"), None), "representative_frames": frames,
            "first_seen": ts(pts[0].get("t")), "last_seen": ts(pts[-1].get("t")), "video_timestamp": ts(best.get("t")),
            "best_px": [int(best["box"][2] - best["box"][0]), int(best["box"][3] - best["box"][1])]}


def structured(idx: int, t: dict, r: dict | None, eng: str | None, names: dict, evidence: dict, confirmed: dict | None) -> dict:
    """Per-vehicle result in the investigation format (see anpr_result for the evidence levels)."""
    read = dict(r or {})
    if confirmed:
        read["confirmed_registration"] = confirmed["registration"]
    located = bool(r and (r.get("plate_box") or r.get("located_only")))
    status, reason = status_for(read if read.get("plate") or confirmed else None, located, tuple(evidence.get("best_px") or ()) or None)
    if not eng and status in ("plate_not_detected",):
        reason = "No ANPR engine installed on this machine (run read_plates.bat)."
    confs = [p.get("conf") for p in t["points"] if p.get("conf") is not None]
    feats = []
    if read.get("plate_colour"):
        feats.append({"text": f"{read['plate_colour']} number plate", "level": LEVEL["observed"]})
    if read.get("lines") == 2:
        feats.append({"text": "two-line number plate", "level": LEVEL["observed"]})
    return {
        "vehicle_track_id": t["id"], "vehicle_label": f"V-{idx:02d}",
        "registration_status": status, "status_label": STATUS_LABEL[status], "reason": reason,
        "confirmed_registration": confirmed["registration"] if confirmed else None,
        "best_reading": read.get("plate"), "raw_ocr_text": read.get("plate"), "raw_reads": (read.get("reads") or [])[:12],
        "candidate_registrations": read.get("candidates") or [],
        "plate_info": plate_info(read.get("plate"), read.get("plate_colour"), read.get("lines")),
        "vehicle_details": {"category": vehicle_type(t, names).title(), "make_model": "Unknown (not visually confirmed)",
                            "colour": (t.get("colour") or "unknown"), "direction": direction(t["points"]), "distinctive_features": feats},
        "matching_status": "not_checked", "database_matches": [],
        "matching_note": "No authorised registration database is connected, so no registry match is claimed.",
        "evidence": {**{k: evidence.get(k) for k in ("video_timestamp", "first_seen", "last_seen", "vehicle_crop", "representative_frames")},
                     "plate_crop": read.get("crop"), "plate_fused": (read.get("fused") or {}).get("file"),
                     "plate_fused_frames": (read.get("fused") or {}).get("frames")},
        "quality": {"plate_detection": "found" if located else "not found",
                    "ocr_confidence": read.get("confidence"), "ocr_agreement": read.get("agreement"),
                    "frames_with_reading": read.get("frames_voted", 0),
                    "classification_confidence": round(sum(confs) / len(confs), 2) if confs else None,
                    "note": "Scores are model / agreement indicators, not calibrated probabilities of correctness."},
        "requires_manual_review": not confirmed,
        "verification_status": "Investigator-confirmed" if confirmed else "Awaiting investigator verification",
    }


def run(case_dir: Path, roles: dict[str, str] | None = None, force: bool = False, log=lambda *a: None) -> dict:
    out_p = case_dir / "plates_all.json"
    if out_p.exists() and not force:
        cached = json.loads(out_p.read_text(encoding="utf-8"))
        if "legible" in cached and all("anpr" in v for v in cached.get("vehicles", [])):  # older formats are rebuilt
            return cached
    ent = _entities(case_dir)
    names = ent.get("names", {})
    involved = [i for i in [ent.get("primary")] + ent.get("involved", []) if i]
    tracks = [t for t in _tracks(case_dir) if (t.get("class") or "") in VEHICLE]
    existing = json.loads((case_dir / "plates.json").read_text(encoding="utf-8")) if (case_dir / "plates.json").exists() else None
    roles = roles or {}

    vehicles = []
    if existing and not existing.get("generated_by"):  # the simulated demo case ships its own reads
        for v in existing.get("vehicles", []):
            vehicles.append({"track": v["track"], "type": next((t["class"] for t in tracks if t["id"] == v["track"]), "car"),
                             "colour": next((t["colour"] for t in tracks if t["id"] == v["track"]), None), "plate": v["plate"],
                             "confidence": v.get("confidence", 0), "reads": v.get("reads", []), "frames": v.get("frames", []),
                             "partial": "?" in v["plate"], "method": "multi-frame plate reads (simulated case file)", "involved": True,
                             "legible": True, "crop": None, "plate_box": None, "frame": None})
        involved = involved or [v["track"] for v in vehicles]
        eng, real = None, {}
    else:
        eng, real = read_real(case_dir, tracks, {**{ent.get("primary"): "suspect"}, **roles} if ent.get("primary") else roles, log, involved)
        order = sorted(tracks, key=lambda t: (t["id"] not in involved, involved.index(t["id"]) if t["id"] in involved else 0, t["id"]))
        for t in order:
            r = real.get(t["id"])
            vehicles.append({"track": t["id"], "type": vehicle_type(t, names), "colour": t.get("colour"),
                             "plate": r["plate"] if r else None, "confidence": r["confidence"] if r else 0.0,
                             "reads": r["reads"] if r else [], "frames": r["frames"] if r else [], "partial": bool(r and r.get("partial")),
                             "known": r.get("known") if r else 0,
                             "method": r["method"] if r else ("no plate read: " + (f"{eng} could not locate a readable plate on this vehicle at this resolution" if eng else "no ANPR engine installed")),
                             "involved": t["id"] in involved, "legible": bool(r and r.get("plate")), "crop": r.get("crop") if r else None,
                             "plate_box": r.get("plate_box") if r else None, "frame": r.get("frame") if r else None})
    confirmed = json.loads((case_dir / "plates_confirmed.json").read_text(encoding="utf-8")) if (case_dir / "plates_confirmed.json").exists() else {}
    video = _video(case_dir)
    tmap = {t["id"]: t for t in tracks}
    real_ = real if not (existing and not existing.get("generated_by")) else {}
    for i, v in enumerate(vehicles, 1):
        v["name"] = names.get(v["track"], v["track"])
        v["registered"] = False  # no authorised registry is queried
        t = tmap.get(v["track"], {"id": v["track"], "class": v["type"], "colour": v.get("colour"), "points": []})
        ev = _evidence(case_dir, t, video) if (v["involved"] or v.get("crop")) else {}
        v["anpr"] = structured(i, t, real_.get(v["track"]), eng, names, ev, confirmed.get(v["track"]))
        if confirmed.get(v["track"]):
            v["plate"], v["legible"], v["partial"] = confirmed[v["track"]]["registration"], True, False
    out = {"generated_by": "plate_reader", "engine": eng, "involved": involved, "vehicles": vehicles, "schema": 2,
           "legible": sum(v["legible"] for v in vehicles),
           "note": "Plates are shown only when the ANPR actually read them; the crop behind each number is saved as evidence."}
    out_p.write_text(json.dumps(out, indent=2))
    if not existing or existing.get("generated_by"):
        inv = [v for v in vehicles if v["involved"] and v["plate"]]
        (case_dir / "plates.json").write_text(json.dumps({"generated_by": "plate_reader", "vehicles": [
            {"track": v["track"], "plate": v["plate"], "confidence": v["confidence"], "frames": [x for x in v["frames"] if isinstance(x, int)] or [0],
             "reads": v["reads"] or [v["plate"]], "partial": v["partial"]} for v in inv]}, indent=2))
    return out


def confirm(case_dir: Path, track: str, registration: str | None, by: str = "Investigator") -> dict:
    """Investigator confirms (or clears, registration=None) a vehicle's registration. Updates plates_all.json in place."""
    from datetime import datetime
    p = case_dir / "plates_confirmed.json"
    conf = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    if registration:
        conf[track] = {"registration": alnum(registration), "by": by, "at": datetime.now().astimezone().isoformat(timespec="seconds")}
    else:
        conf.pop(track, None)
    p.write_text(json.dumps(conf, indent=2))
    pa_p = case_dir / "plates_all.json"
    pa = json.loads(pa_p.read_text(encoding="utf-8"))
    for v in pa["vehicles"]:
        if v["track"] == track and "anpr" in v:
            a = v["anpr"]
            if registration:
                a.update(confirmed_registration=conf[track]["registration"], registration_status="investigator_confirmed",
                         status_label=STATUS_LABEL["investigator_confirmed"], reason=f"Confirmed by {by} at {conf[track]['at']}.",
                         requires_manual_review=False, verification_status="Investigator-confirmed")
                v["plate"], v["legible"], v["partial"] = conf[track]["registration"], True, False
            else:
                a.update(confirmed_registration=None, requires_manual_review=True, verification_status="Awaiting investigator verification")
    pa_p.write_text(json.dumps(pa, indent=2))
    return conf.get(track) or {}
