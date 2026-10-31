"""Two programs polling one bot: Telegram answers 409, and the page has to be able to say so."""
from app import telegram_bot as tb


def _run(monkeypatch, replies):
    def fake(token, method, _t=10, **params):
        if method == "getMe":
            return {"ok": True, "result": {"username": "test_bot"}}
        if method == "getUpdates":
            r = replies.pop(0)
            if not replies:
                tb._state["running"] = False
            return r
        return {"ok": True}
    monkeypatch.setattr(tb, "_api", fake)
    monkeypatch.setattr(tb.time, "sleep", lambda s: None)
    monkeypatch.setenv("TELEGRAM_BOT_USERNAME", "test_bot")
    monkeypatch.setitem(tb._state, "conflict_at", None)
    monkeypatch.setitem(tb._state, "running", True)
    tb._loop("token", tb._state["gen"])


def test_a_conflict_is_reported_while_it_is_recent(monkeypatch):
    _run(monkeypatch, [{"ok": False, "description": "Conflict: terminated by other getUpdates request"}])
    assert tb.status()["conflict"] is True
    monkeypatch.setitem(tb._state, "conflict_at", tb.time.time() - tb.CONFLICT_WINDOW_S - 1)
    assert tb.status()["conflict"] is False


def test_other_errors_are_not_called_a_conflict(monkeypatch):
    _run(monkeypatch, [{"ok": False, "description": "Bad Gateway"}])
    assert tb.status()["conflict"] is False


def test_a_new_token_stops_the_old_loop(monkeypatch):
    gen = tb._state["gen"]
    monkeypatch.setattr(tb, "_api", lambda *a, **k: {"ok": True, "result": {"username": "test_bot"}})
    monkeypatch.setitem(tb._state, "gen", gen + 1)
    monkeypatch.setitem(tb._state, "running", True)
    tb._loop("old-token", gen)   # returns at once: it belongs to the previous generation
