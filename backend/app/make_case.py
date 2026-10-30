"""One command: evidence in -> every website artifact out.

  python -m app.make_case hero                      # reuse video output, rerun everything after it
  python -m app.make_case hero --video <mp4> ...    # run the video pipeline first
  python -m app.make_case hero --simulate-sensor    # generate telematics from the calibrated bus track

Stages: video -> case build -> calibration -> sensor -> witnesses -> fusion -> severity -> merged events.
Any stage whose inputs are missing is skipped and reported; the website shows "not computed yet" for it."""
import argparse
import json
from pathlib import Path

import numpy as np

from . import build_case, calibration, severity
from .custody import Ledger, sha256_file
from .pipeline import fusion, sensor, sensor_sim, video, witness

DATA = Path(__file__).resolve().parents[2] / "data" / "cases"


def severity_for(case_dir: Path, ent: dict, metric: dict, events: list[dict]) -> dict:
    tracks = {t["id"]: t for t in metric["tracks"]}
    sig, refs = {}, {}
    csv_p = case_dir / "evidence" / "sensor.csv"
    if csv_p.exists():
        g, row = sensor.peak_g(csv_p)
        sig["peak_g"], refs["peak_g"] = round(g, 2), f"sensor.csv#r={row}"
        if any(e["action"] == "airbag" for e in events):
            sig["airbag"] = True
    bus = tracks.get(ent.get("bus", ""))
    if bus:
        before = [p["v_kmh"] for p in bus["points"] if -0.6 <= p["t"] <= -0.1]
        after = [p["v_kmh"] for p in bus["points"] if 0.2 <= p["t"] <= 0.7]
        if before and after:
            sig["dv_kmh"], refs["dv_kmh"] = round(float(np.mean(before) - np.mean(after)), 1), f"tracks_metric:{bus['id']}"
        off = tracks.get(ent.get("officer", ""))
        if off and bus["points"]:
            rest = bus["points"][-1]
            near = min(np.hypot(p["x"] - rest["x"], p["y"] - rest["y"]) for p in off["points"] if -0.5 <= p["t"] <= 1.0) if any(-0.5 <= p["t"] <= 1.0 for p in off["points"]) else 99
            sig["vru_involved"] = bool(near < 3.0)
            refs["vru_involved"] = f"officer within {near:.1f} m of the bus at impact (tracks_metric)"
    downs = [e for e in events if e["action"] == "person_down"]
    sig["person_down_s"] = max((e["t"]["end"] - e["t"]["start"] for e in downs), default=0)
    if downs:
        refs["person_down_s"] = downs[0]["ref"]
    sig["refs"] = refs
    out = severity.score(sig)
    out["signals"] = sig
    out["minor_example"] = severity.score({"peak_g": 0.8, "dv_kmh": 4})
    return out


def score_against(gt: dict, analysis: dict, witness_events: list[dict]) -> dict:
    """A planted contradiction is caught when a contradiction of the same type cites a claim from that witness.
    A false flag is a contradiction on a claim the ground truth lists as consistent."""
    src = {e["id"]: e["source"] for e in witness_events}
    quote = {e["id"]: e.get("quote", "") for e in witness_events}
    found = [(c["type"], {src[i] for i in c["events"] if i in src}, [quote[i] for i in c["events"] if i in quote]) for c in analysis["contradictions"]]
    caught = [p["id"] for p in gt["planted"] if any(t == p["type"] and p["witness"] in ws for t, ws, _ in found)]
    false_flags = sum(1 for c in gt.get("consistent", []) for t, ws, qs in found
                      if t != "witness" and c["witness"] in ws and any(c["claim"].split()[1] in q.lower() for q in qs))
    return {"planted": len(gt["planted"]), "caught": len(caught), "caught_ids": caught, "false_flags": false_flags,
            "extra_found": [c["id"] for c in analysis["contradictions"] if c["type"] == "witness"]}


def make(case_id: str, video_path: Path | None = None, title: str | None = None, location: str | None = None,
         simulate_sensor: bool = False, impact_label: float | None = None) -> dict:
    d = DATA / case_id
    d.mkdir(parents=True, exist_ok=True)
    report = {}
    prev = json.loads((d / "case.json").read_text()) if (d / "case.json").exists() else {}

    if video_path and not (d / "video_events.json").exists():
        report["video"] = video.run(video_path, d, impact_label=impact_label)
    src = video_path or (d / "evidence" / "cctv.mp4")
    case = build_case.build(case_id, src, title or prev.get("title", case_id), location or prev.get("location", {}).get("name", ""),
                            prev.get("location", {}).get("lat"), prev.get("location", {}).get("lon"))
    for k in ("clock_overlay",):
        if k in prev:
            case[k] = prev[k]
    (d / "case.json").write_text(json.dumps(case, indent=2))
    video_events = json.loads((d / "events.json").read_text())   # build_case wrote them on T0

    metric = calibration.run(d)
    report["calibration"] = f"reprojection {metric['reproj_err_m']} m" if metric else "skipped (no calibration.json)"
    if not metric:
        return report
    ent = fusion.guess_entities(metric) if not (d / "entities.json").exists() else json.loads((d / "entities.json").read_text())

    csv_p = d / "evidence" / "sensor.csv"
    if simulate_sensor and not csv_p.exists() and ent.get("bus"):
        bus = next(t for t in metric["tracks"] if t["id"] == ent["bus"])
        report["sensor_sim"] = sensor_sim.generate(bus, csv_p)
    sensor_events = sensor.run(csv_p, ent.get("bus", "vehicle")) if csv_p.exists() else []
    report["sensor"] = f"{len(sensor_events)} events" if sensor_events else "skipped (no sensor.csv)"

    witness_events = witness.run(d)
    report["witnesses"] = f"{len(witness_events)} claims"

    fz = fusion.run(d, video_events, sensor_events, witness_events)
    events = video_events + fz["sensor_events"] + fz["witness_events"] + fz["inferred"]
    events.sort(key=lambda e: (e["t"]["start"], e["id"]))
    (d / "events.json").write_text(json.dumps(events, indent=2))
    report["fusion"] = f"{len(fz['analysis']['contradictions'])} contradictions, {len(fz['analysis']['gaps'])} gaps"

    gt_p = d / "ground_truth.json"
    if gt_p.exists():
        fz["analysis"]["score"] = score_against(json.loads(gt_p.read_text()), fz["analysis"], witness_events)
        (d / "analysis.json").write_text(json.dumps(fz["analysis"], indent=2, default=str))
        report["score"] = f"caught {fz['analysis']['score']['caught']}/{fz['analysis']['score']['planted']}, false flags {fz['analysis']['score']['false_flags']}"

    sev = severity_for(d, fz["analysis"]["entities"], metric, events)
    (d / "severity.json").write_text(json.dumps(sev, indent=2))
    report["severity"] = f"{sev['level']} {sev['label']} ({sev['score']})"

    case["evidence"] = [e for e in case["evidence"] if e["type"] in ("video", "derived")]
    if csv_p.exists():
        case["evidence"].append({"id": "sensor", "type": "sensor", "file": "sensor.csv", "label": "Bus telematics (simulated from calibrated track)"})
    wm = json.loads((d / "witnesses.json").read_text()) if (d / "witnesses.json").exists() else {}
    for f in sorted((d / "evidence").glob("witness_*.txt")):
        m = wm.get(f.stem, {})
        case["evidence"].append({"id": f.stem, "type": "witness", "file": f.name, "label": f"{m.get('name', f.stem)} · {m.get('vantage', '')}"})
    (d / "case.json").write_text(json.dumps(case, indent=2))

    led = Ledger(d / "custody.jsonl")
    known = {(e["details"].get("file"), e["details"].get("sha256")) for e in led.entries()}
    for e in case["evidence"]:
        p = d / "evidence" / e["file"]
        h = sha256_file(p)
        if (e["file"], h) not in known:
            led.append("evidence_registered", file=e["file"], sha256=h)
    return report


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("case_id")
    ap.add_argument("--video", type=Path)
    ap.add_argument("--title")
    ap.add_argument("--location")
    ap.add_argument("--impact-label", type=float)
    ap.add_argument("--simulate-sensor", action="store_true")
    a = ap.parse_args()
    print(json.dumps(make(a.case_id, a.video, a.title, a.location, a.simulate_sensor, a.impact_label), indent=2))
