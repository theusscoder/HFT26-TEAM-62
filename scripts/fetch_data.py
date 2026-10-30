"""Fetch a small, real demo set: CCTV crash clips (ACCIDENT, Kaggle) + dashcam collision clips (Nexar, HF).
Downloads individual files only, never the full archives. Output: data/raw/{accident,nexar}/

Prereqs (each teammate does this once with their own account):
  Kaggle: kaggle.com > Settings > API > Create New Token, saved where the kaggle CLI expects it
  Nexar:  open https://huggingface.co/datasets/nexar-ai/nexar_collision_prediction, accept the terms,
          then `backend/.venv/Scripts/hf auth login` with a read token

Run: backend/.venv/Scripts/python scripts/fetch_data.py [--cctv 12] [--dashcam 8]"""
import argparse
import csv
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "data" / "raw"
SCRIPTS = Path(sys.executable).parent
KAGGLE = str(SCRIPTS / "kaggle")
SLUG = "picekl/accident"


def kaggle_file(name: str, dest: Path) -> Path:
    """Download one file from the Kaggle dataset; Kaggle zips single files sometimes."""
    dest.mkdir(parents=True, exist_ok=True)
    subprocess.run([KAGGLE, "datasets", "download", SLUG, "-f", name, "-p", str(dest), "-q"], check=True)
    out = dest / Path(name).name
    z = out.with_name(out.name + ".zip")
    if z.exists():
        with zipfile.ZipFile(z) as f:
            f.extractall(dest)
        z.unlink()
    return out


def fetch_accident(n: int):
    dest = ROOT / "accident"
    meta = kaggle_file("metadata-real.csv", dest)
    rows = list(csv.DictReader(open(meta, encoding="utf-8")))
    print(f"ACCIDENT real metadata: {len(rows)} rows, columns: {list(rows[0].keys())}")
    path_col = next((c for c in rows[0] if c.lower() in ("path", "video", "video_path", "filename", "file", "video_id")), None)
    type_col = next((c for c in rows[0] if "type" in c.lower()), None)
    if not path_col:
        print("Could not find the video column; inspect metadata-real.csv and set it here.")
        return
    # Demo-worthy only: clear daytime junction footage. Rain/rollover kept for the weather and severity demos.
    good = {"Excellent", "Good"}
    junction = {"signalized_intersection", "simple_intersection", "city_street"}
    rows = [r for r in rows if r["quality"] in good and r["day_time"] == "day" and r["scene_layout"] in junction]
    rows.sort(key=lambda r: (r["quality"] != "Excellent", r["weather"] != "normal"))
    print(f"  {len(rows)} clear daytime junction clips")
    # Spread picks across collision types so we get T-bone, rear-end, head-on, etc.
    by_type: dict[str, list[dict]] = {}
    for r in rows:
        by_type.setdefault(r.get(type_col, "all") if type_col else "all", []).append(r)
    picks, i = [], 0
    while len(picks) < n and any(i < len(v) for v in by_type.values()):
        for v in by_type.values():
            if i < len(v) and len(picks) < n:
                picks.append(v[i])
        i += 1
    for r in picks:
        name = r[path_col]
        if not name.startswith("real_videos"):
            name = f"real_videos/{name}"
        if not name.endswith(".mp4"):
            name += ".mp4"
        try:
            kaggle_file(name, dest)
            print("  ok", name, r["type"], r["scene_layout"], r["quality"], r["weather"], f"impact {r['accident_time']}s")
        except subprocess.CalledProcessError:
            print("  failed", name)


def fetch_nexar(n: int):
    from huggingface_hub import hf_hub_download, list_repo_files
    repo = "nexar-ai/nexar_collision_prediction"
    dest = ROOT / "nexar"
    for meta in ("README.md", "LICENSE"):
        hf_hub_download(repo, meta, repo_type="dataset", local_dir=dest)
    files = [f for f in list_repo_files(repo, repo_type="dataset") if f.startswith("train/positive/")]
    for f in files[:n]:
        hf_hub_download(repo, f, repo_type="dataset", local_dir=dest)
        print("  ok", f)
    # Training labels (event / alert time) live in a CSV in the repo root when present.
    for f in list_repo_files(repo, repo_type="dataset"):
        if f.endswith(".csv") and "/" not in f:
            hf_hub_download(repo, f, repo_type="dataset", local_dir=dest)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--cctv", type=int, default=12)
    ap.add_argument("--dashcam", type=int, default=8)
    a = ap.parse_args()
    for label, fn, n in (("ACCIDENT (CCTV)", fetch_accident, a.cctv), ("Nexar (dashcam)", fetch_nexar, a.dashcam)):
        print(f"== {label}")
        try:
            fn(n)
        except Exception as e:  # keep going so one missing login doesn't block the other source
            print(f"  skipped: {e}")
