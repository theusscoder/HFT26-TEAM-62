"""OWNER: P2. Sensor CSV -> OBSERVED events by threshold rules (device clock; fusion aligns it).

CSV columns: t,speed_kmh,accel_g,brake,indicator,airbag,lat,lon
Rules: braking = accel_g <= -0.12 g sustained 0.3 s | impact = largest |accel_g| spike | stop = speed < 1 km/h
for 1 s after moving | airbag flag | peak speed over the log."""
import csv


def _ev(n, actor, action, t0, t1, value, conf, row0, row1, rule, source):
    ref = f"{source}.csv#r={row0}" if row0 == row1 else f"{source}.csv#r={row0}-{row1}"
    return dict(id=f"EV-S-{n:03d}", source=source, kind="OBSERVED", t=dict(start=t0, end=t1, sigma=0.05), clock="device",
                actor=actor, action=action, value=value, confidence=conf, ref=ref, derived_from=[], rule=rule)


def run(csv_path, actor: str, source: str = "sensor") -> list[dict]:
    rows = list(csv.DictReader(open(csv_path)))
    T = [float(r["t"]) for r in rows]; V = [float(r["speed_kmh"]) for r in rows]; G = [float(r["accel_g"]) for r in rows]
    out, n = [], 0
    rr = lambda i: i + 2  # CSV row number incl. header
    pk = max(range(len(rows)), key=lambda i: V[i])
    out.append(_ev(n, actor, "speed", T[0], T[-1], f"peak {V[pk]:.1f} km/h", 0.95, rr(0), rr(len(rows) - 1), "R_peak_speed", source)); n += 1
    i = 0
    while i < len(rows):
        if G[i] <= -0.12:
            j = i
            while j + 1 < len(rows) and G[j + 1] <= -0.12:
                j += 1
            if T[j] - T[i] >= 0.3:
                out.append(_ev(n, actor, "brake", T[i], T[j], f"min {min(G[i:j + 1]):.2f} g", 0.93, rr(i), rr(j), "R_brake_0.12g_0.3s", source)); n += 1
            i = j + 1
        else:
            i += 1
    imp = max(range(len(rows)), key=lambda i: abs(G[i]))
    out.append(_ev(n, actor, "impact", T[imp], T[imp], f"{G[imp]:.2f} g", 0.96, rr(imp), rr(imp), "R_peak_accel", source)); n += 1
    moving = [k for k in range(len(rows)) if V[k] > 3]
    if moving and moving[-1] + 10 < len(rows):
        k = moving[-1] + 1
        out.append(_ev(n, actor, "stop", T[k], T[-1], "speed < 1 km/h", 0.9, rr(k), rr(len(rows) - 1), "R_stop_1kmh", source)); n += 1
    if any(r["airbag"] == "1" for r in rows):
        k = next(i for i, r in enumerate(rows) if r["airbag"] == "1")
        out.append(_ev(n, actor, "airbag", T[k], T[k], "deployed", 0.99, rr(k), rr(k), "R_airbag_flag", source)); n += 1
    return out


def peak_g(csv_path) -> tuple[float, int]:
    rows = list(csv.DictReader(open(csv_path)))
    i = max(range(len(rows)), key=lambda i: abs(float(rows[i]["accel_g"])))
    return abs(float(rows[i]["accel_g"])), i + 2
