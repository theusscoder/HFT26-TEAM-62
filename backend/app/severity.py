"""Explainable accident severity (PLAN.md section 2). Rules decide; every point is traceable to
the signal and evidence reference that produced it. Weights/thresholds are tunable here."""

LEVELS = [
    (0, "L0", "Near-miss", ["log"]),
    (15, "L1", "Minor", ["owner"]),
    (40, "L2", "Moderate", ["family", "police", "hospital_standby"]),
    (70, "L3", "Severe", ["family", "police", "hospital"]),
]


def _g_points(peak_g: float) -> int:
    if peak_g >= 8: return 45
    if peak_g >= 4: return 30
    if peak_g >= 2: return 15
    return 5 if peak_g > 0.5 else 0


def _dv_points(dv_kmh: float) -> int:
    if dv_kmh >= 25: return 25
    if dv_kmh >= 10: return 12
    return 3 if dv_kmh > 0 else 0


def score(signals: dict) -> dict:
    """signals: {peak_g, dv_kmh, vru_involved, person_down_s, rollover, airbag, fire_smoke,
    collision_type, refs: {signal_name: evidence_ref}}"""
    refs = signals.get("refs", {})
    parts = []

    def add(name, pts, why):
        if pts:
            parts.append({"signal": name, "points": pts, "why": why, "ref": refs.get(name)})

    add("peak_g", _g_points(signals.get("peak_g", 0)), f"peak deceleration {signals.get('peak_g', 0)} g")
    add("dv_kmh", _dv_points(signals.get("dv_kmh", 0)), f"speed change at impact {signals.get('dv_kmh', 0)} km/h")
    if signals.get("contact"):
        add("contact", 15, "road users in contact on camera")
    if signals.get("vru_involved"):
        add("vru_involved", 15, "pedestrian / two-wheeler involved")
    if signals.get("person_down_s", 0) >= 5:
        add("person_down_s", 25, f"person not moving for {signals['person_down_s']} s after impact")
    if signals.get("rollover"):
        add("rollover", 20, "vehicle rolled / spun > 90 degrees")
    if signals.get("airbag"):
        add("airbag", 20, "airbag deployment flag in sensor log")
    if signals.get("fire_smoke"):
        add("fire_smoke", 25, "fire or smoke seen in post-impact frame (VLM)")
    if signals.get("collision_type") in ("head-on", "t-bone"):
        add("collision_type", 10, f"{signals['collision_type']} collision")

    total = min(100, sum(p["points"] for p in parts))
    level = LEVELS[0]
    for lv in LEVELS:
        if total >= lv[0]:
            level = lv
    return {"score": total, "level": level[1], "label": level[2], "notify": level[3], "breakdown": parts}
