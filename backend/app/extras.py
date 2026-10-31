"""API routes added on top of main.py: red team, reports, context, interview flags, frames and entity correction.
Reads and writes the same data/cases/<id>/ files as everything else."""
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import cv2
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field

from . import context, emergency, intercept, interview, make_case, redteam, reports
from .custody import Ledger, sha256_file
from .pipeline import pursuit as pursuit_rules

DATA = Path(__file__).resolve().parents[2] / "data" / "cases"
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]+$")
VIDEO_SUFFIXES = {".mp4", ".mov", ".avi", ".mkv", ".webm"}

router = APIRouter()


def case_path(cid: str) -> Path:
    if not SAFE_ID.match(cid) or not (DATA / cid / "case.json").is_file():
        raise HTTPException(404, f"case {cid} not found")
    return DATA / cid


def load(d: Path, name: str, default=None):
    p = d / f"{name}.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


class RedTeamBody(BaseModel):
    text: str = Field(min_length=1)


@router.post("/api/cases/{cid}/redteam")
def red_team(cid: str, body: RedTeamBody):
    d = case_path(cid)
    if not (d / "events.json").exists() or not (d / "tracks_metric.json").exists():
        raise HTTPException(409, "Run the pipeline and calibrate this case first.")
    return redteam.check(d, body.text)


@router.get("/api/cases/{cid}/interview-flags")
def interview_flags(cid: str):
    d = case_path(cid)
    flags = []
    for f in sorted((d / "evidence").glob("witness_*.txt")):
        flags += interview.detect(f.stem, f.read_text(encoding="utf-8"))
    return flags


class LocationBody(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    time_utc: datetime | None = None
    name: str | None = None
    heading_deg: float | None = None


@router.put("/api/cases/{cid}/location")
def set_location(cid: str, body: LocationBody):
    """Where and when it happened. Looks up what those allow, stores it, and re-runs the analysis with it."""
    d = case_path(cid)
    case = load(d, "case")
    case["location"] = {"name": body.name or case["location"].get("name", ""), "lat": body.lat, "lon": body.lon}
    if body.time_utc is not None:
        when = body.time_utc if body.time_utc.tzinfo else body.time_utc.replace(tzinfo=timezone.utc)
        case["incident_time_utc"] = when.isoformat()
        found = context.weather(body.lat, body.lon, when)
        if found:
            case["weather"] = found
    if body.heading_deg is not None:
        case["heading_deg"] = body.heading_deg
    (d / "case.json").write_text(json.dumps(case, indent=2))
    nearby = context.facilities(body.lat, body.lon)
    if nearby:
        (d / "facilities.json").write_text(json.dumps(nearby, indent=2))
    Ledger(d / "custody.jsonl").append("location_set", lat=body.lat, lon=body.lon)
    if (d / "tracks_metric.json").exists():
        make_case.make(cid)
    else:
        pursuit_rules.run(d)
    return get_context(cid)


@router.get("/api/cases/{cid}/context")
def get_context(cid: str):
    d = case_path(cid)
    case = load(d, "case")
    loc, notes = case.get("location", {}), []
    lat, lon = loc.get("lat"), loc.get("lon")
    when = datetime.fromisoformat(case["incident_time_utc"]) if case.get("incident_time_utc") else None
    sun = None
    if lat is not None and when is not None:
        sun = context.sun_check(when, lat, lon, case.get("heading_deg"))
    else:
        notes.append("Weather and sun position appear once the location and time are logged.")
    limit = None
    if lat is not None:
        measured = (load(d, "analysis", {}).get("counterfactual") or {}).get("observed_speed_kmh")
        limit = context.speed_limit(lat, lon, measured)
        if limit is None:
            notes.append("OpenStreetMap couldn't be reached, so no speed limit is shown.")
    return {"weather": case.get("weather"), "sun": sun, "speed_limit": limit, "location": loc, "incident_time_utc": case.get("incident_time_utc"), "incident_time_source": case.get("incident_time_source"), "notes": notes}


def _custody(d: Path) -> list[dict]:
    return Ledger(d / "custody.jsonl").entries()


@router.get("/api/cases/{cid}/reports/dar")
def report_dar(cid: str):
    d = case_path(cid)
    return reports.dar(load(d, "case"), load(d, "events", []), load(d, "analysis", {}), load(d, "severity"), _custody(d))


@router.get("/api/cases/{cid}/reports/packet")
def report_packet(cid: str):
    d = case_path(cid)
    return reports.packet(load(d, "case"), load(d, "plates"), load(d, "pursuit"), load(d, "events", []), _custody(d))


@router.get("/api/cases/{cid}/reports/{kind}.html", response_class=HTMLResponse)
def report_page(cid: str, kind: str):
    if kind == "dar":
        return report_dar(cid)["html"]
    if kind == "packet":
        return report_packet(cid)["html"]
    raise HTTPException(404)


@router.get("/api/cases/{cid}/custody/files")
def custody_files(cid: str):
    """Re-hash every registered file against the last hash the ledger recorded, and report every version it has."""
    d = case_path(cid)
    versions: dict[str, list[str]] = {}
    for e in _custody(d):
        if e.get("action") in ("evidence_registered", "evidence_received", "evidence_changed"):
            hashes = versions.setdefault(e["details"].get("stored") or e["details"]["file"], [])
            if e["details"]["sha256"] not in hashes:
                hashes.append(e["details"]["sha256"])
    out = []
    for name, hashes in sorted(versions.items()):
        p = d / "evidence" / Path(name).name
        current = sha256_file(p) if p.exists() else None
        out.append({"file": name, "recorded": hashes[-1], "current": current, "ok": current == hashes[-1], "versions": len(hashes)})
    return {"ok": all(f["ok"] for f in out), "files": out}


@router.get("/api/cases/{cid}/frame/{name}/{frame_idx}")
def frame(cid: str, name: str, frame_idx: int):
    """One still from a video, for showing the frame a contradiction cites."""
    d = case_path(cid)
    video = d / "evidence" / Path(name).name
    if not video.is_file() or video.suffix.lower() not in VIDEO_SUFFIXES or frame_idx < 0:
        raise HTTPException(404)
    cache = d / "frames" / video.stem
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / f"{frame_idx:06d}.jpg"
    if not target.exists():
        cap = cv2.VideoCapture(str(video))
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        ok, image = False, None
        if frame_idx < total:
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
            ok, image = cap.read()
        cap.release()
        if not ok:
            raise HTTPException(404, f"no frame {frame_idx}")
        cv2.imwrite(str(target), image)
    return FileResponse(target, media_type="image/jpeg")


@router.get("/api/cases/{cid}/emergency")
def get_emergency(cid: str):
    return emergency.plan(case_path(cid))


class EmergencyStart(BaseModel):
    officer: str = Field(min_length=1)


@router.post("/api/cases/{cid}/emergency/start")
def start_emergency(cid: str, body: EmergencyStart):
    return emergency.start(case_path(cid), body.officer.strip())


class EmergencyDispatch(BaseModel):
    unit: str
    officer: str = Field(min_length=1)


@router.post("/api/cases/{cid}/emergency/dispatch")
def dispatch_unit(cid: str, body: EmergencyDispatch):
    if not body.officer.strip():
        raise HTTPException(422, "a named officer has to send this")
    try:
        return emergency.dispatch(case_path(cid), body.unit, body.officer.strip())
    except ValueError as e:
        raise HTTPException(422, str(e))


@router.post("/api/cases/{cid}/emergency/auto")
def emergency_auto(cid: str):
    return {"auto": emergency.auto_trigger(case_path(cid)), "plan": emergency.plan(case_path(cid))}


class CertBody(BaseModel):
    officer: str = Field(min_length=1)
    hospital: str | None = None


@router.post("/api/cases/{cid}/emergency/certificate")
def emergency_certificate(cid: str, body: CertBody):
    if not body.officer.strip():
        raise HTTPException(422, "a named officer issues the certificate")
    return emergency.certificate(case_path(cid), body.officer.strip(), body.hospital)


@router.get("/api/cases/{cid}/emergency/certificate.html", response_class=HTMLResponse)
def emergency_certificate_html(cid: str):
    return emergency.certificate_html(case_path(cid))


@router.get("/api/cases/{cid}/licence")
def case_licence(cid: str):
    from . import toll_db
    return {"licences": toll_db.licences_for(toll_db.plates_of(case_path(cid)))}


@router.post("/api/cases/{cid}/licence/{plate}/face-check")
def licence_face_check(cid: str, plate: str):
    from . import faces, toll_db
    d = case_path(cid)
    lic = next((l for l in toll_db.licences_for(toll_db.plates_of(d)) if l["plate"] == plate), None)
    if not lic:
        raise HTTPException(404, "no licence linked to this case's plates")
    if not faces.sources(d):
        return {"status": "not_comparable", "reason": "This case has no footage yet. Add a frame or clip where the driver's face is visible."}
    res = faces.compare(d, toll_db.IMAGES / lic["photo"])
    Ledger(d / "custody.jsonl").append("face_check", against=f"licence {lic['dl_no']}", status=res["status"])
    return res


@router.get("/api/telegram/chats")
def telegram_chats():
    from . import alerts
    return alerts.telegram_chats()


class TokenBody(BaseModel):
    token: str = Field(min_length=20, max_length=120, pattern=r"^\d+:[A-Za-z0-9_-]+$")


@router.post("/api/telegram/token")
def telegram_token(body: TokenBody):
    """Store the bot token from @BotFather in backend/.env (git-ignored), check it with Telegram, start the bot."""
    import os
    import httpx
    from . import telegram_bot
    try:
        me = httpx.get(f"https://api.telegram.org/bot{body.token}/getMe", timeout=10).json()
    except Exception as e:
        raise HTTPException(502, f"cannot reach Telegram: {type(e).__name__}")
    if not me.get("ok"):
        raise HTTPException(400, "Telegram rejected this token")
    env = Path(__file__).resolve().parents[1] / ".env"
    lines = env.read_text(encoding="utf-8").splitlines() if env.exists() else []
    lines = [l for l in lines if not l.startswith(("TELEGRAM_BOT_TOKEN=", "TELEGRAM_BOT_USERNAME="))]
    user = me["result"]["username"]
    lines += [f"TELEGRAM_BOT_TOKEN={body.token}", f"TELEGRAM_BOT_USERNAME={user}"]
    env.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.environ["TELEGRAM_BOT_TOKEN"], os.environ["TELEGRAM_BOT_USERNAME"] = body.token, user
    telegram_bot.restart()
    return {"ok": True, "bot": user, "link": f"https://t.me/{user}"}


@router.post("/api/telegram/test-all")
def telegram_test_all():
    """One test message to every subscribed role chat."""
    from . import notify
    return {r: notify.send(r, f"YATHARTH · {r}", None, "✅ YATHARTH test alert", f"This chat is set up to receive {r} alerts.") for r in ("police", "hospital", "family")}


@router.get("/api/cameras")
def cameras_status():
    from . import camera_agent
    return camera_agent.status()


@router.get("/api/cameras/{cam}/stream")
def camera_stream(cam: str):
    from fastapi.responses import StreamingResponse
    from . import camera_agent
    if not any(c["id"] == cam for c in camera_agent.cameras()):
        raise HTTPException(404)
    return StreamingResponse(camera_agent.frame_stream(cam), media_type="multipart/x-mixed-replace; boundary=frame")


@router.get("/api/cameras/{cam}/feed")
def camera_feed(cam: str):
    """A file feed as plain video: unlike a held-open MJPEG stream it doesn't use up the browser's six connections."""
    from . import camera_agent
    c = next((c for c in camera_agent.cameras() if c["id"] == cam), None)
    if not c or "://" in c["source"]:
        raise HTTPException(404)
    p = camera_agent.ROOT / c["source"]
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type="video/mp4")


@router.post("/api/cameras/{cam}/scan")
def camera_scan(cam: str):
    """Screen one camera now (in the background); the result shows in /api/cameras."""
    import threading
    from . import camera_agent
    c = next((c for c in camera_agent.cameras() if c["id"] == cam), None)
    if not c:
        raise HTTPException(404)
    threading.Thread(target=camera_agent.scan, args=(c, True), daemon=True).start()
    return {"started": cam}


@router.post("/api/cameras/agent/{state}")
def camera_agent_switch(state: str):
    from . import camera_agent
    camera_agent.start() if state == "on" else camera_agent.stop()
    return camera_agent.status()


@router.get("/api/cases/{cid}/response-timeline")
def response_timeline_get(cid: str):
    from . import emergency, response_timeline
    d = case_path(cid)
    if not (d / "response_timeline.json").exists():
        emergency.auto_trigger(d)   # the automatic response creates it
        if not (d / "response_timeline.json").exists():
            response_timeline.create(d, emergency._load(d, "emergency", {})["auto"])
    return response_timeline.get(d)


class StepBody(BaseModel):
    by: str = Field(min_length=2, max_length=80)
    detail: str = Field(min_length=2, max_length=600)


@router.post("/api/cases/{cid}/response-timeline/{key}")
def response_timeline_act(cid: str, key: str, body: StepBody):
    """A person does a step now (hospital accepts, treatment report, FIR)."""
    from . import response_timeline
    if key not in ("accepted", "treatment_report", "fir", "treatment", "arrived", "at_scene"):
        raise HTTPException(400, "that step isn't done by hand")
    try:
        return response_timeline.act(case_path(cid), key, body.by.strip(), body.detail.strip())
    except ValueError as e:
        raise HTTPException(404, str(e))


class TranslateBody(BaseModel):
    texts: list[str] = Field(max_length=60)


@router.get("/api/i18n/{lang}")
def i18n_table(lang: str):
    from . import i18n
    return i18n.table(lang) if lang in i18n.LANGS else {}


@router.post("/api/i18n/{lang}")
def i18n_translate(lang: str, body: TranslateBody):
    from . import i18n
    return i18n.translate(lang, body.texts)


@router.get("/api/ops/recent")
def ops_recent():
    from . import response_timeline
    return response_timeline.recent()


@router.get("/api/ops")
def ops_snapshot():
    from . import ops_center
    return ops_center.snapshot()


class AckBody(BaseModel):
    case: str
    hospital: str
    by: str = Field(min_length=2, max_length=80)
    bed: str = Field(min_length=1, max_length=60)
    note: str = ""


@router.post("/api/ops/ack")
def ops_ack(body: AckBody):
    from . import ops_center
    return ops_center.ack(body.case, body.hospital, body.by, body.bed, body.note)


@router.get("/api/ops/certificate/{cid}.html", response_class=HTMLResponse)
def ops_certificate(cid: str):
    from . import ops_center
    return ops_center.certificate_html(cid)


@router.get("/api/citymap")
def citymap():
    from . import citymap as cm
    return cm.markers()


@router.get("/api/incidents")
def incidents_live():
    from . import incident_ops
    return incident_ops.run()


@router.get("/api/live")
def live_feed():
    from . import live
    return live.run()


@router.get("/api/city")
def city_ops(seed: int = 7):
    from . import city_ops as ops
    return ops.run(seed)


@router.get("/api/dashboard")
def dashboard():
    """One row per case for the command centre: everything is read from the case's own files."""
    rows = []
    for d in sorted(DATA.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        case = load(d, "case") if d.is_dir() else None
        if not case:
            continue
        ana, sev, purs, vis, sc = load(d, "analysis", {}) or {}, load(d, "severity", {}) or {}, load(d, "pursuit", {}) or {}, load(d, "vision", {}) or {}, load(d, "scene3d", {}) or {}
        thumb = next((f["file"] for f in vis.get("frames", []) if f["name"] == "impact"), None)
        rows.append({"id": case["id"], "title": case.get("title", case["id"]), "location": case.get("location", {}).get("name", ""), "simulated": case.get("simulated", False), "license": case.get("license"),
                     "level": sev.get("level"), "label": sev.get("label"), "score": sev.get("score"), "contradictions": len(ana.get("contradictions", [])), "gaps": len(ana.get("gaps", [])),
                     "test": ana.get("score"), "hit_and_run": purs.get("status"), "camera": (case.get("camera") or {}).get("type", "cctv"), "fit": (sc.get("fit") or {}).get("iou_all"), "thumb": thumb, "witnesses": len(ana.get("reliability", {}))})
    return {"cases": rows, "totals": {"cases": len(rows), "contradictions": sum(r["contradictions"] for r in rows), "planted": sum((r["test"] or {}).get("planted", 0) for r in rows),
                                      "caught": sum((r["test"] or {}).get("caught", 0) for r in rows), "false_flags": sum((r["test"] or {}).get("false_flags", 0) for r in rows)}}


@router.get("/api/map/hyderabad")
def hyderabad_map():
    return intercept.map_payload()


@router.get("/api/cases/{cid}/intercept")
def get_intercept(cid: str, rerun: bool = False, drill: bool = False):
    """A simulation on the real road map, for a case where a vehicle left the scene. Anything else only runs when asked
    for as a training drill, and says so."""
    d = case_path(cid)
    purs = load(d, "pursuit", {}) or {}
    p = d / "intercept.json"
    cached = json.loads(p.read_text(encoding="utf-8")) if p.exists() and not rerun else None
    if purs.get("status") != "departed" and not drill and not (cached and cached.get("training")):
        return {"eligible": False, "status": purs.get("status"), "summary": purs.get("summary") or "Hit-and-run hasn't been assessed for this case."}
    if cached:
        return cached
    res = intercept.run_for_case(d, load(d, "case"))
    res["training"] = purs.get("status") != "departed"
    res["approved_by"] = None
    p.write_text(json.dumps(res), encoding="utf-8")
    return res


class InterceptApprove(BaseModel):
    officer: str = Field(min_length=1)


@router.post("/api/cases/{cid}/intercept/approve")
def approve_intercept(cid: str, body: InterceptApprove):
    if not body.officer.strip():
        raise HTTPException(422, "a named officer has to approve the plan")
    d = case_path(cid)
    res = get_intercept(cid)
    res["approved_by"] = body.officer.strip()
    (d / "intercept.json").write_text(json.dumps(res), encoding="utf-8")
    Ledger(d / "custody.jsonl").append("intercept_plan_approved", officer=body.officer.strip(), simulated=True)
    return res


class EntitiesBody(BaseModel):
    primary: str | None = None
    involved: list[str] | None = None


@router.put("/api/cases/{cid}/entities")
def correct_entities(cid: str, body: EntitiesBody):
    """A person says which track is the primary vehicle and who it met; everything downstream recomputes."""
    d = case_path(cid)
    known = {t["id"] for t in load(d, "tracks_metric", {}).get("tracks", [])}
    for track in [body.primary, *(body.involved or [])]:
        if track is not None and track not in known:
            raise HTTPException(422, f"unknown track {track}")
    (d / "entities_override.json").write_text(json.dumps(body.model_dump(exclude_none=True), indent=2), encoding="utf-8")
    Ledger(d / "custody.jsonl").append("entities_corrected", **body.model_dump(exclude_none=True))
    return make_case.make(cid)


@router.post("/api/cases/{cid}/pursuit/recompute")
def recompute_pursuit(cid: str):
    d = case_path(cid)
    if not (d / "pursuit.json").exists():
        raise HTTPException(404, "This case has no hit-and-run data.")
    return pursuit_rules.run(d)


