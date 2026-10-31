"""On a public URL, visitors see the demo and nobody can take over the bot, send alerts or spend the key freely."""
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import public_site
from app.main import app

KEY = "test-operator-key"
HERO = Path(__file__).resolve().parents[2] / "data" / "cases" / "hero"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("PUBLIC_DEMO", "1")
    monkeypatch.setenv("OPERATOR_KEY", KEY)
    public_site._hits.clear()
    return TestClient(app, follow_redirects=False)


@pytest.mark.parametrize("method,path", [
    ("post", "/api/telegram/token"), ("post", "/api/telegram/test-all"), ("post", "/api/telegram/test"),
    ("post", "/api/cases"), ("post", "/api/kits/01-india-bus-divider/run"), ("post", "/api/cases/hero/rebuild"),
    ("post", "/api/cameras/CAM-HYD-0417/scan"), ("post", "/api/cameras/agent/off"), ("post", "/api/response/hero/dispatch"),
    ("post", "/api/cases/hero/emergency/start"), ("put", "/api/cases/hero/location"), ("post", "/api/ops/ack"),
    ("post", "/api/cases/hero/faces/compare")])
def test_visitors_cannot_change_or_send_anything(client, method, path):
    assert getattr(client, method)(path).status_code in (403, 404)


@pytest.mark.parametrize("path", ["/api/telegram/chats", "/api/telegram/links", "/docs", "/openapi.json"])
def test_private_reads_are_hidden_from_visitors(client, path):
    assert client.get(path).status_code == 404


def test_visitors_can_read_the_demo(client):
    assert client.get("/api/cases/hero/analysis").status_code == 200
    assert client.get("/api/cases").status_code == 200
    assert client.get("/api/telegram/status").status_code == 200


def test_visitors_cannot_force_a_rebuild(client):
    assert client.get("/api/cases/hero/intercept?rerun=true").status_code == 403


def test_a_visitor_approval_plays_but_is_not_saved(client):
    before = (HERO / "intercept.json").read_bytes(), (HERO / "custody.jsonl").read_bytes()
    r = client.post("/api/cases/hero/intercept/approve", json={"officer": "A Visitor"})
    assert r.status_code == 200 and r.json()["approved_by"] == "A Visitor"
    assert before == ((HERO / "intercept.json").read_bytes(), (HERO / "custody.jsonl").read_bytes())


def test_paid_endpoints_are_rate_limited(client, monkeypatch):
    from app import ask as ask_mod
    monkeypatch.setattr(ask_mod, "answer", lambda *a, **k: {"answer": "stub"}, raising=False)
    codes = [client.post("/api/cases/nope/ask", json={"question": "q"}).status_code for _ in range(25)]
    assert codes[-1] == 429 and 403 not in codes


def test_the_operator_key_unlocks_and_leaves_the_address_bar(client):
    r = client.get("/?operator=" + KEY)
    assert r.status_code == 303 and r.headers["location"] == "/" and public_site.COOKIE in r.cookies
    assert "operator" not in r.headers["location"]
    assert client.get("/api/telegram/chats").status_code != 404


def test_a_wrong_key_unlocks_nothing(client):
    r = client.get("/?operator=wrong")
    assert public_site.COOKIE not in r.cookies
    assert client.post("/api/ops/ack").status_code == 403


def test_off_by_default_nothing_changes(monkeypatch):
    monkeypatch.delenv("PUBLIC_DEMO", raising=False)
    c = TestClient(app, follow_redirects=False)
    assert c.get("/api/telegram/links").status_code != 404
    assert c.post("/api/ops/ack").status_code != 403
    assert json.loads(c.get("/api/cases/hero/case").text)["id"] == "hero"
