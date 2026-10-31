"""Golden-hour alerts. The registry is a fictional demo dict; chat ids point at teammates' phones.
If TELEGRAM_BOT_TOKEN is unset, alerts are simulated (still logged and shown in the UI)."""
import os

import httpx

# Fictional demo registry. Put a teammate's Telegram chat id in telegram_chat_id for the stage demo.
REGISTRY = {
    "TS09EA1234": {"owner": "Ravi Teja Goud", "vehicle": "White hatchback", "rto": "Hyderabad (Central)",
                   "insurance": "Valid", "emergency_contact": "+91 98••• ••412",
                   "telegram_chat_id": os.getenv("DEMO_CHAT_ID_1")},
    "TS07GK5521": {"owner": "Karthik Varma", "vehicle": "Red sedan", "rto": "Ranga Reddy",
                   "insurance": "Expired", "emergency_contact": "+91 99••• ••208",
                   "telegram_chat_id": os.getenv("DEMO_CHAT_ID_2")},
}

AUTO_SEND_PLATE_CONFIDENCE = 0.80


def telegram_chats() -> dict:
    """Who has messaged the bot, so their chat ids can go in backend/.env. Needs TELEGRAM_BOT_TOKEN from @BotFather."""
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token:
        return {"configured": False, "chats": [], "how": "Create a bot with @BotFather, put TELEGRAM_BOT_TOKEN=... in backend/.env, restart the API, then message the bot from each phone."}
    r = httpx.get(f"https://api.telegram.org/bot{token}/getUpdates", timeout=10)
    chats = {}
    for u in r.json().get("result", []) if r.is_success else []:
        ch = (u.get("message") or u.get("edited_message") or {}).get("chat")
        if ch:
            chats[ch["id"]] = {"id": ch["id"], "name": ch.get("title") or " ".join(x for x in (ch.get("first_name"), ch.get("last_name")) if x) or ch.get("username")}
    return {"configured": True, "chats": list(chats.values()), "how": "Put a chat id in DEMO_CHAT_ID_1 / DEMO_CHAT_ID_2 (vehicle owners' contacts) or AUTHORITY_CHAT_ID (police) in backend/.env and restart."}


def lookup(plate: str) -> dict | None:
    from . import records, ts_police_db  # records (main), then the mock TS police DB (A2) as fallback
    key = plate.replace(" ", "").upper()
    rec = records.index().get(key)
    if rec:
        return {**rec, "telegram_chat_id": REGISTRY.get(key, {}).get("telegram_chat_id")}
    return REGISTRY.get(key) or ts_police_db.registry_card(plate)


def send(plate: str, text: str) -> dict:
    rec = lookup(plate)
    if not rec:
        return {"status": "not_found", "plate": plate}
    token, chat = os.getenv("TELEGRAM_BOT_TOKEN"), rec.get("telegram_chat_id") or os.getenv("DEMO_CHAT_ID_1")
    if not (token and chat):
        return {"status": "simulated", "to": rec["owner"], "text": text}
    r = httpx.post(f"https://api.telegram.org/bot{token}/sendMessage",
                   json={"chat_id": chat, "text": text}, timeout=10)
    return {"status": "sent" if r.is_success else "failed", "to": rec["owner"], "text": text}
