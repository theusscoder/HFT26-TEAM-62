"""The response timeline of one incident, from the crash to the treatment report, with a time on every step.

Created the moment the automatic response runs (emergency.auto_trigger). Steps that have happened carry the time they
happened; steps still to come are scheduled from the road-network ETAs and turn 'done' when their time passes. People can
act earlier and their action replaces the scheduled one: the hospital accepting the patient (bed, doctor), the treatment
report, the FIR. If no one acts, the police and hospital systems file them on schedule (marked as such).

Steps: occurred -> detected -> analysed -> police informed -> units dispatched -> hospital alerted -> Telegram -> FIR
registered -> treat-first certificate -> hospital accepted -> ambulance at scene -> patient on the way -> arrived at
hospital -> treatment started -> treatment report. Each milestone that matters to someone is also sent on Telegram.
Stored in data/cases/<id>/response_timeline.json; a small ticker thread sends the due notifications."""
import hashlib
import json
import random
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CASES = ROOT / "data" / "cases"
ON_SCENE_S = 300        # ambulance crew on scene before leaving
AUTO_ACCEPT_S = 90      # hospital system confirms a bed if the desk hasn't
FIR_AFTER_S = 45
CERT_AFTER_S = 60
NOTIFY = {"fir": ["police"], "certificate": ["hospital"], "accepted": ["police", "family"], "at_scene": ["family"],
          "arrived": ["police", "family"], "treatment_report": ["police", "family"]}
_lock = threading.Lock()
_run = {"thread": None}


def _j(p: Path, default=None):
    try:
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default
    except ValueError:
        return default


def _iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).isoformat(timespec="seconds")


def _t(s: str) -> datetime:
    return datetime.fromisoformat(s)


def _rng(cid: str) -> random.Random:
    return random.Random(int(hashlib.sha256(cid.encode()).hexdigest()[:10], 16))


def _sections(level: str, fled: bool) -> list[str]:
    s = ["BNS s.281 (rash driving on a public way)"]
    if level in ("L2", "L3"):
        s.append("BNS s.125(b) (endangering life, grievous hurt)" if level == "L3" else "BNS s.125(a) (endangering life, hurt)")
    if fled:
        s += ["BNS s.106(2) / MV Act s.134 (failing to stop and report)", "MV Act s.187"]
    return s


def _officer(station: str | None) -> dict:
    try:
        from . import ops_center
        o = next((o for o in ops_center.build()["officers"] if o["station"] == station), None)
        if o:
            return o
    except Exception:
        pass
    r = random.Random(station or "ps")
    from .records import FIRST, LAST
    return {"name": f"{r.choice(FIRST)} {r.choice(LAST)}", "rank": "Sub-Inspector", "rank_short": "SI", "call_sign": "PS 11", "station": station or "Police station"}


def create(d: Path, auto: dict) -> dict:
    """Build and store the timeline for this case (once)."""
    p = d / "response_timeline.json"
    if p.exists():
        return get(d)
    from . import records
    cid = d.name
    case = _j(d / "case.json", {}) or {}
    sev = _j(d / "severity.json", {}) or {}
    led = [json.loads(l) for l in (d / "custody.jsonl").read_text().splitlines() if l.strip()] if (d / "custody.jsonl").exists() else []
    rec = records.load(d) or {}
    t_auto = _t(auto["time"])
    t_case = _t(led[0]["time"]) if led else t_auto - timedelta(seconds=120)
    if t_case > t_auto or t_auto - t_case > timedelta(minutes=30):
        # an older case being responded to now: the response is timed from when the alert went out
        t_case = t_auto - timedelta(seconds=75)
    occ = _t(case["incident_time_utc"]) if case.get("incident_time_utc") else None
    if not occ or not (timedelta(0) <= t_case - occ <= timedelta(minutes=30)):
        occ = t_case - timedelta(seconds=20)   # footage from another day: the response is measured from when it reached us
    src = case.get("source") or {}
    help_ = auto.get("help") or {}
    hosp, police = help_.get("hospital") or {}, help_.get("police") or {}
    officer = _officer(police.get("name"))
    level = sev.get("level", "L1")
    vic = next((v for v in rec.get("vehicles", []) if v["track"] == rec.get("victim")), None)
    per = next((p for p in rec.get("people", []) if p["track"] == rec.get("victim")), None)
    patient = (vic or {}).get("driver", {}).get("name") or (per or {}).get("name") or "the injured person"
    fled = bool(rec.get("suspect"))
    amb = next((x for x in auto.get("dispatched", []) if x["unit"] == "ambulance"), None)
    r = _rng(cid)
    ev = []

    def add(key, label, when, actor, detail="", **kw):
        ev.append({"key": key, "label": label, "time": _iso(when), "actor": actor, "detail": detail, "planned": True, **kw})

    add("occurred", "Crash", occ, "Camera", f"{case.get('location', {}).get('name', '')}", planned=False)
    add("detected", "Detected and reported", t_case, "Camera agent" if src.get("kind") == "camera agent" else "Officer upload",
        (f"{src.get('camera')}: {(src.get('detection') or {}).get('why', '')}" if src.get("kind") == "camera agent" else "Footage uploaded to YATHARTH"), planned=False)
    add("analysed", "Analysis complete", t_auto - timedelta(seconds=2), "YATHARTH", f"Severity {level} {sev.get('label', '')}".strip(), planned=False)
    pi = auto.get("police_intimation") or {}
    add("police_informed", "Police informed", _t(pi.get("time", auto["time"])), "Dispatch agent", f"Intimation {pi.get('ref', '')} to {pi.get('to', police.get('name', 'police control room'))}", planned=False, ref=pi.get("ref"))
    for x in auto.get("dispatched", []):
        add(f"dispatch_{x['unit']}", f"{x['name']} dispatched", t_auto, "Dispatch agent",
            f"From {x.get('from') or 'nearest base'}" + (f", ETA {x['eta_s'] // 60} min {x['eta_s'] % 60} s by road" if x.get("eta_s") is not None else ""), planned=False)
    add("hospital_alerted", "Hospital alerted", t_auto + timedelta(seconds=1), "Dispatch agent",
        f"{hosp.get('name', 'Nearest hospital')}: {'incoming patient' if amb else 'pre-alert, ambulance on standby'}", planned=False)
    for m in (auto.get("telegram") or []):
        add(f"telegram_{m['role']}", f"Telegram · {m['role']}", t_auto + timedelta(seconds=2), "Telegram", f"{m['title'] if 'title' in m else ''} ({m.get('status')})", planned=False)
    fir_no = f"{r.randint(400, 1900)}/{datetime.now().year}"
    add("fir", "FIR registered", t_auto + timedelta(seconds=FIR_AFTER_S), f"{officer['rank_short']} {officer['name']}",
        f"FIR {fir_no}, {officer['station']}: " + "; ".join(_sections(level, fled)), ref=fir_no, auto_by="police records system")
    add("certificate", "Treat-first certificate sent to hospital", t_auto + timedelta(seconds=CERT_AFTER_S), f"{officer['rank_short']} {officer['name']}",
        f"To {hosp.get('name', 'the receiving hospital')}: treat now, FIR {fir_no} follows (Parmanand Katara v. Union of India)", ref=f"AC-{fir_no}")
    add("accepted", "Hospital accepted the patient", t_auto + timedelta(seconds=AUTO_ACCEPT_S), hosp.get("name", "Hospital"),
        f"Bed assigned for {patient}", auto_by="hospital system (no response from the desk yet)")
    if amb and amb.get("eta_s") is not None:
        at_scene = t_auto + timedelta(seconds=amb["eta_s"])
        leave = at_scene + timedelta(seconds=ON_SCENE_S)
        arrive = leave + timedelta(seconds=amb["eta_s"])
        add("at_scene", "Ambulance at the scene", at_scene, f"Ambulance · {amb.get('from')}", f"Crew with {patient}")
        add("transport", "Patient on the way to hospital", leave, f"Ambulance · {amb.get('from')}", f"Routing to {hosp.get('name')}, about {amb['eta_s'] // 60} min")
        add("arrived", "Arrived at hospital", arrive, hosp.get("name", "Hospital"), f"{patient} handed over to the emergency team")
        add("treatment", "Treatment started", arrive + timedelta(seconds=120), hosp.get("name", "Hospital"), "Primary survey and stabilisation")
        triage = {"L3": "Red (immediate)", "L2": "Yellow (urgent)"}.get(level, "Green (minor)")
        add("treatment_report", "Treatment report", arrive + timedelta(seconds=900), f"Dr. {r.choice(['Kavitha', 'Ramesh', 'Sana', 'Vikram', 'Anusha'])} {r.choice(['Rao', 'Reddy', 'Iyer', 'Khan', 'Varma'])}, Emergency Medicine",
            f"Triage {triage}. " + {"L3": "Head and chest trauma; CT done; admitted to ICU, critical but stable.",
                                     "L2": "Fractures suspected; X-ray done; admitted to the orthopaedic ward, stable.",
                                     "L1": "Abrasions and contusions; dressed; under observation, likely discharge today."}.get(level, "Assessed; under observation.")
            + f" BP {r.randint(100, 135)}/{r.randint(65, 88)}, pulse {r.randint(78, 112)}, SpO₂ {r.randint(94, 99)}%.", auto_by="ER system (provisional)")
    else:
        add("no_transport", "No ambulance needed", t_auto + timedelta(seconds=5), "Dispatch agent", "Severity and the vision check show no one hurt; ambulance on standby", planned=False)
    ev.sort(key=lambda e: e["time"])
    out = {"case": cid, "created": _iso(datetime.now(timezone.utc)), "occurred": _iso(occ), "events": ev, "notified": {}}
    with _lock:
        p.write_text(json.dumps(out, indent=2), encoding="utf-8")
    return get(d)


def get(d: Path) -> dict:
    tl = _j(d / "response_timeline.json")
    if not tl:
        return {"events": []}
    now = datetime.now(timezone.utc)
    occ = _t(tl["occurred"])
    for e in tl["events"]:
        e["status"] = "done" if _t(e["time"]) <= now else "scheduled"
        e["t_plus_s"] = round((_t(e["time"]) - occ).total_seconds())
    done = {e["key"]: e for e in tl["events"] if e["status"] == "done"}
    def gap(a, b):
        return round((_t(done[b]["time"]) - _t(done[a]["time"])).total_seconds()) if a in done and b in done else None
    tl["kpi"] = {"to_police_s": gap("occurred", "police_informed"), "to_fir_s": gap("occurred", "fir"), "to_accept_s": gap("occurred", "accepted"),
                 "to_scene_s": gap("occurred", "at_scene"), "to_hospital_s": gap("occurred", "arrived"),
                 "golden_hour_left_s": max(0, 3600 - round((now - occ).total_seconds()))}
    tl["now"] = _iso(now)
    return tl


def act(d: Path, key: str, by: str, detail: str) -> dict:
    """A person did a step now (hospital accepted, treatment report filed, FIR registered): it replaces the scheduled one."""
    with _lock:
        tl = _j(d / "response_timeline.json")
        if not tl:
            raise ValueError("no response timeline yet")
        e = next((e for e in tl["events"] if e["key"] == key), None)
        if not e:
            raise ValueError(f"no step {key}")
        e.update({"time": _iso(datetime.now(timezone.utc)), "actor": by, "detail": detail, "planned": False, "auto_by": None, "by_person": True})
        tl["events"].sort(key=lambda e: e["time"])
        (d / "response_timeline.json").write_text(json.dumps(tl, indent=2), encoding="utf-8")
    tick_case(d)
    return get(d)


def tick_case(d: Path):
    """Send the Telegram for every milestone that has come due and hasn't been sent."""
    from . import notify
    tl = _j(d / "response_timeline.json")
    if not tl:
        return
    now = datetime.now(timezone.utc)
    case = _j(d / "case.json", {}) or {}
    changed = False
    for e in tl["events"]:
        roles = NOTIFY.get(e["key"])
        if not roles or e["key"] in tl["notified"] or _t(e["time"]) > now:
            continue
        res = {}
        for role in roles:
            res[role] = notify.send(role, f"YATHARTH · {case.get('title', d.name)}", None, f"⏱ {e['label']} · {_t(e['time']).astimezone().strftime('%H:%M:%S')}",
                                    f"{e['detail']}\n{e['actor']}")["status"]
        tl["notified"][e["key"]] = res
        changed = True
    if changed:
        with _lock:
            cur = _j(d / "response_timeline.json") or tl
            cur["notified"] = {**cur.get("notified", {}), **tl["notified"]}
            (d / "response_timeline.json").write_text(json.dumps(cur, indent=2), encoding="utf-8")


def _loop():
    while True:
        for p in CASES.glob("*/response_timeline.json"):
            try:
                tick_case(p.parent)
            except Exception:
                pass
        time.sleep(5)


def start():
    import os
    if os.getenv("PYTEST_CURRENT_TEST") or (_run["thread"] and _run["thread"].is_alive()):
        return
    _run["thread"] = threading.Thread(target=_loop, daemon=True, name="response-ticker")
    _run["thread"].start()
