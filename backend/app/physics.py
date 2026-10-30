"""Counterfactual stopping physics. d = v*t_r + v^2 / (2*mu*g)."""
G = 9.81


def stopping_distance(speed_kmh: float, reaction_s: float = 1.0, mu: float = 0.7) -> dict:
    v = speed_kmh / 3.6
    reaction = v * reaction_s
    braking = v * v / (2 * mu * G)
    return {"reaction_m": round(reaction, 2), "braking_m": round(braking, 2),
            "total_m": round(reaction + braking, 2)}


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
        "assumptions": {"reaction_s": reaction_s, "mu": mu, "note": "dry asphalt, constant deceleration"},
    }
