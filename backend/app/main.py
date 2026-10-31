"""YATHARTH API. Single FastAPI process; cases live in data/cases/<id>/ as JSON files.
Run: uvicorn app.main:app --reload --port 8000   (from backend/)"""
import asyncio
import json
import re
import shutil
import subprocess
import threading
import traceback
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import alerts, ask as ask_mod, extras, faces, llm, make_case, physics, severity, toll_db
from .pipeline.witness import AUDIO_SUFFIXES
from .response_api import router as response_router  # A2 plates + A3 alerts
from .custody import Ledger, sha256_file

DATA = Path(__file__).resolve().parents[2] / "data" / "cases"
ARTIFACTS = ["case", "events", "tracks", "tracks_ui", "tracks_metric", "calibration", "entities", "witnesses",
             "witness_extractions", "ground_truth", "vision", "analysis", "severity", "plates", "pursuit", "facilities", "scene3d", "insights", "dashcam", "records"]

app = FastAPI(title="YATHARTH")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(response_router)


@app.on_event("startup")
def _start_telegram_linker():  # lets case contacts link their phone to the bot while the demo runs
    from . import camera_agent, telegram_bot
    telegram_bot.start()
    from . import response_timeline
    response_timeline.start()   # sends each response milestone (FIR, hospital accepted, arrived...) on Telegram as it comes due
    camera_agent.start()   # watches the traffic cameras and opens cases by itself (CAMERA_AGENT=off to disable)


def case_dir(cid: str) -> Path:
    d = DATA / cid
    if not extras.SAFE_ID.match(cid) or not d.is_dir():
        raise HTTPException(404, f"case {cid} not found")
    return d


def read(cid: str, name: str):
    p = case_dir(cid) / f"{name}.json"
    if not p.exists():
        raise HTTPException(404, f"{name}.json missing for {cid}")
    return json.loads(p.read_text(encoding="utf-8"))


@app.get("/api/llm/health")
def llm_health():
    return llm.health()


class Calibration(BaseModel):
    img_pts: list[list[float]]
    world_pts: list[list[float]]
    scale_sigma: float = 0.15
    note: str = ""
    features: dict = {}


@app.post("/api/cases/{cid}/calibration")
def set_calibration(cid: str, body: Calibration):
    """Save a new road calibration and recompute everything downstream of it (metric tracks, fusion, severity)."""
    d = case_dir(cid)
    if len(body.img_pts) < 4 or len(body.img_pts) != len(body.world_pts):
        raise HTTPException(400, "need >= 4 matching image/world points")
    (d / "calibration.json").write_text(json.dumps(body.model_dump(), indent=2))
    Ledger(d / "custody.jsonl").append("calibration_updated", points=len(body.img_pts))
    return make_case.make(cid)


@app.get("/api/cases/{cid}/toll-match")
def toll_match(cid: str):
    return toll_db.search(toll_db.plates_of(case_dir(cid)))


class TollNotify(BaseModel):
    capture_id: str
    officer: str = Field(min_length=1)
    authority: str
    reviewed: bool


@app.post("/api/cases/{cid}/toll-match/notify")
def toll_notify(cid: str, body: TollNotify):
    """Only a named officer who has confirmed the review can send this, and only for a capture this case's plates found."""
    d = case_dir(cid)
    if not body.reviewed or not body.officer.strip():
        raise HTTPException(422, "a named officer must confirm the review first")
    if body.authority not in toll_db.AUTHORITIES:
        raise HTTPException(422, "unknown authority")
    found = toll_db.search(toll_db.plates_of(d))["matches"]
    capture = next((m for m in found if m["id"] == body.capture_id), None)
    if not capture:
        raise HTTPException(404, "that capture isn't a match for this case")
    res = toll_db.notify(cid, capture, body.officer.strip(), body.authority)
    Ledger(d / "custody.jsonl").append("authority_notified", capture=capture["id"], plate=capture["plate"], authority=body.authority, officer=body.officer.strip(), status=res["status"])
    return res


@app.get("/api/toll-images/{name}")
def toll_image(name: str):
    p = toll_db.IMAGES / Path(name).name
    portrait = toll_db.FICTIONAL / "portraits" / Path(name).name   # AI-generated faces of people who don't exist
    if portrait.exists():
        return FileResponse(portrait)
    # a generated face (or a consented team photo) dropped into data/fictional/faces replaces the drawn placeholder
    real = next((q for q in (toll_db.FICTIONAL / "faces" / (p.stem + e) for e in (".jpg", ".png")) if q.exists()), None)
    if real:
        return FileResponse(real)
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type="image/svg+xml" if p.suffix == ".svg" else None)


@app.post("/api/toll-captures/{capture_id}/photo")
async def toll_photo(capture_id: str, photo: UploadFile, consent: bool = Form(False)):
    """Replace a placeholder with a real booth photo, for the demo, only of someone who agreed to it."""
    if not consent:
        raise HTTPException(422, "only a photo of someone who agreed to be in the demo")
    records = toll_db.load()
    rec = next((r for r in records if r["id"] == capture_id), None)
    ext = Path(photo.filename or "").suffix.lower()
    if rec is None or ext not in (".jpg", ".jpeg", ".png", ".webp"):
        raise HTTPException(404 if rec is None else 422, "unknown record" if rec is None else "use a .jpg, .png or .webp photo")
    name = f"{capture_id}{ext}"
    (toll_db.IMAGES / name).write_bytes(await photo.read())
    rec["driver_image"], rec["consented_photo"] = name, True
    toll_db.DB.write_text(json.dumps(records, indent=2), encoding="utf-8")
    return rec


@app.get("/api/cases/{cid}/faces")
def case_faces(cid: str):
    d = case_dir(cid)
    if not faces.sources(d):
        return {"faces": [], "usable": 0, "frames_scanned": 0, "note": "This case has no footage."}
    p = d / "faces.json"
    return json.loads(p.read_text()) if p.exists() else faces.scan(d)


@app.post("/api/cases/{cid}/faces/compare")
async def faces_compare(cid: str, photo: UploadFile, consent: bool = Form(False)):
    """One photo, of someone who agreed to it, against the faces in this case's footage. Nothing is stored or searched beyond this case."""
    if not consent:
        raise HTTPException(422, "only a photo of someone who agreed to it")
    d = case_dir(cid)
    if not faces.sources(d):
        return {"status": "not_comparable", "reason": "This case has no footage yet. Add a frame or clip where the face is visible."}
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / f"photo{Path(photo.filename or 'x.jpg').suffix.lower() or '.jpg'}"
        p.write_bytes(await photo.read())
        res = faces.compare(d, p)
    Ledger(d / "custody.jsonl").append("face_check", source="uploaded consented photo", status=res["status"], similarity=(res.get("best") or {}).get("similarity"))
    return res


@app.post("/api/cases/{cid}/faces/evidence")
async def face_evidence(cid: str, file: UploadFile):
    """Another view of the scene where faces are visible: hashed into the custody ledger, then scanned with the rest."""
    d = case_dir(cid)
    ext = Path(file.filename or "").suffix.lower()
    if ext not in faces.IMAGE_EXT + faces.VIDEO_EXT:
        raise HTTPException(422, "use an image or a video")
    n = len(list((d / "evidence").glob("face_source_*"))) + 1
    dest = d / "evidence" / f"face_source_{n}{ext}"
    dest.write_bytes(await file.read())
    Ledger(d / "custody.jsonl").append("evidence_registered", file=dest.name, original=Path(file.filename or "").name, sha256=sha256_file(dest))
    return faces.scan(d)


@app.get("/api/cases/{cid}/faces/{name}")
def face_crop(cid: str, name: str):
    p = case_dir(cid) / "faces" / Path(name).name
    if not p.exists() or p.suffix != ".jpg":
        raise HTTPException(404)
    return FileResponse(p)


@app.post("/api/cases/{cid}/toll-match/{capture_id}/face-check")
def face_check(cid: str, capture_id: str):
    """One to one: the booth photo of a record this case's plate found, against the faces in this case's footage."""
    d = case_dir(cid)
    capture = next((m for m in toll_db.search(toll_db.plates_of(d))["matches"] if m["id"] == capture_id), None)
    if not capture:
        raise HTTPException(404, "that record isn't a plate match for this case")
    if not (d / "evidence" / "cctv.mp4").exists():
        return {"status": "not_comparable", "reason": "This case has no footage to take a face from."}
    res = faces.compare(d, toll_db.IMAGES / capture["driver_image"])
    Ledger(d / "custody.jsonl").append("face_check", capture=capture_id, status=res["status"], similarity=(res.get("best") or {}).get("similarity"))
    return res


class AskReq(BaseModel):
    question: str


@app.post("/api/cases/{cid}/ask")
def ask(cid: str, body: AskReq):
    return ask_mod.ask(case_dir(cid), body.question)


@app.post("/api/cases/{cid}/rebuild")
def rebuild(cid: str):
    case_dir(cid)
    return make_case.make(cid)


@app.get("/api/cases")
def list_cases():
    out = []
    for d in sorted(DATA.iterdir(), key=lambda d: d.stat().st_mtime, reverse=True):
        if (d / "case.json").exists():
            c = json.loads((d / "case.json").read_text(encoding="utf-8"))
            c["status"] = JOBS.get(d.name, {}).get("status", "done")
            out.append(c)
        elif d.name in JOBS:
            out.append({"id": d.name, "title": d.name, "location": {"name": ""}, "status": JOBS[d.name]["status"]})
    return out


# ---------------- new case: upload any video (+ optional witnesses, sensor log, metadata) ----------------
JOBS: dict[str, dict] = {}
VIDEO_EXT = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:32]
    return s or "case"


def _run_job(cid: str, video_path: Path, title: str, location: str, simulate_sensor: bool):
    job = JOBS[cid]
    def progress(stage, status, detail=""):
        job["stages"][stage] = {"status": status, "detail": detail}
    try:
        job["report"] = make_case.make(cid, video_path, title, location, simulate_sensor=simulate_sensor, progress=progress)
        job["status"] = "done"
    except Exception as e:  # surfaced to the browser, never swallowed
        job["status"], job["error"] = "error", f"{type(e).__name__}: {e}"
        job["trace"] = traceback.format_exc()[-1500:]


@app.post("/api/cases")
async def create_case(video: UploadFile, witnesses: list[UploadFile] = File(default=[]), sensor: UploadFile | None = None,
                      meta: list[UploadFile] = File(default=[]), title: str = Form(""), location: str = Form(""),
                      simulate_sensor: bool = Form(False)):
    """Create a case from an uploaded clip and start the full pipeline in the background.
    witnesses: .txt statements or voice notes; sensor: telematics .csv; meta: witnesses.json / ground_truth.json (demo kits)."""
    ext = Path(video.filename or "").suffix.lower()
    if ext not in VIDEO_EXT:
        raise HTTPException(400, f"unsupported video type {ext or '?'}; use {', '.join(sorted(VIDEO_EXT))}")
    cid = f"{_slug(title or Path(video.filename).stem)}-{datetime.now().strftime('%H%M%S')}"
    d = DATA / cid
    ev = d / "evidence"
    ev.mkdir(parents=True)
    led = Ledger(d / "custody.jsonl")
    vpath = ev / f"upload{ext}"
    vpath.write_bytes(await video.read())
    led.append("evidence_received", file=video.filename, stored=vpath.name, sha256=sha256_file(vpath))
    for i, w in enumerate(witnesses, 1):
        if not w.filename:
            continue
        suffix = Path(w.filename).suffix.lower()
        dst = ev / f"witness_{i}{suffix if suffix in AUDIO_SUFFIXES else '.txt'}"
        dst.write_bytes(await w.read())
        led.append("evidence_received", file=w.filename, stored=dst.name, sha256=sha256_file(dst))
    if sensor is not None and sensor.filename:
        dst = ev / "sensor.csv"
        dst.write_bytes(await sensor.read())
        led.append("evidence_received", file=sensor.filename, stored=dst.name, sha256=sha256_file(dst))
    for m in meta:
        if m.filename in ("witnesses.json", "ground_truth.json"):
            (d / m.filename).write_bytes(await m.read())
    return {"id": _start(cid, vpath, title or Path(video.filename).stem, location, simulate_sensor)}


def _start(cid: str, vpath: Path, title: str, location: str, simulate_sensor: bool) -> str:
    """Normalise the clip to H.264 MP4 if needed and launch the pipeline thread."""
    if vpath.suffix.lower() != ".mp4":
        mp4 = vpath.with_name("upload.mp4")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(vpath), "-c:v", "libx264", "-pix_fmt", "yuv420p", str(mp4)], check=True)
        vpath = mp4
    JOBS[cid] = {"status": "running", "stages": {s: {"status": "pending", "detail": ""} for s in make_case.STAGES}, "report": None}
    threading.Thread(target=_run_job, args=(cid, vpath, title, location, simulate_sensor), daemon=True).start()
    return cid


# ---------------- demo kits: ready-made evidence sets in demo_kits/<name>/ ----------------
KITS = Path(__file__).resolve().parents[2] / "demo_kits"


def _kit_info(d: Path) -> dict:
    meta = {}
    if (d / "kit.json").exists():
        meta = json.loads((d / "kit.json").read_text(encoding="utf-8"))
    video = next((f.name for f in sorted(d.iterdir()) if f.suffix.lower() in VIDEO_EXT), None)
    return {"name": d.name, "title": meta.get("title", d.name), "summary": meta.get("summary", ""), "location": meta.get("location", ""),
            "camera": meta.get("camera", "cctv"), "ego_class": meta.get("ego_class"),
            "video": video, "witnesses": sorted(f.name for f in d.glob("witness_*.txt")),
            "sensor": (d / "sensor.csv").exists(), "ground_truth": (d / "ground_truth.json").exists()}


@app.get("/api/kits")
def list_kits():
    return [_kit_info(d) for d in sorted(KITS.iterdir()) if d.is_dir()] if KITS.exists() else []


@app.get("/api/kits/{name}/file/{fname}")
def kit_file(name: str, fname: str):
    p = KITS / Path(name).name / Path(fname).name
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p)


@app.post("/api/cases/{cid}/dashcam")
async def add_dashcam(cid: str, video: UploadFile, ego_class: str = Form("car")):
    """A dashcam clip of this crash: analysed as its own linked case (camera forced to dashcam), and linked from this one."""
    d = case_dir(cid)
    ext = Path(video.filename or "").suffix.lower()
    if ext not in VIDEO_EXT:
        raise HTTPException(400, f"unsupported video type {ext or '?'}")
    if ego_class not in ("car", "motorcycle", "bus", "truck"):
        raise HTTPException(422, "unknown camera vehicle")
    sub = f"{cid[:40]}-dashcam-{datetime.now().strftime('%H%M%S')}"
    sd = DATA / sub
    (sd / "evidence").mkdir(parents=True)
    vpath = sd / "evidence" / f"upload{ext}"
    vpath.write_bytes(await video.read())
    digest = sha256_file(vpath)
    Ledger(sd / "custody.jsonl").append("evidence_received", file=video.filename, stored=vpath.name, sha256=digest, linked_to=cid)
    Ledger(d / "custody.jsonl").append("dashcam_linked", file=video.filename, sha256=digest, case=sub)
    (sd / "case_hint.json").write_text(json.dumps({"camera": "dashcam", "ego_class": ego_class, "location": read(cid, "case").get("location")}))
    case = read(cid, "case")
    case["dashcam_case"] = sub
    (d / "case.json").write_text(json.dumps(case, indent=2), encoding="utf-8")
    title = f"Dashcam of: {case.get('title', cid)}"
    return {"id": _start(sub, vpath, title, case.get("location", {}).get("name", ""), False), "linked_to": cid}


@app.post("/api/kits/{name}/run")
def run_kit(name: str):
    """One click: create a new case from a demo kit's files exactly as an upload would, and start the pipeline."""
    k = KITS / Path(name).name
    if not k.is_dir():
        raise HTTPException(404, "no such kit")
    info = _kit_info(k)
    if not info["video"]:
        raise HTTPException(400, "kit has no video")
    cid = f"{_slug(info['title'])}-{datetime.now().strftime('%H%M%S')}"
    d = DATA / cid
    ev = d / "evidence"
    ev.mkdir(parents=True)
    led = Ledger(d / "custody.jsonl")
    vpath = ev / f"upload{Path(info['video']).suffix.lower()}"
    shutil.copy(k / info["video"], vpath)
    led.append("evidence_received", file=info["video"], stored=vpath.name, sha256=sha256_file(vpath), via=f"demo kit {name}")
    for i, w in enumerate(info["witnesses"], 1):
        shutil.copy(k / w, ev / f"witness_{i}.txt")
        led.append("evidence_received", file=w, stored=f"witness_{i}.txt", sha256=sha256_file(ev / f"witness_{i}.txt"))
    if info["sensor"]:
        shutil.copy(k / "sensor.csv", ev / "sensor.csv")
        led.append("evidence_received", file="sensor.csv", stored="sensor.csv", sha256=sha256_file(ev / "sensor.csv"))
    for m in ("witnesses.json", "ground_truth.json"):
        if (k / m).exists():
            shutil.copy(k / m, d / m)
    if info.get("ego_class"):   # camera type is still auto-detected; the kit only names the vehicle the camera is in
        (d / "case_hint.json").write_text(json.dumps({"ego_class": info["ego_class"]}))
    return {"id": _start(cid, vpath, info["title"], info["location"], False)}


@app.get("/api/jobs/{cid}")
def job(cid: str):
    if cid not in JOBS:
        raise HTTPException(404, "no running job")
    return JOBS[cid]


@app.websocket("/ws/cases/{cid}/run")
async def run(ws: WebSocket, cid: str):
    """Streams the real pipeline's stage status for a case created via POST /api/cases."""
    await ws.accept()
    last = None
    while True:
        j = JOBS.get(cid)
        if j is None:
            await ws.send_json({"status": "unknown"})
            break
        snap = json.dumps(j, default=str)
        if snap != last:
            await ws.send_text(snap)
            last = snap
        if j["status"] != "running":
            break
        await asyncio.sleep(0.5)
    await ws.close()


@app.post("/api/cases/{cid}/evidence")
async def upload(cid: str, file: UploadFile):
    d = case_dir(cid) / "evidence"
    d.mkdir(parents=True, exist_ok=True)
    dest = d / Path(file.filename).name
    dest.write_bytes(await file.read())
    digest = sha256_file(dest)
    Ledger(case_dir(cid) / "custody.jsonl").append("evidence_registered", file=dest.name, sha256=digest)
    return {"file": dest.name, "sha256": digest}


@app.get("/api/cases/{cid}/custody")
def custody(cid: str):
    led = Ledger(case_dir(cid) / "custody.jsonl")
    return {"verify": led.verify(), "entries": led.entries()}


class Counterfactual(BaseModel):
    speed_kmh: float
    hazard_at_m: float | None = None
    reaction_s: float = 1.0
    mu: float | None = None


@app.post("/api/cases/{cid}/counterfactual")
def counterfactual(cid: str, body: Counterfactual):
    cf = read(cid, "analysis")["counterfactual"]
    # Friction defaults to what the weather says, when that's known.
    mu = body.mu if body.mu is not None else (read(cid, "case").get("weather") or {}).get("mu", physics.MU_DRY)
    return physics.ghost_trajectory(body.speed_kmh, body.hazard_at_m or cf["hazard_at_m"],
                                    cf["brake_start_s"], body.reaction_s, mu)


@app.post("/api/severity/score")
def score_severity(signals: dict):
    return severity.score(signals)


class AlertReq(BaseModel):
    plate: str
    text: str


@app.post("/api/cases/{cid}/alert")
def alert(cid: str, body: AlertReq):
    res = alerts.send(body.plate, body.text)
    Ledger(case_dir(cid) / "custody.jsonl").append("alert", plate=body.plate, status=res["status"])
    return res


@app.get("/api/registry/{plate}")
def registry(plate: str):
    rec = alerts.lookup(plate)
    if not rec:
        raise HTTPException(404, "not in demo registry")
    return {k: v for k, v in rec.items() if k != "telegram_chat_id"}


# Added routes go before the generic artifact route, which would otherwise shadow them.
app.include_router(extras.router)


# Generic artifact route last so it does not shadow /custody etc.
@app.get("/api/cases/{cid}/{artifact}")
def get_artifact(cid: str, artifact: str):
    if artifact not in ARTIFACTS:
        raise HTTPException(404)
    return read(cid, artifact)


@app.get("/api/cases/{cid}/keyframes/{name}")
def keyframe(cid: str, name: str):
    p = case_dir(cid) / "keyframes" / Path(name).name
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p)


@app.get("/api/cases/{cid}/scene/{name}")
def scene_file(cid: str, name: str):
    p = case_dir(cid) / "scene" / Path(name).name
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p)


@app.get("/api/cases/{cid}/file/{name}")
def evidence_file(cid: str, name: str):
    p = case_dir(cid) / "evidence" / Path(name).name
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p)
