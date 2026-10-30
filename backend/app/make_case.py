"""One command: evidence in -> every website artifact out. Works on any uploaded clip.

  python -m app.make_case hero                      # reuse video output, rerun everything after it
  python -m app.make_case mycase --video <mp4>      # run the video pipeline first
  python -m app.make_case mycase --simulate-sensor  # generate telematics from the calibrated primary track

Stages: video -> case build -> calibration (auto if none) -> vision keyframes -> sensor -> witnesses -> fusion ->
severity -> merged events. A stage whose inputs are missing is skipped and reported; the website shows
"not computed yet" for it. `progress(stage, status, detail)` lets the API stream live status to the browser."""
import argparse
import json
from pathlib import Path

import numpy as np

from . import build_case, calibration, emergency, insights, severity
from .custody import Ledger, sha256_file
from .pipeline import dashcam, fusion, pursuit, scene3d, sensor, sensor_sim, video, vision, witness

DATA = Path(__file__).resolve().parents[2] / "data" / "cases"
STAGES = ["video", "camera", "calibration", "vision", "sensor", "witnesses", "fusion", "severity", "insights", "pursuit", "scene3d"]


def severity_for(case_dir: Path, ent: dict, metric: dict, events: list[dict]) -> dict:
    seen = emergency.scene_signals(json.loads((case_dir / "vision.json").read_text()) if (case_dir / "vision.json").exists() else None)
    tracks = {t["id"]: t for t in metric["tracks"]}
    sig, refs = {}, {}
    csv_p = case_dir / "evidence" / "sensor.csv"
    if csv_p.exists():
        g, row = sensor.peak_g(csv_p)
        sig["peak_g"], refs["peak_g"] = round(g, 2), f"sensor.csv#r={row}"
        if any(e["action"] == "airbag" for e in events):
            sig["airbag"] = True
    prim = tracks.get(ent.get("primary") or "")
    if prim:
        before = [p["v_kmh"] for p in prim["points"] if -0.6 <= p["t"] <= -0.1]
        after = [p["v_kmh"] for p in prim["points"] if 0.2 <= p["t"] <= 0.7]
        if before and after:
            sig["dv_kmh"], refs["dv_kmh"] = round(float(np.mean(before) - np.mean(after)), 1), f"tracks_metric:{prim['id']}"
    vru = [i for i in ent.get("involved", []) if tracks.get(i, {}).get("class") in ("person", "motorcycle", "bicycle")]
    sig["vru_involved"] = bool(vru)
    if vru:
        refs["vru_involved"] = f"{', '.join(ent['names'].get(i, i) for i in vru)} within 3 m of the impact"
    downs = [e for e in events if e["action"] == "person_down"]
    sig["person_down_s"] = max((e["t"]["end"] - e["t"]["start"] for e in downs), default=0)
    if downs:
        refs["person_down_s"] = downs[0]["ref"]
    sig["fire_smoke"], sig["rollover"] = seen["fire_smoke_seen"], seen["overturned_seen"]
    if seen["fire_smoke_seen"] or seen["overturned_seen"]:
        refs["fire_smoke"] = refs["rollover"] = "vision.json"
    sig["refs"] = refs
    out = severity.score(sig)
    out["signals"] = sig
    out["minor_example"] = severity.score({"peak_g": 0.8, "dv_kmh": 4})
    return out


def score_against(gt: dict, analysis: dict, witness_events: list[dict]) -> dict:
    """A planted contradiction is caught when a contradiction of the same type cites a claim from that witness,
    each planted item matching once. Any other contradiction is a false flag, apart from witness-vs-witness,
    which is a real extra finding about the statements rather than a claim against the evidence."""
    src = {e["id"]: e["source"] for e in witness_events}
    remaining = [c for c in analysis["contradictions"] if c["type"] != "witness"]
    caught = []
    for p in gt["planted"]:
        hit = next((c for c in remaining if c["type"] == p["type"] and p["witness"] in {src.get(i) for i in c["events"]}), None)
        if hit is not None:
            caught.append(p["id"])
            remaining.remove(hit)
    return {"planted": len(gt["planted"]), "caught": len(caught), "caught_ids": caught, "false_flags": len(remaining),
            "false_flag_ids": [c["id"] for c in remaining],
            "extra_found": [c["id"] for c in analysis["contradictions"] if c["type"] == "witness"]}


def make(case_id: str, video_path: Path | None = None, title: str | None = None, location: str | None = None,
         simulate_sensor: bool = False, impact_label: float | None = None, progress=None) -> dict:
    say = progress or (lambda *a: None)
    d = DATA / case_id
    d.mkdir(parents=True, exist_ok=True)
    report = {}
    prev = json.loads((d / "case.json").read_text()) if (d / "case.json").exists() else {}

    src = video_path or (d / "evidence" / "cctv.mp4")
    if not (d / "video_events.json").exists():
        say("video", "running", "detecting and tracking road users (YOLO11 + ByteTrack)")
        report["video"] = video.run(src, d, impact_label=impact_label, progress=lambda f: say("video", "running", f"{f * 100:.0f}% of frames"))
    say("video", "done", "tracks + annotated video")
    # Camera type: auto from background motion; a case hint (demo kit / user) may override it and name the ego vehicle.
    hint = json.loads((d / "case_hint.json").read_text()) if (d / "case_hint.json").exists() else {}
    cam = json.loads((d / "tracks.json").read_text())["video"].get("camera", {"type": "cctv"})
    mode = hint.get("camera") or cam["type"]
    report["camera"] = f"{mode} ({cam.get('why', 'given')}{', overridden by case hint' if hint.get('camera') and hint['camera'] != cam['type'] else ''})"
    say("camera", "done", report["camera"])
    t0_override = None
    if mode == "dashcam":
        dc = dashcam.analyse(d, hint.get("ego_class", "car"))
        t0_override = (dc["t0_video_s"], f"dashcam:{dc['t0_method']}")
    case = build_case.build(case_id, src, title or prev.get("title", case_id), location or prev.get("location", {}).get("name", ""),
                            prev.get("location", {}).get("lat"), prev.get("location", {}).get("lon"), t0_override)
    case["camera"] = {**cam, "type": mode}
    for k in ("clock_overlay", "weather", "incident_time_utc", "heading_deg", "dashcam_case"):
        if k in prev:
            case[k] = prev[k]
    (d / "case.json").write_text(json.dumps(case, indent=2))
    video_events = json.loads((d / "events.json").read_text())

    say("calibration", "running", "road plane: metres and km/h")
    if mode == "dashcam":
        metric = dashcam.to_metric(d)
        video_events += dashcam.events(d)
        report["calibration"] = "dashcam geometry (vanishing point + ego speed from road flow), ±30%"
    else:
        metric = calibration.run(d)
        report["calibration"] = ("auto (object-size fit), " if metric.get("auto") else "manual, ") + f"±{metric['scale_sigma'] * 100:.0f}%"
    say("calibration", "done", report["calibration"])

    ui = json.loads((d / "tracks_ui.json").read_text())
    sc = fusion.scene(metric, ui, fusion.override_of(d))
    prim = sc["primary"]
    say("vision", "running", "keyframes → Featherless vision model")
    vis = vision.run(d, case, prim, sc["tracks"].get(prim, {}).get("class") if prim else None)
    if vis.get("overlay_clock") and "clock_overlay" not in case:
        case["clock_overlay"] = {"at_video_s": 0.0, "value": vis["overlay_clock"], "method": "read by vision model from the burned-in overlay"}
        (d / "case.json").write_text(json.dumps(case, indent=2))
    report["vision"] = vis["method"]
    report["road_users"] = f"{len(scene3d.identify(d))} checked by vision"
    say("vision", "done", f"{vis['method']}; {report['road_users']}")

    csv_p = d / "evidence" / "sensor.csv"
    if simulate_sensor and not csv_p.exists() and prim:
        report["sensor_sim"] = sensor_sim.generate(sc["tracks"][prim], csv_p)
    sensor_events = sensor.run(csv_p, prim or "vehicle") if csv_p.exists() else []
    report["sensor"] = f"{len(sensor_events)} events" if sensor_events else "skipped (no sensor.csv)"
    say("sensor", "done", report["sensor"])

    say("witnesses", "running", "extracting checkable claims")
    witness_events = witness.run(d)
    methods = sorted({e["method"].split(" · ")[0] for e in witness_events})
    report["witnesses"] = f"{len(witness_events)} claims ({', '.join(methods) or 'no statements'})"
    say("witnesses", "done", report["witnesses"])

    say("fusion", "running", "aligning clocks, checking every claim")
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
    say("fusion", "done", report["fusion"])

    sev = severity_for(d, fz["analysis"]["entities"], metric, events)
    (d / "severity.json").write_text(json.dumps(sev, indent=2))
    report["severity"] = f"{sev['level']} {sev['label']} ({sev['score']})"
    say("severity", "done", report["severity"])
    try:  # the moment a crash is analysed: police informed, urgent units out, the struck party's contact told
        report["auto_response"] = f"{len(emergency.auto_trigger(d)['dispatched'])} unit(s) sent automatically"
    except Exception as e:
        report["auto_response"] = f"not run: {str(e)[:80]}"
    ins = insights.build(d)
    report["insights"] = f"{len(ins)} key findings"
    say("insights", "done", report["insights"])

    left = pursuit.run(d, say)
    report["pursuit"] = f"{left['status']}: {left['plates_method']}"
    say("pursuit", "done", left["status"])

    from . import faces
    if faces.available() and (d / "evidence" / "cctv.mp4").exists():
        report["faces"] = f"{faces.scan(d)['usable']} usable faces in the footage"
    say("scene3d", "running", "solving the camera, fitting vehicles to the footage")
    built = scene3d.run(d)
    report["scene3d"] = f"camera {built['camera']['height_m']:.1f} m up, fit IoU {built['fit']['iou_all']}, {built['actors']['asked']} road users checked by vision" if built else "skipped"
    say("scene3d", "done", report["scene3d"])

    case["evidence"] = [e for e in case["evidence"] if e["type"] in ("video", "derived")]
    if csv_p.exists():
        case["evidence"].append({"id": "sensor", "type": "sensor", "file": "sensor.csv", "label": "Vehicle telematics"})
    wm = json.loads((d / "witnesses.json").read_text()) if (d / "witnesses.json").exists() else {}
    for f in sorted((d / "evidence").glob("witness_*.txt")):
        m = wm.get(f.stem, {})
        case["evidence"].append({"id": f.stem, "type": "witness", "file": f.name, "label": f"{m.get('name', f.stem.replace('_', ' ').title())}{' · ' + m['vantage'] if m.get('vantage') else ''}"})
    (d / "case.json").write_text(json.dumps(case, indent=2))

    led = Ledger(d / "custody.jsonl")
    entries = led.entries()
    known = {(e["details"].get("stored") or e["details"].get("file"), e["details"].get("sha256")) for e in entries}
    named = {e["details"].get("stored") or e["details"].get("file") for e in entries}
    for e in case["evidence"]:
        p = d / "evidence" / e["file"]
        h = sha256_file(p)
        if (e["file"], h) not in known:
            # A known file with a new hash is a change, and the ledger says so rather than registering it afresh.
            led.append("evidence_changed" if e["file"] in named else "evidence_registered", file=e["file"], sha256=h)
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
    print(json.dumps(make(a.case_id, a.video, a.title, a.location, a.simulate_sensor, a.impact_label,
                          progress=lambda s, st, det="": print(f"  [{s}] {st} {det}")), indent=2))
