"""The operations centre behind the police and hospital dashboards. One shared timeline, so both sides see the same thing:

- the dispatch agent assigns officers from the nearest stations to each incident (by road time), and the intercept agent
  assigns its units to a fleeing vehicle; each officer has a call sign, a patrol vehicle and a status that changes as the
  incident unfolds (assigned, en route, on scene, pursuing <plate>, suspect stopped, at hospital);
- the assigned officer issues the police intimation and the treat-first certificate (Parmanand Katara v. Union of India)
  the moment the crash is confirmed, so it reaches the receiving hospital before the ambulance does;
- the hospital acknowledges (bed ready, team) and the acknowledgement shows on the police side.

The incidents repeat on a cycle so the boards are always live. Officers and patients are fictional; positions follow the
road network."""
import json
import time
from functools import lru_cache
from pathlib import Path

from . import incident_ops, records
from .records import _rng, FIRST, LAST

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / "data" / "ops"
ACKS = STATE / "hospital_acks.json"
GAP_S = 50.0            # a new incident every 50 s of cycle time
RANKS = [("Inspector", "INS"), ("Sub-Inspector", "SI"), ("Asst. Sub-Inspector", "ASI"), ("Head Constable", "HC"), ("Constable", "PC")]
STARTED = time.time()


def _officers(stations: list[dict]) -> list[dict]:
    out = []
    for si, st in enumerate(stations):
        r = _rng("station", st["name"])
        short = "".join(w[0] for w in st["name"].split() if w[0].isalpha())[:3].upper() or "PS"
        for k in range(3):
            rank, ab = [RANKS[r.choice([0, 1])], RANKS[r.choice([2, 3])], RANKS[4]][k]
            out.append({"id": f"{short}-{si + 1}{k + 1}", "name": f"{r.choice(FIRST)} {r.choice(LAST)}", "rank": rank, "rank_short": ab,
                        "station": st["name"], "lat": st["lat"], "lon": st["lon"], "call_sign": f"{short} {si + 1}{k + 1}",
                        "vehicle": f"TS09PA{r.randint(1000, 9999)}" if k < 2 else "Bike patrol", "phone": f"+91 94••• ••{r.randint(100, 999)}"})
    return out


@lru_cache(maxsize=1)
def build() -> dict:
    data = incident_ops.run()
    sc = data["scenarios"]
    stations = sc[0]["stations"] if sc else []
    officers = _officers(stations)
    free_at = {o["id"]: -1.0 for o in officers}   # cycle time each officer is free again
    by_station = {}
    for o in officers:
        by_station.setdefault(o["station"], []).append(o)
    incidents, assignments, log = [], [], []
    for i, s in enumerate(sc):
        off = i * GAP_S
        rec = records.load(incident_ops.live.CASES / s["id"]) or {}
        vic = next((v for v in rec.get("vehicles", []) if v["track"] == rec.get("victim")), None)
        per = next((p for p in rec.get("people", []) if p["track"] == rec.get("victim")), None)
        sus = next((v for v in rec.get("vehicles", []) if v["track"] == rec.get("suspect")), None)
        crew = []
        free = {k: v <= off for k, v in free_at.items()}
        # scene patrols: the agent's nearest stations by road, one officer each (the senior first)
        for p in s["police"]:
            o = next((o for o in by_station.get(p["name"], []) if free[o["id"]]), None) or next((o for o in officers if free[o["id"]]), None)
            if o:
                free[o["id"]], free_at[o["id"]] = False, off + s["end"]
                crew.append({"officer": o["id"], "role": "scene", "keys": p["keys"], "arrive": p["arrive"], "eta_s": p["eta_s"],
                             "why": f"nearest free officer by road from {p['name']}, {p['eta_s'] / 60:.1f} min"})
        # pursuit units: the intercept agent's plan; each unit is crewed by the nearest free officer
        if s["flee"]:
            for u in s["flee"]["units"]:
                st = min(stations, key=lambda q: (q["lat"] - u["keys"][0][1]) ** 2 + (q["lon"] - u["keys"][0][2]) ** 2)
                o = next((o for o in by_station.get(st["name"], []) if free[o["id"]]), None) or next((o for o in officers if free[o["id"]]), None)
                if o:
                    free[o["id"]], free_at[o["id"]] = False, off + s["end"]
                    crew.append({"officer": o["id"], "role": u["role"], "keys": u["keys"], "arrive": u["keys"][-1][0], "unit": u["name"],
                                 "why": f"intercept plan: {u['role']}"})
        lead = crew[0]["officer"] if crew else None
        t_cert = incident_ops.T_NOTIFY + 12
        amb = s["ambulance"] or {}
        victim = ({"name": vic["driver"]["name"], "age": vic["driver"]["age"], "blood_group": vic["driver"]["blood_group"], "vehicle": vic["registration"]["vehicle"],
                   "plate": vic["plate"], "contact": vic["registration"]["emergency_contact"], "relation": vic["registration"]["contact_relation"], "photo": vic["driver"]["photo"],
                   "licence": vic["driver"]["dl_no"]} if vic else
                  {"name": per["name"], "age": per["age"], "blood_group": per["blood_group"], "vehicle": "on foot", "plate": None, "contact": per["emergency_contact"],
                   "relation": per["contact_relation"], "photo": per["photo"], "licence": (per.get("licence") or {}).get("dl_no")} if per else None)
        level = s["card"]["level"] or "L2"
        incidents.append({"id": s["id"], "offset_s": off, "end_s": s["end"], "title": s["card"]["title"], "place": s["card"]["place"], "level": level,
                          "label": s["card"].get("label"), "crash": s["crash"], "phases": s["phases"], "log": s["log"], "fled": s["fled"],
                          "flee": {"keys": s["flee"]["keys"], "outcome": s["flee"]["outcome"]} if s["flee"] else None,
                          "suspect": {"plate": sus["plate"], "read": sus["plate_read"], "vehicle": sus["registration"]["vehicle"], "owner": sus["registration"]["owner"]} if sus else None,
                          "victim": victim, "ambulance": amb, "hospital": amb.get("from"), "hospitals_alerted": [h["name"] for h in s["hospitals"]],
                          "crew": crew, "lead": lead, "intimation": f"PI-{s['id'][:6].upper()}-{1000 + i * 37}", "t_cert": t_cert,
                          "certificate_url": f"/api/ops/certificate/{s['id']}.html",
                          "triage": {"L3": "Red · immediate", "L2": "Yellow · urgent", "L1": "Green · minor"}.get(level, "Green · minor"),
                          "injuries": "Suspected head and chest trauma" if level == "L3" else "Suspected fractures, abrasions" if level == "L2" else "Minor injuries, under observation"})
        for c in crew:
            o = next(o for o in officers if o["id"] == c["officer"])
            log.append({"incident": s["id"], "t": incident_ops.T_NOTIFY + (2 if c["role"] == "scene" else 0), "agent": "Dispatch",
                        "text": f"{o['rank_short']} {o['name']} ({o['call_sign']}) assigned to {s['card']['place']}: {c['why']}."})
    hospitals = sorted({h for inc in incidents for h in inc["hospitals_alerted"]})
    cycle = max(inc["offset_s"] + inc["end_s"] for inc in incidents) + 20 if incidents else 300
    return {"officers": officers, "incidents": incidents, "hospitals": hospitals, "cycle_s": round(cycle, 1), "log": log,
            "stations": stations, "t_notify": incident_ops.T_NOTIFY}


def acks() -> dict:
    try:
        return json.loads(ACKS.read_text(encoding="utf-8")) if ACKS.exists() else {}
    except ValueError:
        return {}


def cycle_no(now: float | None = None) -> int:
    return int(((now or time.time()) - STARTED) // build()["cycle_s"])


def ack(case_id: str, hospital: str, by: str, bed: str, note: str = "") -> dict:
    STATE.mkdir(parents=True, exist_ok=True)
    a = acks()
    a[case_id] = {"hospital": hospital, "by": by, "bed": bed, "note": note, "time": time.time(), "cycle": cycle_no()}
    ACKS.write_text(json.dumps(a, indent=2), encoding="utf-8")
    try:   # and the case's own response timeline records the acceptance
        from . import response_timeline
        d = ROOT / "data" / "cases" / case_id
        if (d / "response_timeline.json").exists():
            response_timeline.act(d, "accepted", f"{hospital} · {by}", f"{bed} ready")
    except Exception:
        pass
    from . import notify   # the police control room hears it on Telegram too
    inc = next((i for i in build()["incidents"] if i["id"] == case_id), {})
    a[case_id]["telegram"] = notify.send("police", "YATHARTH · hospital confirmation", None, f"🏥 {hospital}: bed ready",
                                         f"{bed} ready for the patient from {inc.get('place', case_id)}. Confirmed by {by}.")["status"]
    return a[case_id]


def certificate_html(case_id: str) -> str:
    """The treat-first certificate the lead officer issued for this incident, as the hospital receives it."""
    import html
    from datetime import datetime
    from .emergency import KATARA
    b = build()
    inc = next((i for i in b["incidents"] if i["id"] == case_id), None)
    if not inc:
        return "<p>No such incident.</p>"
    o = next((o for o in b["officers"] if o["id"] == inc["lead"]), {})
    issued = datetime.fromtimestamp(STARTED + cycle_no() * b["cycle_s"] + inc["offset_s"] + inc["t_cert"]).strftime("%d %b %Y, %H:%M:%S")
    v = inc["victim"] or {}
    rows = [("Reference", f"AC-{inc['intimation'][3:]}"), ("Police intimation", inc["intimation"]), ("Issued", issued + " IST"),
            ("Issued by", f"{o.get('rank', '')} {o.get('name', '')}, {o.get('station', '')} ({o.get('call_sign', '')})"), ("To", inc["hospital"] or "Receiving hospital"),
            ("Location", inc["place"] + ", Hyderabad"), ("Crash severity", f"{inc['level']} · {inc.get('label') or ''}"), ("Patient", f"{v.get('name', 'Unknown')}, {v.get('age', '')} · blood group {v.get('blood_group', '?')}"),
            ("Vehicle", f"{v.get('vehicle', '')} {v.get('plate') or ''}"), ("Triage on scene", inc["triage"]), ("Reported injuries", inc["injuries"])]
    body = "".join(f"<tr><th>{html.escape(k)}</th><td>{html.escape(str(val))}</td></tr>" for k, val in rows)
    return ("<!doctype html><html><head><meta charset='utf-8'><title>Accident certificate</title><style>body{font-family:Helvetica,Arial,sans-serif;max-width:46rem;margin:2rem auto;color:#111}"
            "h1{font-size:1.5rem;border-bottom:3px solid #111;padding-bottom:.4rem}th{text-align:left;padding:.35rem 1rem .35rem 0;color:#555;font-weight:500;vertical-align:top}td{padding:.35rem 0}"
            ".k{border:2px solid #e30613;padding:1rem;margin-top:1.4rem}.s{margin-top:2rem;border-top:1px solid #999;padding-top:.5rem;color:#333}</style></head><body>"
            "<h1>Accident certificate for immediate treatment</h1><p>The police have been informed of this road accident. Treat the injured now; the FIR and medico-legal formalities follow.</p>"
            f"<table>{body}</table><p class='k'>{html.escape(KATARA)}</p><p class='s'>Digitally issued by {html.escape(o.get('name', ''))}, {html.escape(o.get('station', ''))}</p></body></html>")


def snapshot() -> dict:
    """Everything both dashboards need, plus the server clock they share."""
    c = cycle_no()
    return {**build(), "started_at": STARTED, "server_now": time.time(), "cycle_no": c, "acks": {k: v for k, v in acks().items() if v.get("cycle") == c}}
