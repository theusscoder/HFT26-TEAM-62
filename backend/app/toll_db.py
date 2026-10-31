"""Toll-booth captures: plate, time, place and the photo a booth took of the driver. Keyed by plate.

The database here is FICTIONAL: invented plates, invented people, and drawn placeholders instead of photographs.
A real one needs a lawful source and a legal basis for processing biometric-grade data, which a demo doesn't have.

This looks a record up by its plate. It never compares faces. A booth photo shows who was at that booth at that time,
which doesn't establish who was driving at the crash, and every result says so. Nothing leaves the system until a named
officer has reviewed the record and confirmed, and each notification goes in the custody ledger."""
import json
import os
import re
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
FICTIONAL = ROOT / "data" / "fictional"
DB = FICTIONAL / "toll_captures.json"
IMAGES = FICTIONAL / "driver_images"
CAVEAT = "This photo shows who was at this booth at this time. It does not establish who was driving at the crash."
AUTHORITIES = ("Police control room", "Highway patrol", "Traffic investigation unit")


def load() -> list[dict]:
    return json.loads(DB.read_text(encoding="utf-8")) if DB.exists() else []


def _pattern(plate: str) -> re.Pattern:
    return re.compile("^" + re.escape(plate.upper().replace(" ", "")).replace(r"\?", ".") + "$")


def search(plates: list[str]) -> dict:
    """Every capture whose plate fits a searched plate. '?' stands for a character the camera couldn't read."""
    records, matches, seen = load(), [], set()
    for plate in plates:
        rx = _pattern(plate)
        for rec in records:
            if rec["id"] not in seen and rx.match(rec["plate"]):
                seen.add(rec["id"])
                matches.append({**rec, "searched": plate, "exact": "?" not in plate})
    return {"searched": plates, "matches": matches, "fictional": True, "caveat": CAVEAT, "authorities": AUTHORITIES,
            "method": "lookup by plate; no face matching"}


LICENCES = FICTIONAL / "licences.json"


def licences_for(plates: list[str]) -> list[dict]:
    """The registered owner's driving licence for each exactly-read plate. The owner may not be the driver."""
    from . import alerts
    recs = json.loads(LICENCES.read_text(encoding="utf-8")) if LICENCES.exists() else {}
    out = []
    for p in plates:
        reg = alerts.lookup(p) or {} if "?" not in p else {}
        drv = reg.get("driver") or {}
        lic = {"dl_no": drv["dl_no"], "holder": drv["name"], "class": drv["class"], "valid_till": drv["valid_till"], "photo": drv["photo"],
               "issued_by": f"RTA {reg.get('rto', 'Hyderabad')}", "age": drv.get("age"), "blood_group": drv.get("blood_group"),
               "owner": reg.get("owner"), "owner_is_driver": drv.get("owner_is_driver")} if drv else recs.get(p)
        if "?" in p or not lic:
            continue
        out.append({"plate": p, **lic, "vehicle": reg.get("vehicle"), "insurance": reg.get("insurance"), "fictional": True,
                    "caveat": "The registered owner may not be the driver. The face check compares this licence photo with the footage, one to one."})
    return out


def plates_of(case_dir: Path) -> list[str]:
    found = []
    p = case_dir / "plates.json"
    if p.exists():
        found += [v["plate"] for v in json.loads(p.read_text(encoding="utf-8")).get("vehicles", []) if v.get("plate")]
    p = case_dir / "pursuit.json"
    if p.exists():
        pursuit = json.loads(p.read_text(encoding="utf-8"))
        found += [x for x in [(pursuit.get("match") or {}).get("plate"), pursuit.get("partial_plate")] if x]
    return list(dict.fromkeys(found))


def notify(case_id: str, capture: dict, officer: str, authority: str) -> dict:
    """Telegram if a channel is configured; otherwise simulated, and it says so. Never automatic."""
    text = (f"YATHARTH case {case_id}: vehicle {capture['plate']} ({capture['colour']} {capture['class']}) last captured at {capture['plaza']}, "
            f"{capture['time']}, FASTag {capture['fastag']}. Reviewed and sent by {officer}. Unverified: for authorised follow-up. {CAVEAT}")
    token, chat = os.getenv("TELEGRAM_BOT_TOKEN"), os.getenv("AUTHORITY_CHAT_ID")
    if not (token and chat):
        return {"status": "simulated", "to": authority, "text": text}
    r = httpx.post(f"https://api.telegram.org/bot{token}/sendMessage", json={"chat_id": chat, "text": text}, timeout=10)
    return {"status": "sent" if r.is_success else "failed", "to": authority, "text": text}
