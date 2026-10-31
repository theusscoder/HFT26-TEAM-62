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
PHOTO_AGE = {"M-01.jpg": 24, "M-02.jpg": 30, "M-03.jpg": 32, "M-04.jpg": 38, "M-05.jpg": 25, "M-06.jpg": 38, "M-07.jpg": 28, "M-08.jpg": 27, "M-09.jpg": 36, "M-10.jpg": 36, "M-11.jpg": 42, "M-12.jpg": 56, "F-01.jpg": 26, "F-02.jpg": 30, "F-03.jpg": 25, "F-04.jpg": 28, "F-05.jpg": 43, "F-06.jpg": 27, "F-07.jpg": 33, "F-08.jpg": 29, "F-09.jpg": 26, "F-10.jpg": 52, "F-11.jpg": 41, "F-12.jpg": 31}   # how old each portrait looks, so a record's age fits its photo
# A first name and surname have to belong together: no "Srinivas Siddiqui" or "Mohammed Kumar"
MUSLIM_FIRST = {"Mohammed", "Farhan", "Imran", "Ayesha"}
MUSLIM_SURNAMES = ["Khan", "Siddiqui", "Ali", "Ahmed", "Shaik"]
SURNAME_FOR_OTHERS = {"Khan": "Reddy", "Siddiqui": "Rao", "Patel": "Goud"}
FAMILY_FIRST = {(False, False): ["Ravi", "Srinivas", "Anil", "Venkatesh", "Suresh", "Naveen"], (False, True): ["Lakshmi", "Priya", "Kavitha", "Sravani", "Madhavi", "Swathi"],
                (True, False): ["Mohammed", "Farhan", "Imran", "Salman"], (True, True): ["Ayesha", "Fatima", "Sana", "Nazia"]}   # (Muslim family, female)


def full_name(first: str, last: str) -> str:
    if first in MUSLIM_FIRST:
        return f"{first} {MUSLIM_SURNAMES[LAST.index(last) % len(MUSLIM_SURNAMES)]}"
    if first in FEMALE and last == "Kumar":
        last = "Reddy"
    return f"{first} {SURNAME_FOR_OTHERS.get(last, last)}"


def random_name(r) -> str:
    return full_name(r.choice(FIRST), r.choice(LAST))


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
        n = random_name(r)
        if n not in used:
            used.add(n)
            return n


def _free_photo(photo: str, taken: set) -> str:
    """This portrait, or the next of the same gender if someone in the case already has it."""
    pool = PHOTOS_F if photo in PHOTOS_F else PHOTOS_M
    i = pool.index(photo) if photo in pool else 0
    return next((p for p in pool[i:] + pool[:i] if p not in taken), photo)


def _age_of(photo: str, drawn: int) -> int:
    """The age a portrait looks, give or take a couple of years so two people with one face differ."""
    return PHOTO_AGE[photo] + drawn % 5 - 2 if photo in PHOTO_AGE else drawn


def _fit_age(driver: dict, year_now: int):
    """A licence can't predate its holder turning 18, so the issue year follows the age the photo gives."""
    age = _age_of(driver["photo"], driver["age"])
    m = re.match(r"(\S+ )(\d{4})( .*)", driver["dl_no"])
    if m and int(m[2]) < year_now - age + 18:
        year = year_now - age + 18
        driver["dl_no"] = f"{m[1]}{year}{m[3]}"
        driver["valid_till"] = f"{year + 20}{driver['valid_till'][4:]}"


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
                             "insurance": f"{r.choice(INSURERS)} · valid till {r.choice(['Jan', 'Mar', 'Jun', 'Aug', 'Nov'])} {year_now + r.randint(1, 2)}" if ins_ok else f"Expired {r.choice(['Feb', 'May', 'Sep'])} {year_now - 1}",
                             "insurance_ok": ins_ok, "puc": "Valid" if r.random() > 0.15 else "Expired", "pending_challans": r.choice([0, 0, 0, 1, 2, 3]),
                             "emergency_contact": _phone(r), "contact_relation": r.choice(RELATION), "address_area": r.choice(AREAS)},
            "driver": {"name": driver, "age": r.randint(21, 62), "dl_no": f"{plate[:4]} {dl_year} •••{r.randint(1000, 9999)}", "class": DL_CLASS.get(kind, "LMV"),
                       "valid_till": f"{dl_year + 20}-{r.randint(1, 12):02d}-{r.randint(1, 28):02d}", "blood_group": r.choice(["O+", "B+", "A+", "AB+", "O-"]),
                       "photo": _photo(r, driver), "phone": _phone(r), "owner_is_driver": driver == owner,
                       "face_match": round(r.uniform(0.66, 0.88), 2)}}


COLOURS = ("white", "silver", "grey", "gray", "black", "red", "blue", "green", "yellow", "orange", "brown", "purple", "beige", "maroon", "gold")
NAME_KIND = (("auto-rickshaw", "auto"), ("auto rickshaw", "auto"), ("rickshaw", "auto"), ("bus", "bus"), ("truck", "truck"), ("lorry", "truck"),
             ("van", "car"), ("motorcycle", "motorcycle"), ("scooter", "motorcycle"), ("bike", "motorcycle"), ("bicycle", "bicycle"), ("car", "car"))


def _recolour(desc: str, colour: str | None) -> str:
    """A registry description must agree with the colour the case saw ("Black Honda Shine" for a silver bike is wrong)."""
    if not colour or not desc:
        return desc
    words = desc.split()
    if words and words[0].lower() in COLOURS:
        words = words[1:]
    return f"{colour.title()} {' '.join(words)}".strip()


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
    def cls(tid):
        nm = (names.get(tid) or "").lower()
        # what the case calls it (the vision model's word) beats the detector's class: YOLO calls buses and autos "car"
        named = next((k for w, k in NAME_KIND if w in nm), None)
        if named:
            return named
        if tid == "ego":
            return "car"
        return _kind((ui.get(tid) or {}).get("class") or ("car" if str(tid).startswith("car") else str(tid).split("_")[0]))
    if not ent and cid == "demo":   # the synthetic case has no tracks: car A was hit, car B left
        prim, involved, left = "car_B", ["car_A"], ["car_B"]
        names = {"car_A": "White hatchback", "car_B": "Red sedan"}
    key = [t for t in dict.fromkeys([prim, *involved, *left]) if t and (cls(t) in VEHICLES or t == "ego")]
    people = [t for t in involved if cls(t) == "person"]
    # who was hurt: a person on foot, then a rider (motorcycle, bicycle), then the vehicle that was struck. Being the
    # "primary" (the faster of the pair) says nothing about fault: a rider who runs into a car that cut in is the victim.
    others = [t for t in key if t != prim]
    riders = [t for t in key if cls(t) in ("motorcycle", "bicycle")]
    victim = (people[0] if people else None) or (riders[0] if riders else None) \
        or next((t for t in others if t not in left), None) or (others[0] if others else None) or prim
    suspect = next((t for t in left if t != victim), None)
    dc = _j(case_dir / "dashcam.json", {}) or {}
    hazard = dc.get("hazard") if dc.get("hazard") in key and dc.get("hazard") not in (victim, suspect) else None
    ins = _j(case_dir / "insights.json", []) or []
    hazard_note = next((k["title"] for k in ins if k.get("actor") == hazard and "lane" in k.get("title", "")), None) if hazard else None
    used: set = set()
    vehicles = []
    for tid in key:
        first = (names.get(tid) or "").split(" ")[0].lower()
        colour = first if first in COLOURS else (ui.get(tid) or {}).get("colour_name")   # the case's name first, so they agree
        c = cls(tid)
        role = "victim" if tid == victim else "suspect" if tid == suspect else "hazard" if tid == hazard else "primary" if tid == prim else "involved"
        v = _vehicle(cid, tid, c, colour, role, read.get(tid) or (purs.get("partial_plate") if tid == suspect else None), used)
        v["name"] = (names.get(tid) or tid).replace(" (primary)", "")
        v["left_scene"] = tid in left
        if role == "hazard":
            v["note"] = hazard_note or "The vehicle ahead"
        if role == "victim" and pin.get("plate"):
            reg, lic = pin.get("registration") or {}, pin.get("licence") or {}
            v["plate"], v["plate_basis"] = pin["plate"], v["plate_basis"]
            v["registration"].update({k: reg[k] for k in ("owner", "vehicle", "rto", "insurance", "emergency_contact") if reg.get(k)})
            v["registration"]["vehicle"] = _recolour(v["registration"]["vehicle"], colour)
            v["driver"].update({"name": lic.get("holder", v["driver"]["name"]), "dl_no": lic.get("dl_no", v["driver"]["dl_no"]), "class": lic.get("class", v["driver"]["class"]),
                                "valid_till": lic.get("valid_till", v["driver"]["valid_till"]), "photo": lic.get("photo", v["driver"]["photo"]), "face_match": pin.get("face_match", v["driver"]["face_match"])})
            v["driver"]["owner_is_driver"] = v["driver"]["name"] == v["registration"]["owner"]
            v["registration"]["insurance_ok"] = "expired" not in v["registration"]["insurance"].lower()
        if role == "suspect" and pin.get("suspect"):
            s = pin["suspect"]
            v["plate"], v["plate_read"] = s.get("resolved", v["plate"]), s.get("plate", v["plate_read"])
            v["plate_basis"] = "resolved from the partial read"
            v["registration"].update({"owner": s.get("owner", v["registration"]["owner"]), "vehicle": _recolour(s.get("vehicle", v["registration"]["vehicle"]), colour)})
            v["driver"].update({"photo": s.get("photo", v["driver"]["photo"]), "name": s.get("owner", v["driver"]["name"]), "owner_is_driver": True})
        vehicles.append(v)
    # one face per person in a case, the pinned people keeping theirs
    taken = {p for p in ((pin.get("licence") or {}).get("photo"), (pin.get("suspect") or {}).get("photo")) if p}
    for v in vehicles:
        pinned = (v["role"] == "victim" and pin.get("plate")) or (v["role"] == "suspect" and pin.get("suspect"))
        if not pinned:
            v["driver"]["photo"] = _free_photo(v["driver"]["photo"], taken)
        taken.add(v["driver"]["photo"])
        _fit_age(v["driver"], year_now=2026)
        v["driver"]["age"] = _age_of(v["driver"]["photo"], v["driver"]["age"])
    persons = []
    for tid in people:
        r = _rng(cid, tid, "person")
        lic = pin.get("licence") if victim == tid else None
        name = (lic or {}).get("holder") or _person(r, used)
        drawn_age = r.randint(24, 58)
        photo = (lic or {}).get("photo") or _free_photo(_photo(r, name), taken)
        taken.add(photo)
        persons.append({"track": tid, "role": "victim" if tid == victim else "involved", "name": name, "age": _age_of(photo, drawn_age),
                        "description": (pin.get("victim") if victim == tid and pin.get("victim") else None) or (names.get(tid) or "Pedestrian"),
                        "identified_by": "duty roster (on-duty constable)" if "constable" in str(pin.get("victim", "")).lower() and victim == tid else "documents at the scene",
                        "phone": _phone(r), "emergency_contact": _phone(r), "contact_relation": r.choice(RELATION), "blood_group": r.choice(["O+", "B+", "A+"]),
                        "photo": photo, "licence": lic})
    out = {"case": cid, "victim": victim, "suspect": suspect, "vehicles": vehicles, "people": persons,
           "note": "Registry records for this case. People are fictional; numbers are shown masked."}
    (case_dir / "records.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    _merge_plates(case_dir, vehicles)
    index.cache_clear()
    return out


def police_record(v: dict, year_now: int = 2026) -> dict:
    """One record vehicle in the police DB's shape, for the dossier screen. What the case already says is kept, so the
    screens agree; the fields only this screen shows (chassis, policy, FASTag, challan rows) are generated from the plate."""
    r = _rng(v["plate"], "dossier")
    reg, drv = v["registration"], v["driver"]
    words = reg["vehicle"].split()
    coloured = bool(words) and words[0].lower() in COLOURS
    ins = reg["insurance"]
    ok = reg.get("insurance_ok", True)
    insurer, till = ins.split(" · ", 1) if ok and " · " in ins else (r.choice(INSURERS), ins)
    relation = reg.get("contact_relation") or "family"
    first = r.choice(FAMILY_FIRST[(drv["name"].split()[0] in MUSLIM_FIRST, relation in ("wife", "mother", "sister"))])
    day = lambda: f"{r.randint(1, 12):02d}-{r.randint(1, 28):02d}"
    two_wheel = v["class"] in ("motorcycle", "bicycle")
    offences = [("No helmet (Sec 194D)", 1000) if two_wheel else ("No seat belt (Sec 194B)", 1000), ("Signal jump (Sec 184)", 1000),
                ("Overspeeding (Sec 183)", 2000), ("Wrong-side driving (Sec 184)", 1000), ("Parking violation (Sec 177)", 500)]
    challans = [{"date": f"{year_now}-{r.randint(1, 9):02d}-{r.randint(1, 28):02d}", "offence": o, "amount_inr": a, "status": "unpaid", "location": reg.get("address_area") or "Hyderabad"}
                for o, a in r.sample(offences, min(reg.get("pending_challans") or 0, len(offences)))]
    flags = ([] if ok else ["Insurance expired"]) + ([f"{len(challans)} unpaid challan{'s' if len(challans) > 1 else ''}"] if challans else [])
    return {"plate": v["plate"], "class": v["class"], "make_model": " ".join(words[1:]) if coloured else reg["vehicle"], "colour": words[0].lower() if coloured else None,
            "fuel": reg.get("fuel"), "case_record": True,
            "registration": {"date": f"{reg.get('registered', year_now - 5)}-{day()}", "rto": reg.get("rto"), "chassis": f"MA3{r.choice('ABEFGJ')}…{r.randint(1000, 9999)}", "status": "Active"},
            "owner": {"id": f"OWN-{v['plate']}", "type": "company" if "Travels" in reg["owner"] else "individual", "name": reg["owner"], "driver_on_record": drv["name"],
                      "phone": drv["phone"], "address": f"{reg.get('address_area') or 'Hyderabad'}, Hyderabad", "dl_number": drv["dl_no"], "dl_valid_till": drv["valid_till"]},
            "emergency_contact": {"name": f"{first} {drv['name'].split()[-1]}", "relation": relation, "phone": reg.get("emergency_contact")},
            "insurance": {"insurer": insurer, "policy": f"POL-{r.randint(10000000, 99999999)}", "valid_till": re.sub(r"(?i)valid till |expired ", "", till), "status": "Valid" if ok else "Expired"},
            "puc_valid_till": f"{year_now + 1 if reg.get('puc') == 'Valid' else year_now - 1}-{day()}",
            "fastag_id": None if two_wheel else "".join(r.choice("0123456789") for _ in range(20)),
            "challans": challans, "accident_history": [], "flags": flags}


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
