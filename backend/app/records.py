"""Case records: the registry side of every case. For each vehicle in the crash (primary, the one it met, anyone who left)
and each person involved: plate, registration, insurance, driver, driving licence, emergency contact.

The people are fictional and generated deterministically from the case id, so a rebuild gives the same names. Anything the
footage did read is kept: a partial plate such as MP04PA0?02 resolves to a registered plate that fits it, never to one that
contradicts it. Phone and licence numbers are stored masked. data/fictional/live_identities.json pins the victim and the
suspect for the live feed's cases so the home page and the case agree."""
import hashlib
import json
import random
import re
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CASES = ROOT / "data" / "cases"
PINS = ROOT / "data" / "fictional" / "live_identities.json"

FIRST = ["Ravi", "Srinivas", "Mohammed", "Anil", "Lakshmi", "Priya", "Venkatesh", "Suresh", "Kavitha", "Rahul", "Sai Kiran", "Naveen",
         "Farhan", "Sravani", "Harish", "Deepika", "Prakash", "Ayesha", "Raju", "Madhavi", "Karthik", "Vamshi", "Swathi", "Imran"]
LAST = ["Reddy", "Rao", "Goud", "Yadav", "Naidu", "Sharma", "Khan", "Varma", "Chary", "Kumar", "Patel", "Siddiqui", "Mudiraj", "Prasad"]
AREAS = ["Kukatpally", "Madhapur", "Kondapur", "Gachibowli", "Miyapur", "Manikonda", "Tolichowki", "Ameerpet", "Begumpet", "Uppal",
         "LB Nagar", "Mehdipatnam", "Banjara Hills", "Chandanagar", "Serilingampally", "Nizampet"]
RTO = {"TS09": "Hyderabad (Central)", "TS07": "Ranga Reddy", "TS08": "Ranga Reddy (Medchal)", "TS10": "Secunderabad", "TS13": "Hyderabad (East)",
       "TS11": "Hyderabad (North)", "TS12": "Hyderabad (South)", "MP04": "Bhopal", "MP09": "Indore", "UP04": "Agra", "KA01": "Bengaluru (Central)"}
MODELS = {"car": ["Maruti Suzuki Swift", "Hyundai i20", "Honda City", "Maruti Suzuki Dzire", "Tata Nexon", "Hyundai Creta", "Toyota Innova", "Kia Seltos"],
          "motorcycle": ["Bajaj Pulsar 150", "Honda Shine", "Hero Splendor Plus", "TVS Apache RTR 160", "Royal Enfield Classic 350", "Honda Activa 6G"],
          "bus": ["Ashok Leyland city bus", "Tata Starbus", "Eicher Skyline"], "truck": ["Tata 407", "Ashok Leyland Dost", "Eicher Pro 2049"],
          "bicycle": ["Hero Sprint bicycle"], "auto": ["Bajaj RE auto-rickshaw"]}
INSURERS = ["New India Assurance", "ICICI Lombard", "Bajaj Allianz", "HDFC ERGO", "United India Insurance", "Tata AIG"]
RELATION = ["wife", "husband", "brother", "father", "mother", "sister", "son"]
# AI-generated portraits (data/fictional/portraits/SOURCE.md), chosen by the gender of the fictional name
PHOTOS_M = [f"M-{i:02d}.jpg" for i in range(1, 13)]
PHOTOS_F = [f"F-{i:02d}.jpg" for i in range(1, 13)]
FEMALE = {"Lakshmi", "Priya", "Kavitha", "Sravani", "Deepika", "Ayesha", "Madhavi", "Swathi"}


def _photo(r, name: str) -> str:
    return r.choice(PHOTOS_F if name.split()[0].rstrip(".") in FEMALE else PHOTOS_M)
DL_CLASS = {"car": "LMV", "motorcycle": "MCWG", "bus": "TRANS (HPMV)", "truck": "TRANS (HGMV)", "auto": "LMV-3W", "bicycle": "—"}
VEHICLES = {"car", "motorcycle", "bus", "truck", "bicycle", "auto"}


def _rng(*parts) -> random.Random:
    return random.Random(int(hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:12], 16))


def _j(p: Path, default=None):
    try:
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default
    except (OSError, ValueError):
        return default


def _phone(r):
    return f"+91 {r.choice('6789')}{r.randint(0, 9)}••• ••{r.randint(100, 999)}"


def _plate(r, read: str | None, state: str = "TS") -> str:
    """A registered plate; a partial read's known characters are kept and only the '?' are filled."""
    if read and len(read.replace("?", "")) >= 4 and re.fullmatch(r"[A-Z0-9?]{6,11}", read):
        return "".join(r.choice("0123456789") if c == "?" and (i >= len(read) - 4) else (r.choice("ABCDEFGHJKMNPRSTUVWXYZ") if c == "?" else c) for i, c in enumerate(read))
    code = r.choice(["09", "07", "08", "10", "13", "11"])
    return f"{state}{code}{r.choice('ABCDEFGHJKMNPRSTUVWXYZ')}{r.choice('ABCDEFGHJKMNPRSTUVWXYZ')}{r.randint(1000, 9999)}"


def _person(r, used: set) -> str:
    while True:
        n = f"{r.choice(FIRST)} {r.choice(LAST)}"
        if n not in used:
            used.add(n)
            return n


def _kind(cls: str) -> str:
    return {"auto_rickshaw": "auto"}.get(cls, cls)


def _vehicle(cid, tid, cls, colour, role, read, used, year_now=2026):
    r = _rng(cid, tid)
    kind = _kind(cls)
    plate = _plate(r, read)
    owner = _person(r, used)
    driver = owner if kind != "bus" and r.random() < 0.7 else _person(r, used)
    model = r.choice(MODELS.get(kind, MODELS["car"]))
    reg_year = r.randint(2012, 2024)
    dl_year = r.randint(2005, 2021)
    ins_ok = r.random() > 0.2
    return {"track": tid, "role": role, "class": kind,
            "plate": plate, "plate_read": read, "plate_basis": "resolved from the partial read" if read and "?" in read else ("read from the footage" if read else "matched in the vehicle registry"),
            "registration": {"owner": owner if kind != "bus" else f"{r.choice(['Sri Sai', 'Lakshmi', 'Venkateswara'])} Travels", "vehicle": f"{(colour or '').title()} {model}".strip(),
                             "rto": RTO.get(plate[:4], "Hyderabad"), "registered": str(reg_year), "fuel": r.choice(["Petrol", "Diesel", "CNG"]) if kind != "motorcycle" else "Petrol",
                             "insurance": f"{r.choice(INSURERS)} · valid till {r.choice(['Jan', 'Mar', 'Jun', 'Aug', 'Nov'])} {year_now + r.randint(0, 2)}" if ins_ok else f"Expired {r.choice(['Feb', 'May', 'Sep'])} {year_now - 1}",
                             "insurance_ok": ins_ok, "puc": "Valid" if r.random() > 0.15 else "Expired", "pending_challans": r.choice([0, 0, 0, 1, 2, 3]),
                             "emergency_contact": _phone(r), "contact_relation": r.choice(RELATION), "address_area": r.choice(AREAS)},
            "driver": {"name": driver, "age": r.randint(21, 62), "dl_no": f"{plate[:4]} {dl_year} •••{r.randint(1000, 9999)}", "class": DL_CLASS.get(kind, "LMV"),
                       "valid_till": f"{dl_year + 20}-{r.randint(1, 12):02d}-{r.randint(1, 28):02d}", "blood_group": r.choice(["O+", "B+", "A+", "AB+", "O-"]),
                       "photo": _photo(r, driver), "phone": _phone(r), "owner_is_driver": driver == owner,
                       "face_match": round(r.uniform(0.66, 0.88), 2)}}


def build(case_dir: Path) -> dict:
    """Write records.json for one case and return it."""
    cid = case_dir.name
    ent = _j(case_dir / "entities.json", {}) or {}
    purs = _j(case_dir / "pursuit.json", {}) or {}
    plates = _j(case_dir / "plates.json", {}) or {}
    ui = {t["id"]: t for t in (_j(case_dir / "tracks_ui.json", {}) or {}).get("tracks", [])}
    names = ent.get("names", {})
    pin = (_j(PINS, {}) or {}).get(cid) or {}
    # what the footage itself read (rows this module added earlier carry the partial read, not a reading)
    read = {v["track"]: (v.get("partial") if v.get("source") == "registry" else v.get("plate")) for v in plates.get("vehicles", []) if v.get("track")}
    left = [v["track"] for v in purs.get("vehicles", []) if v.get("status") == "left_view"]
    prim = ent.get("primary")
    involved = [i for i in ent.get("involved", []) if i]
    cls = lambda tid: _kind((ui.get(tid) or {}).get("class") or ("car" if str(tid).startswith("car") else str(tid).split("_")[0]))
    if not ent and cid == "demo":   # the synthetic case has no tracks: car A was hit, car B left
        prim, involved, left = "car_B", ["car_A"], ["car_B"]
        names = {"car_A": "White hatchback", "car_B": "Red sedan"}
    key = [t for t in dict.fromkeys([prim, *involved, *left]) if t and (cls(t) in VEHICLES or t == "ego")]
    people = [t for t in involved if cls(t) == "person"]
    # who was hurt, who to chase
    others = [t for t in key if t != prim]
    victim = next((t for t in others if t not in left), None) or (others[0] if others else None)
    if people and (not victim or pin.get("plate") is None and pin.get("licence")):
        victim = people[0]
    victim = victim or prim
    suspect = next((t for t in left if t != victim), None)
    used: set = set()
    vehicles = []
    for tid in key:
        colour = (ui.get(tid) or {}).get("colour_name") or (names.get(tid, "").split(" ")[0].lower() if names.get(tid) else None)
        c = "motorcycle" if tid == "ego" and "motor" in json.dumps(_j(case_dir / "case_hint.json", {}) or {}) else ("car" if tid == "ego" else cls(tid))
        role = "victim" if tid == victim else "suspect" if tid == suspect else "primary" if tid == prim else "involved"
        v = _vehicle(cid, tid, c, colour, role, read.get(tid) or (purs.get("partial_plate") if tid == suspect else None), used)
        v["name"] = (names.get(tid) or tid).replace(" (primary)", "")
        v["left_scene"] = tid in left
        if role == "victim" and pin.get("plate"):
            reg, lic = pin.get("registration") or {}, pin.get("licence") or {}
            v["plate"], v["plate_basis"] = pin["plate"], v["plate_basis"]
            v["registration"].update({k: reg[k] for k in ("owner", "vehicle", "rto", "insurance", "emergency_contact") if reg.get(k)})
            v["driver"].update({"name": lic.get("holder", v["driver"]["name"]), "dl_no": lic.get("dl_no", v["driver"]["dl_no"]), "class": lic.get("class", v["driver"]["class"]),
                                "valid_till": lic.get("valid_till", v["driver"]["valid_till"]), "photo": lic.get("photo", v["driver"]["photo"]), "face_match": pin.get("face_match", v["driver"]["face_match"])})
            v["driver"]["owner_is_driver"] = v["driver"]["name"] == v["registration"]["owner"]
            v["registration"]["insurance_ok"] = "expired" not in v["registration"]["insurance"].lower()
        if role == "suspect" and pin.get("suspect"):
            s = pin["suspect"]
            v["plate"], v["plate_read"] = s.get("resolved", v["plate"]), s.get("plate", v["plate_read"])
            v["plate_basis"] = "resolved from the partial read"
            v["registration"].update({"owner": s.get("owner", v["registration"]["owner"]), "vehicle": s.get("vehicle", v["registration"]["vehicle"])})
            v["driver"].update({"photo": s.get("photo", v["driver"]["photo"]), "name": s.get("owner", v["driver"]["name"]), "owner_is_driver": True})
        vehicles.append(v)
    persons = []
    for tid in people:
        r = _rng(cid, tid, "person")
        lic = pin.get("licence") if victim == tid else None
        name = (lic or {}).get("holder") or _person(r, used)
        persons.append({"track": tid, "role": "victim" if tid == victim else "involved", "name": name, "age": r.randint(24, 58),
                        "description": pin.get("victim") if victim == tid else (names.get(tid) or "Pedestrian"),
                        "identified_by": "duty roster (on-duty constable)" if "constable" in str(pin.get("victim", "")).lower() and victim == tid else "documents at the scene",
                        "phone": _phone(r), "emergency_contact": _phone(r), "contact_relation": r.choice(RELATION), "blood_group": r.choice(["O+", "B+", "A+"]),
                        "photo": (lic or {}).get("photo") or _photo(r, name), "licence": lic})
    out = {"case": cid, "victim": victim, "suspect": suspect, "vehicles": vehicles, "people": persons,
           "note": "Registry records for this case. People are fictional; numbers are shown masked."}
    (case_dir / "records.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    _merge_plates(case_dir, vehicles)
    index.cache_clear()
    return out


def _merge_plates(case_dir: Path, vehicles: list[dict]):
    """plates.json lists every recorded vehicle: footage reads stay as they are; the rest are marked as registry matches."""
    p = case_dir / "plates.json"
    plates = _j(p, {"vehicles": [], "checked": []}) or {"vehicles": [], "checked": []}
    have = {v.get("track"): v for v in plates.get("vehicles", [])}
    for v in vehicles:
        cur = have.get(v["track"])
        if cur and cur.get("plate") and "?" not in cur["plate"]:
            continue
        row = {"track": v["track"], "plate": v["plate"], "confidence": 0.9 if v["plate_read"] else 0.8, "reads": (cur or {}).get("reads", []),
               "partial": v["plate_read"], "basis": v["plate_basis"], "source": "registry"}
        if cur:
            cur.update(row)
        else:
            plates.setdefault("vehicles", []).append(row)
    p.write_text(json.dumps(plates, indent=2), encoding="utf-8")


@lru_cache(maxsize=1)
def index() -> dict:
    """plate -> {registration..., driver..., case} over every case's records."""
    out = {}
    for f in CASES.glob("*/records.json"):
        rec = _j(f, {}) or {}
        for v in rec.get("vehicles", []):
            out[v["plate"]] = {**v["registration"], "driver": v["driver"], "case": rec.get("case"), "track": v["track"], "telegram_chat_id": None}
    return out


def load(case_dir: Path) -> dict | None:
    return _j(case_dir / "records.json")


def live_identity(case_dir: Path) -> dict | None:
    """The shape the live feed uses: victim, plate, registration, licence, face match, suspect."""
    rec = load(case_dir)
    if not rec:
        return None
    vic = next((v for v in rec["vehicles"] if v["track"] == rec["victim"]), None)
    per = next((p for p in rec["people"] if p["track"] == rec["victim"]), None)
    sus = next((v for v in rec["vehicles"] if v["track"] == rec.get("suspect")), None)
    out = {}
    if vic:
        d = vic["driver"]
        out = {"victim": f"Driver of the {vic['name'].lower()}" if vic["class"] != "motorcycle" else f"Rider of the {vic['name'].lower()}",
               "plate": vic["plate"], "registration": {k: vic["registration"][k] for k in ("owner", "vehicle", "rto", "insurance", "emergency_contact")},
               "licence": {"dl_no": d["dl_no"], "holder": d["name"], "class": d["class"], "valid_till": d["valid_till"], "photo": d["photo"]}, "face_match": d["face_match"]}
    elif per:
        out = {"victim": per["description"], "plate": None, "registration": None,
               "licence": per["licence"] or {"dl_no": "—", "holder": per["name"], "class": "—", "valid_till": "—", "photo": per["photo"]}, "face_match": 0.8}
    if sus:
        out["suspect"] = {"plate": sus["plate_read"] or sus["plate"], "resolved": sus["plate"], "vehicle": sus["registration"]["vehicle"],
                          "owner": sus["registration"]["owner"], "last_seen": "Left the scene after the impact", "photo": sus["driver"]["photo"]}
    return out
