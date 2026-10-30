"""Upload evidence to a running YATHARTH server and follow the pipeline live.

  # a whole demo kit folder (video + witness_*.txt + sensor.csv + witnesses.json + ground_truth.json)
  backend/.venv/Scripts/python scripts/upload.py demo_kits/02-atlanta-tbone

  # any video, optionally with statements and telematics
  backend/.venv/Scripts/python scripts/upload.py path/to/clip.mp4 --witness w1.txt --witness w2.txt --sensor log.csv --title "My case"

  # every kit, one after another
  backend/.venv/Scripts/python scripts/upload.py demo_kits/*

Prints each stage as it finishes and the case URL at the end. Needs only the API on :8000 (and the website on :5173 to view)."""
import argparse
import json
import sys
import time
from pathlib import Path

import httpx

VIDEO_EXT = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}


def collect(target: Path, a) -> tuple[Path, list[Path], Path | None, list[Path], str, str]:
    if target.is_dir():
        kit = json.loads((target / "kit.json").read_text(encoding="utf-8")) if (target / "kit.json").exists() else {}
        video = next((f for f in sorted(target.iterdir()) if f.suffix.lower() in VIDEO_EXT), None)
        if not video:
            sys.exit(f"{target}: no video file")
        meta = [target / m for m in ("witnesses.json", "ground_truth.json") if (target / m).exists()]
        sensor = target / "sensor.csv" if (target / "sensor.csv").exists() else None
        return video, sorted(target.glob("witness_*.txt")), sensor, meta, a.title or kit.get("title", target.name), a.location or kit.get("location", "")
    return target, [Path(w) for w in a.witness], Path(a.sensor) if a.sensor else None, [], a.title or target.stem, a.location or ""


def upload(target: Path, a) -> str:
    video, wits, sensor, meta, title, loc = collect(target, a)
    files = [("video", (video.name, video.open("rb")))] + [("witnesses", (w.name, w.open("rb"))) for w in wits] + \
            ([("sensor", (sensor.name, sensor.open("rb")))] if sensor else []) + [("meta", (m.name, m.open("rb"))) for m in meta]
    data = {"title": title, "location": loc, "simulate_sensor": str(bool(a.simulate_sensor and not sensor)).lower()}
    print(f"\n▶ {title}\n  video {video.name} · {len(wits)} witness statement(s) · {'telematics' if sensor else 'no telematics'}{' · ' + ', '.join(m.name for m in meta) if meta else ''}")
    r = httpx.post(f"{a.api}/api/cases", files=files, data=data, timeout=300)
    if r.status_code != 200:
        sys.exit(f"  upload failed: {r.status_code} {r.text}")
    cid = r.json()["id"]
    seen = {}
    while True:
        j = httpx.get(f"{a.api}/api/jobs/{cid}", timeout=30).json()
        for k, v in j["stages"].items():
            if v["status"] == "done" and seen.get(k) != "done":
                print(f"  ✓ {k:12s} {v['detail']}")
            seen[k] = v["status"]
        if j["status"] != "running":
            break
        time.sleep(2)
    if j["status"] == "error":
        sys.exit(f"  ✗ failed: {j.get('error')}")
    rep = j.get("report") or {}
    if "score" in rep:
        print(f"  ★ {rep['score']}")
    print(f"  → {a.web}/case/{cid}")
    return cid


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("targets", nargs="+", type=Path, help="video file(s) or demo-kit folder(s)")
    ap.add_argument("--witness", action="append", default=[], help="witness statement .txt (repeatable; video uploads only)")
    ap.add_argument("--sensor", help="telematics .csv (video uploads only)")
    ap.add_argument("--simulate-sensor", action="store_true", help="no CSV? simulate telematics from the video track")
    ap.add_argument("--title")
    ap.add_argument("--location")
    ap.add_argument("--api", default="http://localhost:8000")
    ap.add_argument("--web", default="http://localhost:5173")
    a = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    for t in a.targets:
        if t.is_dir() or t.suffix.lower() in VIDEO_EXT:
            upload(t, a)
