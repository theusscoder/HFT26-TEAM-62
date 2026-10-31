"""ANPR result logic tests. Run from backend/:  python -m pytest -q tests"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.pipeline.anpr_result import (candidates, direction, is_standard, normalise, plate_info, status_for,  # noqa: E402
                                      vote)
from app.pipeline import plate_reader  # noqa: E402


# ---------- partial OCR ----------
def test_single_uncertain_read_keeps_question_marks():
    v = vote([("TS09AB1234", 0.8, [0.9, 0.9, 0.9, 0.9, 0.9, 0.3, 0.9, 0.9, 0.9, 0.9])])
    assert v["plate"] == "TS09A?1234"
    assert v["partial"] and v["known"] == 9


def test_partial_never_fills_unknown_without_observed_alternatives():
    v = vote([("TS09AB1234", 0.8, [0.9] * 5 + [0.2] + [0.9] * 4)])
    # the only character ever seen at position 5 is 'B': it may be offered as a candidate, nothing else is invented
    assert candidates(v["plate"], v["alternatives"]) == ["TS09AB1234"]
    assert candidates("TS09A?1234", {}) == []


# ---------- multiple candidate readings ----------
def test_frames_that_disagree_give_candidates_from_observed_characters_only():
    v = vote([("TS09AB1234", 0.5), ("TS09A81234", 0.5), ("TS09AB1234", 0.2), ("TS09A81234", 0.2)])
    assert v["plate"] == "TS09A?1234"
    c = candidates(v["plate"], v["alternatives"])
    assert set(c) == {"TS09AB1234", "TS09A81234"}
    assert all(len(x) == 10 for x in c)


def test_candidate_count_is_capped():
    alts = {i: list("ABCD") for i in range(4, 7)}
    assert len(candidates("TS09???234", alts)) <= 8


# ---------- repeated frames ----------
def test_repeated_frames_reinforce_a_full_read():
    v = vote([("MP04PA0802", 0.7)] * 6 + [("MP04PA0892", 0.4)])
    assert v["plate"] == "MP04PA0802" and not v["partial"]
    assert v["frames_voted"] == 7


def test_one_clear_frame_survives_blurred_ones():
    # blurred frames produce empty reads; the clear one is retained
    v = vote([("", 0.1), ("MP04PA0802", 0.8, [0.9] * 10), ("", 0.05)])
    assert v["plate"] == "MP04PA0802"


# ---------- unreadable plates ----------
def test_unreadable_plate_status_and_reason():
    assert status_for(None, plate_located=True, vehicle_px=(300, 200))[0] == "plate_detected_ocr_failed"
    assert status_for(None, plate_located=False, vehicle_px=(300, 200))[0] == "plate_not_detected"
    s, reason = status_for(None, plate_located=False, vehicle_px=(40, 50))
    assert s == "insufficient_image_quality" and "Insufficient visual evidence" in reason
    assert vote([])["plate"] is None


def test_non_standard_plate_is_preserved_not_rejected():
    assert normalise("TEMP-1234-KA") == "TEMP1234KA" or normalise("TEMP-1234-KA") is not None
    assert normalise("AB12") == "AB12"           # short / temporary formats kept raw
    assert not is_standard("AB12")
    assert normalise("T509U84471") == "TS09UB4471"  # position-wise OCR confusions fixed for standard length


# ---------- what the plate tells us ----------
def test_plate_info_uses_only_observed_characters():
    info = {i["field"]: i for i in plate_info("MP04PA0802", "yellow", 2)}
    assert info["Registering state"]["value"] == "Madhya Pradesh"
    assert info["RTO (district office)"]["value"] == "Bhopal"
    assert "commercial" in info["Vehicle use"]["value"]
    assert all(i["level"] in ("PREDICTED", "OBSERVED") for i in info.values())
    assert plate_info("?P04PA0802") == []        # unknown state letter -> no state claimed
    assert [i["field"] for i in plate_info("MP?4PA0802")] == ["Registering state"]  # no RTO without both digits


# ---------- tracking association ----------
def test_reads_of_different_tracks_are_never_merged():
    track_a = [("MP04PA0802", 0.8)] * 3
    track_b = [("TS09UB4471", 0.8)] * 3
    assert vote(track_a)["plate"] == "MP04PA0802"
    assert vote(track_b)["plate"] == "TS09UB4471"
    t = {"id": "car_1", "class": "car", "colour": "white", "points": []}
    a = plate_reader.structured(1, t, vote(track_a) | {"plate_box": [1, 1, 2, 2]}, "test", {}, {}, None)
    b = plate_reader.structured(2, dict(t, id="car_2"), vote(track_b) | {"plate_box": [1, 1, 2, 2]}, "test", {}, {}, None)
    assert (a["vehicle_track_id"], a["best_reading"]) == ("car_1", "MP04PA0802")
    assert (b["vehicle_track_id"], b["best_reading"]) == ("car_2", "TS09UB4471")


def test_direction_from_track():
    pts = [{"box": [0 + i * 20, 100, 40 + i * 24, 140 + i * 4]} for i in range(10)]
    assert "left to right" in direction(pts)


# ---------- missing database access ----------
def test_no_database_means_no_match_claimed():
    t = {"id": "car_1", "class": "car", "colour": "white", "points": []}
    r = plate_reader.structured(1, t, vote([("MP04PA0802", 0.8)] * 3) | {"plate_box": [1, 1, 2, 2]}, "test", {}, {}, None)
    assert r["matching_status"] == "not_checked" and r["database_matches"] == []
    assert r["confirmed_registration"] is None and r["requires_manual_review"]
    assert r["verification_status"] == "Awaiting investigator verification"


def test_investigator_confirmation_is_the_only_way_to_confirm():
    t = {"id": "car_1", "class": "car", "colour": "white", "points": []}
    r = plate_reader.structured(1, t, vote([("MP04PA08?2", 0.8)]), "test", {}, {}, {"registration": "MP04PA0802"})
    assert r["registration_status"] == "investigator_confirmed" and r["confirmed_registration"] == "MP04PA0802"
    assert not r["requires_manual_review"]
