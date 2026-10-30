"""OWNER: P3. Witness text -> CLAIMED events. Featherless LLM first (structured JSON over a fixed claim vocabulary);
an offline rule-based extractor when no key / network; a hand-annotated seed file if a case ships one.
Whatever produced the claims, every quote is verified in code against the statement and the method is recorded.

The extractor only maps sentences to checkable claims. Fusion's rules decide what is true."""
import json
import re
from pathlib import Path

from .. import asr, llm

AUDIO_SUFFIXES = {".wav", ".mp3", ".m4a", ".ogg", ".flac", ".opus"}
ACTIONS = {
    "speed": "a speed estimate; value = number in km/h (midpoint if a range)",
    "no_brake": "says a vehicle did not slow down / brake",
    "brake": "says a vehicle braked or slowed",
    "cut_in": "says one vehicle cut in front of another; value = the other road user",
    "impact": "says a road user hit something; value = what it hit",
    "turn": "says a vehicle turned or swerved; value = left / right / towards <thing>",
    "fell": "says a person fell / was lying on the road",
    "stopped_in_time": "says a vehicle stopped before hitting anything",
    "signal": "states a traffic signal colour; value = red / amber / green",
    "time_of_day": "states the clock time; value = HH:MM 24h",
    "presence": "says something was present; value = what",
}
_BRAKING = r"\b(brake|brakes|braked|braking|slow|slowed|slows|slowing|stop|stopped)\b"
ACTION_WORDS = {  # every pattern listed must appear
    "fell": [r"\b(fell|fall|falls|fallen|falling|lying|lay|collapsed|knocked|thrown)\b"],
    "no_brake": [r"\b(not|never|no|without|didn't|didnt|wasn't)\b|n't\b", _BRAKING],
    "stopped_in_time": [r"\b(stop|stopped|stops|halted|in time)\b"],
    "speed": [r"\d|\b(fast|slow|slowly|speed|speeding|crawling|parked|stationary|still|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b"],
}
HEDGES = ["i think", "maybe", "around", "about", "probably", "i guess", "not sure", "approximately", "at least", "roughly", "seemed"]

PROMPT = """You extract checkable claims from a road-accident witness statement.
Return ONE JSON object: {{"claims": [{{"actor": <short noun phrase from the statement, e.g. "the bus", "a white car", "the policeman", "I">,
"action": <one of the actions>, "value": <string or null>, "order": <"before_impact"|"at_impact"|"after_impact"|"unknown">,
"quote": <exact substring of the statement>,
"translation": <English meaning of the quote if the statement isn't in English, else null>}}],
"orderings": [{{"before": <claim index>, "after": <claim index>, "quote": <exact words stating the order>}}]}}
Actions: {actions}
Rules: quote must be copied character-for-character from the statement, in its original language and script.
One claim per checkable fact. "orderings" lists only sequences the witness states outright, such as "X and then Y".
Do not infer anything that is not said. Do not judge who is at fault.
Statement ({witness}): \"\"\"{text}\"\"\""""

# ---------- offline rule-based extractor ----------
NOUN = r"(?:(?:the|a|an|that|this|one)\s+)?(?:(?:white|black|silver|grey|gray|red|blue|green|yellow|orange|brown|big|small|private|government|school)\s+)*(?:bus|car|truck|lorry|van|auto|auto-rickshaw|bike|motorbike|motorcycle|scooter|cycle|bicycle|jeep|suv|tempo|policeman|police|constable|officer|pedestrian|lady|woman|man|boy|girl|person|driver)"
OBJ = r"(?:divider|median|pole|wall|kerb|curb|footpath|barrier|tree|signal|shop)"
WORDNUM = {"ten": 10, "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "hundred": 100}


def _sentences(text):
    for m in re.finditer(r"[^.!?]+[.!?]?", text):
        s = m.group().strip()
        if s:
            yield s


def _actor(sentence, default=None):
    m = re.search(NOUN, sentence, re.I)
    return m.group().strip() if m else default


def _order(sentence):
    s = sentence.lower()
    if re.search(r"\b(before|just before|earlier|approach|coming)\b", s): return "before_impact"
    if re.search(r"\b(after|then|later|afterwards)\b", s): return "after_impact"
    if re.search(r"\b(hit|crash|collid|smash|bang)\w*", s): return "at_impact"
    return "unknown"


def _clause(sentence, pattern):
    """Smallest comma/and-delimited clause of the sentence containing the pattern (keeps quotes short)."""
    m = re.search(pattern, sentence, re.I)
    if not m:
        return None
    parts = re.split(r"(?<=,)\s+|\s+(?=\band\b)|\s+(?=\bso\b)|\s+(?=\bbut\b)", sentence)
    for p in parts:
        if re.search(pattern, p, re.I):
            return p.strip(" ,.").removeprefix("and ").removeprefix("so ").removeprefix("but ").strip()
    return sentence.strip(" .")


def rule_extract(text: str) -> list[dict]:
    claims, last_vehicle = [], None
    for s in _sentences(text):
        low = s.lower()
        act = _actor(s, last_vehicle)
        if act and not re.search(r"police|constable|officer|pedestrian|lady|woman|man|boy|girl|person", act, re.I):
            last_vehicle = act
        def add(action, value, pattern, actor=None):
            q = _clause(s, pattern)
            if not q:
                return
            if actor is None:  # subject = the last road user named before the verb, else the sentence's subject
                m = re.search(pattern, s, re.I)
                before = list(re.finditer(NOUN, s[:m.start()], re.I)) if m else []
                actor = before[-1].group().strip() if before else (act or last_vehicle or "unknown")
            claims.append({"actor": actor, "action": action, "value": value, "order": _order(s), "quote": q})
        sp = re.search(r"(\d{1,3})(?:\s*(?:-|to|or)\s*(\d{1,3}))?\s*(?:km/?h|kmph|kph|km per hour)?", s, re.I)
        if re.search(r"\b(speed|fast|slow|km|kmph|going|driving|doing|travelling|traveling|about|maybe|around|at least)\b", low) and sp and not re.search(r"\d{1,2}:\d{2}", s):
            v = (int(sp.group(1)) + int(sp.group(2))) / 2 if sp.group(2) else int(sp.group(1))
            if 3 <= v <= 200:
                add("speed", str(v), re.escape(sp.group()))
        for w, n in WORDNUM.items():
            if re.search(rf"\b{w}\b", low) and re.search(r"\b(speed|fast|km|going)\b", low):
                add("speed", str(n), rf"\b{w}\b")
        if re.search(r"\bstopped\s+(in time|before|short)\b|\bmanaged to stop\b", low):
            add("stopped_in_time", None, r"\bstopped\s+(in time|before|short)\b[^,.]*|\bmanaged to stop\b[^,.]*")
        if re.search(r"(did not|didn't|never|no)\s+(slow|brak|stop)", low):
            add("no_brake", None, r"(did not|didn't|never|no)\s+(slow|brak|stop)\w*(\s+down)?(\s+at all)?")
        elif re.search(r"\b(braked|braking|slowed|applied (the )?brakes?)\b", low):
            add("brake", None, r"\b(braked|braking|slowed|applied (the )?brakes?)\b")
        m = re.search(rf"({NOUN})\s+(?:suddenly\s+)?(?:cut|came)\s+in\s*(?:front)?\s*(?:of\s+({NOUN}))?", s, re.I)
        if m:
            add("cut_in", m.group(2) or "the other vehicle", re.escape(m.group()), actor=m.group(1))
        m = re.search(rf"(?:hit|crashed into|rammed|collided with|struck|smashed into|slammed into|ran into|banged into)(?:\s+the\s+side\s+of)?\s+({NOUN}|(?:the\s+)?{OBJ})", s, re.I)
        if m:
            add("impact", re.sub(r"^(the|a|an)\s+", "", m.group(1), flags=re.I), re.escape(m.group()))
        m = re.search(r"\b(turned|swerved|veered|went)\s+(left|right|towards?\s+\w+(?:\s+\w+)?)", s, re.I)
        if m:
            add("turn", m.group(2), re.escape(m.group()))
        if re.search(r"\b(fell|fallen|lying|knocked down|thrown)\b", low):
            m2 = re.search(r"(policeman|police|constable|officer|pedestrian|lady|woman|man|boy|girl|person|rider|driver)", s, re.I)
            add("fell", None, r"\b(fell|fallen|lying|knocked down|thrown)\b[^,.]*", actor=m2.group() if m2 else "a person")
        m = re.search(r"\b(red|amber|yellow|green)\b\s*(?:light|signal)|signal\s+was\s+(red|amber|yellow|green)", s, re.I)
        if m:
            add("signal", (m.group(1) or m.group(2)).lower().replace("yellow", "amber"), re.escape(m.group()))
        m = re.search(r"\b(\d{1,2})[:.](\d{2})\s*(am|pm|in the (?:morning|evening|night|afternoon))?", s, re.I)
        if m:
            h, mi, suf = int(m.group(1)), m.group(2), (m.group(3) or "").lower()
            if ("pm" in suf or "evening" in suf or "afternoon" in suf or "night" in suf) and h < 12:
                h += 12
            add("time_of_day", f"{h:02d}:{mi}", re.escape(m.group()), actor="I")
        m = re.search(r"\b(many|lots of|several|few|some)\s+(bikes|cars|people|vehicles|pedestrians|autos)\b[^,.]*", s, re.I)
        if m:
            add("presence", m.group(), re.escape(m.group()), actor=m.group(2))
    return claims


# ---------- shared ----------

def hedge_conf(quote: str) -> float:
    q = quote.lower()
    return 0.45 if any(h in q for h in HEDGES) else 0.7


def verify(statement: str, claims: list[dict]) -> tuple[list[dict], list[dict]]:
    """A claim survives only if its quote is verbatim and its words can actually say what the action means. So
    "I had to jump away" can't become a claim that someone fell, however the model labelled it."""
    ok, rejected = [], []
    for c in claims:
        quote = (c.get("quote") or "").strip()
        i = statement.find(quote) if quote else -1
        if i < 0 or c.get("action") not in ACTIONS:
            c["rejected_because"] = "quote not verbatim" if i < 0 else "unknown action"
            rejected.append(c)
            continue
        readable = (quote if quote.isascii() or not c.get("translation") else c["translation"]).lower()
        if not all(re.search(p, readable) for p in ACTION_WORDS.get(c["action"], [])):
            c["rejected_because"] = f"quote doesn't say {c['action']}"
            rejected.append(c)
            continue
        c["span"] = [i, i + len(quote)]
        ok.append(c)
    return ok, rejected


def extract(statement: str, witness_id: str, seed: dict | None = None) -> dict:
    msgs = [{"role": "user", "content": PROMPT.format(actions=json.dumps(ACTIONS), witness=witness_id, text=statement)}]
    try:
        r = llm.chat_json(msgs)
        claims, method = r["data"].get("claims", []), f"featherless:{r['model']}{' (cached)' if r['cached'] else ''}"
        orderings = r["data"].get("orderings", [])
    except Exception as e:
        if seed and witness_id in seed:
            claims, method = json.loads(json.dumps(seed[witness_id])), "seed (hand-annotated)"
        else:
            claims, method = rule_extract(statement), "offline rule-based extractor"
        method += f" · LLM unavailable: {str(e)[:50]}"
        orderings = []
    raw = list(claims)
    ok, rejected = verify(statement, claims)
    kept_index = {i: next(j for j, k in enumerate(ok) if k is c) for i, c in enumerate(raw) if any(c is k for k in ok)}
    # An order only counts if both claims survived and its own words are in the statement.
    verified = [
        {"before": kept_index[o["before"]], "after": kept_index[o["after"]], "quote": o["quote"]}
        for o in orderings
        if isinstance(o, dict) and o.get("before") in kept_index and o.get("after") in kept_index
        and o.get("before") != o.get("after") and o.get("quote") and o["quote"] in statement
    ]
    return {"witness": witness_id, "statement": statement, "method": method, "claims": ok, "rejected": rejected, "orderings": verified}


def to_events(ex: dict) -> list[dict]:
    order_t = {"before_impact": (-3.0, -0.2), "at_impact": (-0.5, 0.5), "after_impact": (0.2, 4.0), "unknown": (-6.0, 6.0)}
    out = []
    num = re.sub(r"\D", "", ex["witness"]) or "0"
    for i, c in enumerate(ex["claims"]):
        a, b = order_t.get(c.get("order", "unknown"), order_t["unknown"])
        out.append({"id": f"EV-W-{num}{i + 1:02d}", "source": ex["witness"], "kind": "CLAIMED",
                    "t": {"start": a, "end": b, "sigma": 1.0}, "clock": "order", "order": c.get("order", "unknown"), "actor": c["actor"], "actor_text": c["actor"],
                    "action": c["action"], "value": c.get("value"), "confidence": hedge_conf(c["quote"]), "quote": c["quote"], "translation": c.get("translation"),
                    "span": c["span"], "ref": f"{ex['witness']}.txt#c={c['span'][0]}-{c['span'][1]}", "derived_from": [],
                    "rule": "R_claim_extraction", "method": ex["method"]})
    return out


def transcribe_voice_notes(ev_dir: Path, languages: dict) -> list[str]:
    """Voice statements become witness_N.txt, so quotes get checked against the transcript like any other."""
    done = []
    for audio in sorted(p for p in ev_dir.glob("witness_*") if p.suffix.lower() in AUDIO_SUFFIXES):
        target = audio.with_suffix(".txt")
        if not target.exists():
            target.write_text(asr.transcribe(audio, languages.get(audio.stem, "te")) + "\n", encoding="utf-8")
            done.append(audio.stem)
    return done


def orderings_as_constraints(ex: dict, events_by_index: dict[int, dict]) -> list[dict]:
    out = []
    for n, o in enumerate(ex.get("orderings", []), start=1):
        before, after = events_by_index.get(o["before"]), events_by_index.get(o["after"])
        if before and after:
            start = ex["statement"].find(o["quote"])
            ref = f"{ex['witness']}.txt#c={start}-{start + len(o['quote'])}" if start >= 0 else before["ref"]
            out.append({"id": f"ORDER-{ex['witness']}-{n}", "from": before["id"], "to": after["id"], "min_s": 0.0, "max_s": None,
                        "confidence": before["confidence"], "ref": ref, "quote": o["quote"]})
    return out


def run(case_dir: Path) -> list[dict]:
    ev_dir = case_dir / "evidence"
    seed_p = case_dir / "witness_extractions.seed.json"
    seed = json.loads(seed_p.read_text()) if seed_p.exists() else None
    meta_p = case_dir / "witnesses.json"
    meta = json.loads(meta_p.read_text(encoding="utf-8")) if meta_p.exists() else {}
    transcribe_voice_notes(ev_dir, {k: v.get("language", "te") for k, v in meta.items()})
    events, extractions, constraints = [], [], []
    for f in sorted(ev_dir.glob("witness_*.txt")):
        ex = extract(f.read_text(encoding="utf-8").strip(), f.stem, seed)
        extractions.append(ex)
        new_events = to_events(ex)
        events += new_events
        constraints += orderings_as_constraints(ex, dict(enumerate(new_events)))
    (case_dir / "witness_extractions.json").write_text(json.dumps(extractions, indent=2))
    (case_dir / "witness_orderings.json").write_text(json.dumps(constraints, indent=2))
    return events


def parse_speed(value) -> float | None:
    m = re.findall(r"\d+(?:\.\d+)?", str(value or ""))
    return sum(map(float, m)) / len(m) if m else None
