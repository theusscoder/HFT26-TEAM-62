"""Red team: a judge types a fake statement and the same rules test it live. Runs fusion on a scratch copy of the
case, so nothing here changes the evidence or the stored analysis. "No conflict" never means true."""
import json
import shutil
import tempfile
from pathlib import Path

from .pipeline import fusion, stn, witness

INPUT_ID = "witness_9"
COPY = ["case.json", "tracks_metric.json", "tracks_ui.json", "vision.json", "entities.json", "entities_override.json", "witnesses.json", "vision_actors.json"]


def check(case_dir: Path, statement: str) -> dict:
    statement = statement.strip()
    try:
        ex = witness.extract(statement, INPUT_ID)
    except Exception:
        return {"status": "not_checked", "reason": "The statement couldn't be read.", "claims": [], "contradictions": []}
    new_events = witness.to_events(ex)
    if not new_events:
        return {"status": "no_conflict", "reason": "No checkable claim was found in that statement.", "claims": [], "rejected": ex["rejected"], "contradictions": []}

    events = json.loads((case_dir / "events.json").read_text(encoding="utf-8"))
    video = [e for e in events if e["source"] not in ("sensor", "fusion") and not e["source"].startswith("witness_")]
    sensor_events = [e for e in events if e["source"] == "sensor"]

    with tempfile.TemporaryDirectory() as tmp:
        scratch = Path(tmp)
        (scratch / "evidence").mkdir()
        for name in COPY:
            if (case_dir / name).exists():
                shutil.copy(case_dir / name, scratch / name)
        for name in ("sensor.csv",):
            if (case_dir / "evidence" / name).exists():
                shutil.copy(case_dir / "evidence" / name, scratch / "evidence" / name)
        (scratch / "evidence" / f"{INPUT_ID}.txt").write_text(statement, encoding="utf-8")
        meta = json.loads((scratch / "witnesses.json").read_text()) if (scratch / "witnesses.json").exists() else {}
        meta[INPUT_ID] = {"name": "The typed statement", "vantage": "red-team input"}
        (scratch / "witnesses.json").write_text(json.dumps(meta))
        (scratch / "witness_orderings.json").write_text(json.dumps(witness.orderings_as_constraints(ex, dict(enumerate(new_events)))), encoding="utf-8")
        result = fusion.run(scratch, video, sensor_events, new_events)

    new_ids = {e["id"] for e in new_events}
    found = [c for c in result["analysis"]["contradictions"] if new_ids & set(c["events"])]
    claims = [{"id": e["id"], "actor": e["actor"], "action": e["action"], "value": e.get("value"), "quote": e["quote"]} for e in new_events]
    checks = {c["claim"]: c["status"] for c in result["analysis"]["checks"]}
    for c in claims:
        c["status"] = checks.get(c["id"], "unverifiable")
    if found:
        return {"status": "flagged", "reason": found[0]["summary"], "claims": claims, "contradictions": found, "rejected": ex["rejected"]}
    all_unverifiable = all(c["status"] == "unverifiable" for c in claims)
    return {"status": "no_conflict", "claims": claims, "contradictions": [], "rejected": ex["rejected"],
            "reason": "Nothing in the evidence can test this statement." if all_unverifiable
            else "Nothing in the evidence conflicts with this statement. That does not show it is true."}
