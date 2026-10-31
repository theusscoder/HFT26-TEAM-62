"""A2 + A3 · Response dashboard data for one case.

  plates (every vehicle, involved first) → TS police DB records → roles (victim / suspect) → suspect's FASTag
  history and post-incident trail → nearest hospitals and police → alert plan → officer approves → dispatch
  → suspect (and victims) linked in the TS police DB.

Roles are assigned by explicit rules and can be changed by the officer; a 'suspect' is a vehicle to
investigate, not a finding of fault. Hospitals get the medical picture only; police get the suspect dossier."""
import json
import os
import re
from datetime import datetime
from pathlib import Path

from . import notify, tracking, ts_police_db as db
from .custody import Ledger
from .pipeline import plate_reader

DATA = Path(__file__).resolve().parents[2] / "data" / "cases"
IST = datetime.fromisoformat("2026-01-01T00:00:00+05:30").tzinfo


def _j(p: Path, default=None):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


def incident_time(case: dict) -> tuple[datetime, str]:
    """Best available wall-clock time of the impact, and where it came from."""
    for src, text in (("burned-in clock overlay", (case.get("clock_overlay") or {}).get("value")),
                      ("case location / title", f"{case.get('location', {}).get('name', '')} {case.get('title', '')}")):
        if not text:
            continue
        m = re.search(r"(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})[ T,]+(\d{1,2}):(\d{2})", str(text))
        if m:
            d, mo, y, h, mi = map(int, m.groups())
            try:
                return datetime(y, mo, d, h, mi, tzinfo=IST), src
            except ValueError:
                pass
    if case.get("created"):
        try:
            return datetime.fromisoformat(case["created"]), "case record"
        except ValueError:
            pass
    return db.anchor(), "not in evidence (demo default)"


def location(case_dir: Path, case: dict) -> dict:
    over = _j(case_dir / "response_location.json")
    if over:
        return over | {"assumed": False, "source": "set by officer"}
    loc = case.get("location", {})
    if loc.get("lat") is not None and loc.get("lon") is not None:
        return {"name": loc.get("name", ""), "lat": loc["lat"], "lon": loc["lon"], "assumed": False, "source": "case record"}
    d = db.meta()["incident_default"]
    return d | {"assumed": True, "source": "no GPS in the evidence; demo location in Hyderabad. Set the real one on this page."}


def _roles(case_dir: Path, plates: dict, ent: dict) -> dict[str, dict]:
    """{track: {role, rule}} for every involved road user."""
    over = _j(case_dir / "roles.json", {})
    pursuit = _j(case_dir / "pursuit.json")
    fled = None
    if pursuit and pursuit.get("partial_plate"):
        rx = re.compile("^" + db.norm(pursuit["partial_plate"]).replace("?", ".") + "$")
        fled = next((v["track"] for v in plates["vehicles"] if rx.match(db.norm(v["plate"]).replace("?", "X")) or db.norm(v["plate"]) == db.norm(pursuit["partial_plate"])), None)
    out = {}
    involved = plates.get("involved") or []
    extra = [i for i in ent.get("involved", []) if i not in involved]
    for tid in involved + extra + [t for t in over if t not in involved and t not in extra]:
        if tid in over:
            out[tid] = {"role": over[tid], "rule": "set by officer"}
        elif fled:
            out[tid] = {"role": "suspect", "rule": "left the scene (hit-and-run trace matched its partial plate)"} if tid == fled else \
                       {"role": "victim", "rule": "other party in the collision"}
        elif tid == ent.get("primary"):
            out[tid] = {"role": "suspect", "rule": "striking vehicle: the faster vehicle of the colliding pair (fusion 'primary')"}
        else:
            out[tid] = {"role": "victim", "rule": "struck / endangered road user within 3 m of the impact"}
    return out


def case_contacts(case_dir: Path) -> dict:
    """Phone numbers the case links to each role: data/cases/<id>/contacts.json, else DEMO_SUSPECT_PHONE / DEMO_VICTIM_PHONE."""
    import os
    c = _j(case_dir / "contacts.json", {}) or {}
    return {"suspect": c.get("suspect") or os.getenv("DEMO_SUSPECT_PHONE") or None,
            "victim": c.get("victim") or os.getenv("DEMO_VICTIM_PHONE") or None}


def challans_for(s: dict, sev: dict, victims: list[dict]) -> list[dict]:
    """E-challans proposed from what the evidence shows (Motor Vehicles Act, 1988, as amended 2019).
    Proposed only: an officer verifies before issue."""
    vru = any(v["type"] in ("person", "motorcycle", "bicycle") for v in victims)
    out = [{"section": "Sec 184", "offence": "Driving dangerously" + (" near a pedestrian / two-wheeler" if vru else ""),
            "amount": "₹1,000-5,000", "basis": f"collision recorded on CCTV ({s['role_rule']})"},
           {"section": "Sec 134 r/w 187", "offence": "Duty to report the accident and secure medical aid",
            "amount": "up to ₹5,000", "basis": "accident with injury risk; driver must report within 24 h"}]
    return [c | {"status": "proposed · pending officer verification"} for c in out]


def _party(v: dict | None, tid: str, name: str, role: dict, incident: datetime, loc: dict, case_dir_name: str | None = None) -> dict:
    p = {"track": tid, "name": name, "role": role["role"], "role_rule": role["rule"]}
    if v is None:  # a person on foot: no registration to look up
        p.update({"type": "person", "plate": None, "record": None, "contacts": [],
                  "note": "Person on foot, no registration. Identity unknown until police / hospital confirm. Medical alert goes to hospitals."})
        return p
    plate = v["plate"]
    # partial reads are never completed from the mock registry (only the simulated demo case does that)
    cands = db.match_partial(plate) if plate and "?" in plate and "simulated" in (v.get("method") or "") else []
    resolved = cands[0]["plate"] if len(cands) == 1 else None
    rec = db.lookup(resolved or plate) if plate else None
    p.update({"legible": v.get("legible", bool(plate)), "crop": v.get("crop"), "plate_box": v.get("plate_box"), "plate_frame": v.get("frame"),
              "plate_partial": bool(v.get("partial")), "plate_known": v.get("known"), "anpr": v.get("anpr")})
    p.update({"type": v["type"], "colour": v.get("colour"), "plate": plate, "resolved_plate": resolved,
              "partial_candidates": [c["plate"] for c in cands], "plate_confidence": v["confidence"], "plate_method": v["method"],
              "plate_reads": v.get("reads", []), "record": rec, "same_owner": db.same_owner(rec["plate"]) if rec else []})
    contacts = []
    if rec:
        contacts.append({"label": f"Registered owner · {rec['owner']['name']}", "number": rec["owner"]["phone"], "kind": "owner"})
        ec = rec["emergency_contact"]
        contacts.append({"label": f"Emergency contact · {ec['name']} ({ec['relation']})", "number": ec["phone"], "kind": "family"})
    p["contacts"] = contacts
    if rec and role["role"] == "suspect":
        p["toll"] = db.toll_analysis(rec["plate"], incident, loc["lat"], loc["lon"])
        tr = tracking.status(case_dir_name) if case_dir_name else None
        if tr and tr["plate"] == rec["plate"]:
            p["toll"]["after"] = tr["sightings"]
            p["toll"]["flagged"] = [s for s in tr["sightings"] if not s["reachable"]]
            p["toll"]["last_seen_after"] = tr["last_seen"]
            p["tracking"] = {k: tr[k] for k in ("active", "sim_clock", "alerts_sent", "feed", "search_radius_km")}
        p["toll"]["funnel"] = db.toll_funnel(plate, rec["class"], rec["colour"])
        unpaid = sum(c["status"] == "unpaid" for c in rec["challans"])
        notes = [f for f in rec["flags"] if "challan" not in f.lower() and "insurance" not in f.lower()]
        if unpaid:
            notes.append(f"{unpaid} unpaid challan(s)")
        if rec["insurance"]["status"] != "Valid":
            notes.append(f"Insurance {rec['insurance']['status'].lower()} (valid till {rec['insurance']['valid_till']})")
        if rec["accident_history"]:
            notes.append(f"{len(rec['accident_history'])} earlier accident record(s)")
        p["risk_notes"] = notes
    return p


def build(case_id: str) -> dict:
    d = DATA / case_id
    case = _j(d / "case.json", {})
    ent = (_j(d / "analysis.json", {}) or {}).get("entities") or {}
    sev = _j(d / "severity.json", {}) or {}
    plates = plate_reader.run(d, roles={k: v for k, v in _j(d / "roles.json", {}).items()})
    when, when_src = incident_time(case)
    loc = location(d, case)
    names = ent.get("names", {})
    roles = {k: r for k, r in _roles(d, plates, ent).items() if r["role"] != "bystander"}
    by_track = {v["track"]: v for v in plates["vehicles"]}

    def label(tid):
        v = by_track.get(tid) or {}
        if names.get(tid):
            return names[tid]
        return f"{(v.get('colour') or '').title()} {v.get('type', '')}".strip() or tid
    parties = [_party(by_track.get(tid), tid, label(tid), r, when, loc, case_id) for tid, r in roles.items()]
    victims = [p for p in parties if p["role"] == "victim"]
    suspects = [p for p in parties if p["role"] == "suspect"]
    contacts = case_contacts(d)
    if suspects and contacts.get("suspect"):
        suspects[0]["contact"] = contacts["suspect"]
    vv = next((v for v in victims if v["type"] != "person"), victims[0] if victims else None)
    if vv is not None and contacts.get("victim"):
        vv["contact"] = contacts["victim"]
    for v in plates["vehicles"]:
        v["role"] = roles.get(v["track"], {}).get("role", "bystander")
        rec = db.lookup(v["plate"])
        v["db"] = {"owner": rec["owner"]["name"], "make_model": rec["make_model"], "flags": len(rec["flags"])} if rec else None

    allh = db.nearest(db.hospitals(), loc["lat"], loc["lon"], 20, lambda h: h["trauma"])
    hospitals = [h for h in allh if h["dist_km"] <= 15] or allh[:3]  # every trauma hospital within 15 km
    govt = db.nearest(db.hospitals(), loc["lat"], loc["lon"], 1, lambda h: h["trauma"] and h["govt"])
    if govt and not any(h["govt"] for h in hospitals):  # always alert at least one government trauma centre
        hospitals = hospitals + govt
    police = db.nearest(db.police_stations(), loc["lat"], loc["lon"], 2)
    station = police[0] if police else None
    checkpoints = []
    for c in db.nearest(list(db.plazas().values()), loc["lat"], loc["lon"], 3):
        checkpoints.append({"id": c["id"], "name": c["name"], "lat": c["lat"], "lon": c["lon"], "dist_km": c["dist_km"],
                            "eta_min": [round(c["dist_km"] / 70 * 60), round(c["dist_km"] / 30 * 60)]})
    for s_ in suspects:
        s_["challans"] = challans_for(s_, sev, victims)
    if not (d / "facilities.json").exists():  # also feeds the Golden-hour map
        (d / "facilities.json").write_text(json.dumps({"source": "TS police DB (mock), approximate coordinates", "police": police, "hospitals": hospitals}, indent=2))

    people = [p for p in parties if p["type"] in ("person", "motorcycle", "bicycle")]
    level = sev.get("level", "L?")
    sev_notify = sev.get("notify", [])
    loc_line = f"{loc['name']} ({loc['lat']:.4f}, {loc['lon']:.4f}) https://maps.google.com/?q={loc['lat']},{loc['lon']}"
    t_line = when.strftime("%d %b %Y %H:%M")
    ref = f"YATHARTH case {case_id}"
    veh_line = ", ".join(f"{p.get('colour') or ''} {p['type']}".strip() for p in parties) or "unknown"

    plan = []
    for h in hospitals:
        on = level in ("L2", "L3") or bool(people)
        plan.append({"id": f"hospital:{h['id']}", "role": "hospital", "to_label": h["name"], "to_number": h["emergency_phone"],
                     "title": f"🚑 ACCIDENT ALERT · {level} {sev.get('label', '')}".strip(),
                     "text": f"Road accident at {loc_line} at {t_line}.\nInvolved: {veh_line}.\nPeople at risk: {len(people)} "
                             f"({', '.join(p['name'] for p in people) or 'none identified'}).\nDistance {h['dist_km']} km, ETA {h['eta_min']} min. "
                             f"Police informed: {station['name'] if station else 'n/a'}. Ref {ref}.",
                     "default_on": on, "reason": ("severity " + level + " requires a hospital") if level in ("L2", "L3") else
                     ("a pedestrian / two-wheeler is involved" if people else f"not required at {level}; opt in if needed"),
                     "payload": "medical picture only (no suspect data)"})
    for s in suspects:
        rec = s["record"]
        plate = (rec or {}).get("plate") or s.get("plate")
        veh = f"{s.get('colour') or ''} {s['type']}".strip()
        contact = s.get("contact") or (rec["owner"]["phone"] if rec else None)
        facts = "; ".join(f"{i['field']}: {i['value']}" for i in ((s.get("anpr") or {}).get("plate_info") or []) if i["field"] != "Plate layout")
        status = (s.get("anpr") or {}).get("status_label")
        plate_line = (f"{plate} ({status or 'ANPR'}, unverified)" if plate else f"plate not read ({status or 'no ANPR result'})") + (f" · {facts}" if facts else "")
        if station:
            plan.append({"id": f"police:{station['id']}:{s['track']}", "role": "police", "to_label": station["name"], "to_number": station["phone"],
                         "title": f"🚓 INCIDENT + CULPRIT VEHICLE · {plate or veh}",
                         "text": f"{level} road incident at {loc_line} at {t_line}.\nCulprit vehicle: {veh} · {plate_line}.\n"
                                 + (f"Registered contact: {contact}.\n" if contact else "")
                                 + (f"Proposed e-challans: {'; '.join(c['section'] + ' ' + c['offence'] for c in s.get('challans', []))}.\n" if s.get("challans") else "")
                                 + f"Victims: {', '.join(v['name'] + (' ' + v['plate'] if v.get('plate') else '') for v in victims) or 'none identified'}.\n"
                                 + f"Checkpoints alerted: {', '.join(c['name'] for c in checkpoints) or 'none'}. Ref {ref}. Role assigned by rule ({s['role_rule']}); verify before action.",
                         "default_on": True, "reason": "culprit vehicle identified → jurisdiction police station",
                         "payload": "culprit plate + contact + challans", "link": {"plate": plate, "role": "suspect", "phone": contact} if plate else None})
        for c in checkpoints:
            plan.append({"id": f"checkpoint:{c['id']}:{s['track']}", "role": "police", "to_label": f"{c['name']} checkpoint", "to_number": None,
                         "title": f"🛑 CHECKPOINT ALERT · stop {plate or veh}",
                         "text": f"Stop and hold {veh}{' ' + plate if plate else ''} (culprit vehicle, {level} accident at {loc['name']} at {t_line}). "
                                 f"{c['dist_km']} km from the site; earliest arrival in about {c['eta_min'][0]}-{c['eta_min'][1]} min. Report to {station['name'] if station else 'control room'}. Ref {ref}.",
                         "default_on": True, "reason": "on the culprit's likely route out of the incident site", "payload": "stop-and-check request"})
        if contact:
            plan.append({"id": f"suspect:{s['track']}", "role": "suspect", "to_label": f"Culprit · registered contact of {plate or veh}", "to_number": contact,
                         "title": f"🚨 [YATHARTH DEMO] NOTICE · {plate or veh} · road accident case {case_id}",
                         "text": f"Your vehicle ({veh}{', number plate ' + plate_line if plate else ''}) is identified as the culprit vehicle in a {level} road accident at {loc['name']} on {t_line}.\n"
                                 f"Rule: {s['role_rule']}. This is under investigation, not a final finding of fault.\n"
                                 + (f"Proposed e-challans: {'; '.join(c['section'] + ' · ' + c['offence'] + ' · ' + c['amount'] for c in s.get('challans', []))}.\n" if s.get("challans") else "")
                                 + f"• Report to {station['name'] if station else 'the nearest police station'}{' (' + station['phone'] + ')' if station else ''} within 24 hours with the RC, driving licence and insurance.\n"
                                 f"• Under Section 134 of the Motor Vehicles Act, 1988 the driver must help the injured and report the accident to police.\n"
                                 f"• This number is linked to the case and checkpoints on your route have been alerted.\nRef {ref}.",
                         "default_on": True, "reason": "culprit's registered contact; linked to the case in the police DB",
                         "payload": "notice + challans", "link": {"plate": plate, "role": "suspect", "phone": contact} if plate else None})
    for v in victims:
        rec = v.get("record")
        contact = v.get("contact") or (rec["owner"]["phone"] if rec else None)
        if not contact:
            continue
        plate = (rec or {}).get("plate") or v.get("plate")
        veh = f"{v.get('colour') or ''} {v['type']}".strip()
        vfacts = "; ".join(f"{i['field']}: {i['value']}" for i in ((v.get("anpr") or {}).get("plate_info") or []) if i["field"] != "Plate layout")
        if vfacts:
            veh += f" ({vfacts})"
        help_line = f"Help dispatched: {', '.join(h['name'] + ' (ETA ' + str(h['eta_min']) + ' min)' for h in hospitals[:3])}; {station['name'] if station else 'police'} informed." if hospitals else ""
        plan.append({"id": f"victim:{v['track']}", "role": "victim", "to_label": f"Victim · registered contact of {plate or veh}", "to_number": contact,
                     "title": f"🚨 [YATHARTH DEMO] Your vehicle {plate or veh} was in a road accident",
                     "text": f"Your vehicle ({veh}{', ' + plate if plate else ''}) was involved in a road accident at {loc_line} at {t_line}. {help_line} "
                             f"The other vehicle has been identified and reported. Ref {ref}.",
                     "default_on": True, "reason": "victim's registered contact", "payload": "incident + help status",
                     "link": {"plate": plate, "role": "victim", "phone": contact} if plate else None})
        if rec:
            ec = rec["emergency_contact"]
            plan.append({"id": f"family:{v['track']}", "role": "victim", "to_label": f"Family of {rec['owner']['name']} · {ec['name']} ({ec['relation']})",
                         "to_number": ec["phone"], "title": f"🚨 {rec['owner']['name']}'s vehicle was in a road incident",
                         "text": f"{rec['owner']['name']}'s vehicle {rec['plate']} was involved in a road incident at {loc['name']} at {t_line}. {help_line} Ref {ref}.",
                         "default_on": level in ("L2", "L3") or "family" in sev_notify, "reason": "family alert (on by default from L2)", "payload": "incident + help status"})

    log = _j(d / "notifications.json", [])
    last_status = {}
    for entry in log:
        for r in entry["results"]:
            last_status[r["id"]] = r
    for item in plan:
        item["last"] = last_status.get(item["id"])

    out = {"case_id": case_id, "title": case.get("title", case_id),
           "incident": {"time": when.isoformat(timespec="minutes"), "time_source": when_src, "location": loc,
                        "severity": {k: sev.get(k) for k in ("level", "label", "score", "notify")}, "people_at_risk": len(people)},
           "plates": {"engine": plates.get("engine"), "note": plates.get("note"), "vehicles": plates["vehicles"],
                      "counts": {"vehicles": len(plates["vehicles"]), "involved": sum(v["involved"] for v in plates["vehicles"]),
                                 "registered": sum(v["registered"] for v in plates["vehicles"]),
                                 "legible": sum(not v["method"].startswith("demo") for v in plates["vehicles"])}},
           "victims": victims, "suspects": suspects,
           "facilities": {"hospitals": hospitals, "police": police, "jurisdiction": station},
           "notifications": {"channels": notify.channels(), "approval_required": True, "plan": plan, "log": log[-10:]},
           "db_links": [l for l in db.links() if l["case_id"] == case_id]}
    (d / "response.json").write_text(json.dumps(out, indent=2, default=str))
    return out


def set_role(case_id: str, track: str, role: str) -> dict:
    d = DATA / case_id
    roles = _j(d / "roles.json", {})
    roles[track] = role
    (d / "roles.json").write_text(json.dumps(roles, indent=2))
    Ledger(d / "custody.jsonl").append("role_set", track=track, role=role)
    # demo-assigned plates are drawn from the role's pool, so re-assign them
    pa = _j(d / "plates_all.json")
    if pa and any(v["track"] == track and v["method"].startswith("demo") for v in pa["vehicles"]):
        plate_reader.run(d, roles=roles, force=True)
    return build(case_id)


def set_location(case_id: str, lat: float, lon: float, name: str) -> dict:
    d = DATA / case_id
    (d / "response_location.json").write_text(json.dumps({"name": name or "Incident site", "lat": lat, "lon": lon}, indent=2))
    if (d / "facilities.json").exists() and (_j(d / "facilities.json", {}) or {}).get("source", "").startswith("TS police DB"):
        (d / "facilities.json").unlink()
    Ledger(d / "custody.jsonl").append("location_set", lat=lat, lon=lon)
    return build(case_id)


def _sms_text(p: dict, resp: dict, case_id: str) -> str:
    """Short, plain SMS (sender identified, demo-labelled, opt-out line). Long version goes to Telegram."""
    inc, fac = resp["incident"], resp["facilities"]
    when = inc["time"][11:16]
    place = inc["location"]["name"].replace(" (assumed)", "")
    st = fac.get("jurisdiction") or {}
    h = (fac.get("hospitals") or [{}])[0]
    if p["role"] == "suspect":
        veh = p["to_label"].split("of ", 1)[-1]
        return (f"YATHARTH ALERT (demo): Road accident at {place}, {when}. Vehicle {veh} registered to this number is identified as "
                f"involved. Report to {st.get('name', 'nearest police station')} within 24 h. Ref {case_id}. Reply STOP to opt out.")
    veh = p["to_label"].split("of ", 1)[-1]
    return (f"YATHARTH ALERT (demo): Your vehicle {veh} was in a road accident at {place}, {when}. Ambulance: {h.get('name', 'nearest hospital')} "
            f"ETA {h.get('eta_min', '?')} min. Police informed. Ref {case_id}.")


def dispatch(case_id: str, ids: list[str], officer: str = "Duty officer") -> dict:
    """Send every selected alert IN PARALLEL (real contacts first), measure latency, link vehicles, log to custody."""
    import time as _time
    from concurrent.futures import ThreadPoolExecutor
    t0 = _time.perf_counter()
    d = DATA / case_id
    resp = build(case_id)
    plan = {p["id"]: p for p in resp["notifications"]["plan"]}
    station = resp["facilities"]["jurisdiction"]
    contacts = {notify.digits(v) for v in case_contacts(d).values() if v}
    led = Ledger(d / "custody.jsonl")
    items = [plan[i] for i in ids if i in plan]
    items.sort(key=lambda p: p["role"] not in ("suspect", "victim"))  # perpetrator / victim first

    def one(p):
        real = p["role"] in ("suspect", "victim") and notify.digits(p["to_number"]) in contacts
        r = notify.send(p["role"], p["to_label"], p["to_number"], p["title"], p["text"],
                        sms_text=_sms_text(p, resp, case_id) if real else None, real=real)
        return p, real, r, round((_time.perf_counter() - t0) * 1000)

    with ThreadPoolExecutor(max_workers=min(16, max(1, len(items)))) as ex:
        done = list(ex.map(one, items))
    results, linked = [], []
    for p, real, r, ms in done:
        results.append({"id": p["id"], "role": p["role"], "to": p["to_label"], "number": p["to_number"], "real_recipient": real, **r,
                        "ms_after_dispatch": ms, "at": datetime.now().astimezone().isoformat(timespec="seconds")})
        led.append("alert_dispatched", id=p["id"], role=p["role"], to=p["to_label"], status=r["status"], channel=r["channel"],
                   real=real, ms=ms, approved_by=officer)
        lk = p.get("link")
        if lk and lk["plate"] not in {x["plate"] for x in linked}:
            rec = db.link_vehicle(case_id, lk["plate"], lk["role"], lk["phone"], station["name"] if station else None,
                                  f"{resp['incident']['severity'].get('level')} incident at {resp['incident']['location']['name']}")
            linked.append(rec)
            led.append("ts_police_db_linked", plate=lk["plate"], role=lk["role"])
    log = _j(d / "notifications.json", [])
    log.append({"at": datetime.now().astimezone().isoformat(timespec="seconds"), "approved_by": officer, "results": results})
    (d / "notifications.json").write_text(json.dumps(log, indent=2))
    started = None
    sus = next((l for l in linked if l["role"] == "suspect"), None)
    if sus:  # continuous tracking from the moment the police / suspect alerts are approved
        started = tracking.start(case_id, sus["plate"], datetime.fromisoformat(resp["incident"]["time"]),
                                 resp["incident"]["location"]["lat"], resp["incident"]["location"]["lon"], station,
                                 contact=sus.get("registered_phone"))["plate"]
        db.update_link(case_id, sus["plate"], status="Under tracking · awaiting first sighting")
    out = build(case_id)
    return {"results": results, "linked": linked, "tracking_started": started, "response": out}


def _detection(case_dir: Path, track: str, t0: float) -> dict | None:
    """Best plate view of a track: its largest box up to 1 s after impact. Also returns the box path (T0 seconds)
    so the website can keep the plate box on the vehicle while the video plays."""
    t = _j(case_dir / "tracks.json", {}) or {}
    tr = (t.get("tracks") or {})
    pts = tr.get(track, {}).get("points", []) if isinstance(tr, dict) else []
    pts = [p for p in pts if p.get("box")]
    if not pts:
        return None
    area = lambda p: (p["box"][2] - p["box"][0]) * (p["box"][3] - p["box"][1])
    before = [p for p in pts if p["t"] <= t0 + 1.0] or pts
    top = max(area(p) for p in before)
    best = next(p for p in before if area(p) >= 0.6 * top)  # first frame where the vehicle is close enough to read
    path = [{"t": round(p["t"] - t0, 3), "box": p["box"]} for p in pts[::2]]
    return {"t": round(best["t"] - t0, 2), "box": best["box"], "frame": best.get("f"), "path": path}


def _speed(case_dir: Path, track: str) -> float | None:
    m = _j(case_dir / "tracks_metric.json", {}) or {}
    for t in m.get("tracks", []):
        if t["id"] == track:
            v = [p["v_kmh"] for p in t["points"] if -1.5 <= p["t"] <= 0 and p.get("v_kmh") is not None]
            return round(max(v), 1) if v else None
    return None


def replay_summary(case_id: str) -> dict:
    """Everything the Evidence-replay screen needs: ANPR detections synced to the video, culprit and victim
    cards (plate crop, vehicle, contact, Telegram notice), the culprit's challans and checkpoints notified,
    and every hospital notified for the victim."""
    d = DATA / case_id
    r = build(case_id)
    case = _j(d / "case.json", {}) or {}
    t0 = case.get("t0_video_s", 0) or 0
    plan = r["notifications"]["plan"]
    tr = tracking.status(case_id)

    def st(p):
        last = p.get("last") or {}
        return {"to": p["to_label"], "number": p["to_number"], "title": p["title"], "text": p["text"],
                "status": last.get("status"), "at": last.get("at"), "channel": last.get("channel"),
                "ms": last.get("ms_after_dispatch"), "detail": last.get("detail")}

    def card(p: dict, kind: str) -> dict:
        det = _detection(d, p["track"], t0) if p["type"] != "person" else None
        if det and p.get("plate_frame") is not None:  # lock at the frame the plate was actually read
            fr = next((q for q in det["path"] if abs(q["t"] - ((p["plate_frame"] / ((case.get("video") or {}).get("fps") or 25)) - t0)) < 0.15), None)
            if fr:
                det["t"] = fr["t"]
        c = {"track": p["track"], "kind": kind, "name": p["name"], "type": p["type"], "colour": p.get("colour"), "role_rule": p["role_rule"],
             "plate": (p.get("record") or {}).get("plate") or p.get("plate"), "legible": p.get("legible", False),
             "partial": p.get("plate_partial", False), "known": p.get("plate_known"),
             "plate_confidence": p.get("plate_confidence"), "plate_method": p.get("plate_method"), "reads": len(p.get("plate_reads") or []),
             "crop": p.get("crop"), "detection": det, "contact": p.get("contact"), "speed_kmh": _speed(d, p["track"]), "note": p.get("note"),
             "anpr": p.get("anpr"), "reach": notify.reach(p.get("contact")),
             "tg_link": (f"t.me/{os.getenv('TELEGRAM_BOT_USERNAME')}" if os.getenv("TELEGRAM_BOT_USERNAME") and p.get("contact")
                         and not notify._chat_for_number(p.get("contact")) else None)}
        mine = [x for x in plan if x["id"].endswith(":" + p["track"]) or x["id"] == f"{'suspect' if kind == 'culprit' else 'victim'}:{p['track']}"]
        c["telegram"] = [st(x) for x in mine if x["role"] in ("suspect", "victim") and not x["id"].startswith("family:")]
        if kind == "culprit":
            c["challans"] = p.get("challans", [])
            c["checkpoints"] = [st(x) | {"kind": "police station" if x["id"].startswith("police:") else "toll checkpoint"} for x in mine if x["role"] == "police"]
            if tr and tr.get("plate") == c["plate"]:
                c["tracking"] = {"active": tr["active"], "last_seen": tr["last_seen"], "alerts": tr["alerts_sent"]}
        return c

    culprits = [card(p, "culprit") for p in r["suspects"]]
    victims = [card(p, "victim") for p in r["victims"]]
    hospitals = []
    for x in plan:
        if x["role"] == "hospital":
            h = next(h for h in r["facilities"]["hospitals"] if x["id"] == f"hospital:{h['id']}")
            hospitals.append(st(x) | {"name": h["name"], "govt": h["govt"], "dist_km": h["dist_km"], "eta_min": h["eta_min"]})
    for v in victims:
        v["hospitals"] = hospitals
    dispatched = any(x.get("last") for x in plan)
    alerted = {x["id"].split(":")[1]: bool(x.get("last")) for x in plan if x["role"] in ("hospital", "police") and ":" in x["id"]}
    fmap = {"incident": r["incident"]["location"],
            "hospitals": [{k: h[k] for k in ("id", "name", "lat", "lon", "dist_km", "eta_min", "govt")} | {"alerted": alerted.get(h["id"], False)} for h in r["facilities"]["hospitals"]],
            "police": [{k: s_[k] for k in ("id", "name", "lat", "lon", "dist_km", "eta_min")} | {"alerted": alerted.get(s_["id"], False)} for s_ in r["facilities"]["police"][:1]],
            "checkpoints": [{"id": c["to"], "name": c["to"], "lat": None, "lon": None, "alerted": bool(c.get("status"))} for cu in culprits for c in cu.get("checkpoints", []) if c["kind"] == "toll checkpoint"]}
    pz = db.plazas()
    for c in fmap["checkpoints"]:
        p_ = next((p for p in pz.values() if c["name"].startswith(p["name"])), None)
        c["name"] = c["name"].replace(" checkpoint", "")
        if p_:
            c["lat"], c["lon"] = p_["lat"], p_["lon"]
    return {"case_id": case_id, "video": case.get("video", {}), "t0_video_s": t0, "severity": r["incident"]["severity"], "map": fmap,
            "location": r["incident"]["location"], "incident_time": r["incident"]["time"], "anpr": r["plates"]["engine"],
            "culprits": culprits, "victims": victims, "dispatched": dispatched,
            "dispatch_ids": [p["id"] for p in plan if p["default_on"] and not p["id"].startswith("family:")],  # only the case's real contacts
            "channels": r["notifications"]["channels"]}
