"""The Telegram messages for one incident, sent the moment the automatic response runs:

- police control room: what, where (map link), severity, the struck road user, any vehicle that left (plate, owner),
  the intimation number and the case link;
- hospital emergency desk: an incoming patient (name, age, blood group), how soon, the treat-first note and certificate;
- the victim's family: that their person was in an accident, where, and which hospital is receiving them.

Delivery goes through notify.send (every chat subscribed to the role with /police, /hospital, /family, plus the .env
chat ids). Each send is logged in the case's emergency.json and in the custody ledger. Runs once per case."""
import json
import os
from pathlib import Path

from . import notify, records
from .custody import Ledger

APP_URL = os.getenv("APP_URL", "http://localhost:5173")


def _j(p: Path, default=None):
    try:
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default
    except ValueError:
        return default


def messages(d: Path, auto: dict) -> list[tuple[str, str, str]]:
    """[(role, title, text)] for this incident."""
    case = _j(d / "case.json", {}) or {}
    sev = _j(d / "severity.json", {}) or {}
    rec = records.load(d) or {}
    loc = case.get("location") or {}
    where = loc.get("name") or "location being confirmed"
    maps = f"https://maps.google.com/?q={loc['lat']},{loc['lon']}" if loc.get("lat") else ""
    level = f"{sev.get('level', '')} {sev.get('label', '')}".strip() or "severity being assessed"
    vic = next((v for v in rec.get("vehicles", []) if v["track"] == rec.get("victim")), None)
    per = next((p for p in rec.get("people", []) if p["track"] == rec.get("victim")), None)
    sus = next((v for v in rec.get("vehicles", []) if v["track"] == rec.get("suspect")), None)
    help_ = auto.get("help") or {}
    hosp, police = (help_.get("hospital") or {}), (help_.get("police") or {})
    ref = (auto.get("police_intimation") or {}).get("ref", "")
    link = f"{APP_URL}/case/{case.get('id', d.name)}"
    who = (f"{vic['driver']['name']}, {vic['driver']['age']} · {vic['registration']['vehicle']} {vic['plate']}" if vic else
           f"{per['name']}, {per['age']} · {per['description']}" if per else "being identified")
    blood = (vic or {}).get("driver", {}).get("blood_group") or (per or {}).get("blood_group") or "?"
    eta = f"{hosp['eta_s'] // 60} min" if hosp.get("eta_s") is not None else "minutes"
    amb = any(x.get("unit") == "ambulance" for x in auto.get("dispatched", []))
    out = []
    police_text = [f"📍 {where}", maps, f"Severity: {level}", f"Victim: {who}"]
    if sus:
        police_text.append(f"🚨 Vehicle LEFT the scene: {sus['plate']} ({sus['registration']['vehicle']}), registered to {sus['registration']['owner']}")
    police_text += [f"Ambulance: {hosp.get('name', 'nearest hospital')}, about {eta}" if amb else f"Ambulance: on standby at {hosp.get('name', 'the nearest hospital')}",
                    f"Intimation {ref}", link]
    out.append(("police", f"🚔 ACCIDENT · {case.get('title', 'Road accident')}", "\n".join(t for t in police_text if t)))
    out.append(("hospital", f"🏥 INCOMING PATIENT · {level}", "\n".join(t for t in [
        f"Patient: {who}", f"Blood group: {blood}", f"From: {where}", maps, f"Ambulance ETA: about {eta}",
        "Treat now; police formalities follow (Parmanand Katara v. Union of India, 1989; MV Act s.134A).",
        f"Police intimation {ref}" + (f" · {police.get('name')}" if police.get("name") else ""), link] if t)))
    name = (vic or {}).get("driver", {}).get("name") or (per or {}).get("name")
    amb = any(x.get("unit") == "ambulance" for x in auto.get("dispatched", []))
    if name:
        out.append(("family", f"⚠️ {name} was in a road accident", "\n".join(t for t in [
            f"Where: {where}", maps,
            f"Emergency services are with them. Ambulance taking them to {hosp.get('name', 'the nearest hospital')}." if amb else
            f"Police are at the scene. If they need treatment, the nearest hospital is {hosp.get('name', 'nearby')}.",
            f"Police reference {ref}. Keep this message for the hospital."] if t)))
    return out


def send_incident(d: Path, auto: dict) -> list[dict]:
    """Send this incident's messages once; returns the delivery log (also stored in emergency.json)."""
    state = _j(d / "emergency.json", {}) or {}
    if state.get("telegram"):
        return state["telegram"]
    log = []
    for role, title, text in messages(d, auto):
        label = {"police": "YATHARTH · police control room", "hospital": "YATHARTH · hospital emergency desk", "family": "YATHARTH · family alert"}[role]
        r = notify.send(role, label, None, title, text)
        log.append({"role": role, "title": title, "status": r["status"], "channel": r.get("channel"), "latency_ms": r.get("latency_ms"),
                    "detail": r.get("detail", ""), "text": text})
    # The case's own phones (contacts.json, or DEMO_SUSPECT_PHONE / DEMO_VICTIM_PHONE): the teammate's dispatch sends the
    # perpetrator and the victim their SMS + Telegram (only to phones that linked themselves in the bot). Facility copies
    # are left out here because the role chats above already have them. The evidence replay then sees it as dispatched.
    try:
        from . import response
        if not (d / "notifications.json").exists():
            plan = response.build(d.name)["notifications"]["plan"]
            ids = [p["id"] for p in plan if p["role"] in ("suspect", "victim") and p.get("to_number")]
            if ids:
                res = response.dispatch(d.name, ids, officer="Dispatch agent (automatic)")
                for x in res["results"]:
                    log.append({"role": f"{x['role']} phone", "title": x["to"], "status": x["status"], "channel": x.get("channel"),
                                "latency_ms": x.get("latency_ms"), "detail": x.get("detail") or ("" if x.get("real_recipient") else "not one of the case phones"), "text": ""})
    except Exception as e:
        log.append({"role": "case phones", "title": "contacts", "status": "failed", "detail": f"{type(e).__name__}: {e}"[:160], "text": ""})
    state = _j(d / "emergency.json", {}) or {}
    state["telegram"] = log
    (d / "emergency.json").write_text(json.dumps(state, indent=2), encoding="utf-8")
    Ledger(d / "custody.jsonl").append("telegram_alerts", sent=[f"{x['role']}:{x['status']}" for x in log])
    return log
