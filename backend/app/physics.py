"""Counterfactual stopping physics. d = v*t_r + v^2 / (2*mu*g)."""
G = 9.81
BRAKE_G = -0.12  # same threshold as sensor.py
MU_DRY, MU_WET = 0.7, 0.4
STOPPED_KMH = 2.0


def stopping_distance(speed_kmh: float, reaction_s: float = 1.0, mu: float = 0.7) -> dict:
    v = speed_kmh / 3.6
    reaction = v * reaction_s
    braking = v * v / (2 * mu * G)
    return {"reaction_m": round(reaction, 2), "braking_m": round(braking, 2),
            "total_m": round(reaction + braking, 2)}


def stop_claim_check(rows: list[dict], mu: float, mu_basis: str) -> dict | None:
    """Could the vehicle have stopped before impact, as a witness says? From the last sustained braking in the
    telematics (or the last sample before the spike), compare braking distance with the road it actually covered.
    Rows need t, speed_kmh, accel_g. Returns None when the log has no impact to test against."""
    if len(rows) < 2:
        return None
    impact = max(range(len(rows)), key=lambda i: abs(rows[i]["accel_g"]))
    if impact == 0:
        return None
    start = impact - 1
    while start > 0 and rows[start - 1]["accel_g"] <= BRAKE_G:
        start -= 1
    speed = rows[start]["speed_kmh"]
    needed = speed / 3.6 * speed / 3.6 / (2 * mu * G)
    had = sum((rows[i]["speed_kmh"] + rows[i + 1]["speed_kmh"]) / 2 / 3.6 * (rows[i + 1]["t"] - rows[i]["t"]) for i in range(start, impact))
    still_moving = rows[impact - 1]["speed_kmh"]
    return {"speed_kmh": round(speed, 1), "needed_m": round(needed, 1), "had_m": round(had, 1), "mu": mu, "mu_basis": mu_basis,
            "speed_at_impact_kmh": round(still_moving, 1), "start_row": start + 2, "impact_row": impact + 2,
            # Still moving at the logged impact is direct evidence; the distances show why.
            "possible": still_moving < STOPPED_KMH}


def ghost_trajectory(speed_kmh: float, hazard_at_m: float, brake_start_s: float,
                     reaction_s: float = 1.0, mu: float = 0.7, dt: float = 0.1) -> dict:
    """1-D replay along the vehicle's path. Position 0 = where the vehicle was when the hazard
    became visible (brake_start_s - reaction_s before braking). Returns samples and the outcome."""
    v = speed_kmh / 3.6
    decel = mu * G
    t, x, samples = 0.0, 0.0, []
    while v > 0 and t < 15:
        if t >= reaction_s:
            v = max(0.0, v - decel * dt)
        x += v * dt
        t += dt
        samples.append({"t": round(t, 2), "x": round(x, 2), "v_kmh": round(v * 3.6, 1)})
    stops_at = samples[-1]["x"] if samples else 0.0
    return {
        "speed_kmh": speed_kmh,
        "hazard_at_m": hazard_at_m,
        "stops_at_m": stops_at,
        "margin_m": round(hazard_at_m - stops_at, 2),
        "avoided": stops_at < hazard_at_m,
        "samples": samples,
        "assumptions": {"reaction_s": reaction_s, "mu": mu, "note": ("wet" if mu <= MU_WET else "dry") + " road, constant deceleration"},
    }
