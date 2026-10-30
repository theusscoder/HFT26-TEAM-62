"""Hit-and-run, computed from the case. Three questions, each answered only as far as the evidence goes:

  1. Who left?   Every involved vehicle's track after T0: stopped, or left the camera's view (rules, not the model).
  2. Which one?  Qwen vision reads the plate on the sharpest crops of that vehicle; reads are voted per character,
                 and a lone read stays a low-confidence candidate.
  3. Where to?   With the crash's coordinates: reachable toll windows from the exit speed, then a funnel over a
                 toll log. Plazas and log are FICTIONAL, seeded, and labelled so; the funnel counts are real counts
                 over that log. A result is always a candidate for authorised follow-up, never an identification.

CLI (from backend/): python -m app.pipeline.pursuit hero"""
import csv
import json
import math
import random
import re
import sys
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

import cv2
import numpy as np

from .. import llm

ROOT = Path(__file__).resolve().parents[3]
VEHICLE_CLASSES = ("car", "bus", "truck", "motorcycle", "bicycle")
STOPPED_KMH = 4.0
MOVING_KMH = 8.0
EDGE_FRACTION = 0.04
NEAR_IMPACT_M = 5.0
PLATE_FRAMES = 5
MIN_READS = 2
LOG_SIZE = 312
LOG_MINUTES = 30
LOG_START = datetime(2026, 1, 1, 14, 0, 0)
COLUMNS = ["time", "plaza", "plate", "class", "colour", "fastag"]
PLATE_RE = re.compile(r"^[A-Z]{2}\d{1,2}[A-Z?]{0,3}[\d?]{4}$")

PLATE_QUESTION = """This is a crop of one vehicle from road CCTV. Read its number plate if you can actually see one.
Answer ONLY with one JSON object: {"plate_visible": true|false, "text": "<characters exactly as seen, no spaces, ? for any you can't read, or null>"}
Do not guess. A plate you can't see is {"plate_visible": false, "text": null}."""


def _at(track: dict, t: float) -> dict:
    return min(track["points"], key=lambda p: abs(p["t"] - t))


def _direction(ui_track: dict, last_t: float) -> str | None:
    pts = [q for q in ui_track["points"] if last_t - 1.5 <= q["t"] <= last_t]
    if len(pts) < 2:
        return None
    dx, dy = pts[-1]["x"] - pts[0]["x"], pts[-1]["y"] - pts[0]["y"]
    if math.hypot(dx, dy) < 5:
        return None
    side = "right" if dx > 0 else "left"
    vert = "bottom" if dy > 0 else "top"
    return f"{vert} of the frame" if abs(dy) > 2 * abs(dx) else f"{side} of the frame" if abs(dx) > 2 * abs(dy) else f"{vert}-{side} of the frame"


def after_impact(track: dict, ui_track: dict | None, case: dict, impact: list[float]) -> dict:
    """What a track does after T0. Rules only; the wording stays with what the camera can show."""
    pts = [p for p in track["points"] if p["t"] >= 0]
    clip_end = case["range"][1]
    if not pts:
        return {"status": "not_seen_after", "label": "Not tracked after impact", "last_seen_t": track["points"][-1]["t"]}
    last = pts[-1]
    tail = [p for p in pts if p["t"] >= last["t"] - 1.0]
    v_tail = float(np.median([p["v_kmh"] for p in tail]))
    travelled = float(sum(math.hypot(b["x"] - a["x"], b["y"] - a["y"]) for a, b in zip(pts, pts[1:])))
    ended_early = clip_end - last["t"] > 0.6
    at_edge = False
    if ui_track:
        box = min(ui_track["points"], key=lambda q: abs(q["t"] - last["t"]))["box"]
        W, H = case["video"]["width"], case["video"]["height"]
        at_edge = box[0] < EDGE_FRACTION * W or box[2] > (1 - EDGE_FRACTION) * W or box[1] < EDGE_FRACTION * H or box[3] > (1 - EDGE_FRACTION) * H
    out = {"last_seen_t": round(last["t"], 2), "travelled_m": round(travelled, 1), "exit_speed_kmh": round(v_tail, 1),
           "from_impact_m": round(math.hypot(last["x"] - impact[0], last["y"] - impact[1]), 1), "at_frame_edge": at_edge,
           "direction": _direction(ui_track, last["t"]) if ui_track else None}
    if v_tail < STOPPED_KMH and not ended_early:
        # At rest = never again more than a metre from here. Summing the path would count tracker jitter as movement.
        stop = next((p for i, p in enumerate(pts) if all(math.hypot(q["x"] - p["x"], q["y"] - p["y"]) < 1.0 for q in pts[i:])), last)
        when = "Stopped at the impact" if stop["t"] < 0.3 else f"Came to rest {stop['t']:.1f} s after impact"
        return {**out, "status": "stopped", "label": f"{when} and stays in view", "stop_t": round(stop["t"], 2)}
    if ended_early and v_tail >= MOVING_KMH and (at_edge or travelled > 5):
        return {**out, "status": "left_view", "label": f"Left the camera's view at T+{last['t']:.1f} s, moving at about {v_tail:.0f} km/h"}
    if not ended_early and v_tail >= MOVING_KMH:
        if out["from_impact_m"] > 8:
            return {**out, "status": "left_view", "label": f"Still driving away when the clip ends, {out['from_impact_m']:.0f} m from the impact"}
        return {**out, "status": "moving", "label": f"Still moving at about {v_tail:.0f} km/h when the clip ends, close to the impact"}
    if ended_early and v_tail < STOPPED_KMH:
        return {**out, "status": "lost_at_rest", "label": f"Last seen at rest at T+{last['t']:.1f} s, then hidden or lost by the tracker"}
    return {**out, "status": "uncertain", "label": f"Tracker lost it at T+{last['t']:.1f} s; can't tell whether it stayed"}


def _frames_of(case_dir: Path, case: dict, ui_track: dict, n: int) -> list[dict]:
    """The sharpest large views of a vehicle, at least 0.4 s apart. Picked by rule, before any model sees them."""
    W, H = case["video"]["width"], case["video"]["height"]
    cap = cv2.VideoCapture(str(case_dir / "evidence" / "cctv.mp4"))
    fps, t0 = cap.get(cv2.CAP_PROP_FPS) or 25, case["t0_video_s"]
    ranked = sorted(ui_track["points"], key=lambda q: (q["box"][2] - q["box"][0]) * (q["box"][3] - q["box"][1]), reverse=True)[:40]
    scored = []
    for q in ranked[::2]:
        idx = int(round((q["t"] + t0) * fps))
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, img = cap.read()
        if not ok:
            continue
        x1, y1, x2, y2 = (int(v) for v in q["box"])
        pad = int(0.08 * max(x2 - x1, y2 - y1))
        crop = img[max(0, y1 - pad):min(H, y2 + pad), max(0, x1 - pad):min(W, x2 + pad)]
        if crop.size == 0:
            continue
        sharp = float(cv2.Laplacian(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var())
        scored.append({"t": q["t"], "frame": idx, "crop": crop, "score": sharp * crop.shape[0] * crop.shape[1]})
    cap.release()
    picked = []
    for s in sorted(scored, key=lambda s: -s["score"]):
        if all(abs(s["t"] - p["t"]) >= 0.4 for p in picked):
            picked.append(s)
        if len(picked) == n:
            break
    return picked


def vote(reads: list[str]) -> tuple[str | None, float]:
    """Per-character majority over reads of the commonest length. '?' where the reads don't agree."""
    clean = [r for r in reads if len(r) >= 4]
    if not clean:
        return None, 0.0
    length = Counter(len(r) for r in clean).most_common(1)[0][0]
    same = [r for r in clean if len(r) == length]
    out, shares = "", []
    for i in range(length):
        ch, n = Counter(r[i] for r in same if r[i] != "?").most_common(1)[0] if any(r[i] != "?" for r in same) else ("?", 0)
        share = n / len(same)
        out += ch if share >= 0.6 else "?"
        shares.append(share)
    # A plate read once is a candidate at best, however clear that one answer sounded.
    return out, round(float(np.mean(shares)) * min(1.0, len(same) / max(MIN_READS + 1, 1)), 2)


def read_plate(case_dir: Path, case: dict, ui_track: dict) -> dict:
    out_dir = case_dir / "keyframes"
    out_dir.mkdir(exist_ok=True)
    reads, frames, asked, errors = [], [], 0, []
    for i, s in enumerate(_frames_of(case_dir, case, ui_track, PLATE_FRAMES)):
        crop = s["crop"]
        if crop.shape[1] < 640:
            k = 640 / crop.shape[1]
            crop = cv2.resize(crop, None, fx=k, fy=k, interpolation=cv2.INTER_CUBIC)
        path = out_dir / f"plate_{ui_track['id']}_{i}.jpg"
        cv2.imwrite(str(path), crop, [cv2.IMWRITE_JPEG_QUALITY, 92])
        if i == 0:
            cv2.imwrite(str(out_dir / f"veh_{ui_track['id']}.jpg"), crop, [cv2.IMWRITE_JPEG_QUALITY, 88])
        asked += 1
        try:
            r = llm.chat_json([{"role": "user", "content": [{"type": "text", "text": PLATE_QUESTION}, llm.image_part(path)]}], model=llm.VISION_MODEL)
        except Exception as e:
            errors.append(str(e)[:80])
            continue
        text = re.sub(r"[^A-Z0-9?]", "", str(r["data"].get("text") or "").upper())
        if r["data"].get("plate_visible") and text:
            reads.append(text)
            frames.append(s["frame"])
    plate, conf = vote(reads)
    return {"track": ui_track["id"], "plate": plate, "confidence": conf, "reads": reads, "frames": frames, "asked": asked,
            "well_formed": bool(plate and PLATE_RE.match(plate)), "errors": errors[:1]}


# ---------- the toll trail (fictional data, real counts) ----------

def _plate_regex(partial: str) -> re.Pattern:
    return re.compile("^" + partial.replace(" ", "").replace("?", ".") + "$")


def _offset(lat: float, lon: float, km: float, bearing: float) -> tuple[float, float]:
    r = math.radians(bearing)
    return round(lat + km * math.cos(r) / 111.0, 4), round(lon + km * math.sin(r) / (111.0 * math.cos(math.radians(lat))), 4)


def make_plazas(case_id: str, lat: float, lon: float, speed: tuple[float, float]) -> list[dict]:
    rng = random.Random(case_id)
    plazas = []
    for name, (near, far) in zip("ABCD", [(1.5, 3), (3, 6), (6, 12), (15, 30)]):
        km = round(rng.uniform(near, far), 1)
        la, lo = _offset(lat, lon, km, rng.uniform(0, 360))
        plazas.append({"name": f"Demo Toll {name}", "lat": la, "lon": lo, "dist_km": km,
                       "window_min": [round(km / speed[1] * 60, 1), round(km / speed[0] * 60, 1)]})
    return plazas


def make_log(path: Path, seed: str, plazas: list[dict], target: dict) -> None:
    """A seeded fictional log: decoy traffic, plates that look like the target, and one planted passage."""
    rng = random.Random(seed)
    letters = "ABCDEFGHJKLMNPRSTUVWXYZ"
    rows = []
    for i in range(LOG_SIZE - 3):
        plate = f"ZZ{rng.randint(1, 38):02d}{rng.choice(letters)}{rng.choice(letters)}{rng.randint(1000, 9999)}"
        rows.append([LOG_START + timedelta(seconds=rng.randint(0, LOG_MINUTES * 60)), rng.choice(plazas)["name"], plate, rng.choice(["car", "truck", "bus", "motorcycle"]),
                     rng.choice(["white", "black", "red", "blue", "silver"]), f"DEMO-FT-{10000 + i}"])
    near = plazas[0]
    when = LOG_START + timedelta(minutes=sum(near["window_min"]) / 2)
    rows.append([when, near["name"], target["plate"], target["class"], target["colour"], "DEMO-FT-88213"])
    for n, (cls, colour, swap) in enumerate((("car", "white", "X"), ("truck", "red", "P")), start=1):
        look_alike = target["plate"][:5] + swap + target["plate"][6:]
        rows.append([when + timedelta(seconds=30 * n), near["name"], look_alike, cls, colour, f"DEMO-FT-9000{n}"])
    rows.sort(key=lambda r: r[0])
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(COLUMNS)
        w.writerows([[r[0].isoformat(), *r[1:]] for r in rows])


def trace(log_path: Path, plazas: list[dict], vehicle: dict, partial: str | None) -> dict:
    rows = list(csv.DictReader(log_path.open()))
    window = {t["name"]: t["window_min"] for t in plazas}

    def minutes(r):
        return (datetime.fromisoformat(r["time"]) - LOG_START).total_seconds() / 60

    in_window = [r for r in rows if r["plaza"] in window and window[r["plaza"]][0] <= minutes(r) <= window[r["plaza"]][1]]
    funnel = [{"stage": f"Toll passages in {LOG_MINUTES} min", "count": len(rows)}, {"stage": "Inside the reachable window", "count": len(in_window)}]
    kept = in_window
    if partial:
        rx = _plate_regex(partial)
        kept = [r for r in kept if rx.match(r["plate"])]
        funnel.append({"stage": f"Plate pattern {partial}", "count": len(kept)})
    kept = [r for r in kept if r["class"] == vehicle["class"] and (not vehicle.get("colour") or r["colour"] == vehicle["colour"])]
    funnel.append({"stage": f"{(vehicle.get('colour') or '').title()} {vehicle['class']}".strip(), "count": len(kept)})
    match = None
    if len(kept) == 1:
        r = kept[0]
        match = {"plate": r["plate"], "toll": r["plaza"], "time": f"{minutes(r):.1f} min after leaving", "fastag": r["fastag"], "status": "candidate_unverified"}
    return {"funnel": funnel, "match": match, "candidates": len(kept)}


def _trail(case_dir: Path, case: dict, leaver: dict, track: dict, plate: dict | None) -> dict:
    lat, lon = case.get("location", {}).get("lat"), case.get("location", {}).get("lon")
    v = leaver.get("exit_speed_kmh") or 30.0
    speed = (max(15.0, round(v * 0.6)), min(110.0, round(v * 2.2) + 20))
    trail = {"exit": {"t": leaver["last_seen_t"], "heading": leaver.get("direction") or "unknown", "speed_kmh": list(speed), "lat": lat, "lon": lon}}
    if lat is None or lon is None:
        return {**trail, "needs": "coordinates"}
    plazas = make_plazas(case["id"], lat, lon, speed)
    vehicle = {"class": track["class"], "colour": track.get("colour_name")}
    usable = plate["plate"] if plate and plate.get("plate") else None
    target = (usable or "ZZ00AA0000").replace("?", "0")
    if len(target) < 7:
        target = target.ljust(7, "0")
    log = case_dir / "toll_log_fictional.csv"
    make_log(log, case["id"], plazas, {"plate": target, "class": vehicle["class"], "colour": vehicle["colour"] or "white"})
    return {**trail, "tolls": plazas, "vehicle": vehicle, "partial_plate": usable, "fictional": True, **trace(log, plazas, vehicle, usable)}


def run(case_dir: Path, say=None) -> dict:
    say = say or (lambda *a: None)
    case = json.loads((case_dir / "case.json").read_text(encoding="utf-8"))
    if not (case_dir / "tracks_metric.json").exists():
        return _run_fixture(case_dir, case)
    metric = json.loads((case_dir / "tracks_metric.json").read_text())
    ui = json.loads((case_dir / "tracks_ui.json").read_text())
    ent = json.loads((case_dir / "entities.json").read_text())
    tracks = {t["id"]: t for t in metric["tracks"]}
    ui_tracks = {t["id"]: t for t in ui["tracks"]}
    names, impact = ent.get("names", {}), ent.get("impact_xy") or [0.0, 0.0]
    key = [i for i in [ent.get("primary"), *ent.get("involved", [])] if i in tracks and tracks[i]["class"] in VEHICLE_CLASSES]

    def row(tid: str, role: str) -> dict:
        tr, u = tracks[tid], ui_tracks.get(tid)
        return {"track": tid, "name": (names.get(tid) or tid).replace(" (primary)", ""), "role": role, "class": tr["class"], "colour": tr.get("colour_name"),
                "ref": f"tracks_metric:{tid}", "path": [[p["t"], p["x"], p["y"]] for p in tr["points"] if p["t"] >= -1.5][::2], **after_impact(tr, u, case, impact)}

    vehicles = [row(tid, "primary" if tid == ent.get("primary") else "involved") for tid in key]
    near = []
    for tid, tr in tracks.items():
        if tid in key or tr["class"] not in VEHICLE_CLASSES or not any(-0.5 <= p["t"] <= 0.5 for p in tr["points"]):
            continue
        p = _at(tr, 0)
        if math.hypot(p["x"] - impact[0], p["y"] - impact[1]) < NEAR_IMPACT_M:
            r = row(tid, "nearby")
            if r["status"] == "left_view":
                near.append(r)
    leavers = [v for v in vehicles if v["status"] == "left_view"]

    # Plates: everyone who left, and the primary (the emergency flow needs it too).
    to_read = list(dict.fromkeys([v["track"] for v in leavers] + [ent["primary"]] if ent.get("primary") else [v["track"] for v in leavers]))
    say("pursuit", "running", f"reading plates on {len(to_read)} vehicle(s)")
    read = {tid: read_plate(case_dir, case, ui_tracks[tid]) for tid in to_read if tid in ui_tracks}
    for v in vehicles:
        if v["track"] not in read and v["track"] in ui_tracks:  # a picture of it, without asking the model
            best = _frames_of(case_dir, case, ui_tracks[v["track"]], 1)
            if best:
                cv2.imwrite(str(case_dir / "keyframes" / f"veh_{v['track']}.jpg"), best[0]["crop"], [cv2.IMWRITE_JPEG_QUALITY, 88])
        v["thumb"] = f"veh_{v['track']}.jpg" if (case_dir / "keyframes" / f"veh_{v['track']}.jpg").exists() else None
        v["plate"] = read.get(v["track"])
    ran = any(r["reads"] or (r["asked"] and not r["errors"]) for r in read.values())
    readable = [r for r in read.values() if r["plate"]]
    plates = {"vehicles": sorted(readable, key=lambda r: -r["confidence"]), "checked": list(read), "model": llm.VISION_MODEL,
              "method": f"featherless:{llm.VISION_MODEL} on {sum(r['asked'] for r in read.values())} crops" if ran else "not run (vision model unavailable); crops saved for review"}
    (case_dir / "plates.json").write_text(json.dumps(plates, indent=2))

    if leavers:
        n = len(leavers)
        status, summary = "departed", f"{n} involved vehicle{'s' if n > 1 else ''} left the camera's view after impact. This doesn't establish why."
    elif any(v["status"] in ("uncertain", "not_seen_after", "moving") for v in vehicles):
        status, summary = "unclear", "No involved vehicle is seen driving away, but the tracker lost at least one, so this can't be ruled out."
    elif vehicles:
        hidden = [v["name"] for v in vehicles if v["status"] == "lost_at_rest"]
        status, summary = "stayed", "No involved vehicle is seen leaving, so this footage shows no hit-and-run." + (f" {', '.join(hidden)}: last seen at rest, then hidden from the camera." if hidden else "")
    else:
        status, summary = "unclear", "No vehicle could be identified as involved, so this can't be assessed."
    out = {"status": status, "summary": summary, "vehicles": vehicles, "nearby_left": near, "plates_method": plates["method"], "clip_end": case["range"][1]}
    if leavers:
        out.update(_trail(case_dir, case, leavers[0], tracks[leavers[0]["track"]], read.get(leavers[0]["track"])))
    (case_dir / "pursuit.json").write_text(json.dumps(out, indent=2))
    return out


def _run_fixture(case_dir: Path, case: dict) -> dict:
    """The synthetic demo case has no tracks, only a fixture for its exit, plazas and vehicle. Counts still come from the log."""
    path = case_dir / "pursuit.json"
    p = json.loads(path.read_text(encoding="utf-8"))
    vehicle = p.get("vehicle") or {"class": "car", "colour": "red"}
    log = case_dir / "toll_log_fictional.csv"
    make_log(log, case["id"], p["tolls"], {"plate": "TS07GK5521", "class": vehicle["class"], "colour": vehicle["colour"]})
    p.update(trace(log, p["tolls"], vehicle, p["partial_plate"]))
    p.update({"vehicle": vehicle, "fictional": True, "status": "departed", "summary": "Synthetic demo: car B leaves the junction after the collision."})
    path.write_text(json.dumps(p, indent=2))
    return p


if __name__ == "__main__":
    print(json.dumps(run(ROOT / "data" / "cases" / sys.argv[1]), indent=1)[:6000])
