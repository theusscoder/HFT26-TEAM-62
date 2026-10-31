"""Emergency response: what to send, why, and a record of what a person decided.

Rules recommend from what the case can show (severity, who was involved, what vision saw, whether the road is blocked).
It never states an injury: footage can't establish one, so the ambulance is a "go and check" when a vulnerable road user was
at the impact. A named officer dispatches each unit; nothing goes out on its own, and every step goes in the custody
ledger. Sends are simulated unless a channel is configured, and the result says which it was."""
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import httpx

from .custody import Ledger

GOLDEN_HOUR_S = 3600
CITY_KMH = 30.0
UNIT_NAMES = {"ambulance": "Ambulance", "police": "Traffic police", "fire": "Fire and rescue", "tow": "Tow and road crew"}


def _load(d: Path, name: str, default=None):
    p = d / f"{name}.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


def scene_signals(vision: dict | None) -> dict:
    """What vision saw, with only the answers that hold up. The model tends to say 'people on the ground' on every frame
    of a busy road, so that only counts if it's new: not seen before the impact, seen after it."""
    frames = {f["name"]: f.get("answer") or {} for f in (vision or {}).get("frames", [])}
    before = [frames.get(n, {}) for n in ("first", "before")]
    after = [frames.get(n, {}) for n in ("impact", "after")]
    new_down = bool(frames.get("after", {}).get("people_on_ground")) and not any(b.get("people_on_ground") for b in before)
    fire = sum(bool(a.get("fire_or_smoke")) for a in after)
    return {"person_down_seen": new_down, "fire_smoke_seen": fire >= 1, "overturned_seen": any(a.get("vehicle_overturned") for a in after),
            "road_surface": frames.get("after", {}).get("road_surface"), "weather": frames.get("after", {}).get("weather"),
            "ran": bool(any(frames.values())), "frames": [{"name": f["name"], "file": f["file"], "t": f["t"]} for f in (vision or {}).get("frames", [])]}


def plan(d: Path) -> dict:
    case, sev = _load(d, "case", {}), _load(d, "severity", {}) or {}
    ana, pursuit = _load(d, "analysis", {}) or {}, _load(d, "pursuit", {}) or {}
    seen = scene_signals(_load(d, "vision"))
    fac = _load(d, "facilities")
    signals = sev.get("signals", {})
    level = sev.get("level", "L0")
    rank = {"L0": 0, "L1": 1, "L2": 2, "L3": 3}.get(level, 0)
    vru = bool(signals.get("vru_involved"))
    downs = float(signals.get("person_down_s", 0) or 0)
    left = pursuit.get("status") == "departed"
    prim = next((v for v in pursuit.get("vehicles", []) if v.get("role") == "primary"), None)
    blocking = bool(prim and prim.get("status") == "stopped")
    names = ana.get("entities", {}).get("names", {})

    def unit(uid, priority, why):
        return {"id": uid, "name": UNIT_NAMES[uid], "priority": priority, "why": why}

    units = []
    why = []
    if rank >= 3:
        why.append(f"severity {level}")
    if downs >= 5:
        why.append(f"a person isn't moving for {downs:.0f} s after impact")
    if seen["person_down_seen"]:
        why.append("vision sees someone on the ground after the impact, not before")
    if why:
        units.append(unit("ambulance", "now", why))
    elif rank >= 2 or vru:
        units.append(unit("ambulance", "check", ([f"severity {level}"] if rank >= 2 else []) + (["a pedestrian or two-wheeler was at the impact, and footage can't rule out injury"] if vru else [])))
    else:
        units.append(unit("ambulance", "not_needed", ["no vulnerable road user at the impact, and nobody seen down"]))
    pol = ([f"severity {level}"] if rank >= 2 else []) + (["a vehicle left the scene"] if left else []) + (["a pedestrian or two-wheeler was involved"] if vru else [])
    units.append(unit("police", "now" if left or rank >= 2 or vru else "check", pol or ["record the collision"]))
    fire = (["vision sees fire or smoke"] if seen["fire_smoke_seen"] else []) + (["vision sees an overturned vehicle"] if seen["overturned_seen"] else [])
    units.append(unit("fire", "now" if fire else "not_needed", fire or ["no fire, smoke or overturned vehicle seen"]))
    tow = ([f"{(names.get(prim['track']) or prim['name']).replace(' (primary)', '')} stopped at the scene and stays there"] if blocking else [])
    units.append(unit("tow", "check" if tow else "not_needed", tow or ["no vehicle is seen stopped at the scene"]))

    nearest = {}
    if fac:
        for key, rows in (("police", fac.get("police", [])), ("hospital", fac.get("hospitals", []))):
            if rows:
                best = min(rows, key=lambda r: r.get("dist_km", 1e9))
                nearest[key] = {**best, "eta_min": best.get("eta_min") or round(best.get("dist_km", 0) / CITY_KMH * 60, 1)}
    state = _load(d, "emergency", {"started": None, "log": []})
    done = {e["unit"]: e for e in state["log"] if e["action"] == "dispatch"}
    for u in units:
        u["dispatch"] = done.get(u["id"])
    return {"auto": state.get("auto"), "certificate": state.get("certificate"), "level": level, "label": sev.get("label"), "score": sev.get("score"), "breakdown": sev.get("breakdown", []), "notify": sev.get("notify", []),
            "units": units, "scene": seen, "nearest": nearest, "location": case.get("location", {}), "clock_at_impact": _clock_at_impact(case), "started": state["started"], "log": state["log"],
            "golden_hour_s": GOLDEN_HOUR_S, "injury_note": "This rates the crash, not injuries. Only a responder at the scene can assess a person.",
            "channel": "telegram" if os.getenv("TELEGRAM_BOT_TOKEN") and os.getenv("AUTHORITY_CHAT_ID") else "simulated"}


def _clock_at_impact(case: dict) -> str | None:
    clk = case.get("clock_overlay")
    if not clk:
        return None
    from datetime import timedelta
    try:
        t = datetime.strptime(str(clk["value"]).split()[-1][:8], "%H:%M:%S") + timedelta(seconds=case["t0_video_s"] - clk["at_video_s"])
        return t.strftime("%H:%M:%S")
    except (KeyError, ValueError):
        return None


def _save(d: Path, state: dict) -> None:
    (d / "emergency.json").write_text(json.dumps(state, indent=1), encoding="utf-8")


def start(d: Path, officer: str) -> dict:
    state = _load(d, "emergency", {"started": None, "log": []})
    if not state["started"]:
        now = datetime.now(timezone.utc).isoformat()
        state["started"] = now
        state["log"].append({"time": now, "action": "started", "officer": officer, "text": f"Response opened by {officer}"})
        _save(d, state)
        Ledger(d / "custody.jsonl").append("emergency_opened", officer=officer)
    return plan(d)


def dispatch(d: Path, unit_id: str, officer: str) -> dict:
    p = plan(d)
    u = next((u for u in p["units"] if u["id"] == unit_id), None)
    if u is None:
        raise ValueError("unknown unit")
    state = _load(d, "emergency", {"started": None, "log": []})
    if any(e["action"] == "dispatch" and e["unit"] == unit_id for e in state["log"]):
        return plan(d)
    case = _load(d, "case", {})
    text = f"YATHARTH case {case.get('id')}: send {u['name']} to {case.get('location', {}).get('name') or 'the incident'}. Severity {p['level']}. Why: {'; '.join(u['why'])}. Sent by {officer}."
    status = "simulated"
    token, chat = os.getenv("TELEGRAM_BOT_TOKEN"), os.getenv("AUTHORITY_CHAT_ID")
    if token and chat:
        r = httpx.post(f"https://api.telegram.org/bot{token}/sendMessage", json={"chat_id": chat, "text": text}, timeout=10)
        status = "sent" if r.is_success else "failed"
    now = datetime.now(timezone.utc).isoformat()
    state["log"].append({"time": now, "action": "dispatch", "unit": unit_id, "officer": officer, "status": status, "text": f"{u['name']} {status} by {officer}"})
    if not state["started"]:
        state["started"] = now
    _save(d, state)
    Ledger(d / "custody.jsonl").append("unit_dispatched", unit=unit_id, officer=officer, status=status)
    return plan(d)


# ---------------- the automatic response: what happens the moment a crash is detected ----------------
AUTO_LEVELS = ("L2", "L3")
KATARA = ("Emergency treatment must not wait for police formalities: Supreme Court of India, Pt. Parmanand Katara v. Union of India (1989). "
          "Under the Motor Vehicles Act, sec. 134A, a person who brings an accident victim to hospital can't be detained or made to wait.")
VICTIM_Q = """This CCTV frame is at or just after a road collision. Answer ONLY with one JSON object:
{"struck": "pedestrian|two_wheeler_rider|car|bus|truck|auto_rickshaw|none_visible", "colour": "<colour of the struck vehicle or null>",
 "people_down": <number of people on the ground>, "reason": "<one short sentence of what is visible>"}
Say which road user was hit or is most likely hurt. Don't judge who caused it."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def nearest_help(d: Path, case: dict) -> dict:
    """Nearest hospital and police station by road time on the real map when the crash is inside it, else straight line."""
    loc = case.get("location", {})
    lat, lon = loc.get("lat"), loc.get("lon")
    if lat is None or lon is None:
        return {}
    from . import intercept
    c = intercept.city()
    s, w, n, e = c.raw["bbox"]
    out = {}
    if s <= lat <= n and w <= lon <= e:
        node = c.nearest(*c.xy(lat, lon))
        for kind in ("hospital", "police"):
            best = None
            for p in c.raw["places"]:
                if p["amenity"] != kind:
                    continue
                dist, _ = c.dijkstra(c.nearest(*c.xy(p["lat"], p["lon"])), police=True, limit=1800)
                eta = dist.get(node)
                if eta is not None and (best is None or eta < best["eta_s"]):
                    best = {"name": p["name"], "lat": p["lat"], "lon": p["lon"], "eta_s": round(eta), "how": "road network, emergency speed"}
            out[kind] = best
        return out
    fac = _load(d, "facilities") or {}
    import math
    for kind, rows in (("hospital", fac.get("hospitals", [])), ("police", fac.get("police", []))):
        if rows:
            r = min(rows, key=lambda r: r.get("dist_km", 1e9))
            out[kind] = {"name": r["name"], "lat": r["lat"], "lon": r["lon"], "eta_s": round(r.get("dist_km", 0) / CITY_KMH * 3600), "how": "straight line"}
    return out


def victim(d: Path) -> dict:
    """Who was struck, judged by the vision model on the impact frame (never who caused it), and whose registration that gives."""
    from . import alerts, llm
    vis = _load(d, "vision") or {}
    frame = next((f for f in vis.get("frames", []) if f["name"] in ("impact", "after")), None)
    judged = None
    if frame:
        try:
            judged = llm.chat_json([{"role": "user", "content": [{"type": "text", "text": VICTIM_Q}, llm.image_part(d / frame["file"])]}], model=llm.VISION_MODEL)["data"]
        except Exception:
            judged = None
    purs = _load(d, "pursuit", {}) or {}
    left = {v["track"] for v in purs.get("vehicles", []) if v.get("status") == "left_view"} | ({"car_B"} if purs.get("status") == "departed" and not purs.get("vehicles") else set())
    plates = [v for v in (_load(d, "plates", {}) or {}).get("vehicles", []) if v.get("plate") and "?" not in v["plate"] and v.get("track") not in left]
    from . import records
    rec = records.load(d) or {}
    vic = next((v for v in rec.get("vehicles", []) if v["track"] == rec.get("victim")), None)
    per = next((p for p in rec.get("people", []) if p["track"] == rec.get("victim")), None)
    why = f"Vision model: {judged.get('reason')} " if judged and judged.get("reason") else ""
    if vic:
        return {"judged": judged, "plate": vic["plate"], "track": vic["track"], "owner": vic["registration"]["owner"], "contact": vic["registration"]["emergency_contact"],
                "driver": vic["driver"]["name"], "reason": why + f"The struck vehicle is the {vic['name'].lower()}, plate {vic['plate']}, registered to {vic['registration']['owner']}."}
    if per:
        return {"judged": judged, "plate": None, "track": per["track"], "owner": per["name"], "contact": per["emergency_contact"],
                "reason": why + f"The struck person is {per['name']} ({per['description'].lower()}), identified by {per['identified_by']}."}
    struck = (judged or {}).get("struck")
    if struck in ("pedestrian", "two_wheeler_rider") and not plates:
        return {"judged": judged, "plate": None, "contact": None, "reason": "The struck road user has no number plate, so there's no registration to find an emergency contact from."}
    for v in plates:
        rec = alerts.lookup(v["plate"])
        if rec:
            return {"judged": judged, "plate": v["plate"], "track": v.get("track"), "owner": rec["owner"], "contact": rec.get("emergency_contact"),
                    "reason": (f"Vision model: {judged.get('reason')} " if judged else "No vision judgement for this case; ") + f"the struck vehicle stayed at the scene and its plate {v['plate']} is registered."}
    return {"judged": judged, "plate": None, "contact": None, "reason": "No registered plate was read on the struck vehicle."}


def auto_trigger(d: Path) -> dict:
    """Runs once per case, the moment the pipeline finishes. Police are always informed. Units marked 'send now', and an
    ambulance for a moderate or severe crash, go out straight away; anything else waits for an officer. All sends are
    simulated unless a channel is configured, and every step is in the custody ledger."""
    from . import alerts
    state = _load(d, "emergency", {"started": None, "log": []})
    if state.get("auto"):
        return state["auto"]
    case, p = _load(d, "case", {}), plan(d)
    help_ = nearest_help(d, case)
    now = _now()
    auto = {"time": now, "level": p["level"], "dispatched": [], "held": [], "help": help_}
    state["started"] = state["started"] or now

    def log(text, **kw):
        state["log"].append({"time": _now(), "action": kw.pop("action", "auto"), "officer": "Dispatch agent", "text": text, **kw})

    for u in p["units"]:
        go = u["priority"] == "now" or (u["id"] == "ambulance" and p["level"] in AUTO_LEVELS)
        where = help_.get("hospital" if u["id"] == "ambulance" else "police") if u["id"] in ("ambulance", "police") else None
        if go:
            eta = f", about {where['eta_s'] // 60} min {where['eta_s'] % 60} s away by road" if where and where.get("eta_s") is not None else ""
            auto["dispatched"].append({"unit": u["id"], "name": u["name"], "from": where["name"] if where else None, "eta_s": where["eta_s"] if where else None, "why": u["why"]})
            state["log"].append({"time": _now(), "action": "dispatch", "unit": u["id"], "officer": "Dispatch agent", "status": "simulated" if p["channel"] == "simulated" else "sent",
                                 "text": f"{u['name']} sent automatically{(' from ' + where['name']) if where else ''}{eta}. Why: {'; '.join(u['why'])}"})
        elif u["priority"] != "not_needed":
            auto["held"].append({"unit": u["id"], "name": u["name"], "why": u["why"]})
    ref = f"PI-{case.get('id', 'case')}-{datetime.now().strftime('%H%M%S')}"
    plates = [v["plate"] for v in (_load(d, "plates", {}) or {}).get("vehicles", []) if v.get("plate")]
    text = (f"ACCIDENT INTIMATION {ref}. {case.get('location', {}).get('name') or 'Location not set'}, {now[:19]} UTC. Severity {p['level']} {p.get('label') or ''}. "
            f"Vehicles: {', '.join(plates) or 'plates not read'}. Ambulance {'dispatched' if any(x['unit'] == 'ambulance' for x in auto['dispatched']) else 'recommended'}. Case {case.get('id')}.")
    auto["police_intimation"] = {"ref": ref, "time": _now(), "to": (help_.get("police") or {}).get("name") or "Police control room", "text": text, "status": p["channel"]}
    log(f"Police informed immediately ({auto['police_intimation']['to']}), intimation {ref}.", action="police_intimation")
    v = victim(d)
    auto["victim"] = v
    if v.get("plate"):
        msg = (f"YATHARTH: a vehicle registered to {v['owner']} ({v['plate']}) was involved in a road accident at {case.get('location', {}).get('name') or 'a reported location'}. "
               f"Emergency services have been informed{(' and an ambulance is on the way from ' + auto['dispatched'][0]['from']) if auto['dispatched'] and auto['dispatched'][0].get('from') else ''}. Ref {ref}.")
        res = alerts.send(v["plate"], msg)
        auto["notifications"] = [{"to": f"emergency contact of {v['owner']}", "via": "Telegram", "status": res["status"], "text": msg}]
        log(f"Emergency contact for {v['plate']} notified on Telegram ({res['status']}).", action="contact_notified")
    elif v.get("contact"):
        msg = (f"YATHARTH: {v['owner']} was involved in a road accident at {case.get('location', {}).get('name') or 'a reported location'}. "
               f"Emergency services have been informed. Ref {ref}.")
        auto["notifications"] = [{"to": f"emergency contact of {v['owner']} ({v['contact']})", "via": "Telegram", "status": "simulated", "text": msg}]
        log(f"Emergency contact of {v['owner']} notified ({v['contact']}, simulated).", action="contact_notified")
    else:
        auto["notifications"] = []
        log(f"No emergency contact to notify: {v['reason']}", action="contact_skipped")
    state["auto"] = auto
    _save(d, state)
    Ledger(d / "custody.jsonl").append("auto_response", level=p["level"], dispatched=[x["unit"] for x in auto["dispatched"]], intimation=ref,
                                       contact=[n["status"] for n in auto["notifications"]])
    from . import incident_alerts   # Telegram: police control room, hospital desk, family
    try:
        auto["telegram"] = incident_alerts.send_incident(d, auto)
    except Exception as e:
        auto["telegram"] = [{"role": "all", "status": "failed", "detail": f"{type(e).__name__}: {e}"[:160]}]
    return auto


def certificate(d: Path, officer: str, hospital: str | None = None) -> dict:
    """Police acknowledge the accident for the hospital, so treatment starts without waiting for an FIR."""
    state = _load(d, "emergency", {"started": None, "log": []})
    auto = state.get("auto") or auto_trigger(d)
    state = _load(d, "emergency", {"started": None, "log": []})
    case = _load(d, "case", {})
    hosp = hospital or (auto.get("help", {}).get("hospital") or {}).get("name") or "Receiving hospital"
    issued = _now()
    t0 = datetime.fromisoformat(auto["time"])
    cert = {"ref": f"AC-{case.get('id', 'case')}-{datetime.now().strftime('%H%M%S')}", "issued": issued, "officer": officer, "hospital": hosp,
            "intimation": auto["police_intimation"]["ref"], "minutes_after_detection": round((datetime.fromisoformat(issued) - t0).total_seconds() / 60, 1),
            "location": case.get("location", {}).get("name"), "level": auto["level"], "note": KATARA, "status": "simulated" if not (os.getenv("TELEGRAM_BOT_TOKEN") and os.getenv("AUTHORITY_CHAT_ID")) else "sent"}
    state["certificate"] = cert
    state["log"].append({"time": issued, "action": "certificate", "officer": officer, "text": f"Accident certificate {cert['ref']} issued to {hosp} by {officer}: treat now, paperwork follows."})
    _save(d, state)
    Ledger(d / "custody.jsonl").append("hospital_certificate", ref=cert["ref"], officer=officer, hospital=hosp)
    return plan(d)


def certificate_html(d: Path) -> str:
    import html
    state = _load(d, "emergency", {}) or {}
    c = state.get("certificate")
    if not c:
        return "<p>No certificate issued.</p>"
    rows = [("Reference", c["ref"]), ("Police intimation", c["intimation"]), ("Issued", c["issued"][:19] + " UTC"), ("Issued by", c["officer"]), ("To", c["hospital"]),
            ("Location", c.get("location") or "Not set"), ("Crash severity", c["level"]), ("Issued", f"{c['minutes_after_detection']} min after the crash was detected")]
    body = "".join(f"<tr><th>{html.escape(k)}</th><td>{html.escape(str(v))}</td></tr>" for k, v in rows)
    return ("<!doctype html><html><head><meta charset='utf-8'><title>Accident certificate</title><style>body{font-family:Helvetica,Arial,sans-serif;max-width:46rem;margin:2rem auto;color:#111}"
            "h1{font-size:1.5rem;border-bottom:3px solid #111;padding-bottom:.4rem}th{text-align:left;padding:.35rem 1rem .35rem 0;color:#555;font-weight:500}td{padding:.35rem 0}"
            ".k{border:2px solid #e30613;padding:1rem;margin-top:1.4rem}</style></head><body><h1>Accident certificate for immediate treatment</h1>"
            f"<p>The police have been informed of this road accident. Treat the injured now; the FIR and medico-legal formalities follow.</p><table>{body}</table>"
            f"<p class='k'>{html.escape(c['note'])}</p><p style='color:#777;font-size:.8rem'>Generated by YATHARTH for the issuing officer. Demo document ({c['status']}).</p></body></html>")
