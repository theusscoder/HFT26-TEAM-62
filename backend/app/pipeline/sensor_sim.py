"""OWNER: P2. Simulated telematics for one vehicle, generated FROM its calibrated video track (PS allows
"simulated sensor records"). The device clock is deliberately offset from the CCTV clock, as real
telematics units are, so fusion has to align it on the impact spike.

CSV: t (device seconds), speed_kmh, accel_g, brake, indicator, airbag, lat, lon"""
import csv
from pathlib import Path

import numpy as np


def generate(track: dict, out: Path, device_offset_s: float = 100.8, impact_g: float = -1.9, rate_hz: float = 10,
             lat: float = 17.4401, lon: float = 78.3489, seed: int = 7) -> dict:
    rng = np.random.default_rng(seed)
    p = track["points"]
    ts = np.array([q["t"] for q in p]); vs = np.array([q["v_kmh"] for q in p])
    grid = np.arange(ts[0], ts[-1], 1 / rate_hz)
    v = np.interp(grid, ts, vs)
    v = np.convolve(np.pad(v, (3, 3), mode="edge"), np.ones(7) / 7, mode="valid")
    v = np.maximum(0, v + rng.normal(0, 0.4, len(v)))
    acc = np.gradient(v / 3.6, 1 / rate_hz) / 9.81
    t_imp = grid[np.argmin(np.abs(grid - 0.0))]
    rows = []
    for i, t in enumerate(grid):
        g = float(acc[i])
        if abs(t - t_imp) < 0.15:                      # impact pulse
            g = impact_g * (1 - abs(t - t_imp) / 0.15) + g
        brake = int(g < -0.12 and t < t_imp + 0.5)
        rows.append([round(t + device_offset_s, 2), round(float(v[i]), 1), round(g, 2), brake, 0,
                     int(abs(t - t_imp) < 0.3 and impact_g < -4), lat, lon])
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["t", "speed_kmh", "accel_g", "brake", "indicator", "airbag", "lat", "lon"])
        w.writerows(rows)
    return {"rows": len(rows), "device_offset_s": device_offset_s, "actor": track["id"]}
