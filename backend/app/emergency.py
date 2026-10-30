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
    return {"level": level, "label": sev.get("label"), "score": sev.get("score"), "breakdown": sev.get("breakdown", []), "notify": sev.get("notify", []),
            "units": units, "scene": seen, "nearest": nearest, "location": case.get("location", {}), "clock_at_impact": _clock_at_impact(case), "started": state["started"], "log": state["log"],
            "golden_hour_s": GOLDEN_HOUR_S, "injury_note": "This rates the crash, not injuries. Only a responder at the scene can assess a person.",
            "channel": "telegram" if os.getenv("TELEGRAM_BOT_TOKEN") and os.getenv("AUTHORITY_CHAT_ID") else "simulated"}


def _clock_at_impact(case: dict) -> str | None:
    clk = case.get("clock_overlay")
    if not clk:
        return None
    from datetime import timedelta
    try:
        t = datetime.strptime(clk["value"], "%H:%M:%S") + timedelta(seconds=case["t0_video_s"] - clk["at_video_s"])
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
