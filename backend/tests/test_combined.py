import json
import random
import shutil
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import ask, build_case, context, extras, interview, llm, main, make_case, physics, redteam, reliability, reports, toll_db
from app.pipeline import fusion, pursuit, scene3d, sensor, stn, witness

ROOT = Path(__file__).resolve().parents[2]
HERO = ROOT / "data" / "cases" / "hero"


@pytest.fixture
def cases(tmp_path, monkeypatch):
    target = tmp_path / "cases"
    target.mkdir()
    for module in (main, extras, make_case, build_case):
        monkeypatch.setattr(module, "DATA", target)
    return target


@pytest.fixture
def hero(cases):
    shutil.copytree(HERO, cases / "hero")
    return cases / "hero"


@pytest.fixture
def api(cases):
    return TestClient(main.app)


def event(eid, start=None, end=None, kind="OBSERVED", clock="T0", order=None, actor="car", action="x", source="sensor", confidence=0.9):
    e = {"id": eid, "source": source, "kind": kind, "clock": clock, "actor": actor, "action": action, "confidence": confidence, "ref": "r",
         "t": {"start": start if start is not None else -3.0, "end": end if end is not None else -0.2, "sigma": 0.0}}
    if order:
        e["order"] = order
    return e


# --- STN ---


def test_stn_tightens_through_a_constraint():
    events = [event("a", -5.0, -1.0), event("b", kind="CLAIMED", clock="order", order="unknown")]
    solved = stn.solve(events, [{"id": "c", "from": "a", "to": "b", "min_s": 1.0, "max_s": 2.0, "confidence": 0.7}])
    assert solved["consistent"]
    assert solved["windows"]["b"] == [-4.0, 1.0]


def test_stn_finds_an_impossible_stated_order_and_sets_the_statement_aside():
    measured_brake = event("brake", -0.5, -0.4, action="brake")
    measured_impact = event("impact", -0.05, 0.05, action="impact")
    said_impact = event("w1", kind="CLAIMED", clock="order", order="unknown", action="impact", confidence=0.7)
    said_brake = event("w2", kind="CLAIMED", clock="order", order="unknown", action="brake", confidence=0.7)
    events = [measured_brake, measured_impact, said_impact, said_brake]
    order = [{"id": "o", "from": "w1", "to": "w2", "min_s": 0.0, "max_s": None, "confidence": 0.7}]
    constraints = order + stn.match_constraints([said_impact, said_brake], events)
    solved = stn.solve(events, constraints)
    assert not solved["consistent"]
    assert solved["conflicts"][0]["off_by_s"] > 0
    assert set(solved["excluded"]) <= {"w1", "w2"}
    assert "brake" in solved["windows"] and "impact" in solved["windows"]


def test_stn_agrees_with_an_independent_check_on_random_networks():
    rng = random.Random(7)
    seen = {True: 0, False: 0}
    for _ in range(300):
        names = [f"e{i}" for i in range(rng.randint(2, 7))]
        events = []
        for n in names:
            if rng.random() < 0.5:
                a, b = sorted((rng.uniform(-9, 9), rng.uniform(-9, 9)))
                events.append(event(n, a, b))
            else:
                events.append(event(n, kind="CLAIMED", clock="order", order="unknown"))
        constraints = []
        for i in range(rng.randint(0, 8)):
            a, b = rng.sample(names, 2)
            lo = rng.uniform(-3, 3)
            constraints.append({"id": f"c{i}", "from": a, "to": b, "min_s": lo, "max_s": lo + rng.uniform(0, 3), "confidence": 0.7})
        nodes = [stn.T0, *names]
        edges = stn.build_edges(events, constraints)
        dist, ok = stn.floyd_warshall(nodes, edges)
        cycle = stn.negative_cycle(nodes, edges)
        assert ok == (cycle is None)
        seen[ok] += 1
        if cycle:
            assert sum(e.w for e in cycle) < 0
            assert all(cycle[i].b == cycle[(i + 1) % len(cycle)].a for i in range(len(cycle)))
        elif np.isfinite(dist[0]).all():
            x = dict(zip(nodes, dist[0]))
            assert all(x[e.b] - x[e.a] <= e.w + 1e-6 for e in edges)
    assert seen[True] > 20 and seen[False] > 20


def test_sensitivity_gives_the_margin_and_only_covers_the_vehicles_involved():
    brake = event("b", -0.5, -0.4, action="brake", actor="bus", source="sensor")
    impact = event("i", 0.0, 0.1, action="impact", actor="bus", source="cctv")
    other = event("m", -0.2, -0.1, action="sudden_decel", actor="bike", source="cctv")
    offsets = {"sensor": {"sigma": 0.1}, "cctv": {"sigma": 0.05}}
    out = stn.sensitivity([brake, impact, other], offsets, {"bus"})
    assert [(s["earlier"], s["later"], s["margin_s"]) for s in out] == [("b", "i", 0.4)]
    assert "off by more than 0.4 s" in out[0]["text"]


# --- Hero ---


def test_hero_catches_all_planted_with_no_false_flags(hero):
    make_case.make("hero")
    score = json.loads((hero / "analysis.json").read_text(encoding="utf-8"))["score"]
    assert score["caught"] == score["planted"] == 5
    assert score["false_flags"] == 0, score["false_flag_ids"]


def test_scorer_counts_an_unplanned_contradiction_as_a_false_flag():
    gt = {"planted": [{"id": "P1", "witness": "witness_1", "type": "state"}]}
    events = [{"id": "w1", "source": "witness_1"}, {"id": "w2", "source": "witness_1"}]
    analysis = {"contradictions": [{"id": "C1", "type": "state", "events": ["w1"]}, {"id": "C2", "type": "state", "events": ["w2"]},
                                   {"id": "C3", "type": "witness", "events": ["w1", "w2"]}]}
    s = make_case.score_against(gt, analysis, events)
    assert s["caught"] == 1 and s["false_flags"] == 1 and s["false_flag_ids"] == ["C2"] and s["extra_found"] == ["C3"]


# --- Witness verification ---


def test_a_quote_must_actually_say_what_the_claim_says():
    statement = "I had to jump away. The policeman fell down."
    ok, rejected = witness.verify(statement, [
        {"actor": "the witness", "action": "fell", "quote": "I had to jump away"},
        {"actor": "officer", "action": "fell", "quote": "The policeman fell down."},
    ])
    assert [c["quote"] for c in ok] == ["The policeman fell down."]
    assert "doesn't say fell" in rejected[0]["rejected_because"]


def test_invented_quotes_and_unknown_actions_are_rejected():
    ok, rejected = witness.verify("The bus was fast.", [{"action": "speed", "quote": "made up"}, {"action": "fault", "quote": "The bus was fast."}])
    assert ok == [] and len(rejected) == 2


def test_translated_quote_is_checked_through_its_translation():
    quote = "పోలీసు పడిపోయాడు"
    ok, _ = witness.verify(quote, [{"action": "fell", "quote": quote, "translation": "the policeman fell"}])
    assert ok and ok[0]["translation"] == "the policeman fell"





def test_orderings_survive_only_if_both_claims_did(monkeypatch):
    statement = "The bus hit the divider and then the policeman fell."
    monkeypatch.setattr(llm, "chat_json", lambda *a, **k: {"model": "m", "cached": False, "data": {
        "claims": [{"actor": "x", "action": "impact", "quote": "not there"},
                   {"actor": "the bus", "action": "impact", "quote": "The bus hit the divider"},
                   {"actor": "officer", "action": "fell", "quote": "the policeman fell"}],
        "orderings": [{"before": 1, "after": 2, "quote": "and then"}, {"before": 0, "after": 2, "quote": "and then"}, {"before": 1, "after": 2, "quote": "invented"}]}})
    ex = witness.extract(statement, "witness_1")
    assert ex["orderings"] == [{"before": 0, "after": 1, "quote": "and then"}]


# --- Sensor ---


def _csv(path, rows):
    path.write_text("t,speed_kmh,accel_g,brake,indicator,airbag,lat,lon\n" + "".join(f"{t},{v},{g},0,0,0,0,0\n" for t, v, g in rows))


def test_impact_below_five_g_is_only_a_candidate(tmp_path):
    p = tmp_path / "s.csv"
    _csv(p, [(0.0, 40, 0), (0.1, 40, 0), (0.2, 30, -2.7), (0.3, 20, -2.7)])
    impact = next(e for e in sensor.run(p, "car") if e["action"] == "impact")
    assert impact["confidence"] == 0.6 and "candidate" in impact["value"]
    _csv(p, [(0.0, 40, 0), (0.1, 40, 0), (0.2, 10, -9.0), (0.3, 5, -1.0)])
    impact = next(e for e in sensor.run(p, "car") if e["action"] == "impact")
    assert impact["confidence"] == 0.96 and "candidate" not in impact["value"]


# --- Physics ---


def _rows(speeds, accels, dt=0.1):
    return [{"t": i * dt, "speed_kmh": s, "accel_g": a} for i, (s, a) in enumerate(zip(speeds, accels))]


def test_quote_saying_never_touched_is_not_a_claim_about_braking():
    ok, rejected = witness.verify("The bus never touched it and it did not slow down.", [
        {"action": "no_brake", "quote": "never touched it"}, {"action": "no_brake", "quote": "it did not slow down"}])
    assert [c["quote"] for c in ok] == ["it did not slow down"] and len(rejected) == 1





def test_red_team_checks_who_did_the_hitting(hero, monkeypatch):
    _model_says(monkeypatch, [{"actor": "the white car", "action": "impact", "value": "the bus", "order": "at_impact", "quote": "The white car rammed the bus"}])
    assert redteam.check(hero, "The white car rammed the bus.")["status"] == "flagged"


def test_stop_claim_is_impossible_when_the_vehicle_is_still_fast_at_impact():
    check = physics.stop_claim_check(_rows([60, 60, 58, 56, 54, 20], [0, 0, -0.6, -0.6, -0.6, -9.0]), 0.4, "wet")
    assert check["possible"] is False
    assert check["needed_m"] > check["had_m"]


def test_stop_claim_is_possible_when_there_was_room():
    speeds = [20.0] * 40 + [20.0 - i * 2.2 for i in range(10)] + [0.0, 0.0]
    accels = [0.0] * 40 + [-0.65] * 10 + [-1.0, 0.0]
    assert physics.stop_claim_check(_rows(speeds, accels), 0.7, "dry")["possible"] is True


def test_wet_road_stops_later_than_dry_in_the_counterfactual():
    dry = physics.ghost_trajectory(40, 100, -1, 1.0, physics.MU_DRY)
    wet = physics.ghost_trajectory(40, 100, -1, 1.0, physics.MU_WET)
    assert wet["stops_at_m"] > dry["stops_at_m"] and "wet" in wet["assumptions"]["note"]


# --- Reliability ---


def test_reliability_gives_reasons_and_marks_down_speed_estimates():
    close = reliability.weigh_statement("The bus hit it.", {"distance_m": 1})
    far = reliability.weigh_statement("I think the bus hit it. I only saw it for a moment.", {"distance_m": 50})
    assert far["weight"] < close["weight"]
    assert any("far" in r for r in far["reasons"]) and any("hedged" in r for r in far["reasons"])
    speed = reliability.weigh_claim(close["weight"], "speed", close["reasons"])
    assert speed["weight"] < close["weight"] and any("Loftus" in r for r in speed["reasons"])


# --- Q&A ---


@pytest.fixture
def no_model(monkeypatch):
    def fail(*a, **k):
        raise llm.LLMUnavailable("no")

    monkeypatch.setattr(llm, "chat_json", fail)


@pytest.mark.parametrize("question,reason", [
    ("Who's at fault?", "legal_fault"), ("who is to blame", "legal_fault"), ("Was the driver negligent?", "legal_fault"),
    ("What is the driver's name?", "identity"), ("Who owns the bus?", "identity"), ("Was anyone injured?", "injury"), ("Did anyone die?", "injury"),
])









@pytest.mark.parametrize("data", [{"answer": "The bus was at fault.", "cited": [1]}, {"answer": "It braked.", "cited": []}, {"answer": "It braked.", "cited": [99]}, {"answer": "", "cited": [1]}])






# --- Red team ---


def _model_says(monkeypatch, claims, orderings=()):
    monkeypatch.setattr(llm, "chat_json", lambda *a, **k: {"model": "m", "cached": False, "data": {"claims": claims, "orderings": list(orderings)}})


def test_red_team_flags_a_false_speed_and_leaves_the_case_untouched(hero, monkeypatch):
    before = (hero / "analysis.json").read_bytes()
    _model_says(monkeypatch, [{"actor": "the bus", "action": "speed", "value": "90", "order": "before_impact", "quote": "doing about 90"}])
    result = redteam.check(hero, "The bus was doing about 90.")
    assert result["status"] == "flagged"
    assert result["contradictions"][0]["type"] == "quantity"
    assert (hero / "analysis.json").read_bytes() == before
    assert not (hero / "evidence" / "witness_9.txt").exists()


def test_red_team_catches_an_impossible_order_through_the_stn(hero, monkeypatch):
    statement = "The bus hit the divider and only after that it braked."
    _model_says(monkeypatch, [
        {"actor": "the bus", "action": "impact", "value": "the divider", "order": "unknown", "quote": "The bus hit the divider"},
        {"actor": "the bus", "action": "brake", "order": "unknown", "quote": "it braked"},
    ], [{"before": 0, "after": 1, "quote": "only after that"}])
    result = redteam.check(hero, statement)
    assert result["status"] == "flagged"
    assert any(c["type"] == "temporal" for c in result["contradictions"])


def test_red_team_never_calls_a_statement_true(hero, monkeypatch):
    _model_says(monkeypatch, [{"actor": "the bus", "action": "speed", "value": "16", "order": "before_impact", "quote": "about 16"}])
    result = redteam.check(hero, "The bus was going about 16.")
    assert result["status"] == "no_conflict" and "does not show it is true" in result["reason"]





# --- Interview ---


def test_leading_question_is_flagged():
    text = "Q: How fast was it going when it smashed into the bus?\nA: Fast.\nQ: Where were you?\nA: At the stall."
    flags = interview.detect("witness_1", text)
    assert [f["term"] for f in flags] == ["smashed"] and '"hit"' in flags[0]["suggestion"]
    assert interview.detect("w", "A: It smashed into the bus.") == []


# --- Context ---


def test_sun_position_matches_known_values():
    assert context.sun_position(datetime(2026, 3, 20, 12, 7, tzinfo=timezone.utc), 0.0, 0.0)[0] > 88
    elevation, azimuth = context.sun_position(datetime(2026, 10, 15, 12, 0, tzinfo=timezone.utc), 17.39, 78.32)
    assert -2 < elevation < 8 and 250 < azimuth < 280
    assert context.sun_check(datetime(2026, 10, 15, 18, 0, tzinfo=timezone.utc), 17.39, 78.32)["is_dark"]


def test_weather_parsing_and_failure():
    when = datetime(2026, 10, 12, 13, tzinfo=timezone.utc)
    rain = {"hourly": {"precipitation": [0.0] * 13 + [1.2] + [0.0] * 10, "visibility": [9000.0] * 24}}
    wet = context.weather(17.4, 78.3, when, fetch=lambda u: rain)
    assert wet["road_state"] == "wet" and wet["mu"] == physics.MU_WET

    def down(u):
        raise OSError

    assert context.weather(17.4, 78.3, when, fetch=down) is None
    assert context.weather(17.4, 78.3, when, fetch=lambda u: {"hourly": {}}) is None


def test_speed_limit_and_facilities_parse_and_fail_empty():
    limit = context.speed_limit(17.4, 78.3, 62.0, fetch=lambda u: {"elements": [{"tags": {"maxspeed": "50"}}]})
    assert limit["limit_kmh"] == 50 and limit["exceeds"] is True and "unofficial" in limit["source"]

    def down(u):
        raise OSError

    assert context.speed_limit(17.4, 78.3, 62.0, fetch=down) is None
    found = context.facilities(17.4, 78.3, fetch=lambda u: {"elements": [
        {"lat": 17.41, "lon": 78.3, "tags": {"amenity": "police", "name": "PS"}},
        {"center": {"lat": 17.42, "lon": 78.3}, "tags": {"amenity": "hospital", "name": "H", "emergency": "yes"}},
        {"lat": 17.5, "lon": 78.3, "tags": {"amenity": "police"}}]})
    assert found["police"][0]["name"] == "PS" and found["hospitals"][0]["trauma"] is True and len(found["police"]) == 1
    assert context.facilities(17.4, 78.3, fetch=down) is None


# --- Pursuit ---





# --- API ---





def test_report_has_links_hashes_and_no_html_injection(api, hero):
    dar = api.get("/api/cases/hero/reports/dar").json()
    assert dar["status"] == "draft_for_officer_verification" and "SHA-256" in dar["sections"]["3. Evidence and custody"]
    assert "sensor.csv#r=" in dar["sections"]["4. Established sequence (undisputed)"]
    assert "not injuries" in dar["sections"]["8. Crash severity"]
    case = {"id": "c", "title": "<script>x</script>"}
    assert "<script>x" not in reports.dar(case, [], {}, None, [])["html"]


def test_custody_detects_an_edited_evidence_file(api, hero):
    assert api.get("/api/cases/hero/custody/files").json()["ok"] is True
    with (hero / "evidence" / "witness_1.txt").open("a", encoding="utf-8") as f:
        f.write("tampered")
    result = api.get("/api/cases/hero/custody/files").json()
    assert result["ok"] is False and next(x for x in result["files"] if x["file"] == "witness_1.txt")["ok"] is False


def test_frame_route_returns_a_real_still_and_404s_past_the_end(api, hero):
    r = api.get("/api/cases/hero/frame/cctv.mp4/10")
    assert r.status_code == 200 and r.content[:2] == b"\xff\xd8"
    assert api.get("/api/cases/hero/frame/cctv.mp4/999999").status_code == 404
    assert api.get("/api/cases/hero/frame/witness_1.txt/1").status_code == 404
    assert api.get("/api/cases/hero/frame/cctv.mp4/-1").status_code == 404





def test_unsafe_case_ids_are_refused(api):
    assert api.post("/api/cases/..%2F..%2Fx/evidence", files={"file": ("a.txt", b"x")}).status_code == 404
    assert api.get("/api/cases/a.b/context").status_code == 404







# --- dev ---


def test_every_new_route_answers_on_the_hero_case(api, hero, no_model):
    for path in ("case", "events", "analysis", "severity", "interview-flags", "context", "reports/dar", "reports/packet", "custody", "custody/files", "scene3d", "pursuit", "toll-match"):
        assert api.get(f"/api/cases/hero/{path}").status_code == 200, path
    assert api.post("/api/cases/hero/ask", json={"question": "Who's at fault?"}).json()["reason"] == "legal_fault"
    assert api.get("/api/cases/hero/reports/dar.html").headers["content-type"].startswith("text/html")


@pytest.mark.parametrize("question,reason", [("Who's at fault?", "legal_fault"), ("What is the driver's name?", "identity"), ("Who owns the bus?", "identity"), ("Was anyone injured?", "injury"), ("Did anyone die?", "injury")])
def test_refusals_happen_before_any_model_sees_the_question(hero, monkeypatch, question, reason):
    calls = []
    monkeypatch.setattr(llm, "chat_json", lambda *a, **k: calls.append(1))
    result = ask.ask(hero, question)
    assert result["refused"] and result["reason"] == reason and calls == []


def test_entity_correction_rejects_unknown_tracks(api, hero):
    assert api.put("/api/cases/hero/entities", json={"primary": "nope"}).status_code == 422


def test_speed_flip_is_what_it_takes_to_reach_the_tolerance():
    assert round(fusion.speed_flip_pct(55, 16)) == 155
    measured = 16 * (1 + fusion.speed_flip_pct(55, 16) / 100)
    assert abs(55 - measured) <= fusion.SPEED_TOL(measured) + 1e-6


def test_the_crash_spike_is_not_reported_as_braking(tmp_path):
    p = tmp_path / "s.csv"
    _csv(p, [(i * 0.1, 40, -0.3 if 5 <= i < 9 else 0) for i in range(9)] + [(0.9, 30, -1.2), (1.0, 20, -6.0), (1.1, 10, -1.0), (1.2, 5, 0), (1.3, 5, 0)])
    brakes = [e for e in sensor.run(p, "car") if e["action"] == "brake"]
    assert brakes and all(float(e["value"].split()[1]) > -2 for e in brakes)  # the -6 g pulse stays out of it


def test_toll_lookup_needs_a_plate_and_a_named_officer(api, cases):
    d = cases / "t1"
    (d / "evidence").mkdir(parents=True)
    (d / "plates.json").write_text(json.dumps({"vehicles": [{"plate": "TS07GK5521"}]}))
    found = api.get("/api/cases/t1/toll-match").json()
    assert found["fictional"] and [m["plate"] for m in found["matches"]] == ["TS07GK5521"]
    cid = found["matches"][0]["id"]
    assert api.post("/api/cases/t1/toll-match/notify", json={"capture_id": cid, "officer": " ", "authority": "Highway patrol", "reviewed": True}).status_code == 422
    assert api.post("/api/cases/t1/toll-match/notify", json={"capture_id": cid, "officer": "A", "authority": "Highway patrol", "reviewed": False}).status_code == 422
    assert api.post("/api/cases/t1/toll-match/notify", json={"capture_id": "CAP-006", "officer": "A", "authority": "Highway patrol", "reviewed": True}).status_code == 404
    assert api.post("/api/cases/t1/toll-match/notify", json={"capture_id": cid, "officer": "A", "authority": "Highway patrol", "reviewed": True}).json()["status"] == "simulated"


def test_a_real_plate_finds_nothing_in_the_fictional_database():
    assert toll_db.search(["MP04PA0?02"])["matches"] == []


def test_rule_says_who_left_and_who_stayed():
    case = {"range": [-2, 6], "video": {"width": 1000, "height": 800}}
    stay = {"points": [{"t": t / 10, "x": 0.0, "y": 0.0, "v_kmh": 0.5} for t in range(0, 60)]}
    go = {"points": [{"t": t / 10, "x": 0.0, "y": t * 1.0, "v_kmh": 36.0} for t in range(0, 30)]}
    assert pursuit.after_impact(stay, None, case, [0, 0])["status"] == "stopped"
    assert pursuit.after_impact(go, None, case, [0, 0])["status"] == "left_view"


def test_rider_rule_matches_a_person_on_a_bike_and_not_one_beside_it():
    frames = [i / 10 for i in range(20)]
    bike = {"id": "motorcycle_1", "class": "motorcycle", "points": [{"t": t, "box": [100, 100, 160, 200]} for t in frames]}
    rider = {"id": "person_1", "class": "person", "points": [{"t": t, "box": [110, 40, 150, 180]} for t in frames]}
    beside = {"id": "person_2", "class": "person", "points": [{"t": t, "box": [300, 40, 340, 200]} for t in frames]}
    assert scene3d.find_riders([bike, rider, beside]) == {"person_1": "motorcycle_1"}


def test_a_parked_vehicle_is_locked_and_a_moving_one_is_not():
    ts = np.arange(0, 6, 0.05)
    parked_x, v = np.random.default_rng(1).normal(0, 0.3, len(ts)), np.full(len(ts), 1.0)
    rest = scene3d.rest_mask(parked_x, np.zeros(len(ts)), v, ts)
    assert rest.all()
    x, y = scene3d.steady_path(parked_x, np.zeros(len(ts)), rest)
    assert np.ptp(x) == 0 and np.ptp(y) == 0
    assert not scene3d.rest_mask(ts * 5, np.zeros(len(ts)), np.full(len(ts), 18.0), ts).any()
