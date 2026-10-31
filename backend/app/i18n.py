"""Dashboard translation. The browser sends text templates, with numbers, plates and times already replaced by ⟦0⟧, ⟦1⟧...;
they come back translated and the browser puts the originals back, so a translation can never change a plate or a number.

Translations live in data/i18n/<lang>.json, committed and pre-built, so the demo needs neither network nor model. A template
not yet in the file goes to the text model once, is checked, and is added. If the model is unavailable the text stays in
English."""
import json
import re
import threading
from pathlib import Path

from . import llm

ROOT = Path(__file__).resolve().parents[2]
DIR = ROOT / "data" / "i18n"
LANGS = {"te": "Telugu"}
BATCH = 25
_lock = threading.Lock()
_mem: dict[str, dict] = {}
GLOSSARY = """Victim=బాధితుడు; Severity=తీవ్రత; Hit-and-run=హిట్ అండ్ రన్; Ambulance=అంబులెన్స్; Police=పోలీసులు; FIR=ఎఫ్‌ఐఆర్; Witness=సాక్షి;
Contradiction=వైరుధ్యం; Timeline=కాలక్రమం; Evidence=సాక్ష్యం; Reconstruction=పునర్నిర్మాణం; Licence=లైసెన్స్; Registration=రిజిస్ట్రేషన్;
Number plate=నంబర్ ప్లేట్; Camera=కెమెరా; Dashcam=డాష్‌క్యామ్; Hospital=ఆసుపత్రి; Case=కేసు; Impact=ఢీకొన్న క్షణం; Golden hour=గోల్డెన్ అవర్;
Intercept=ఇంటర్‌సెప్ట్; Report=నివేదిక; Telegram=టెలిగ్రామ్; Live=లైవ్; Primary vehicle=ప్రధాన వాహనం; Observed=గమనించినది; Claimed=పేర్కొన్నది;
Inferred=అంచనా; Treatment=చికిత్స; Driver=డ్రైవర్; Insurance=బీమా; Officer=అధికారి; Footage=ఫుటేజ్; Map=మ్యాప్."""
PROMPT = """Translate these road-accident dashboard strings from English to natural, simple Telugu, the way a Hyderabad traffic police
control room would read them. Answer ONLY with one JSON object mapping each key to its translation.
Rules:
- Keep every token like ⟦0⟧ exactly as written; you may move it to fit Telugu word order, but never drop, add or change one.
- Keep these in Latin letters: YATHARTH, CCTV, YOLO, BNS, MV Act, GPS, km/h, RTA, RC, Qwen, SMS, FASTag, ORR, HITEC.
- Write people's and places' names in Telugu script (Ravi Teja Goud = రవి తేజ గౌడ్, Gachibowli = గచ్చిబౌలి).
- Keep it short: buttons and labels stay short. Don't explain, don't add anything.
- Use this glossary: {glossary}

Strings:
{items}"""
TOKEN = re.compile(r"⟦\d+⟧")
TELUGU = re.compile(r"[ఀ-౿]")


def _path(lang: str) -> Path:
    return DIR / f"{lang}.json"


def table(lang: str) -> dict:
    with _lock:
        if lang not in _mem:
            p = _path(lang)
            try:
                _mem[lang] = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
            except ValueError:
                _mem[lang] = {}
            # hand-reviewed strings win over anything the model produced
            reviewed = DIR / f"{lang}_reviewed.json"
            if reviewed.exists():
                _mem[lang].update(json.loads(reviewed.read_text(encoding="utf-8")))
        return _mem[lang]


def good(src: str, out) -> bool:
    """A translation is kept only if every token survived and it is really in the target script."""
    if not isinstance(out, str) or not out.strip():
        return False
    if sorted(TOKEN.findall(src)) != sorted(TOKEN.findall(out)):
        return False
    return bool(TELUGU.search(out)) and len(out) < 4 * len(src) + 60


def _ask(lang: str, batch: list[str]) -> dict:
    keys = {str(i): s for i, s in enumerate(batch)}
    msg = PROMPT.format(glossary=GLOSSARY, items=json.dumps(keys, ensure_ascii=False, indent=0))
    data = llm.chat_json([{"role": "user", "content": msg}], model=llm.TEXT_MODEL, timeout=60)["data"]
    data = data.get("translations", data) if isinstance(data, dict) else {}
    return {keys[k]: v.strip() for k, v in data.items() if k in keys and good(keys[k], v)}


def translate(lang: str, texts: list[str]) -> dict:
    """{template: translation} for those known or newly translated. Anything that fails is simply left out."""
    if lang not in LANGS:
        return {}
    known = table(lang)
    out = {t: known[t] for t in texts if t in known}
    todo = [t for t in dict.fromkeys(texts) if t not in known and 0 < len(t) <= 900]
    new = {}
    for i in range(0, len(todo), BATCH):
        try:
            new.update(_ask(lang, todo[i:i + BATCH]))
        except Exception:
            break   # no model or no network: stay in English for now
    if new:
        with _lock:
            known.update(new)
            DIR.mkdir(parents=True, exist_ok=True)
            tmp = _path(lang).with_suffix(".tmp")
            tmp.write_text(json.dumps(known, ensure_ascii=False, indent=0, sort_keys=True), encoding="utf-8")
            tmp.replace(_path(lang))
        out.update(new)
    return out
