"""Telegram linker that runs inside the backend (long-polling, no webhook, no public URL needed).

Telegram bots cannot message a phone number until that person opens the bot. While the backend runs, this
thread lets each case contact link their own phone:

  1. they open t.me/<bot> and press START,
  2. the bot asks them to tap "Share my phone number" (Telegram sends the number of the account itself;
     we also check contact.user_id == sender, so nobody can link someone else's number),
  3. if that number is a contact in any case (data/cases/*/contacts.json) the chat is saved to
     data/telegram_links.json and a confirmation is sent. Numbers that are not case contacts are refused.

notify.send() then delivers alerts for that number to that chat. /stop unlinks.
"""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
LINKS = DATA / "telegram_links.json"
ROLE_NAME = {"suspect": "perpetrator", "victim": "victim"}

_lock = threading.Lock()
_state = {"running": False, "bot": None, "error": None, "last_poll": None}


def _digits(p) -> str:
    return "".join(ch for ch in str(p or "") if ch.isdigit())[-10:]


def load_links() -> dict:
    try:
        return json.loads(LINKS.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_links(links: dict):
    with _lock:
        tmp = LINKS.with_suffix(".tmp")
        tmp.write_text(json.dumps(links, indent=2), encoding="utf-8")
        os.replace(tmp, LINKS)


ROLES = ("police", "hospital", "family")


def role_chats(role: str) -> list[str]:
    """Chats subscribed to a control-room role with /police, /hospital or /family (all three with /all)."""
    return list(dict.fromkeys((load_links().get("_roles") or {}).get(role, [])))


def _subscribe(chat: str, roles: list[str], name: str | None):
    links = load_links()
    subs = links.setdefault("_roles", {})
    for r in ROLES:
        subs[r] = [c for c in subs.get(r, []) if c != chat] + ([chat] if r in roles else [])
    links.setdefault("_names", {})[chat] = name or ""
    _save_links(links)


def chat_for(number) -> str | None:
    d = _digits(number)
    return (load_links().get(d) or {}).get("chat_id") if d else None


def case_roles(number) -> list[tuple[str, str]]:
    """[(case_id, role)] where this number is a registered case contact."""
    d, out = _digits(number), []
    for f in sorted((DATA / "cases").glob("*/contacts.json")):
        try:
            for role, num in json.loads(f.read_text(encoding="utf-8")).items():
                if num and _digits(num) == d:
                    out.append((f.parent.name, role))
        except Exception:
            pass
    return out


def _api(token: str, method: str, _t: float = 10, **params) -> dict:
    try:
        return httpx.post(f"https://api.telegram.org/bot{token}/{method}", json=params, timeout=_t).json()
    except Exception as e:  # network hiccup: caller retries
        return {"ok": False, "description": str(e)}


def _handle(token: str, m: dict):
    chat = str((m.get("chat") or {}).get("id", ""))
    sender = (m.get("from") or {}).get("id")
    text = (m.get("text") or "").strip()
    if not chat:
        return
    if m.get("contact"):
        c = m["contact"]
        if c.get("user_id") != sender:
            _api(token, "sendMessage", chat_id=chat, text="Please share your own number using the button, not another contact.")
            return
        roles = case_roles(c.get("phone_number"))
        if not roles:
            _api(token, "sendMessage", chat_id=chat, reply_markup={"remove_keyboard": True},
                 text="This number is not a contact in any YATHARTH case, so no alerts will be sent here.")
            return
        links = load_links()
        links[_digits(c["phone_number"])] = {"chat_id": chat, "name": (m.get("from") or {}).get("first_name"),
                                             "linked_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                                             "cases": [{"case": k, "role": r} for k, r in roles]}
        _save_links(links)
        what = ", ".join(f"{ROLE_NAME.get(r, r)} contact in case {k}" for k, r in roles)
        _api(token, "sendMessage", chat_id=chat, reply_markup={"remove_keyboard": True},
             text=f"✅ Linked: +91 {_digits(c['phone_number'])} ({what}).\nAccident alerts for this number will arrive in this chat within seconds. Send /stop to unlink.")
        return
    cmd = text.split("@")[0].lower()
    if cmd in ("/police", "/hospital", "/family", "/all"):
        roles = list(ROLES) if cmd == "/all" else [cmd[1:]]
        _subscribe(chat, roles, (m.get("from") or {}).get("first_name"))
        what = {"police": "police control room", "hospital": "hospital emergency desk", "family": "victim's family"}
        _api(token, "sendMessage", chat_id=chat, reply_markup={"remove_keyboard": True},
             text="✅ This chat now receives YATHARTH alerts as the " + ", ".join(what[r] for r in roles) + ".\nEvery new accident the camera agents detect arrives here within seconds. /stop to unsubscribe.")
        return
    if text.startswith("/stop"):
        _subscribe(chat, [], None)
        links = {k: v for k, v in load_links().items() if k.startswith("_") or v.get("chat_id") != chat}
        _save_links(links)
        _api(token, "sendMessage", chat_id=chat, text="Unlinked. You will not receive YATHARTH alerts here.", reply_markup={"remove_keyboard": True})
        return
    linked = [k for k, v in load_links().items() if not k.startswith("_") and v.get("chat_id") == chat]
    if linked:
        _api(token, "sendMessage", chat_id=chat, text=f"This chat is linked to +91 {linked[0]}. Alerts will arrive here. /stop to unlink.")
        return
    _api(token, "sendMessage", chat_id=chat,
         text="YATHARTH accident alerts.\nChoose what this chat receives:\n/police  police control room\n/hospital  hospital emergency desk\n/family  the victim's family\n/all  everything\n\nOr tap the button to link your phone number as a case contact.",
         reply_markup={"keyboard": [[{"text": "/police"}, {"text": "/hospital"}, {"text": "/family"}, {"text": "/all"}], [{"text": "📱 Share my phone number", "request_contact": True}]],
                       "one_time_keyboard": True, "resize_keyboard": True})


def _loop(token: str):
    me = _api(token, "getMe")
    if not me.get("ok"):
        _state.update(running=False, error=f"token rejected: {me.get('description')}")
        return
    _state["bot"] = me["result"]["username"]
    os.environ.setdefault("TELEGRAM_BOT_USERNAME", _state["bot"])
    _api(token, "deleteWebhook")
    offset = None
    while _state["running"]:
        r = _api(token, "getUpdates", 35, timeout=25, allowed_updates=["message"], **({"offset": offset} if offset else {}))
        _state["last_poll"] = time.time()
        if not r.get("ok"):
            _state["error"] = r.get("description")
            time.sleep(3)  # e.g. another poller (link_telegram.bat) holds the bot: retry
            continue
        _state["error"] = None
        for u in r.get("result", []):
            offset = u["update_id"] + 1
            try:
                _handle(token, u.get("message") or {})
            except Exception as e:
                _state["error"] = f"handler: {e}"


def start():
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token or _state["running"] or os.getenv("TELEGRAM_LINKER", "on") == "off":
        return
    _state.update(running=True, error=None)
    threading.Thread(target=_loop, args=(token,), daemon=True, name="telegram-linker").start()


def status() -> dict:
    links = load_links()
    names = links.get("_names") or {}
    roles = {r: [{"chat": c, "name": names.get(c, "")} for c in role_chats(r)] for r in ROLES}
    contacts = {}
    for f in sorted((DATA / "cases").glob("*/contacts.json")):
        try:
            for role, num in json.loads(f.read_text(encoding="utf-8")).items():
                d = _digits(num)
                if d:
                    contacts.setdefault(d, {"number": num, "roles": [], "linked": d in links})["roles"].append(f"{f.parent.name}:{ROLE_NAME.get(role, role)}")
        except Exception:
            pass
    bot = _state["bot"] or os.getenv("TELEGRAM_BOT_USERNAME")
    return {"token": bool(os.getenv("TELEGRAM_BOT_TOKEN")), "linker_running": _state["running"], "bot": bot,
            "link": f"https://t.me/{bot}" if bot else None, "error": _state["error"], "contacts": list(contacts.values()), "roles": roles}
