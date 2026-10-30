"""OWNER: P1. Video -> tracks.json + video_events.json + annotated.mp4.

Pretrained only: YOLO11 (COCO) detects, ByteTrack links detections into tracks. Everything after that is
our rules on the tracks, so every event says which rule fired and on which frames.

Times here are VIDEO seconds (from the container's frame timestamps). P2's alignment maps them to T0 = impact.
Speeds are approximate until a homography is supplied (scale from object box height, labelled as such).

CLI: python -m app.pipeline.video <video.mp4> <out_dir> [--impact-label 6.5]   (run from backend/)"""
import argparse
import json
import math
import shutil
import subprocess
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np

# COCO ids we care about
CLASSES = {0: "person", 1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck", 9: "traffic_light"}
VEHICLES = {"bicycle", "car", "motorcycle", "bus", "truck"}
COLOURS = {"person": (80, 200, 255), "car": (255, 180, 80), "bus": (60, 220, 120), "truck": (60, 220, 120),
           "motorcycle": (255, 120, 200), "bicycle": (255, 120, 200), "traffic_light": (200, 200, 200)}

MIN_TRACK_FRAMES = 6
MIN_EVENT_CONF = 0.5


def iou(a, b) -> float:
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-9)


def colour_name(bgr_patch) -> str | None:
    """Dominant colour of a crop's centre, named coarsely (white/silver/grey/black/red/blue/...)."""
    if bgr_patch is None or bgr_patch.size == 0:
        return None
    hsv = cv2.cvtColor(bgr_patch, cv2.COLOR_BGR2HSV).reshape(-1, 3).astype(float)
    h, s, v = np.median(hsv[:, 0]), np.median(hsv[:, 1]), np.median(hsv[:, 2])
    if v < 55: return "black"
    if s < 40: return "white" if v > 170 else ("silver" if v > 120 else "grey")
    for lim, name in ((8, "red"), (22, "orange"), (34, "yellow"), (85, "green"), (130, "blue"), (148, "purple"), (180, "red")):
        if h <= lim:
            return name
    return None


def detect_and_track(video: Path, model_name: str, annotated: Path, progress=None):
    from ultralytics import YOLO
    model = YOLO(model_name)
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    W, H = int(cap.get(3)), int(cap.get(4))
    raw = annotated.with_suffix(".raw.mp4")
    out = cv2.VideoWriter(str(raw), cv2.VideoWriter_fourcc(*"mp4v"), fps, (W, H))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    tracks = defaultdict(lambda: {"cls": None, "points": [], "colours": []})
    times, f = [], 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000 or f / fps
        times.append(t)
        r = model.track(frame, persist=True, tracker="bytetrack.yaml", classes=list(CLASSES), conf=0.3, agnostic_nms=True, verbose=False)[0]
        if r.boxes.id is not None:
            for box, tid, c, conf in zip(r.boxes.xyxy.tolist(), r.boxes.id.int().tolist(), r.boxes.cls.int().tolist(), r.boxes.conf.tolist()):
                tr = tracks[tid]
                tr["cls"] = tr["cls"] or CLASSES[c]
                tr["points"].append({"f": f, "t": round(t, 3), "box": [round(v, 1) for v in box], "conf": round(conf, 3)})
                if f % 4 == 0 and CLASSES[c] in VEHICLES:
                    x1, y1, x2, y2 = map(int, box)
                    cw, ch = (x2 - x1) // 4, (y2 - y1) // 4
                    tr["colours"].append(colour_name(frame[y1 + ch:y2 - ch, x1 + cw:x2 - cw]))
        draw(frame, tracks, f, t)
        out.write(frame)
        f += 1
        if progress and f % 10 == 0:
            progress(min(0.99, f / total))
    cap.release()
    out.release()
    # Browsers need H.264; re-encode with ffmpeg when available.
    if shutil.which("ffmpeg"):
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw), "-c:v", "libx264", "-pix_fmt", "yuv420p",
                        "-movflags", "+faststart", str(annotated)], check=True)
        raw.unlink()
    else:
        raw.rename(annotated)
    return dict(tracks), {"fps": fps, "width": W, "height": H, "frames": f, "duration": times[-1] if times else 0}


def draw(frame, tracks, f, t):
    for tid, tr in tracks.items():
        pts = [p for p in tr["points"] if f - 45 <= p["f"] <= f]
        if not pts or pts[-1]["f"] != f:
            continue
        col = COLOURS.get(tr["cls"], (255, 255, 255))
        x1, y1, x2, y2 = map(int, pts[-1]["box"])
        cv2.rectangle(frame, (x1, y1), (x2, y2), col, 2)
        cv2.putText(frame, f"{tr['cls']}_{tid}", (x1, max(14, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, col, 2)
        trail = np.array([[(p["box"][0] + p["box"][2]) / 2, p["box"][3]] for p in pts], np.int32)
        cv2.polylines(frame, [trail], False, col, 2)
    cv2.putText(frame, f"t={t:5.2f}s", (10, frame.shape[0] - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)


def kinematics(tr):
    """Per-point ground position (box bottom-centre), smoothed speed in px/s and approx m/s, heading in degrees."""
    p = tr["points"]
    xs = np.array([(q["box"][0] + q["box"][2]) / 2 for q in p])
    ys = np.array([q["box"][3] for q in p])
    ts = np.array([q["t"] for q in p])
    hs = np.array([q["box"][3] - q["box"][1] for q in p])
    k = min(5, len(p))
    sm = lambda a: np.convolve(np.pad(a, (k // 2, k - 1 - k // 2), mode="edge"), np.ones(k) / k, mode="valid") if len(a) >= k else a
    xs, ys, hs = sm(xs), sm(ys), sm(hs)
    dt = np.gradient(ts) if len(ts) > 1 else np.ones_like(ts)
    vx, vy = np.gradient(xs) / np.maximum(dt, 1e-3), np.gradient(ys) / np.maximum(dt, 1e-3)
    speed_px = np.hypot(vx, vy)
    # Scale-free motion: box heights per second (stable when objects approach the camera and grow).
    # Real km/h needs the road homography (calibration step); never reported without it.
    # Approach/recede shows up as box growth, not translation, so add the log-scale rate.
    grow = np.gradient(np.log(np.maximum(hs, 1))) / np.maximum(dt, 1e-3)
    rel = np.hypot(speed_px / np.maximum(hs, 1), 2 * grow)
    heading = np.degrees(np.arctan2(vy, vx))
    for i, q in enumerate(p):
        q["speed_px_s"] = round(float(speed_px[i]), 1)
        q["rel_speed"] = round(float(rel[i]), 2)
        q["heading_deg"] = round(float(heading[i]), 1)


def ev(n, kind_rule, actor, action, t0, t1, frames, value, conf, rule):
    return {"id": f"EV-V-{n:03d}", "source": "cctv", "kind": kind_rule, "t": {"start": round(t0, 2), "end": round(t1, 2), "sigma": 0.1},
            "clock": "video", "actor": actor, "action": action, "value": value, "confidence": round(conf, 2),
            "ref": f"cctv.mp4#f={frames[0]}-{frames[1]}" if frames[0] != frames[1] else f"cctv.mp4#f={frames[0]}",
            "derived_from": [], "rule": rule}


def _riders(keep: dict) -> set:
    """Persons whose box mostly sits on a motorcycle/bicycle box are riders, not pedestrians."""
    by_f = defaultdict(list)
    for tid, tr in keep.items():
        if tr["cls"] in ("motorcycle", "bicycle"):
            for q in tr["points"]:
                by_f[q["f"]].append(q["box"])
    riders = set()
    for tid, tr in keep.items():
        if tr["cls"] != "person":
            continue
        hits = sum(any(iou(q["box"], b) > 0.15 for b in by_f.get(q["f"], [])) for q in tr["points"])
        if hits > 0.5 * len(tr["points"]):
            riders.add(tid)
    return riders


def events_from_tracks(tracks: dict, info: dict) -> list[dict]:
    out, n = [], 0
    dur, fps = info["duration"], info["fps"]
    # Low-confidence tracks (distant crowd, partial occlusion) jitter and produce fake motion; keep only solid ones.
    keep = {tid: tr for tid, tr in tracks.items() if len(tr["points"]) >= MIN_TRACK_FRAMES and tr["cls"] != "traffic_light"
            and np.mean([q["conf"] for q in tr["points"]]) >= MIN_EVENT_CONF}
    for tr in keep.values():
        kinematics(tr)
    riders = _riders(keep)
    for tid in riders:
        keep[tid]["rider"] = True
    MOVING = 0.6       # box heights per second
    for tid, tr in keep.items():
        if tid in riders:
            continue
        p, name = tr["points"], f"{tr['cls']}_{tid}"
        conf = float(np.mean([q["conf"] for q in p]))
        long_enough = p[-1]["t"] - p[0]["t"] >= 1.0
        rs = np.array([q["rel_speed"] for q in p])
        if long_enough and p[0]["t"] > 0.3:
            n += 1; out.append(ev(n, "OBSERVED", name, "enter", p[0]["t"], p[0]["t"], (p[0]["f"], p[0]["f"]), None, conf, "R_track_start"))
        if long_enough and p[-1]["t"] < dur - 0.3:
            n += 1; out.append(ev(n, "OBSERVED", name, "exit", p[-1]["t"], p[-1]["t"], (p[-1]["f"], p[-1]["f"]), None, conf, "R_track_end"))
        moving = np.where(rs > MOVING)[0]
        if len(moving) >= fps * 0.5:
            i = int(np.argmax(rs))
            n += 1; out.append(ev(n, "OBSERVED", name, "moving", p[moving[0]]["t"], p[moving[-1]]["t"], (p[moving[0]]["f"], p[moving[-1]]["f"]),
                                  f"peak {rs[i]:.1f} body-lengths/s (uncalibrated)", conf * 0.8, "R_rel_speed_gt_0.6"))
            w = max(2, int(0.6 * fps))
            for j in range(moving[0], len(rs) - w):
                if rs[j] > 1.5 and rs[j + w] < 0.4 * rs[j]:
                    n += 1; out.append(ev(n, "OBSERVED", name, "sudden_decel", p[j]["t"], p[j + w]["t"], (p[j]["f"], p[j + w]["f"]),
                                          f"{rs[j]:.1f} to {rs[j + w]:.1f} body-lengths/s", conf * 0.7, "R_decel_60pct_0.6s"))
                    break
            if moving[-1] < len(rs) - int(fps):
                j = moving[-1] + 1
                n += 1; out.append(ev(n, "OBSERVED", name, "stop", p[j]["t"], p[-1]["t"], (p[j]["f"], p[-1]["f"]), "stationary after moving",
                                      conf * 0.8, "R_rel_speed_below_0.6_1s"))
            hd = np.array([q["heading_deg"] for q in p])
            w = max(2, int(0.8 * fps))
            for j in range(len(hd) - w):
                if rs[j] > 1.0 and rs[j + w] > 1.0:
                    d = abs((hd[j + w] - hd[j] + 180) % 360 - 180)
                    if d > 40:
                        n += 1; out.append(ev(n, "OBSERVED", name, "swerve", p[j]["t"], p[j + w]["t"], (p[j]["f"], p[j + w]["f"]),
                                              f"heading change {d:.0f} deg", conf * 0.6, "R_heading_40deg_0.8s"))
                        break
        if tr["cls"] == "person":
            lying = [q for q in p if (q["box"][2] - q["box"][0]) > 1.1 * (q["box"][3] - q["box"][1])]
            if len(lying) >= fps * 0.5:
                n += 1; out.append(ev(n, "OBSERVED", name, "person_down", lying[0]["t"], lying[-1]["t"], (lying[0]["f"], lying[-1]["f"]),
                                      None, conf * 0.6, "R_box_wider_than_tall_0.5s"))
    # Possible impacts / near-misses: a fast-moving vehicle overlapping another road user (riders count via their bike).
    by_frame = defaultdict(list)
    for tid, tr in keep.items():
        if tid in riders:
            continue
        for q in tr["points"]:
            by_frame[q["f"]].append((tid, tr["cls"], q))
    cands = []
    for f, items in by_frame.items():
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                (a, ca, qa), (b, cb, qb) = items[i], items[j]
                o = iou(qa["box"], qb["box"])
                v = max(qa["rel_speed"] if ca in VEHICLES else 0, qb["rel_speed"] if cb in VEHICLES else 0)
                if o > 0.05 and v > 1.0:
                    cands.append((o * min(v, 4) / 4, f, qa["t"], f"{ca}_{a}", f"{cb}_{b}", o, v))
    seen = set()
    for score, f, t, a, b, o, v in sorted(cands, reverse=True):
        key = tuple(sorted((a, b)))
        if key in seen:
            continue
        seen.add(key)
        n += 1; out.append(ev(n, "INFERRED", a, "possible_contact", t, t, (f, f), f"with {b} (box overlap {o:.2f}, {v:.1f} body-lengths/s)",
                              min(0.9, 0.3 + score), "R_overlap_while_moving"))
        if len(seen) >= 3:
            break
    out.sort(key=lambda e: e["t"]["start"])
    return out


MODEL = str(Path(__file__).resolve().parents[2] / "yolo11s.pt")


def run(video: Path, out_dir: Path, model_name: str = MODEL, impact_label: float | None = None, progress=None) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    tracks, info = detect_and_track(video, model_name, out_dir / "annotated.mp4", progress)
    events = events_from_tracks(tracks, info)
    if impact_label is not None:
        events.append({"id": "EV-L-001", "source": "dataset_label", "kind": "CLAIMED", "t": {"start": impact_label, "end": impact_label, "sigma": 0.2},
                       "clock": "video", "actor": "unknown", "action": "impact", "value": "ACCIDENT benchmark annotation",
                       "confidence": 0.9, "ref": "metadata-real.csv", "derived_from": [], "rule": None})
    from collections import Counter
    mode = lambda xs: (Counter(x for x in xs if x).most_common(1) or [(None, 0)])[0][0]
    kept = {f"{tr['cls']}_{tid}": {"class": tr["cls"], "colour": mode(tr.get("colours", [])), "points": tr["points"]} for tid, tr in tracks.items()
            if len(tr["points"]) >= MIN_TRACK_FRAMES}
    (out_dir / "tracks.json").write_text(json.dumps({"video": info, "model": model_name, "tracker": "bytetrack", "tracks": kept}))
    (out_dir / "video_events.json").write_text(json.dumps(events, indent=2))
    return {"info": info, "tracks": len(kept), "events": len(events)}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("video", type=Path)
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--model", default=MODEL)
    ap.add_argument("--impact-label", type=float)
    a = ap.parse_args()
    print(run(a.video, a.out_dir, a.model, a.impact_label))
