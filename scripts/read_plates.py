"""Run the real ANPR on a case and report what it reads (no files the website uses are changed unless --apply).
  backend\\.venv\\Scripts\\python scripts\\read_plates.py hero            -> data/cases/hero/plate_reading_report.txt
  backend\\.venv\\Scripts\\python scripts\\read_plates.py hero --apply    -> also rewrites plates_all.json / plates.json"""
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.pipeline import plate_reader  # noqa: E402

case = sys.argv[1] if len(sys.argv) > 1 else "hero"
d = ROOT / "data" / "cases" / case
lines = []
log = lambda *a: (lines.append(" ".join(str(x) for x in a)), print(*a))
t = time.time()
eng = plate_reader.engine()
log("engine:", eng[0] if eng else None)
for e in plate_reader.ERRORS:
    log("  error:", e)
ent = plate_reader._entities(d)
tracks = [x for x in plate_reader._tracks(d) if (x.get("class") or "") in plate_reader.VEHICLE]
log("vehicle tracks:", len(tracks), "| involved:", [ent.get("primary")] + ent.get("involved", []))
if "--apply" in sys.argv:
    out = plate_reader.run(d, force=True, log=log)
    res = {v["track"]: v for v in out["vehicles"] if v["legible"]}
else:
    _, res = plate_reader.read_real(d, tracks, {}, log)
log("\nRESULT (%.0fs)" % (time.time() - t))
for tid in [ent.get("primary")] + ent.get("involved", []) + [x["id"] for x in tracks]:
    if tid in res:
        r = res[tid]
        log(f"  {tid}: {r['plate']} {'(partial, ' + str(r.get('known')) + ' certain chars)' if r.get('partial') else '(full)'} conf {r['confidence']} from {len(r['reads'])} reads {r['reads'][:8]} crop {r.get('crop')}")
log("  legible:", len(res), "of", len(tracks))
(d / "plate_reading_report.txt").write_text("\n".join(lines), encoding="utf-8")
