"""Locations are logged from the evidence, never asked for, and always say where they came from."""
import json
from pathlib import Path

import pytest

from app import geotag

ROOT = Path(__file__).resolve().parents[2]
CASES = ROOT / "data" / "cases"
SHIPPED = ["hero", "demo", "dashcam", "india-junction", "rear-end"]


def _sensor(d: Path, rows: list[str]):
    (d / "evidence").mkdir(parents=True)
    (d / "evidence" / "sensor.csv").write_text("t,speed_kmh,accel_g,brake,indicator,airbag,lat,lon\n" + "\n".join(rows), encoding="utf-8")


def test_a_location_on_the_case_never_moves(tmp_path):
    loc, new = geotag.resolve("x", tmp_path, None, {"name": "A road", "lat": 17.5, "lon": 78.5})
    assert not new and (loc["lat"], loc["lon"], loc["name"]) == (17.5, 78.5, "A road") and loc["source"]


def test_a_feed_uploaded_by_hand_is_located_by_its_camera(tmp_path):
    cam = json.loads(geotag.CAMS.read_text(encoding="utf-8"))["cameras"][0]
    loc, new = geotag.resolve("x", tmp_path, ROOT / cam["source"])
    assert new and loc["method"] == "camera_registry" and loc["camera"] == cam["id"] and (loc["lat"], loc["lon"]) == (cam["lat"], cam["lon"])


def test_the_agent_camera_id_wins():
    cam = json.loads(geotag.CAMS.read_text(encoding="utf-8"))["cameras"][2]
    assert geotag.matching_camera("x", None, cam["id"])["id"] == cam["id"]


@pytest.mark.parametrize("tags,want", [
    ({"location": "+17.4448+078.3478/"}, (17.4448, 78.3478)),
    ({"com.apple.quicktime.location.ISO6709": "+17.4400+078.3500+540.000/"}, (17.44, 78.35)),
    ({"location": "somewhere"}, None), ({"location": "+00.0000+000.0000/"}, None), ({}, None)])
def test_gps_in_the_video_metadata(tags, want):
    assert geotag.video_gps(tags) == want


def test_telematics_gps_is_taken_at_the_impact(tmp_path):
    _sensor(tmp_path, ["1,40,0.1,0,0,0,17.4300,78.3500", "2,30,3.5,1,0,1,17.4310,78.3510", "3,0,0.1,1,0,1,17.4320,78.3520"])
    loc, new = geotag.resolve("x", tmp_path, None)
    assert new and loc["method"] == "telematics_gps" and (loc["lat"], loc["lon"]) == (17.431, 78.351)


def test_the_simulators_constant_is_not_a_reading(tmp_path):
    _sensor(tmp_path, ["1,40,0.1,0,0,0,17.4401,78.3489"])
    loc, _ = geotag.resolve("x", tmp_path, None)
    assert loc["method"] == "estimated"


def test_no_evidence_gives_an_estimate_that_says_so(tmp_path):
    loc, new = geotag.resolve("some-case", tmp_path, None)
    assert new and loc["estimated"] and "estimated" in loc["source"] and loc["lat"] is not None and loc["name"]
    assert geotag.resolve("some-case", tmp_path, None)[0]["lat"] == loc["lat"]   # the same case lands in the same place


def test_a_linked_dashcam_shares_the_incidents_location(tmp_path):
    parent = {"name": "A junction", "lat": 17.44, "lon": 78.35, "method": "camera_registry", "source": "registered position of camera X"}
    loc, new = geotag.resolve("x", tmp_path, None, None, None, {"location": parent})
    assert new and loc["method"] == "linked_case" and loc["lat"] == 17.44


@pytest.mark.parametrize("cid", SHIPPED)
def test_every_shipped_case_has_a_logged_location(cid):
    loc = json.loads((CASES / cid / "case.json").read_text(encoding="utf-8"))["location"]
    assert loc["lat"] is not None and loc["lon"] is not None and loc["source"] and loc["method"] == "camera_registry"
    assert any('"location_logged"' in line for line in (CASES / cid / "custody.jsonl").read_text(encoding="utf-8").splitlines())


def test_no_screen_asks_for_a_location():
    pages = ROOT / "frontend" / "src"
    for rel in ("pages/NewCase.tsx", "pages/Response.tsx", "pages/Pursuit.tsx", "components/ContextPanel.tsx"):
        s = (pages / rel).read_text(encoding="utf-8")
        for asks in ('placeholder="Location', "Set location", 'aria-label="Latitude"'):
            assert asks not in s, f"{rel} still asks for a location"


def test_alerts_go_out_after_the_records_exist():
    """Sent any earlier, police read "Victim: being identified" and no family alert goes out."""
    s = (ROOT / "backend" / "app" / "make_case.py").read_text(encoding="utf-8")
    assert s.index("records.build(d)") < s.index("emergency.auto_trigger(d)")
