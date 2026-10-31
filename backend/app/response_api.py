"""Routes for A2 (plates → TS police DB) and A3 (officer-approved alerts). Mounted by main.py with one line.
Paths live under /api/response/ and /api/ts-db/ so they never collide with the generic /api/cases/{cid}/{artifact}."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from datetime import datetime

from . import notify, response, tracking, ts_police_db as db

router = APIRouter()
tracking.ensure_worker()  # resumes any active tracking after a restart


def _case(cid: str):
    if not (response.DATA / cid / "case.json").exists():
        raise HTTPException(404, f"case {cid} not found")


@router.get("/api/response/{cid}")
def get_response(cid: str):
    _case(cid)
    return response.build(cid)


@router.get("/api/response/{cid}/replay")
def get_replay(cid: str):
    _case(cid)
    return response.replay_summary(cid)


@router.post("/api/response/{cid}/plates/rerun")
def rerun_plates(cid: str):
    _case(cid)
    from .pipeline import plate_reader
    plate_reader.run(response.DATA / cid, roles=response._j(response.DATA / cid / "roles.json", {}), force=True)
    return response.build(cid)


class RoleReq(BaseModel):
    track: str
    role: str  # victim | suspect | bystander


@router.post("/api/response/{cid}/role")
def set_role(cid: str, body: RoleReq):
    _case(cid)
    if body.role not in ("victim", "suspect", "bystander"):
        raise HTTPException(400, "role must be victim, suspect or bystander")
    return response.set_role(cid, body.track, body.role)


class LocationReq(BaseModel):
    lat: float
    lon: float
    name: str = ""


@router.post("/api/response/{cid}/location")
def set_location(cid: str, body: LocationReq):
    _case(cid)
    return response.set_location(cid, body.lat, body.lon, body.name)


class DispatchReq(BaseModel):
    ids: list[str]
    officer: str = "Duty officer"


@router.post("/api/response/{cid}/dispatch")
def dispatch(cid: str, body: DispatchReq):
    _case(cid)
    if not body.ids:
        raise HTTPException(400, "select at least one recipient")
    return response.dispatch(cid, body.ids, body.officer)


@router.get("/api/ts-db/vehicles")
def ts_vehicles(q: str = "", limit: int = 200):
    return {"meta": {"count": len(db.vehicles()), "links": len(db.links()),
                     "note": "MOCK Telangana State Police registry. Fictional owners and numbers (+91 5xxxx range is not a real mobile range)."},
            "vehicles": db.search(q, limit)}


@router.get("/api/ts-db/vehicle/{plate}")
def ts_vehicle(plate: str):
    rec = db.detail(plate)
    if rec is None:
        cands = db.match_partial(plate) if "?" in plate else []
        if len(cands) == 1:
            rec = db.detail(cands[0]["plate"])
        if rec is None:
            raise HTTPException(404, f"{plate} not in the TS police DB (mock)")
    return rec


@router.get("/api/ts-db/links")
def ts_links():
    return db.links()


@router.get("/api/telegram/status")
def telegram_status():
    return notify.telegram_status()


@router.get("/api/telegram/links")
def telegram_links():
    from . import telegram_bot
    return telegram_bot.status()


@router.post("/api/telegram/test")
def telegram_test():
    st = notify.telegram_status()
    if not st["configured"]:
        raise HTTPException(400, st["detail"])
    return notify.send("police", "YATHARTH system check", None, "✅ YATHARTH test alert",
                       "If you can read this, the control-room demo channel works.")


@router.post("/api/notify/{cid}/test-contacts")
def test_contacts(cid: str):
    """Send one short test alert to the case's real contacts (perpetrator / victim numbers in contacts.json)."""
    _case(cid)
    out = {}
    for role, num in response.case_contacts(response.DATA / cid).items():
        if num:
            out[role] = notify.send(role, f"{role} contact", num, "✅ YATHARTH test alert",
                                    f"Test from YATHARTH ({cid}). Accident alerts for this case will reach this number.",
                                    sms_text=f"YATHARTH test (demo): accident alerts for case {cid} will reach this number. Reply STOP to opt out.", real=True)
    return out


class TrackReq(BaseModel):
    speed: float | None = None
    notify_suspect: bool = True
    officer: str = "Duty officer"


@router.get("/api/tracking/{cid}")
def tracking_status(cid: str):
    _case(cid)
    return tracking.status(cid) or {"active": False, "plate": None, "sightings": []}


@router.post("/api/tracking/{cid}/start")
def tracking_start(cid: str, body: TrackReq):
    _case(cid)
    r = response.build(cid)
    sus = next((s for s in r["suspects"] if s.get("record")), None)
    if not sus:
        raise HTTPException(400, "no registered suspect vehicle to track")
    inc = r["incident"]
    tracking.start(cid, sus["record"]["plate"], datetime.fromisoformat(inc["time"]), inc["location"]["lat"], inc["location"]["lon"],
                   r["facilities"]["jurisdiction"], body.speed, body.notify_suspect)
    return tracking.status(cid)


@router.post("/api/tracking/{cid}/stop")
def tracking_stop(cid: str, body: TrackReq):
    _case(cid)
    tracking.stop(cid, body.officer)
    return tracking.status(cid)


@router.post("/api/tracking/{cid}/speed")
def tracking_speed(cid: str, body: TrackReq):
    _case(cid)
    if body.speed is None:
        raise HTTPException(400, "speed required")
    tracking.set_speed(cid, body.speed)
    return tracking.status(cid)


class ConfirmReq(BaseModel):
    track: str
    registration: str | None = None
    by: str = "Investigator"


@router.post("/api/response/{cid}/confirm-plate")
def confirm_plate(cid: str, body: ConfirmReq):
    """Investigator-confirmed registration (the only way a reading becomes 'confirmed')."""
    _case(cid)
    from .custody import Ledger
    from .pipeline import plate_reader
    plate_reader.confirm(response.DATA / cid, body.track, body.registration, body.by)
    Ledger(response.DATA / cid / "custody.jsonl").append("plate_confirmed", track=body.track, registration=body.registration, by=body.by)
    return response.replay_summary(cid)
