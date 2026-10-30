"""YATHARTH API. Single FastAPI process; cases live in data/cases/<id>/ as JSON files.
Run: uvicorn app.main:app --reload --port 8000   (from backend/)"""
import asyncio
import json
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import alerts, llm, make_case, physics, severity
from .custody import Ledger, sha256_file

DATA = Path(__file__).resolve().parents[2] / "data" / "cases"
ARTIFACTS = ["case", "events", "tracks", "tracks_ui", "tracks_metric", "calibration", "entities", "witnesses",
             "witness_extractions", "ground_truth", "analysis", "severity", "plates", "pursuit", "facilities"]
STAGES = ["hash", "video", "plates", "sensor", "witness", "fusion", "contradictions", "severity", "report"]

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


@app.post("/api/cases/{cid}/rebuild")
def rebuild(cid: str):
    case_dir(cid)
    return make_case.make(cid)


@app.get("/api/cases")
def list_cases():
    return [json.loads((d / "case.json").read_text(encoding="utf-8"))
            for d in sorted(DATA.iterdir()) if (d / "case.json").exists()]


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


@app.websocket("/ws/cases/{cid}/run")
async def run(ws: WebSocket, cid: str):
    """Streams pipeline stage progress. TODO(P2): call the real pipeline modules per stage."""
    await ws.accept()
    for s in STAGES:
        await ws.send_json({"stage": s, "status": "running"})
        await asyncio.sleep(0.6)
        await ws.send_json({"stage": s, "status": "done"})
    await ws.send_json({"stage": "all", "status": "done"})
    await ws.close()


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


@app.get("/api/cases/{cid}/file/{name}")
def evidence_file(cid: str, name: str):
    p = case_dir(cid) / "evidence" / Path(name).name
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p)
