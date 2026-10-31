"""Every person reads as a real person: first name and surname belong together, and the age fits the photo."""
import json
from pathlib import Path

import pytest

from app import ops_center, records

CASES = Path(__file__).resolve().parents[2] / "data" / "cases"
SHIPPED = ["hero", "demo", "dashcam", "india-junction", "rear-end"]


def _people(cid):
    rec = json.loads((CASES / cid / "records.json").read_text(encoding="utf-8"))
    return [v["driver"] for v in rec["vehicles"]] + rec["people"]


@pytest.mark.parametrize("first,last,want", [("Srinivas", "Siddiqui", "Srinivas Rao"), ("Mohammed", "Kumar", "Mohammed Shaik"),
                                             ("Farhan", "Reddy", "Farhan Khan"), ("Ravi", "Goud", "Ravi Goud"), ("Priya", "Kumar", "Priya Reddy")])
def test_names_belong_together(first, last, want):
    assert records.full_name(first, last) == want


def test_no_generated_name_mixes_families():
    for first in records.FIRST:
        for last in records.LAST:
            f, s = records.full_name(first, last).rsplit(" ", 1)
            assert (f in records.MUSLIM_FIRST) == (s in records.MUSLIM_SURNAMES)


@pytest.mark.parametrize("cid", SHIPPED)
def test_ages_fit_the_photos_and_licences_fit_the_ages(cid):
    for p in _people(cid):
        assert abs(p["age"] - records.PHOTO_AGE[p["photo"]]) <= 2, p["name"]
        if p.get("dl_no") and "•" in p["dl_no"]:
            assert int(p["dl_no"].split()[1]) >= 2026 - p["age"] + 16, p["name"]


def test_officers_have_proper_names_too():
    for o in ops_center._officers([{"name": "Gachibowli PS", "lat": 17.44, "lon": 78.35}]):
        f, s = o["name"].rsplit(" ", 1)
        assert (f in records.MUSLIM_FIRST) == (s in records.MUSLIM_SURNAMES)
