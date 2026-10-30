"""OWNER: P2. Sensor CSV -> OBSERVED events by threshold rules (device clock; fusion aligns it).

CSV columns: t,speed_kmh,accel_g,brake,indicator,airbag,lat,lon
Rules: braking = accel_g <= -0.12 g sustained 0.3 s | impact = largest |accel_g| spike | stop = speed < 1 km/h
for 1 s after moving | airbag flag | peak speed over the log."""
import csv

CONFIRMED_IMPACT_G = 5.0
MIN_BRAKE_S = 0.3
MIN_BRAKE_INTO_IMPACT_S = 0.15  # braking cut short by the crash is still braking
SPIKE_FLANK = 0.4  # samples this close to the peak are the crash pulse itself, not the brakes


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
    imp = max(range(len(rows)), key=lambda i: abs(G[i]))
    i = 0
    while i < len(rows):
        if G[i] <= -0.12:
            j = i
            while j + 1 < len(rows) and G[j + 1] <= -0.12:
                j += 1
            end, into_impact = j, i < imp <= j
            if into_impact:  # the spike is the crash, not the brakes: a bus can't brake at 2 g
                end = imp - 1
                while end >= i and abs(G[end]) >= SPIKE_FLANK * abs(G[imp]):
                    end -= 1
            if end >= i and T[end] - T[i] >= (MIN_BRAKE_INTO_IMPACT_S if into_impact else MIN_BRAKE_S):
                out.append(_ev(n, actor, "brake", T[i], T[end], f"min {min(G[i:end + 1]):.2f} g", 0.93, rr(i), rr(end), "R_brake_0.12g_0.3s", source)); n += 1
            i = j + 1
        else:
            i += 1
    # The largest spike exists in every log, crash or not. On 20 DeepAccident scenarios, no vehicle that didn't
    # collide passed 4.72 g, so below 5 g this stays a candidate that needs another source to back it up.
    strong = abs(G[imp]) >= CONFIRMED_IMPACT_G
    out.append(_ev(n, actor, "impact", T[imp], T[imp], f"{G[imp]:.2f} g" + ("" if strong else " (candidate: below 5 g, needs a second source)"),
                   0.96 if strong else 0.6, rr(imp), rr(imp), "R_peak_accel", source)); n += 1
    moving = [k for k in range(len(rows)) if V[k] > 3]
    if moving and moving[-1] + 10 < len(rows):
        k = moving[-1] + 1
        out.append(_ev(n, actor, "stop", T[k], T[-1], "speed < 1 km/h", 0.9, rr(k), rr(len(rows) - 1), "R_stop_1kmh", source)); n += 1
    if any(r["airbag"] == "1" for r in rows):
        k = next(i for i, r in enumerate(rows) if r["airbag"] == "1")
        out.append(_ev(n, actor, "airbag", T[k], T[k], "deployed", 0.99, rr(k), rr(k), "R_airbag_flag", source)); n += 1
    return out


def rows_of(csv_path) -> list[dict]:
    return [{"t": float(r["t"]), "speed_kmh": float(r["speed_kmh"]), "accel_g": float(r["accel_g"])} for r in csv.DictReader(open(csv_path))]


def peak_g(csv_path) -> tuple[float, int]:
    rows = list(csv.DictReader(open(csv_path)))
    i = max(range(len(rows)), key=lambda i: abs(float(rows[i]["accel_g"])))
    return abs(float(rows[i]["accel_g"])), i + 2
