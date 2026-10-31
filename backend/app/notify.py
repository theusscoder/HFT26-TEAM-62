"""A3 · alert delivery.

Who gets what, and how (consent-based, no fictional numbers ever dialled):
  • REAL recipients = the phone numbers the case officer put in data/cases/<id>/contacts.json (perpetrator / victim).
      - SMS   : Twilio (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM) or Fast2SMS (FAST2SMS_API_KEY), if configured
      - Telegram: the chat that phone opened with the bot (TG_CHAT_<10 digits> in .env, or linked in-app by telegram_bot.py)
  • Facility recipients (hospitals, police, checkpoints) have placeholder numbers: they are NEVER texted. Their copy goes
    to the control-room demo chat (DEMO_CHAT_ID_<ROLE> / DEMO_CHAT_ID_1) or ntfy, if configured.
All channels for one recipient fire in parallel with short timeouts, so an alert lands within seconds; each attempt's
latency is returned and logged. With nothing configured the alert is 'simulated' (built, logged, shown; not pushed)."""
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor

import httpx

TIMEOUT = 6.0   # per channel; the whole dispatch stays well inside 10 s


def digits(p: str | None) -> str:
    return re.sub(r"\D", "", p or "")[-10:]


def e164(p: str | None) -> str | None:
    d = re.sub(r"\D", "", p or "")
    if len(d) == 10:
        return "+91" + d
    if len(d) == 12 and d.startswith("91"):
        return "+" + d
    return ("+" + d) if d else None


def _chat(role: str) -> str | None:
    return os.getenv(f"DEMO_CHAT_ID_{role.upper()}") or os.getenv("DEMO_CHAT_ID_1")


def _chat_for_number(number: str | None) -> str | None:
    """Chat the person behind this number opened with the bot: .env TG_CHAT_<digits>, else the in-app linker."""
    if not digits(number):
        return None
    from . import telegram_bot
    return os.getenv(f"TG_CHAT_{digits(number)}") or telegram_bot.chat_for(number)


def demo_phone() -> str | None:
    return os.getenv("DEMO_PHONE") or None


def sms_provider() -> str | None:
    if os.getenv("TWILIO_ACCOUNT_SID") and os.getenv("TWILIO_AUTH_TOKEN") and os.getenv("TWILIO_FROM"):
        return "twilio"
    if os.getenv("FAST2SMS_API_KEY"):
        return "fast2sms"
    return None


# ---------------- channels ----------------
def _telegram(chat: str, text: str) -> dict:
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    r = httpx.post(f"https://api.telegram.org/bot{token}/sendMessage",
                   json={"chat_id": chat, "text": text[:4000], "disable_web_page_preview": True}, timeout=TIMEOUT)
    return {"ok": r.is_success, "detail": "" if r.is_success else r.text[:160]}


def _sms(number: str, text: str) -> dict:
    prov = sms_provider()
    if prov == "twilio":
        sid, tok, frm = os.getenv("TWILIO_ACCOUNT_SID"), os.getenv("TWILIO_AUTH_TOKEN"), os.getenv("TWILIO_FROM")
        data = {"To": e164(number), "Body": text[:600]}
        data["MessagingServiceSid" if frm.startswith("MG") else "From"] = frm
        r = httpx.post(f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json", data=data, auth=(sid, tok), timeout=TIMEOUT)
        return {"ok": r.is_success, "detail": "" if r.is_success else r.text[:200], "id": (r.json() or {}).get("sid") if r.is_success else None}
    if prov == "fast2sms":
        r = httpx.post("https://www.fast2sms.com/dev/bulkV2", headers={"authorization": os.getenv("FAST2SMS_API_KEY")},
                       json={"route": "q", "message": text[:600], "language": "english", "flash": 0, "numbers": digits(number)}, timeout=TIMEOUT)
        ok = r.is_success and bool((r.json() or {}).get("return"))
        return {"ok": ok, "detail": "" if ok else r.text[:200]}
    return {"ok": False, "detail": "no SMS provider configured"}


def _ntfy(role: str, title: str, text: str) -> dict:
    server = os.getenv("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
    r = httpx.post(f"{server}/{os.getenv('NTFY_TOPIC')}", content=text.encode("utf-8"),
                   headers={"Title": title.encode("ascii", "ignore").decode()[:120] or "YATHARTH alert",
                            "Priority": "urgent", "Tags": {"hospital": "ambulance", "police": "police_car"}.get(role, "warning")}, timeout=TIMEOUT)
    return {"ok": r.is_success, "detail": "" if r.is_success else r.text[:160]}


def _timed(channel: str, fn, *a) -> dict:
    t = time.perf_counter()
    try:
        r = fn(*a)
    except Exception as e:
        r = {"ok": False, "detail": f"{type(e).__name__}: {e}"[:160]}
    return {"channel": channel, **r, "latency_ms": round((time.perf_counter() - t) * 1000)}


def send(role: str, to_label: str, to_number: str | None, title: str, text: str, sms_text: str | None = None, real: bool = False,
         allow_sms: bool = True) -> dict:
    """real=True: a verified case contact -> SMS + Telegram to that number. real=False: facility copy -> control-room chat."""
    jobs = []
    if real and to_number:
        if sms_provider() and allow_sms:
            jobs.append(("sms", _sms, to_number, sms_text or f"{title}\n{text}"))
        chat = _chat_for_number(to_number)
        if os.getenv("TELEGRAM_BOT_TOKEN") and chat:
            jobs.append(("telegram", _telegram, chat, f"{title}\n{text}"))
    else:
        chat = _chat(role)
        footer = f"\n\n— Copy for {to_label} (control-room demo channel; facility numbers are placeholders)."
        if os.getenv("TELEGRAM_BOT_TOKEN") and chat:
            jobs.append(("telegram", _telegram, chat, f"{title}\n{text}{footer}"))
        if os.getenv("NTFY_TOPIC"):
            jobs.append(("ntfy", _ntfy, role, title, f"{text}{footer}"))
    if not jobs:
        why = "no SMS provider and this number has not opened the Telegram bot" if real else "no control-room channel configured"
        return {"status": "simulated", "channel": "none", "attempts": [], "detail": why}
    with ThreadPoolExecutor(max_workers=len(jobs)) as ex:
        attempts = list(ex.map(lambda j: _timed(j[0], j[1], *j[2:]), jobs))
    ok = [a for a in attempts if a["ok"]]
    return {"status": "sent" if ok else "failed", "channel": "+".join(a["channel"] for a in ok) or attempts[-1]["channel"],
            "attempts": attempts, "latency_ms": min((a["latency_ms"] for a in ok), default=None)}


def channels() -> dict:
    return {"telegram": bool(os.getenv("TELEGRAM_BOT_TOKEN")), "sms": sms_provider(), "ntfy": bool(os.getenv("NTFY_TOPIC")),
            "demo_phone": demo_phone(), "bot": os.getenv("TELEGRAM_BOT_USERNAME"),
            "chat_ids": {r: bool(_chat(r)) for r in ("hospital", "police", "victim", "suspect")}}


def reach(number: str | None) -> list[str]:
    """Which real channels can reach this number right now."""
    out = []
    if number and sms_provider():
        out.append(f"SMS ({sms_provider()})")
    if number and os.getenv("TELEGRAM_BOT_TOKEN") and _chat_for_number(number):
        out.append("Telegram")
    return out


def telegram_status() -> dict:
    """Live check of the bot token and the demo chat (used by the website before the demo)."""
    token, chat = os.getenv("TELEGRAM_BOT_TOKEN"), _chat("police")
    out = {"configured": bool(token and chat), "token": bool(token), "chat": bool(chat), "demo_phone": demo_phone(),
           "bot": os.getenv("TELEGRAM_BOT_USERNAME"), "ok": False, "detail": "", "sms": sms_provider()}
    if not token:
        out["detail"] = "TELEGRAM_BOT_TOKEN missing: run link_telegram.bat"
        return out
    try:
        r = httpx.get(f"https://api.telegram.org/bot{token}/getMe", timeout=10).json()
        out["ok"] = bool(r.get("ok"))
        out["bot"] = (r.get("result") or {}).get("username", out["bot"])
        out["detail"] = "ready" if out["ok"] else r.get("description", "token rejected")
    except Exception as e:
        out["detail"] = f"cannot reach Telegram: {type(e).__name__}"
    return out
