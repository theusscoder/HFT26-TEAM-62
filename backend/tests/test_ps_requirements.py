"""What the problem statement asks, checked on the shipped cases, plus the bugs a full evaluation found."""
import json
import re
from pathlib import Path

import pytest

from app import i18n, records, response, severity
from app.custody import Ledger

CASES = Path(__file__).resolve().parents[2] / "data" / "cases"
SHIPPED = ["hero", "demo", "dashcam", "india-junction", "rear-end"]
LEGAL = re.compile(r"\b(at fault|fault of|is to blame|guilty|negligent|negligence|liable|culprit|perpetrator|unavoidable|convicted|offender)\b", re.I)


def _j(cid, name, default=None):
    p = CASES / cid / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


@pytest.mark.parametrize("cid", SHIPPED)
def test_custody_chain_verifies(cid):
    assert Ledger(CASES / cid / "custody.jsonl").verify()["ok"]


@pytest.mark.parametrize("cid", SHIPPED)
def test_timeline_is_chronological_and_every_event_is_traceable(cid):
    ev = _j(cid, "events.json")
    starts = [e["t"]["start"] for e in ev]
    assert starts == sorted(starts)
    for e in ev:
        assert e["kind"] in ("OBSERVED", "CLAIMED", "INFERRED")
        assert e.get("confidence") is not None
        assert e.get("ref") or e.get("derived_from") or e.get("rule"), e["id"]


@pytest.mark.parametrize("cid", SHIPPED)
def test_contradictions_cite_evidence(cid):
    an, ids = _j(cid, "analysis.json"), {e["id"] for e in _j(cid, "events.json")}
    assert an["contradictions"], "each shipped case has witness statements to check"
    for c in an["contradictions"]:
        assert len(c["events"]) >= 2 and set(c["events"]) <= ids, c["id"]
        assert c["summary"]


@pytest.mark.parametrize("cid", SHIPPED)
def test_no_legal_conclusions_in_generated_findings(cid):
    for name in ("analysis.json", "insights.json", "severity.json", "records.json"):
        p = CASES / cid / name
        if p.exists():
            hit = LEGAL.search(p.read_text(encoding="utf-8"))
            assert not hit, f"{cid}/{name}: {hit and hit.group(0)}"


@pytest.mark.parametrize("cid", ["dashcam", "motorcycle-rear-ends-a-braking-s-034825"])
def test_rider_hit_by_a_car_cutting_in_is_the_victim_on_every_screen(cid):
    if not (CASES / cid / "records.json").exists():
        pytest.skip("local case")
    rec = records.load(CASES / cid)
    assert rec["victim"] == "ego"
    r = response.replay_summary(cid)
    assert "ego" not in [c["track"] for c in r["culprits"]]
    assert "ego" in [v["track"] for v in r["victims"]]


@pytest.mark.parametrize("cid", SHIPPED)
def test_every_screen_shows_the_plate_on_record(cid):
    plates = {v["track"]: v["plate"] for v in records.load(CASES / cid)["vehicles"]}
    r = response.replay_summary(cid)
    for c in r["culprits"] + r["victims"]:
        if c["track"] in plates:
            assert c["plate"] == plates[c["track"]], c["track"]


def test_contact_on_camera_is_at_least_minor():
    assert severity.score({"contact": True})["level"] == "L1"
    assert severity.score({})["level"] == "L0"


def test_a_translation_may_not_change_or_drop_a_number():
    assert i18n.good("Severity ⟦0⟧ at ⟦1⟧", "తీవ్రత ⟦0⟧ ⟦1⟧ వద్ద")
    assert not i18n.good("Severity ⟦0⟧ at ⟦1⟧", "తీవ్రత ⟦0⟧")
    assert not i18n.good("Open case", "Open case")   # not actually translated
    assert i18n.translate("xx", ["Open case"]) == {}


def test_home_page_numbers_match_the_cases():
    from fastapi.testclient import TestClient
    from app.main import app
    h = TestClient(app).get("/api/highlights").json()
    assert h["cameras"] >= 6 and h["planted"] == 8 and h["caught"] == 8 and h["false_flags"] == 0
    assert 0 < h["fit_pct"] <= 100


@pytest.mark.parametrize("cid", ["hero", "demo", "dashcam", "india-junction", "rear-end"])
def test_every_shipped_case_has_a_ready_intercept(cid):
    import json
    from pathlib import Path
    d = Path(__file__).resolve().parents[2] / "data" / "cases" / cid
    assert (d / "intercept.json").exists(), "the plan must be built ahead, not while someone waits"
    sim = json.loads((d / "intercept.json").read_text(encoding="utf-8"))
    departed = json.loads((d / "pursuit.json").read_text(encoding="utf-8")).get("status") == "departed"
    assert sim["run"]["decisions"] and sim["training"] == (not departed)
    assert sim["run"]["outcome"]["result"] in ("contained", "dead_end")
    if not departed:   # a what-if never names anyone in the case as a suspect
        assert sim["plate"] is None
        assert not [n for n in sim["graph"]["nodes"] if "Suspect" in n["label"]]
        assert not [e for e in sim["run"]["decisions"] if "Hit-and-run flagged" in e["text"]]
