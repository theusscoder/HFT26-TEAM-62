"""Configure SMS delivery for the case contacts and send a test to both numbers.
  backend\\.venv\\Scripts\\python scripts\\sms_setup.py twilio <ACCOUNT_SID> <AUTH_TOKEN> <FROM_NUMBER or MG… service SID>
  backend\\.venv\\Scripts\\python scripts\\sms_setup.py fast2sms <API_KEY>
  backend\\.venv\\Scripts\\python scripts\\sms_setup.py test
Twilio trial accounts can text only VERIFIED numbers: add both case numbers under Phone Numbers > Verified Caller IDs first."""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from telegram_setup import read_env, write_env  # noqa: E402

a = sys.argv[1:]
if not a:
    sys.exit(__doc__)
if a[0] == "twilio" and len(a) == 4:
    write_env({"TWILIO_ACCOUNT_SID": a[1], "TWILIO_AUTH_TOKEN": a[2], "TWILIO_FROM": a[3]})
elif a[0] == "fast2sms" and len(a) == 2:
    write_env({"FAST2SMS_API_KEY": a[1]})
elif a[0] != "test":
    sys.exit(__doc__)
for k, v in read_env().items():
    os.environ[k] = v
sys.path.insert(0, str(ROOT / "backend"))
from app import notify  # noqa: E402

print("SMS provider:", notify.sms_provider() or "none")
contacts = json.loads((ROOT / "data" / "cases" / "hero" / "contacts.json").read_text())
for role in ("suspect", "victim"):
    num = contacts.get(role)
    if not num:
        continue
    r = notify.send(role, f"{role} contact", num, "YATHARTH test", "test", real=True,
                    sms_text="YATHARTH test (demo): accident alerts for case hero will reach this number. Reply STOP to opt out.")
    print(f"  {role} {num}: {r['status']} via {r['channel']} {r.get('latency_ms') or ''} ms", *(f"\n    {x['channel']}: {x['detail']}" for x in r["attempts"] if not x["ok"]))
