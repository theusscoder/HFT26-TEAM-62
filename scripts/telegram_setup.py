"""Link the YATHARTH Telegram bot to the demo phone. Standard library only, so it runs before pip install.

Telegram bots cannot message a phone number directly: the phone has to open the bot once. This script
  1. checks the bot token (getMe),
  2. waits for you to press START on the bot from the demo phone,
  3. asks the phone to share its contact and checks it is the DEMO_PHONE number,
  4. writes TELEGRAM_BOT_TOKEN, DEMO_CHAT_ID_1 and DEMO_PHONE into backend/.env (other lines are kept),
  5. sends a test alert.

Usage (repo root):
  python scripts/telegram_setup.py <BOT_TOKEN> --phone +918978777355
  python scripts/telegram_setup.py --test            # resend a test message with the saved settings
Get a token: Telegram → @BotFather → /newbot → copy the token it prints.
"""
import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ENV = Path(__file__).resolve().parents[1] / "backend" / ".env"


def api(token: str, method: str, **params):
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=json.dumps(params).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read() or b"{}") | {"ok": False}


def digits(p: str | None) -> str:
    return re.sub(r"\D", "", p or "")[-10:]


def read_env() -> dict:
    out = {}
    if ENV.exists():
        for line in ENV.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    return out


def write_env(updates: dict):
    lines = ENV.read_text(encoding="utf-8").splitlines() if ENV.exists() else []
    done = set()
    for i, line in enumerate(lines):
        k = line.split("=", 1)[0].strip()
        if k in updates and not line.lstrip().startswith("#"):
            lines[i] = f"{k}={updates[k]}"
            done.add(k)
    lines += [f"{k}={v}" for k, v in updates.items() if k not in done]
    ENV.parent.mkdir(parents=True, exist_ok=True)
    ENV.write_text("\n".join(lines) + "\n", encoding="utf-8")


def test(token: str, chat: str, phone: str):
    r = api(token, "sendMessage", chat_id=chat, text=f"✅ YATHARTH test alert\nThis phone ({phone}) will receive the demo alerts: hospitals, police, victim and suspect notices.")
    print("Test message:", "delivered ✓" if r.get("ok") else f"FAILED {r.get('description')}")
    return r.get("ok")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("token", nargs="?")
    ap.add_argument("--phone", help="demo phone, e.g. +918978777355")
    ap.add_argument("--role", choices=["victim", "suspect", "all"], default="all",
                    help="which alerts this phone receives: victim, suspect (perpetrator) or all (default)")
    ap.add_argument("--skip-verify", action="store_true", help="accept the first chat that presses START without checking the number")
    ap.add_argument("--save", action="store_true",
                    help="only check and save the token; phones then link themselves in the running app (START + Share my phone number)")
    ap.add_argument("--test", action="store_true", help="only send a test message with the saved .env settings")
    ap.add_argument("--wait", type=int, default=300, help="seconds to wait for START (default 300)")
    a = ap.parse_args()
    env = read_env()
    token = a.token or env.get("TELEGRAM_BOT_TOKEN")
    phone = a.phone or env.get("DEMO_PHONE")
    if not token:
        sys.exit("Give the bot token: python scripts/telegram_setup.py <BOT_TOKEN> --phone +91XXXXXXXXXX")
    if a.test:
        if not env.get("DEMO_CHAT_ID_1"):
            sys.exit("No DEMO_CHAT_ID_1 in backend/.env yet. Run the setup first.")
        sys.exit(0 if test(token, env["DEMO_CHAT_ID_1"], phone or "?") else 1)

    me = api(token, "getMe")
    if not me.get("ok"):
        sys.exit(f"Token rejected by Telegram: {me.get('description')}. Copy it again from @BotFather.")
    bot = me["result"]["username"]
    if a.save:
        write_env({"TELEGRAM_BOT_TOKEN": token, "TELEGRAM_BOT_USERNAME": bot})
        print(f"Bot OK: @{bot}  (saved to {ENV})")
        print(f"\nOn EACH phone (+91 7330619997 and +91 8978777355):\n  1. open  https://t.me/{bot}\n  2. press START\n  3. tap 'Share my phone number'")
        print("The running demo links the phone and replies '✅ Linked'. Alerts then reach that phone within seconds.")
        return
    api(token, "deleteWebhook")
    print(f"Bot OK: @{bot}\n\nOn the phone {phone or '(any)'}: open  https://t.me/{bot}  and press START.")
    print("Waiting", a.wait, "s …")

    offset, chat, deadline = None, None, time.time() + a.wait
    asked = set()
    while time.time() < deadline:
        r = api(token, "getUpdates", timeout=25, **({"offset": offset} if offset else {}))
        for u in r.get("result", []):
            offset = u["update_id"] + 1
            m = u.get("message") or {}
            cid = str((m.get("chat") or {}).get("id", ""))
            if not cid:
                continue
            if m.get("contact"):
                shared = m["contact"].get("phone_number")
                own = m["contact"].get("user_id") == (m.get("from") or {}).get("id")
                if phone and digits(shared) != digits(phone):
                    api(token, "sendMessage", chat_id=cid, text=f"This number ({shared}) is not the demo number. Open the bot from {phone}.")
                    print(f"  contact {shared} does not match {phone}; still waiting")
                    continue
                if not own:
                    api(token, "sendMessage", chat_id=cid, text="Please share your own contact, not someone else's.")
                    continue
                chat = cid
                api(token, "sendMessage", chat_id=cid, text="Number verified ✓", reply_markup={"remove_keyboard": True})
                break
            if cid not in asked:
                asked.add(cid)
                print(f"  START from chat {cid} ({(m.get('from') or {}).get('first_name', '')})")
                if a.skip_verify or not phone:
                    chat = cid
                    break
                api(token, "sendMessage", chat_id=cid, text=f"YATHARTH demo alerts. Tap the button to confirm this phone is {phone}.",
                    reply_markup={"keyboard": [[{"text": "📱 Share my number", "request_contact": True}]], "one_time_keyboard": True, "resize_keyboard": True})
        if chat:
            break
    if not chat:
        sys.exit("Timed out. Run again and press START on the bot (then 'Share my number').")
    upd = {"TELEGRAM_BOT_TOKEN": token, "TELEGRAM_BOT_USERNAME": bot}
    if phone:
        upd[f"TG_CHAT_{digits(phone)}"] = chat  # alerts addressed to this number go to this chat
    if a.role == "all":
        upd |= {"DEMO_CHAT_ID_1": chat, "DEMO_PHONE": phone or ""}
    else:
        upd |= {f"DEMO_CHAT_ID_{a.role.upper()}": chat, f"DEMO_{a.role.upper()}_PHONE": phone or ""}
        if a.role == "victim":  # hospital / police copies go to the victim's phone too unless set separately
            upd |= {"DEMO_CHAT_ID_1": chat}
    write_env(upd)
    print(f"Saved to {ENV}: chat {chat} for {phone}")
    test(token, chat, phone or "this chat")
    print("\nRestart the backend so it picks up the new settings.")


if __name__ == "__main__":
    main()
