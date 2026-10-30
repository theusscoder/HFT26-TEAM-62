"""Golden-hour alerts. The registry is a fictional demo dict; chat ids point at teammates' phones.
If TELEGRAM_BOT_TOKEN is unset, alerts are simulated (still logged and shown in the UI)."""
import os

import httpx

# Fictional demo registry. Put a teammate's Telegram chat id in telegram_chat_id for the stage demo.
REGISTRY = {
    "TS09EA1234": {"owner": "DEMO OWNER 01", "vehicle": "White hatchback", "rto": "Hyderabad (Central)",
                   "insurance": "Valid", "emergency_contact": "+91 90000 00001",
                   "telegram_chat_id": os.getenv("DEMO_CHAT_ID_1")},
    "TS07GK5521": {"owner": "DEMO OWNER 02", "vehicle": "Red sedan", "rto": "Ranga Reddy",
                   "insurance": "Expired", "emergency_contact": "+91 90000 00002",
                   "telegram_chat_id": os.getenv("DEMO_CHAT_ID_2")},
}

AUTO_SEND_PLATE_CONFIDENCE = 0.80


def lookup(plate: str) -> dict | None:
    return REGISTRY.get(plate.replace(" ", "").upper())


def send(plate: str, text: str) -> dict:
    rec = lookup(plate)
    if not rec:
        return {"status": "not_found", "plate": plate}
    token, chat = os.getenv("TELEGRAM_BOT_TOKEN"), rec.get("telegram_chat_id")
    if not (token and chat):
        return {"status": "simulated", "to": rec["owner"], "text": text}
    r = httpx.post(f"https://api.telegram.org/bot{token}/sendMessage",
                   json={"chat_id": chat, "text": text}, timeout=10)
    return {"status": "sent" if r.is_success else "failed", "to": rec["owner"], "text": text}
