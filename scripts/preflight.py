"""Pre-demo check. Run with the backend's Python from the repo root:

  backend\\.venv\\Scripts\\python scripts\\preflight.py            # check everything (+ small safe fixes)
  backend\\.venv\\Scripts\\python scripts\\preflight.py --reset    # also clear previous dispatches / roles / DB links
  backend\\.venv\\Scripts\\python scripts\\preflight.py --send-test # also send a Telegram test message

Prints PASS / WARN / FAIL per item and exits 1 if anything FAILs."""
import argparse
import importlib
import json
import shutil
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
results = []


def say(level, what, detail=""):
    results.append(level)
    print(f"  {level:<4} {what}{' · ' + detail if detail else ''}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true")
    ap.add_argument("--send-test", action="store_true")
    ap.add_argument("--quick", action="store_true", help="skip the slow case builds")
    a = ap.parse_args()

    print("Python")
    v = sys.version_info
    say("PASS" if (v.major, v.minor) in ((3, 11), (3, 12)) else "WARN", f"Python {v.major}.{v.minor}", "" if v.minor in (11, 12) else "3.11/3.12 recommended (torch wheels)")
    for mod, need in (("fastapi", True), ("uvicorn", True), ("httpx", True), ("pydantic", True), ("multipart", True), ("numpy", True),
                      ("cv2", False), ("ultralytics", False), ("fast_plate_ocr", False)):
        try:
            importlib.import_module(mod)
            say("PASS", f"import {mod}")
        except Exception:
            say("FAIL" if need else "WARN", f"import {mod}",
                "pip install -r backend/requirements.txt" if need else
                ("optional: real plate OCR (pip install fast-plate-ocr)" if mod == "fast_plate_ocr" else "needed only to analyse NEW uploaded videos (requirements-cv.txt)"))
    say("PASS" if shutil.which("ffmpeg") else "WARN", "ffmpeg on PATH", "" if shutil.which("ffmpeg") else "needed only for .mov/.avi uploads and browser-friendly annotated video")

    print("Data")
    hero = ROOT / "data" / "cases" / "hero"
    for f in ("case.json", "events.json", "analysis.json", "severity.json", "tracks.json", "evidence/cctv.mp4", "evidence/annotated.mp4"):
        say("PASS" if (hero / f).exists() else "FAIL", f"hero/{f}")
    if not (hero / "annotated.mp4").exists() and (hero / "evidence" / "annotated.mp4").exists():
        shutil.copy(hero / "evidence" / "annotated.mp4", hero / "annotated.mp4")  # rebuilds need it at the case root
        say("PASS", "hero/annotated.mp4 restored at case root", "fixes 'Rebuild' / calibration on a fresh clone")
    db = ROOT / "data" / "ts_police_db"
    for f in ("vehicles.json", "toll_logs.csv", "toll_plazas.json", "police_stations.json", "hospitals.json", "meta.json"):
        say("PASS" if (db / f).exists() else "FAIL", f"ts_police_db/{f}", "" if (db / f).exists() else "python scripts/make_ts_police_db.py")
    say("PASS" if (ROOT / "frontend" / "node_modules").exists() else "FAIL", "frontend/node_modules", "" if (ROOT / "frontend" / "node_modules").exists() else "cd frontend && npm install")
    kits = sorted(p.name for p in (ROOT / "demo_kits").glob("*") if p.is_dir())
    say("PASS" if kits else "WARN", "demo kits", ", ".join(kits))

    if a.reset:
        print("Reset demo state")
        for case in ("hero", "demo"):
            for f in ("notifications.json", "roles.json", "response_location.json", "tracking.json"):
                p = ROOT / "data" / "cases" / case / f
                if p.exists():
                    p.unlink()
                    say("PASS", f"removed {case}/{f}")
        p = db / "case_links.json"
        if p.exists():
            p.unlink()
            say("PASS", "removed ts_police_db/case_links.json")

    print("Backend")
    try:
        from app import main  # noqa: F401  (imports every route; also loads backend/.env)
        say("PASS", "backend imports (app.main)")
    except Exception as e:
        say("FAIL", "backend imports", f"{type(e).__name__}: {e}")
        return finish()
    if not a.quick:
        from app import response
        for case in ("hero", "demo"):
            try:
                r = response.build(case)
                say("PASS", f"Response & alerts · {case}", f"{r['plates']['counts']['vehicles']} plates, {len(r['suspects'])} suspect, "
                    f"{len(r['victims'])} victim(s), {len(r['notifications']['plan'])} alerts planned")
            except Exception as e:
                say("FAIL", f"Response & alerts · {case}", f"{type(e).__name__}: {e}")

    print("Telegram")
    import os
    token, chat, phone = os.getenv("TELEGRAM_BOT_TOKEN"), os.getenv("DEMO_CHAT_ID_1"), os.getenv("DEMO_PHONE")
    say("PASS" if phone else "WARN", "DEMO_PHONE", phone or "not set")
    if not token or not chat:
        say("WARN", "Telegram not linked", "run link_telegram.bat (alerts will show as 'simulated' until then)")
    else:
        try:
            with urllib.request.urlopen(f"https://api.telegram.org/bot{token}/getMe", timeout=10) as r:
                me = json.loads(r.read())
            say("PASS" if me.get("ok") else "FAIL", "bot token", "@" + me["result"]["username"] if me.get("ok") else "rejected")
        except Exception as e:
            say("FAIL", "reach api.telegram.org", f"{type(e).__name__}: {e} (check internet / firewall)")
        if a.send_test:
            from app import notify
            r = notify.send("police", "YATHARTH preflight", None, "✅ YATHARTH preflight", "Demo alerts will reach this phone.")
            say("PASS" if r["status"] == "sent" else "FAIL", "test message", r["status"])
    return finish()


def finish():
    f, w = results.count("FAIL"), results.count("WARN")
    print(f"\n{'READY' if not f else 'NOT READY'}: {results.count('PASS')} pass, {w} warn, {f} fail")
    sys.exit(1 if f else 0)


if __name__ == "__main__":
    main()
