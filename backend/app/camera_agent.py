"""The camera agent: watches the city's traffic cameras (data/cameras.json) and opens a case by itself when one of them
sees a crash. Officers can still add cases by hand; this is the automatic path.

For each camera, in turn:
  1. watch: read the feed (a stream URL, or a file that loops like one) at a few frames a second;
  2. screen: a YOLO detector on each sampled frame; an incident is two road users' boxes meeting and staying together
     (vehicle-vehicle, or a person with a vehicle), or, on a dashcam, the whole picture jolting;
  3. cut: the seconds around the incident are written to a clip (for a file feed, the file itself);
  4. open: a new case at the camera's location and time, the full pipeline (tracking, calibration, vision model,
     fusion, records, 3D), then the automatic response: police, ambulance, the certificate and the Telegram alerts.
Each camera clip / stream window is opened once. State and a log live in data/camera_agent.json."""
import hashlib
import json
import os
import shutil
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
CAMS = ROOT / "data" / "cameras.json"
STATE = ROOT / "data" / "camera_agent.json"
CASES = ROOT / "data" / "cases"
SAMPLE_FPS = 4.0
VEHICLES = {2: "car", 3: "motorcycle", 5: "bus", 7: "truck", 1: "bicycle"}
PERSON = 0
CONTACT_IOU = 0.08          # boxes overlapping this much...
CONTACT_FRAMES = 3          # ...for this many samples in a row
MIN_BOX_FRAC = 0.035        # both boxes at least this tall (fraction of the frame): near enough to judge contact
JOLT_RATIO = 3.2            # dashcam: frame change this many times the clip's median
STREAM_WINDOW_S = 60        # a live stream is screened in windows of this length
PAUSE_S = float(os.getenv("CAMERA_AGENT_PAUSE_S", "20"))

_lock = threading.Lock()
_run = {"thread": None, "stop": False, "current": None}
_model = None


def cameras() -> list[dict]:
    return json.loads(CAMS.read_text(encoding="utf-8")).get("cameras", []) if CAMS.exists() else []


def load_state() -> dict:
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except Exception:
        return {"seen": {}, "log": [], "cameras": {}}


def _save(st: dict):
    with _lock:
        st["log"] = st["log"][-200:]
        tmp = STATE.with_suffix(".tmp")
        tmp.write_text(json.dumps(st, indent=2), encoding="utf-8")
        os.replace(tmp, STATE)


def _log(st: dict, cam: str, text: str, **kw):
    st["log"].append({"time": datetime.now().astimezone().isoformat(timespec="seconds"), "camera": cam, "text": text, **kw})
    _save(st)


def _set(st: dict, cam: str, **kw):
    st.setdefault("cameras", {}).setdefault(cam, {}).update(kw)
    _save(st)


def _detector():
    global _model
    if _model is None:
        from ultralytics import YOLO
        _model = YOLO(os.getenv("CAMERA_AGENT_MODEL", "yolo11n.pt"))
    return _model


def _iou(a, b) -> float:
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-9)


def screen(frames: list[tuple[float, np.ndarray]], dashcam: bool) -> dict | None:
    """Look for a crash in sampled frames [(t, image)]. Returns {'t': when, 'why': what was seen, 'score'} or None."""
    if not frames:
        return None
    H = frames[0][1].shape[0]
    model = _detector()
    W = frames[0][1].shape[1]
    run, best = 0, None
    diffs, prev = [], None
    history: deque = deque(maxlen=int(SAMPLE_FPS) + 1)   # last second of detections, to tell moving from parked
    for t, img in frames:
        small = cv2.cvtColor(cv2.resize(img, (320, int(320 * img.shape[0] / img.shape[1]))), cv2.COLOR_BGR2GRAY)
        if prev is not None:
            diffs.append((t, float(np.mean(cv2.absdiff(small, prev)))))
        prev = small
        # class-agnostic: one object, one box (otherwise a bus detected as bus and truck "collides" with itself)
        r = model.predict(img, conf=0.3, classes=[PERSON, *VEHICLES], agnostic_nms=True, verbose=False)[0]
        boxes = [(int(c), b) for b, c in zip(r.boxes.xyxy.tolist(), r.boxes.cls.tolist())]
        near = [(c, b) for c, b in boxes if (b[3] - b[1]) / H > MIN_BOX_FRAC]

        def moved(b):   # did this box come from somewhere else a second ago?
            if len(history) < history.maxlen:
                return True
            old = max(history[0], key=lambda ob: _iou(ob, b), default=None)
            if old is None or _iou(old, b) < 0.05:
                return True
            return np.hypot((old[0] + old[2] - b[0] - b[2]) / 2, (old[1] + old[3] - b[1] - b[3]) / 2) > 0.03 * W

        hit = None
        for i, (ca, a) in enumerate(near):
            for cb, b in near[i + 1:]:
                if ca == PERSON and cb == PERSON:
                    continue
                if PERSON in (ca, cb) and {ca, cb} & {3, 1}:   # a rider on their own motorcycle or bicycle
                    continue
                if ca in VEHICLES or cb in VEHICLES:
                    o = _iou(a, b)
                    gap = max(0.0, max(a[0] - b[2], b[0] - a[2])) + max(0.0, max(a[1] - b[3], b[1] - a[3]))
                    touching = o > CONTACT_IOU or gap < 0.01 * H
                    if touching and o < 0.6 and (moved(a) or moved(b)):
                        s = max(o, 0.05)
                        if hit is None or s > hit[0]:
                            hit = (s, ca, cb)
        history.append([b for _, b in near])
        run = run + 1 if hit else 0
        if hit and run >= CONTACT_FRAMES and (best is None or hit[0] > best["score"]):
            names = [("person" if c == PERSON else VEHICLES[c]) for c in hit[1:]]
            best = {"t": t, "why": f"{names[0]} and {names[1]} boxes meeting for {run} frames", "score": round(hit[0], 3)}
    if dashcam and len(diffs) > 8:
        med = float(np.median([d for _, d in diffs])) or 1.0
        t, peak = max(diffs, key=lambda x: x[1])
        if peak / med > JOLT_RATIO and (best is None or best["score"] < 0.2):
            best = {"t": t, "why": f"camera jolt {peak / med:.1f}x the clip's normal motion", "score": round(peak / med / 10, 3)}
    return best


def _frames_from_file(path: Path) -> tuple[list[tuple[float, np.ndarray]], float]:
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    step, out, f = max(1, round(fps / SAMPLE_FPS)), [], 0
    while True:
        ok = cap.grab()
        if not ok:
            break
        if f % step == 0:
            ok, img = cap.retrieve()
            if ok:
                out.append((f / fps, img))
        f += 1
    cap.release()
    return out, f / fps


def _record_stream(url: str, seconds: float, out_path: Path) -> list[tuple[float, np.ndarray]]:
    """Read a live stream for a window, keep sampled frames, and write the whole window to a clip."""
    cap = cv2.VideoCapture(url)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    w, h = int(cap.get(3)) or 1280, int(cap.get(4)) or 720
    vw = cv2.VideoWriter(str(out_path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    step, sampled, f, t0 = max(1, round(fps / SAMPLE_FPS)), [], 0, time.time()
    while time.time() - t0 < seconds and not _run["stop"]:
        ok, img = cap.read()
        if not ok:
            break
        vw.write(img)
        if f % step == 0:
            sampled.append((f / fps, img))
        f += 1
    cap.release()
    vw.release()
    return sampled


def _open_case(cam: dict, clip: Path, hit: dict) -> str:
    """A new case at the camera's place and time, run end to end, then the automatic response."""
    from . import emergency, make_case, records
    from .custody import Ledger, sha256_file
    stamp = datetime.now().strftime("%H%M%S")
    cid = f"{cam['id'].lower()}-{stamp}"
    d = CASES / cid
    (d / "evidence").mkdir(parents=True)
    dst = d / "evidence" / "upload.mp4"
    shutil.copy(clip, dst)
    Ledger(d / "custody.jsonl").append("evidence_received", file=f"{cam['id']} feed", stored=dst.name, sha256=sha256_file(dst), source="camera agent", detection=hit)
    now = datetime.now(timezone.utc)
    (d / "case.json").write_text(json.dumps({"id": cid, "title": f"Collision at {cam['name']}", "location": {"name": f"{cam['name']}, Hyderabad", "lat": cam["lat"], "lon": cam["lon"]},
                                             "incident_time_utc": now.isoformat(), "source": {"kind": "camera agent", "camera": cam["id"], "detection": hit}}, indent=2))
    if cam.get("camera") == "dashcam":
        (d / "case_hint.json").write_text(json.dumps({"camera": "dashcam", "ego_class": cam.get("ego_class", "car")}))
    try:
        from . import context
        fac = context.facilities_local(cam["lat"], cam["lon"])
        if fac:
            (d / "facilities.json").write_text(json.dumps(fac, indent=2))
    except Exception:
        pass
    def progress(stage, status, detail=""):
        st = load_state()
        _set(st, cam["id"], status="analysing", detail=f"{stage}: {detail or status}", case_pending=cid)
    make_case.make(cid, dst, f"Collision at {cam['name']}", f"{cam['name']}, Hyderabad", progress=progress)
    case = json.loads((d / "case.json").read_text())
    ent = json.loads((d / "entities.json").read_text()) if (d / "entities.json").exists() else {}
    names = ent.get("names", {})
    who = [names.get(i, i).replace(" (primary)", "") for i in [ent.get("primary"), *ent.get("involved", [])] if i][:2]
    case["title"] = (f"{who[0]} and {who[1].lower()} collide at {cam['name']}" if len(who) == 2 else f"{who[0]} crash at {cam['name']}" if who else case["title"])
    case["source"] = {"kind": "camera agent", "camera": cam["id"], "detection": hit}
    (d / "case.json").write_text(json.dumps(case, indent=2))
    records.build(d)
    emergency.auto_trigger(d)   # police, ambulance, certificate, Telegram
    return cid


def scan(cam: dict) -> str | None:
    """Watch one camera once. Returns the new case id, if it opened one."""
    st = load_state()
    src = cam["source"]
    is_url = "://" in src
    _set(st, cam["id"], status="watching", since=time.time())
    try:
        if is_url:
            tmp = ROOT / "data" / "camera_clips"
            tmp.mkdir(exist_ok=True)
            clip = tmp / f"{cam['id']}-{datetime.now().strftime('%H%M%S')}.mp4"
            frames = _record_stream(src, STREAM_WINDOW_S, clip)
            key = f"{cam['id']}:{int(time.time() // STREAM_WINDOW_S)}"
        else:
            clip = ROOT / src
            if not clip.exists():
                _set(st, cam["id"], status="offline", detail="feed unavailable")
                return None
            key = f"{cam['id']}:{hashlib.sha256(clip.read_bytes()).hexdigest()[:16]}"
            if key in st["seen"]:
                _set(st, cam["id"], status="watching", detail="no new incident", last_scan=time.time(), case=st["seen"][key].get("case"))
                return None
            frames, _ = _frames_from_file(clip)
        _set(st, cam["id"], status="screening", detail=f"{len(frames)} frames through the detector")
        hit = screen(frames, cam.get("camera") == "dashcam")
        if not hit:
            st["seen"][key] = {"case": None, "time": time.time()}
            _set(st, cam["id"], status="watching", detail="no incident", last_scan=time.time())
            return None
        _log(st, cam["id"], f"Incident detected at {cam['name']}: {hit['why']} (T={hit['t']:.1f} s). Opening a case.", kind="detected")
        _set(st, cam["id"], status="analysing", detail=hit["why"])
        cid = _open_case(cam, clip, hit)
        st = load_state()
        st["seen"][key] = {"case": cid, "time": time.time()}
        em = json.loads((CASES / cid / "emergency.json").read_text()) if (CASES / cid / "emergency.json").exists() else {}
        units = ", ".join(x["name"].lower() for x in (em.get("auto") or {}).get("dispatched", [])) or "police informed; no units needed for this severity"
        tg = em.get("telegram") or []
        sent = [x["role"] for x in tg if x.get("status") == "sent"]
        tg_txt = f"Telegram sent to {', '.join(sent)}" if sent else "Telegram alerts prepared (connect the bot to deliver them)"
        _log(st, cam["id"], f"Case {cid} opened and analysed. Dispatched automatically: {units}. {tg_txt}.", kind="case", case=cid)
        _set(st, cam["id"], status="watching", detail="incident handled", case=cid, last_scan=time.time())
        return cid
    except Exception as e:
        st = load_state()
        _log(st, cam["id"], f"Error on {cam['name']}: {type(e).__name__}: {e}"[:300], kind="error")
        _set(st, cam["id"], status="error", detail=str(e)[:160])
        return None


def _loop():
    while not _run["stop"]:
        for cam in cameras():
            if _run["stop"]:
                break
            _run["current"] = cam["id"]
            scan(cam)
            time.sleep(PAUSE_S)
        _run["current"] = None
        time.sleep(PAUSE_S)


def _clean_partial():
    """A restart mid-analysis leaves a half-built case. Only the agent's own, only with no analysis; its feed is rescanned."""
    for d in CASES.glob("*"):
        try:
            src = (json.loads((d / "case.json").read_text(encoding="utf-8")).get("source") or {}) if (d / "case.json").exists() else {}
        except ValueError:
            continue
        if src.get("kind") == "camera agent" and not (d / "records.json").exists():
            shutil.rmtree(d, ignore_errors=True)


def start():
    if os.getenv("CAMERA_AGENT", "on") == "off" or os.getenv("PYTEST_CURRENT_TEST") or "pytest" in os.getenv("_", "") \
            or (_run["thread"] and _run["thread"].is_alive()):
        return
    _clean_partial()
    _run["stop"] = False
    _run["thread"] = threading.Thread(target=_loop, daemon=True, name="camera-agent")
    _run["thread"].start()


def stop():
    _run["stop"] = True


def status() -> dict:
    st = load_state()
    cams = []
    for c in cameras():
        s = (st.get("cameras") or {}).get(c["id"], {})
        cams.append({**{k: c[k] for k in ("id", "name", "lat", "lon", "camera")}, "live": "://" in c["source"], **s})
    return {"running": bool(_run["thread"] and _run["thread"].is_alive()), "current": _run["current"], "cameras": cams,
            "log": list(reversed(st.get("log", [])))[:60]}


def frame_stream(cam_id: str):
    """MJPEG of a camera's feed (file feeds loop), for the camera wall."""
    cam = next((c for c in cameras() if c["id"] == cam_id), None)
    if not cam:
        return
    src = cam["source"] if "://" in cam["source"] else str(ROOT / cam["source"])
    cap = cv2.VideoCapture(src)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    step = max(1, round(fps / 10))
    f = 0
    try:
        while True:
            ok, img = cap.read()
            if not ok:
                cap.release()
                cap = cv2.VideoCapture(src)
                continue
            f += 1
            if f % step:
                continue
            img = cv2.resize(img, (640, int(640 * img.shape[0] / img.shape[1])))
            stamp = datetime.now().strftime("%d-%m-%Y %H:%M:%S")
            cv2.putText(img, f"{cam['id']}  {stamp}", (10, img.shape[0] - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
            ok, jpg = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 70])
            yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpg.tobytes() + b"\r\n"
            time.sleep(1 / 10)
    finally:
        cap.release()
