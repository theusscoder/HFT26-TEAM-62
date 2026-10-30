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
from pydantic import BaseModel

from . import alerts, ask as ask_mod, llm, make_case, physics, severity
from .custody import Ledger, sha256_file

DATA = Path(__file__).resolve().parents[2] / "data" / "cases"
ARTIFACTS = ["case", "events", "tracks", "tracks_ui", "tracks_metric", "calibration", "entities", "witnesses",
             "witness_extractions", "ground_truth", "vision", "analysis", "severity", "plates", "pursuit", "facilities"]

app = FastAPI(title="YATHARTH")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def case_dir(cid: str) -> Path:
    d = DATA / cid
    if not d.is_dir():
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
    witnesses: .txt statements; sensor: telematics .csv; meta: witnesses.json / ground_truth.json (demo kits)."""
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
        dst = ev / f"witness_{i}.txt"
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
    d = DATA / cid / "evidence"
    d.mkdir(parents=True, exist_ok=True)
    dest = d / Path(file.filename).name
    dest.write_bytes(await file.read())
    digest = sha256_file(dest)
    Ledger(DATA / cid / "custody.jsonl").append("evidence_registered", file=dest.name, sha256=digest)
    return {"file": dest.name, "sha256": digest}


@app.get("/api/cases/{cid}/custody")
def custody(cid: str):
    led = Ledger(case_dir(cid) / "custody.jsonl")
    return {"verify": led.verify(), "entries": led.entries()}


class Counterfactual(BaseModel):
    speed_kmh: float
    hazard_at_m: float | None = None
    reaction_s: float = 1.0
    mu: float = 0.7


@app.post("/api/cases/{cid}/counterfactual")
def counterfactual(cid: str, body: Counterfactual):
    cf = read(cid, "analysis")["counterfactual"]
    return physics.ghost_trajectory(body.speed_kmh, body.hazard_at_m or cf["hazard_at_m"],
                                    cf["brake_start_s"], body.reaction_s, body.mu)


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


@app.get("/api/cases/{cid}/file/{name}")
def evidence_file(cid: str, name: str):
    p = case_dir(cid) / "evidence" / Path(name).name
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p)
