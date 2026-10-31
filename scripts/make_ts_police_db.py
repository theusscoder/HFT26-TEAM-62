"""Generate the MOCK Telangana State police database used by A2 (plates -> registry) and A3 (alerts).

Everything here is FICTIONAL: owners, phone numbers, DL numbers, challans and toll passages are generated
from a fixed seed. Police-station / hospital / toll-plaza NAMES are real public places in and around
Hyderabad with APPROXIMATE coordinates; their contact numbers are fictional. Phone numbers use the
+91 5xxxx xxxxx range, which is not a valid Indian mobile range, so nothing can reach a real person.

Toll times are anchored at ANCHOR (the "incident minute" of the mock world). The API re-bases them to each
case's incident time, so every case has a 30-day history before it and a live feed after it.

Run from the repo root:  python scripts/make_ts_police_db.py
"""
import csv
import json
import math
import random
from datetime import datetime, timedelta
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "data" / "ts_police_db"
ANCHOR = datetime.fromisoformat("2026-10-30T17:31:00+05:30")
INCIDENT_DEFAULT = {"name": "Gachibowli X-roads, Hyderabad (assumed)", "lat": 17.4401, "lon": 78.3489}
rng = random.Random(62)

FIRST = ["Ravi", "Suresh", "Lakshmi", "Srinivas", "Anjali", "Venkatesh", "Priya", "Mahesh", "Kavya", "Naveen", "Swathi",
         "Prakash", "Divya", "Kiran", "Sravani", "Rajesh", "Harika", "Arjun", "Bhavana", "Sai Teja", "Ramesh", "Sneha",
         "Vamshi", "Pooja", "Karthik", "Manasa", "Anil", "Sowmya", "Tarun", "Keerthi", "Imran", "Ayesha", "Farhan",
         "Nikhil", "Deepika", "Rohith", "Spandana", "Gopal", "Yamini", "Charan"]
LAST = ["Reddy", "Rao", "Goud", "Naidu", "Varma", "Sharma", "Chary", "Yadav", "Kumar", "Prasad", "Shaik", "Khan",
        "Mudiraj", "Patel", "Raju", "Babu", "Achari", "Nayak", "Gupta", "Mohammed"]
AREAS = ["Gachibowli", "Kondapur", "Madhapur", "Kukatpally", "Miyapur", "Manikonda", "Narsingi", "Tolichowki",
         "Mehdipatnam", "Ameerpet", "Begumpet", "Secunderabad", "Uppal", "LB Nagar", "Dilsukhnagar", "Attapur",
         "Shamshabad", "Chandanagar", "Nizampet", "Banjara Hills", "Jubilee Hills", "Kompally", "Patancheru"]
RTO = {"TS07": "Ranga Reddy (Attapur)", "TS08": "Medchal (Uppal)", "TS09": "Hyderabad Central (Khairatabad)",
       "TS10": "Hyderabad North (Secunderabad)", "TS11": "Hyderabad East (Malakpet)", "TS12": "Hyderabad South (Bahadurpura)",
       "TS13": "Hyderabad West (Tolichowki)", "TS15": "Sangareddy", "TS29": "TSRTC"}
MODELS = {
    "car": ["Maruti Suzuki Swift", "Hyundai Creta", "Maruti Suzuki Baleno", "Tata Nexon", "Honda City", "Kia Seltos",
            "Mahindra XUV700", "Toyota Innova Crysta", "Hyundai i20", "Maruti Suzuki Dzire"],
    "motorcycle": ["Honda Activa 6G", "Bajaj Pulsar 150", "Royal Enfield Classic 350", "TVS Apache RTR 160",
                   "Hero Splendor Plus", "Yamaha FZ-S", "Suzuki Access 125"],
    "bus": ["Ashok Leyland Viking (private stage carrier)", "Tata Starbus (school bus)", "Eicher Skyline (staff bus)"],
    "truck": ["Tata Ace (mini truck)", "Ashok Leyland Dost", "BharatBenz 1617R", "Eicher Pro 2049"],
    "auto": ["Bajaj RE Compact (autorickshaw)", "Piaggio Ape City"],
}
COLOURS = {"car": ["white", "silver", "grey", "black", "red", "blue"], "motorcycle": ["black", "grey", "red", "blue", "white"],
           "bus": ["white", "yellow", "silver"], "truck": ["white", "yellow", "blue"], "auto": ["yellow", "green"]}
INSURERS = ["New India Assurance", "ICICI Lombard", "Bajaj Allianz", "HDFC ERGO", "United India Insurance", "Tata AIG"]
OFFENCES = [("Over-speeding (Sec 183 MV Act)", 1000), ("Red-light jumping (Sec 184)", 1000), ("No helmet (Sec 194D)", 100),
            ("Wrong-side driving (Sec 184)", 1000), ("Using mobile while driving (Sec 184)", 1500),
            ("No seat belt (Sec 194B)", 100), ("Parking violation (Sec 177)", 135), ("Drunk driving (Sec 185)", 10000)]

# Real public places, approximate coordinates. Contact numbers are fictional.
TOLLS = [
    ("T01", "Nanakramguda ORR Toll", 17.4186, 78.3407), ("T02", "Narsingi ORR Toll", 17.3897, 78.3550),
    ("T03", "Kokapet ORR Toll", 17.3960, 78.3290), ("T04", "Patancheru (Muthangi) ORR Toll", 17.5253, 78.2697),
    ("T05", "Medchal ORR Toll", 17.6290, 78.4810), ("T06", "Shamirpet ORR Toll", 17.5920, 78.5780),
    ("T07", "Ghatkesar ORR Toll", 17.4510, 78.6860), ("T08", "Pedda Amberpet ORR Toll", 17.3260, 78.6270),
    ("T09", "Tukkuguda ORR Toll", 17.2110, 78.4930), ("T10", "Shamshabad ORR Toll", 17.2380, 78.4180),
    ("T11", "Panthangi Toll Plaza (NH65)", 17.2490, 78.9040), ("T12", "Raikal Toll Plaza (NH44)", 17.0800, 78.2100),
    ("T13", "Gudur Toll Plaza (NH163)", 17.4800, 78.8100),
]
POLICE = [
    ("PS01", "Gachibowli Police Station", 17.4436, 78.3519, "Cyberabad"), ("PS02", "Raidurgam Police Station", 17.4300, 78.3800, "Cyberabad"),
    ("PS03", "Madhapur Police Station", 17.4483, 78.3915, "Cyberabad"), ("PS04", "Narsingi Police Station", 17.3880, 78.3640, "Cyberabad"),
    ("PS05", "Kukatpally Police Station", 17.4849, 78.4138, "Cyberabad"), ("PS06", "Jubilee Hills Police Station", 17.4300, 78.4100, "Hyderabad"),
    ("PS07", "Banjara Hills Police Station", 17.4156, 78.4347, "Hyderabad"), ("PS08", "Panjagutta Police Station", 17.4260, 78.4510, "Hyderabad"),
    ("PS09", "Begumpet Police Station", 17.4440, 78.4670, "Hyderabad"), ("PS10", "Gachibowli Traffic Police Station", 17.4410, 78.3560, "Cyberabad Traffic"),
]
HOSPITALS = [
    ("H01", "District Hospital, Kondapur (Govt)", 17.4620, 78.3640, True, True), ("H02", "NIMS, Punjagutta (Govt)", 17.4216, 78.4510, True, True),
    ("H03", "Osmania General Hospital (Govt)", 17.3713, 78.4747, True, True), ("H04", "Gandhi Hospital, Secunderabad (Govt)", 17.4239, 78.5013, True, True),
    ("H05", "AIG Hospitals, Gachibowli", 17.4434, 78.3627, False, True), ("H06", "Continental Hospitals, Gachibowli", 17.4165, 78.3420, False, True),
    ("H07", "CARE Hospitals, HITEC City", 17.4446, 78.3765, False, True), ("H08", "Apollo Hospitals, Jubilee Hills", 17.4156, 78.4106, False, True),
    ("H09", "Urban PHC, Nanakramguda (Govt)", 17.4200, 78.3460, True, False),
]

# Plates the response builder hands out when a plate is not legible in the footage (see plate_reader.py).
# "suspect" plates have a post-incident toll trail in the mock feed; "victim" plates have a clean record.
POOLS = {
    "suspect": {"car": "TS07GK5521", "bus": "TS09UB4471", "truck": "TS08UC7316", "motorcycle": "TS13EK2290", "auto": "TS11UA0928"},
    "victim": {"car": "TS09EA1234", "bus": "TS29Z0417", "truck": "TS15UD3382", "motorcycle": "TS10EQ6614", "auto": "TS12UB5150"},
}
# Colours chosen to match the demo footage / existing demo registry (hero bus is silver, its motorcycle grey).
POOL_COLOURS = {"TS07GK5521": "red", "TS09EA1234": "white", "TS09UB4471": "silver", "TS10EQ6614": "grey"}
# The suspect plates' owners have records worth finding; victims are ordinary citizens.
SUSPECT_PROFILE = {
    "TS07GK5521": {"flags": ["Insurance expired", "3 unpaid challans"], "accident_history": [{"date": "2025-08-14", "fir": "FIR 412/2025, Narsingi PS", "summary": "Rear-end collision, minor injuries; settled"}]},
    "TS09UB4471": {"flags": ["Fitness certificate expired", "Permit: stage carriage, route deviation noted twice"], "accident_history": [{"date": "2026-03-02", "fir": "FIR 98/2026, Raidurgam PS", "summary": "Bus brushed a two-wheeler; rider injured"}]},
    "TS08UC7316": {"flags": ["Overloading challan x2"], "accident_history": []},
    "TS13EK2290": {"flags": ["Licence suspended until 2026-12-01 (drunk driving)"], "accident_history": [{"date": "2026-05-19", "fir": "FIR 233/2026, Gachibowli PS", "summary": "Hit-and-run on a pedestrian (vehicle traced later)"}]},
    "TS11UA0928": {"flags": ["Permit area violation"], "accident_history": []},
}


# The synthetic demo case's two parties, as data/fictional/live_identities.json and the case records describe them.
DEMO_PARTIES = {
    "TS07GK5521": {"make_model": "Honda City", "fuel": "Diesel", "date": "2023-03-14", "area": "Miyapur", "owner": "Karthik Varma", "dl": "TS07 2015 •••2910", "dl_till": "2035-06-14",
                   "contact": {"name": "Swathi Varma", "relation": "Wife", "phone": "+91 80••• ••784"},
                   "insurance": {"insurer": "ICICI Lombard", "valid_till": "2027-01-31", "status": "Valid"}, "flags": ["3 unpaid challans"]},
    "TS09EA1234": {"make_model": "Maruti Swift", "fuel": "CNG", "date": "2022-08-09", "area": "Banjara Hills", "owner": "Ravi Teja Goud", "dl": "TS09 2019 •••2345", "dl_till": "2034-05-11",
                   "contact": {"name": "Kavitha Goud", "relation": "Sister", "phone": "+91 98••• ••412"},
                   "insurance": {"insurer": "New India Assurance", "valid_till": "2027-03-31", "status": "Valid"}, "flags": ["1 unpaid challan"],
                   "challans": [{"date": "2026-02-11", "offence": "Parking violation (Sec 177)", "amount_inr": 500, "status": "unpaid", "location": "Banjara Hills"}]},
}


def apply_demo_parties(vehicles: list[dict]):
    for v in vehicles:
        p = DEMO_PARTIES.get(v["plate"])
        if not p and v["plate"] != "TS07GH8810":   # the suspect owner's second vehicle
            continue
        o = p or DEMO_PARTIES["TS07GK5521"]
        v["owner"].update({"name": o["owner"], "address": f"{v['owner']['address'].split(',')[0]}, {o['area']}, Hyderabad", "dl_number": o["dl"], "dl_valid_till": o["dl_till"]})
        if p:
            v.update({"make_model": p["make_model"], "fuel": p["fuel"], "emergency_contact": p["contact"], "flags": p["flags"]})
            v["registration"]["date"] = p["date"]
            v["insurance"].update(p["insurance"])
            if "challans" in p:
                v["challans"] = p["challans"]


def km(a_lat, a_lon, b_lat, b_lon) -> float:
    r = 6371.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lon - a_lon)
    return 2 * r * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))


def phone(i: int) -> str:
    return f"+91 5{i:04d} {rng.randint(10000, 99999)}"


def plate_for(cls: str) -> str:
    code = "TS29" if cls == "bus" and rng.random() < 0.3 else rng.choice([k for k in RTO if k != "TS29"])
    series = rng.choice("EFGHJK") + rng.choice("ABCDEFGHJKLMNPQRSTUVWXYZ") if cls in ("car", "motorcycle") else "U" + rng.choice("ABCDE")
    if code == "TS29":
        series = "Z"
    return f"{code}{series}{rng.randint(1, 9999):04d}"


def make_vehicle(i: int, plate: str, cls: str, colour: str | None = None) -> dict:
    first, last = rng.choice(FIRST), rng.choice(LAST)
    area = rng.choice(AREAS)
    reg = (ANCHOR - timedelta(days=rng.randint(200, 3600))).date()
    ins_ok = rng.random() > 0.15
    challans = []
    for _ in range(rng.choice([0, 0, 0, 1, 1, 2, 3])):
        off, amt = rng.choice(OFFENCES[:-1])
        challans.append({"date": str((ANCHOR - timedelta(days=rng.randint(5, 700))).date()), "offence": off, "amount_inr": amt,
                         "status": rng.choice(["paid", "paid", "unpaid"]), "location": rng.choice(AREAS)})
    rto_code = plate[:4]
    owner_kind = "company" if cls in ("bus", "truck") and rng.random() < 0.6 else "individual"
    owner_name = f"{rng.choice(['Sri Sai', 'Lakshmi', 'Deccan', 'Telangana', 'Cyber City', 'Golconda'])} {rng.choice(['Travels', 'Logistics', 'Transport Co.', 'Carriers'])}" if owner_kind == "company" else f"{first} {last}"
    return {
        "plate": plate, "class": cls, "make_model": rng.choice(MODELS[cls]), "colour": colour or rng.choice(COLOURS[cls]),
        "fuel": rng.choice(["Petrol", "Diesel", "CNG", "Electric"]) if cls == "car" else ("Diesel" if cls in ("bus", "truck") else "Petrol"),
        "registration": {"date": str(reg), "rto": RTO.get(rto_code, "Hyderabad"), "chassis": f"MA{rng.randint(1, 9)}X…{rng.randint(1000, 9999)}",
                         "engine": f"K{rng.randint(10, 99)}…{rng.randint(1000, 9999)}", "status": "Active"},
        "owner": {"id": f"OWN{i:04d}", "type": owner_kind, "name": owner_name,
                  "driver_on_record": f"{first} {last}" if owner_kind == "company" else None,
                  "phone": phone(i), "address": f"H.No {rng.randint(1, 20)}-{rng.randint(1, 300)}, {area}, Hyderabad",
                  "dl_number": f"{rto_code}{reg.year}{rng.randint(1000000, 9999999)}",
                  "dl_valid_till": str((ANCHOR + timedelta(days=rng.randint(-60, 3000))).date())},
        "emergency_contact": {"name": f"{rng.choice(FIRST)} {last}", "relation": rng.choice(["Spouse", "Father", "Mother", "Brother", "Sister"]), "phone": phone(5000 + i)},
        "insurance": {"insurer": rng.choice(INSURERS), "policy": f"POL-{rng.randint(10000000, 99999999)}",
                      "valid_till": str((ANCHOR + timedelta(days=rng.randint(30, 360) if ins_ok else -rng.randint(10, 300))).date()),
                      "status": "Valid" if ins_ok else "Expired"},
        "puc_valid_till": str((ANCHOR + timedelta(days=rng.randint(-40, 180))).date()),
        "fastag_id": f"34161FA8{rng.randint(10**11, 10**12 - 1)}" if cls != "motorcycle" else None,
        "challans": challans, "accident_history": [], "flags": [],
    }


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    vehicles, used = [], set()
    i = 1
    for role, pool in POOLS.items():
        for cls, plate in pool.items():
            v = make_vehicle(i, plate, cls, POOL_COLOURS.get(plate))
            if role == "suspect":
                v.update({k: v.get(k, []) + vals if isinstance(vals, list) else vals for k, vals in SUSPECT_PROFILE[plate].items()})
                if "Insurance expired" in v["flags"]:
                    v["insurance"]["status"] = "Expired"
                    v["insurance"]["valid_till"] = str((ANCHOR - timedelta(days=41)).date())
                for _ in range(3 - sum(c["status"] == "unpaid" for c in v["challans"])):
                    off, amt = rng.choice(OFFENCES)
                    v["challans"].append({"date": str((ANCHOR - timedelta(days=rng.randint(5, 300))).date()), "offence": off,
                                          "amount_inr": amt, "status": "unpaid", "location": rng.choice(AREAS)})
            else:
                v["insurance"]["status"] = "Valid"
                v["challans"] = [c | {"status": "paid"} for c in v["challans"]]
            vehicles.append(v)
            used.add(plate)
            i += 1
    # a second vehicle for one suspect owner ("other vehicles registered to the same person")
    extra = make_vehicle(i, "TS07GH8810", "motorcycle")
    extra["owner"] = dict(next(v for v in vehicles if v["plate"] == "TS07GK5521")["owner"])
    vehicles.append(extra); used.add(extra["plate"]); i += 1
    mix = ["car"] * 55 + ["motorcycle"] * 45 + ["bus"] * 8 + ["truck"] * 12 + ["auto"] * 10
    for cls in mix:
        p = plate_for(cls)
        while p in used:
            p = plate_for(cls)
        used.add(p)
        vehicles.append(make_vehicle(i, p, cls))
        i += 1
    apply_demo_parties(vehicles)
    (OUT / "vehicles.json").write_text(json.dumps({"meta": {"name": "TS State Police · Vehicle & Owner Registry (MOCK)",
        "note": "Fictional records for the YATHARTH demo. Phone numbers use the invalid +91 5xxxx range.",
        "generated": ANCHOR.isoformat(), "count": len(vehicles)}, "vehicles": vehicles}, indent=1, ensure_ascii=False))

    (OUT / "toll_plazas.json").write_text(json.dumps([{"id": t, "name": n, "lat": la, "lon": lo, "approx": True} for t, n, la, lo in TOLLS], indent=1))
    (OUT / "police_stations.json").write_text(json.dumps([{"id": p, "name": n, "lat": la, "lon": lo, "commissionerate": c,
        "phone": phone(9000 + k), "approx": True} for k, (p, n, la, lo, c) in enumerate(POLICE)], indent=1))
    (OUT / "hospitals.json").write_text(json.dumps([{"id": h, "name": n, "lat": la, "lon": lo, "govt": g, "trauma": tr,
        "emergency_phone": phone(9500 + k), "approx": True} for k, (h, n, la, lo, g, tr) in enumerate(HOSPITALS)], indent=1))

    # toll passages: 30 days of history + a 2-hour "live feed" after the anchor
    rows = []
    def add(t: datetime, toll, v, direction=None):
        rows.append({"time": t.isoformat(timespec="seconds"), "plaza_id": toll[0], "plaza": toll[1], "plate": v["plate"],
                     "fastag_id": v["fastag_id"] or "", "vehicle_class": v["class"], "colour": v["colour"],
                     "direction": direction or rng.choice(["inbound", "outbound"])})
    fastag = [v for v in vehicles if v["fastag_id"]]
    for v in fastag:
        home = rng.sample(TOLLS, 2)
        commuter = rng.random() < 0.45 or v["plate"] in POOLS["suspect"].values()
        for day in range(30, 0, -1):
            d0 = ANCHOR.replace(hour=0, minute=0, second=0) - timedelta(days=day)
            if commuter and d0.weekday() < 6:
                add(d0 + timedelta(hours=8, minutes=rng.randint(0, 80)), home[0], v, "inbound")
                add(d0 + timedelta(hours=18, minutes=rng.randint(0, 120)), home[1], v, "outbound")
            elif rng.random() < 0.18:
                add(d0 + timedelta(hours=rng.randint(6, 23), minutes=rng.randint(0, 59)), rng.choice(TOLLS), v)
    # live feed after the incident: background traffic
    background = [v for v in fastag if v["plate"] not in POOLS["suspect"].values()]
    for _ in range(320):
        v = rng.choice(background)
        add(ANCHOR + timedelta(minutes=rng.uniform(1, 120)), rng.choice(TOLLS), v)
    # suspect trails: a plausible escape route from the default incident site at ~40-55 km/h, plus one
    # passage that is physically unreachable in time (the analysis should flag it as a possible cloned plate)
    routes = {"TS07GK5521": ["T01", "T02", "T10"], "TS09UB4471": ["T01", "T03", "T04"], "TS08UC7316": ["T02", "T09", "T12"],
              "TS11UA0928": ["T01", "T02"]}
    by_id = {t[0]: t for t in TOLLS}
    for plate, route in routes.items():
        v = next(x for x in vehicles if x["plate"] == plate)
        t, lat, lon = ANCHOR, INCIDENT_DEFAULT["lat"], INCIDENT_DEFAULT["lon"]
        for tid in route:
            toll = by_id[tid]
            d = km(lat, lon, toll[2], toll[3]) * 1.3
            t = t + timedelta(minutes=max(2.0, d / rng.uniform(40, 55) * 60))
            add(t, toll, v, "outbound")
            lat, lon = toll[2], toll[3]
        add(ANCHOR + timedelta(minutes=7), by_id["T11"], v, "inbound")  # 50+ km away 7 min later: impossible
    rows.sort(key=lambda r: r["time"])
    with (OUT / "toll_logs.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    (OUT / "meta.json").write_text(json.dumps({"anchor": ANCHOR.isoformat(), "incident_default": INCIDENT_DEFAULT, "pools": POOLS,
        "note": "Toll times are relative to 'anchor'; the API re-bases them to each case's incident time."}, indent=1))
    print(f"{len(vehicles)} vehicles, {len(rows)} toll passages -> {OUT}")


if __name__ == "__main__":
    main()
