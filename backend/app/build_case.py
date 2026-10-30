"""Assemble a website case from real pipeline output (video.py so far; sensor/witness/fusion join later).

Writes data/cases/<id>/: case.json, events.json (times relative to T0 = impact), tracks.json (image-plane
trajectories until a homography exists), severity.json, analysis.json, evidence/{cctv.mp4, annotated.mp4, background.jpg},
and registers every evidence file in the custody ledger.

Run (from backend/): python -m app.build_case hero --video ../data/raw/accident/real_videos/Xu1KsH1j2iQ_11_00.mp4 \
    --title "Bus veers into divider, traffic officer on duty" --location "Indian city junction (CCTV, 26-01-2016)" """
import argparse
import json
import shutil
from pathlib import Path

import cv2

from . import severity
from .custody import Ledger, sha256_file

DATA = Path(__file__).resolve().parents[2] / "data" / "cases"
PALETTE = ["#4f8cff", "#ff5d5d", "#f5b84f", "#3ecf8e", "#c58cff", "#5fd4e6", "#ff9f5a", "#e7eaee"]


def pick_t0(events: list[dict]) -> tuple[float, str]:
    """Impact anchor: the strongest 'possible_contact' or an abrupt stop of the fastest vehicle; else the dataset label."""
    stops = [e for e in events if e["action"] in ("stop", "sudden_decel") and e["actor"].split("_")[0] in ("car", "bus", "truck")]
    if stops:
        e = max(stops, key=lambda e: e["confidence"])
        return e["t"]["start"], e["id"]
    label = [e for e in events if e["source"] == "dataset_label"]
    return (label[0]["t"]["start"], label[0]["id"]) if label else (0.0, "")


def build(case_id: str, video: Path, title: str, location: str, lat: float | None, lon: float | None):
    d = DATA / case_id
    ev_dir = d / "evidence"
    ev_dir.mkdir(parents=True, exist_ok=True)
    raw_events = json.loads((d / "video_events.json").read_text())
    tr = json.loads((d / "tracks.json").read_text())
    info = tr["video"]

    if Path(video).resolve() != (ev_dir / "cctv.mp4").resolve():
        shutil.copy(video, ev_dir / "cctv.mp4")
    shutil.copy(d / "annotated.mp4", ev_dir / "annotated.mp4")
    cap = cv2.VideoCapture(str(video))
    ok, frame = cap.read()
    if ok:
        cv2.imwrite(str(ev_dir / "background.jpg"), frame)

    t0, anchor = pick_t0(raw_events)
    events = []
    for e in raw_events:
        e = dict(e)
        e["t"] = {**e["t"], "start": round(e["t"]["start"] - t0, 2), "end": round(e["t"]["end"] - t0, 2)}
        e["video_t"] = round(e["t"]["start"] + t0, 2)
        events.append(e)
    (d / "events.json").write_text(json.dumps(events, indent=2))

    # Image-plane trajectories for the UI; only meaningful tracks (>= 1 s) to keep the map readable.
    ui_tracks = []
    for i, (name, t) in enumerate(sorted(tr["tracks"].items(), key=lambda kv: -len(kv[1]["points"]))):
        p = t["points"]
        if p[-1]["t"] - p[0]["t"] < 1.0:
            continue
        ui_tracks.append({"id": name, "class": t["class"], "colour": PALETTE[i % len(PALETTE)],
                          "points": [{"t": round(q["t"] - t0, 2), "x": round((q["box"][0] + q["box"][2]) / 2, 1), "y": q["box"][3],
                                      "box": q["box"], "conf": q["conf"]} for q in p]})
    (d / "tracks_ui.json").write_text(json.dumps({"frame": {"units": "px", "width": info["width"], "height": info["height"],
                                                            "background": "background.jpg"}, "tracks": ui_tracks}))

    # Severity from what the video alone can show; sensor-based signals (g, delta-v) join when a CSV exists.
    persons_moving_after = any(e["action"] == "moving" and e["actor"].startswith("person") and e["t"]["start"] >= -0.5 for e in events)
    downs = [e for e in events if e["action"] == "person_down"]
    signals = {"vru_involved": any(e["actor"].startswith(("person", "motorcycle", "bicycle")) and e["action"] == "possible_contact" for e in events)
               or persons_moving_after,
               "person_down_s": max((e["t"]["end"] - e["t"]["start"] for e in downs), default=0),
               "refs": {"vru_involved": "video_events.json", "person_down_s": downs[0]["ref"] if downs else None}}
    sev = severity.score(signals)
    sev["signals"] = signals
    sev["note"] = "Video-only signals. Peak g and delta-v join when a sensor log is added."
    (d / "severity.json").write_text(json.dumps(sev, indent=2))

    analysis_path = d / "analysis.json"
    if not analysis_path.exists():
        analysis_path.write_text(json.dumps({
            "status": "pending", "note": "Fusion (alignment, contradictions, gaps) runs once witness and sensor evidence are added.",
            "offsets": {"cctv": {"offset_s": -t0, "sigma": 0.05, "anchor": anchor}},
            "contradictions": [], "gaps": [], "reliability": {}, "hypotheses": [], "counterfactual": None}, indent=2))

    label = next((e for e in events if e["source"] == "dataset_label"), None)
    case = {"id": case_id, "title": title, "location": {"name": location, "lat": lat, "lon": lon},
            "t0_video_s": t0, "t0_anchor": anchor, "range": [round(-t0, 2), round(info["duration"] - t0, 2)],
            "video": {"fps": info["fps"], "width": info["width"], "height": info["height"], "duration": info["duration"]},
            "evidence": [{"id": "cctv", "type": "video", "file": "cctv.mp4", "label": "Junction CCTV (real, ACCIDENT benchmark)", "fps": info["fps"]},
                         {"id": "annotated", "type": "derived", "file": "annotated.mp4", "label": "Annotated reconstruction (YOLO11 + ByteTrack)"}],
            "check": {"detected_impact_video_s": t0, "label_impact_video_s": label["video_t"] if label else None},
            "simulated": False, "license": "ACCIDENT benchmark, CC BY-NC-SA 4.0"}
    (d / "case.json").write_text(json.dumps(case, indent=2))

    led = Ledger(d / "custody.jsonl")
    known = {(e["details"].get("file"), e["details"].get("sha256")) for e in led.entries()}
    for f in ("cctv.mp4", "annotated.mp4"):
        h = sha256_file(ev_dir / f)
        if (f, h) not in known:
            led.append("evidence_registered", file=f, sha256=h)
    return case


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("case_id")
    ap.add_argument("--video", type=Path, required=True)
    ap.add_argument("--title", required=True)
    ap.add_argument("--location", default="")
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    a = ap.parse_args()
    c = build(a.case_id, a.video, a.title, a.location, a.lat, a.lon)
    print(json.dumps({k: c[k] for k in ("id", "t0_video_s", "t0_anchor", "range", "check")}, indent=2))
