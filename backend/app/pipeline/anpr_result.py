"""Pure ANPR result logic (no models, no video): voting, partial reads, candidate readings, what a plate tells us,
status labels, and the structured per-vehicle result. Kept separate so it can be unit-tested (backend/tests).

Evidence levels used in every field:
  OBSERVED            directly visible in the footage (category, colour, direction, plate crop)
  OCR_CANDIDATE       text read from the plate image (raw reading, candidate strings)
  PREDICTED           derived interpretation (state / RTO from the observed prefix, use from plate colour)
  DATABASE_MATCH      found in an authorised registration database (none connected -> never set)
  INVESTIGATOR_CONFIRMED  set only by an investigator via the API
Nothing here invents characters: '?' stays '?', candidates use only characters seen in some frame."""
import itertools
import re
from collections import defaultdict

TO_DIGIT = {"O": "0", "D": "0", "Q": "0", "I": "1", "L": "1", "Z": "2", "S": "5", "B": "8", "G": "6", "T": "7"}
TO_ALPHA = {"0": "O", "1": "I", "2": "Z", "5": "S", "8": "B", "6": "G"}
PLATE_RE = re.compile(r"^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$")

STATES = {"AN": "Andaman & Nicobar", "AP": "Andhra Pradesh", "AR": "Arunachal Pradesh", "AS": "Assam", "BR": "Bihar", "CG": "Chhattisgarh",
          "CH": "Chandigarh", "DD": "Daman & Diu", "DL": "Delhi", "DN": "Dadra & Nagar Haveli", "GA": "Goa", "GJ": "Gujarat",
          "HP": "Himachal Pradesh", "HR": "Haryana", "JH": "Jharkhand", "JK": "Jammu & Kashmir", "KA": "Karnataka", "KL": "Kerala",
          "LA": "Ladakh", "LD": "Lakshadweep", "MH": "Maharashtra", "ML": "Meghalaya", "MN": "Manipur", "MP": "Madhya Pradesh",
          "MZ": "Mizoram", "NL": "Nagaland", "OD": "Odisha", "OR": "Odisha (old code)", "PB": "Punjab", "PY": "Puducherry",
          "RJ": "Rajasthan", "SK": "Sikkim", "TN": "Tamil Nadu", "TR": "Tripura", "TS": "Telangana", "TG": "Telangana",
          "UK": "Uttarakhand", "UP": "Uttar Pradesh", "WB": "West Bengal", "BH": "Bharat series (all-India)"}
# Common RTO codes (district office that registered the vehicle). Not exhaustive: unknown codes say so.
RTOS = {"MP04": "Bhopal", "MP09": "Indore", "MP20": "Jabalpur", "MP07": "Gwalior", "TS07": "Ranga Reddy", "TS08": "Medchal-Malkajgiri",
        "TS09": "Hyderabad Central", "TS10": "Hyderabad North", "TS11": "Hyderabad East", "TS12": "Hyderabad South",
        "TS13": "Hyderabad West", "TS15": "Sangareddy", "TG09": "Hyderabad Central", "AP09": "Hyderabad (pre-2014)",
        "AP28": "Hyderabad West (pre-2014)", "AP29": "Hyderabad (pre-2014)", "AP39": "Vijayawada", "KA01": "Bengaluru Central",
        "KA03": "Bengaluru East", "KA05": "Bengaluru South", "MH01": "Mumbai Central", "MH02": "Mumbai West", "MH12": "Pune",
        "DL01": "Delhi North", "DL03": "Delhi South", "DL08": "Delhi North-West", "TN01": "Chennai Central", "TN09": "Chennai West",
        "GJ01": "Ahmedabad", "RJ14": "Jaipur", "UP32": "Lucknow", "UP16": "Noida", "HR26": "Gurugram", "WB02": "Kolkata", "KL07": "Ernakulam"}
PLATE_USE = {"yellow": "commercial / transport vehicle (yellow plate)", "white": "private vehicle (white plate)",
             "green": "electric vehicle (green plate)", "black": "self-drive rental (black plate)", "red": "temporary registration (red plate)"}

LEVEL = {"observed": "OBSERVED", "ocr": "OCR_CANDIDATE", "predicted": "PREDICTED", "db": "DATABASE_MATCH", "confirmed": "INVESTIGATOR_CONFIRMED"}
STATUS_LABEL = {"full_read": "Full plate read", "partial_read": "Partial plate read", "plate_detected_ocr_failed": "Plate detected, OCR failed",
                "plate_not_detected": "Plate not detected", "insufficient_image_quality": "Insufficient image quality",
                "investigator_confirmed": "Investigator-confirmed"}

MIN_CHAR_SHARE = 0.6
MIN_CHAR_CONF = 0.5
ALT_SHARE = 0.2
MAX_CANDIDATES = 8


def alnum(text: str | None) -> str:
    return re.sub(r"[^A-Z0-9]", "", (text or "").upper())


def normalise(text: str | None) -> str | None:
    """Indian-format position correction for 7-10 character reads; other lengths are kept RAW (non-standard,
    temporary or partial plates are never rejected for their format). Returns None only for empty text."""
    t = alnum(text)
    if not t:
        return None
    if not 7 <= len(t) <= 10:
        return t
    t = list(t)
    for i in range(2):
        t[i] = TO_ALPHA.get(t[i], t[i])
    for i in (2, 3):
        t[i] = TO_DIGIT.get(t[i], t[i])
    for i in range(len(t) - 4, len(t)):
        t[i] = TO_DIGIT.get(t[i], t[i])
    for i in range(4, len(t) - 4):
        t[i] = TO_ALPHA.get(t[i], t[i])
    return "".join(t)


def is_standard(plate: str | None) -> bool:
    return bool(plate) and "?" not in plate and bool(PLATE_RE.match(plate)) and plate[:2] in STATES


def vote(reads: list[tuple]) -> dict:
    """reads: (text, read_conf[, per_char_conf]). Weighted per-position vote across frames.
    Uncertain positions become '?'; alternatives actually observed at each position are kept for candidates."""
    rs = []
    for r in reads:
        t = r[0]
        if not t:
            continue
        cc = r[2] if len(r) > 2 and r[2] and len(r[2]) == len(t) else [1.0] * len(t)
        rs.append((t, max(float(r[1]), 1e-6), cc))
    if not rs:
        return {"plate": None, "confidence": 0.0, "reads": [], "partial": False, "known": 0, "length": 0, "alternatives": {}, "agreement": 0.0}
    by_len = defaultdict(float)
    for t, c, _ in rs:
        by_len[len(t)] += c
    n = max(by_len, key=by_len.get)
    same = [x for x in rs if len(x[0]) == n]
    plate, strengths, alts = "", [], {}
    for i in range(n):
        w = defaultdict(float)
        for t, c, cc in same:
            w[t[i]] += c * cc[i]
        total = max(sum(w.values()), 1e-9)
        ch = max(w, key=w.get)
        share = w[ch] / total
        if len(same) > 1:
            ok, strength = share >= MIN_CHAR_SHARE, share
        else:
            strength = same[0][2][i]
            ok = strength >= MIN_CHAR_CONF
        plate += ch if ok else "?"
        strengths.append(strength if ok else 0.0)
        seen = [k for k, v in sorted(w.items(), key=lambda kv: -kv[1]) if v / total >= ALT_SHARE]
        if not ok:
            alts[i] = seen or [ch]
    known = sum(c != "?" for c in plate)
    agreement = sum(c for t, c, _ in rs if t == plate) / sum(c for _, c, _ in rs)
    return {"plate": plate, "confidence": round(sum(strengths) / n, 2), "reads": [t for t, _, _ in rs], "partial": known < n or not is_standard(plate),
            "known": known, "length": n, "alternatives": alts, "agreement": round(agreement, 2), "frames_voted": len(rs)}


def candidates(plate: str | None, alternatives: dict) -> list[str]:
    """Candidate readings for '?' positions, built ONLY from characters observed at that position in some frame.
    No observed alternative -> no candidates (the '?' stays unknown)."""
    if not plate or "?" not in plate:
        return []
    pos = [i for i, c in enumerate(plate) if c == "?"]
    if any(not alternatives.get(i) and not alternatives.get(str(i)) for i in pos):
        return []
    opts = [alternatives.get(i) or alternatives.get(str(i)) for i in pos]
    out = []
    for combo in itertools.product(*opts):
        s = list(plate)
        for i, ch in zip(pos, combo):
            s[i] = ch
        out.append("".join(s))
        if len(out) >= MAX_CANDIDATES:
            break
    return out


def plate_info(plate: str | None, plate_colour: str | None = None, lines: int | None = None) -> list[dict]:
    """What the observed characters / plate colour tell us. Each item says which observed characters it rests on."""
    out = []
    if plate and len(plate) >= 2 and "?" not in plate[:2] and plate[:2] in STATES:
        out.append({"field": "Registering state", "value": STATES[plate[:2]], "basis": f"prefix '{plate[:2]}'", "level": LEVEL["predicted"]})
        if len(plate) >= 4 and "?" not in plate[2:4]:
            code = plate[:4]
            out.append({"field": "RTO (district office)", "value": RTOS.get(code, f"RTO code {code[2:]} (not in local table)"),
                        "basis": f"code '{code}'", "level": LEVEL["predicted"]})
    if plate_colour in PLATE_USE:
        out.append({"field": "Vehicle use", "value": PLATE_USE[plate_colour], "basis": f"{plate_colour} plate background", "level": LEVEL["predicted"]})
    if lines == 2:
        out.append({"field": "Plate layout", "value": "two-line plate (common on commercial vehicles and two-wheelers)", "basis": "plate image", "level": LEVEL["observed"]})
    return out


def status_for(read: dict | None, plate_located: bool, vehicle_px: tuple[int, int] | None) -> tuple[str, str]:
    """(registration_status, reason)."""
    if read and read.get("confirmed_registration"):
        return "investigator_confirmed", "Registration confirmed by an investigator."
    if read and read.get("plate") and read.get("known", 0) >= 3:
        if not read.get("partial"):
            return "full_read", f"All {read['length']} characters agreed across {read.get('frames_voted', 1)} frame(s)."
        return "partial_read", f"{read['known']} of {read['length']} characters certain; '?' marks characters the frames disagree on or the model was unsure of."
    if vehicle_px and min(vehicle_px) < 60:
        return "insufficient_image_quality", f"Insufficient visual evidence: the vehicle is only {vehicle_px[0]}x{vehicle_px[1]} px in the footage."
    if plate_located:
        return "plate_detected_ocr_failed", "A plate region was found but no character was consistent across frames (blur / resolution)."
    return "plate_not_detected", "No plate region was found on this vehicle in any sampled frame (angle, occlusion or resolution)."


def direction(points: list[dict]) -> str | None:
    """Direction of movement in the image, from the tracked box centres (OBSERVED)."""
    pts = [p for p in points if p.get("box")]
    if len(pts) < 3:
        return None
    (ax, ay), (bx, by) = [((p["box"][0] + p["box"][2]) / 2, (p["box"][1] + p["box"][3]) / 2) for p in (pts[0], pts[-1])]
    a0 = (pts[0]["box"][2] - pts[0]["box"][0]) * (pts[0]["box"][3] - pts[0]["box"][1])
    a1 = (pts[-1]["box"][2] - pts[-1]["box"][0]) * (pts[-1]["box"][3] - pts[-1]["box"][1])
    dx, dy = bx - ax, by - ay
    parts = []
    if a1 > 1.3 * a0:
        parts.append("approaching the camera")
    elif a0 > 1.3 * a1:
        parts.append("moving away from the camera")
    if abs(dx) > 25:
        parts.append("left to right" if dx > 0 else "right to left")
    if abs(dy) > 25 and not parts:
        parts.append("down the frame" if dy > 0 else "up the frame")
    return ", ".join(parts) or "nearly stationary in frame"


def ts(seconds: float | None) -> str | None:
    if seconds is None:
        return None
    m, s = divmod(max(0.0, seconds), 60)
    return f"00:{int(m):02d}:{s:05.2f}"
