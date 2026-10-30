"""OWNER: P3. Witness text -> CLAIMED events via Featherless LLM (structured JSON), quote-verified in code.

The LLM only maps sentences onto a FIXED vocabulary of checkable claims; fusion's rules decide what is true.
Fallback when the LLM is unavailable: a hand-annotated seed file (witness_extractions.seed.json) in the
same schema, clearly marked as such in the output. Quotes are verified either way."""
import json
import re
from pathlib import Path

from .. import llm

ACTIONS = {
    "speed": "a speed estimate; value = number in km/h (midpoint if a range)",
    "no_brake": "says a vehicle did not slow down / brake",
    "brake": "says a vehicle braked or slowed",
    "cut_in": "says one vehicle cut in front of another; value = the other vehicle",
    "impact": "says a vehicle hit something; value = what it hit",
    "turn": "says a vehicle turned or swerved; value = direction",
    "fell": "says a person fell / was lying on the road",
    "time_of_day": "states the clock time; value = HH:MM 24h",
    "presence": "says something was present; value = what",
}
ENTITIES = {"bus": "the bus", "officer": "the traffic officer / policeman (the constable himself if he is the speaker)",
            "white_car": "the white car", "bikes": "motorcycles / bikes", "self": "the speaker"}
HEDGES = ["i think", "maybe", "around", "about", "probably", "i guess", "not sure", "approximately", "at least"]

PROMPT = """You extract checkable claims from a road-accident witness statement.
Return ONE JSON object: {{"claims": [{{"actor": <entity>, "action": <action>, "value": <string or null>,
"order": <"before_impact"|"at_impact"|"after_impact"|"unknown">, "quote": <exact substring of the statement>}}]}}
Entities: {entities}
Actions: {actions}
Rules: quote must be copied character-for-character from the statement. One claim per checkable fact.
Do not infer anything that is not said. Do not judge who is at fault.
Statement ({witness}): \"\"\"{text}\"\"\""""


def hedge_conf(quote: str) -> float:
    q = quote.lower()
    return 0.45 if any(h in q for h in HEDGES) else 0.7


def verify(statement: str, claims: list[dict]) -> tuple[list[dict], list[dict]]:
    ok, rejected = [], []
    for c in claims:
        quote = (c.get("quote") or "").strip()
        i = statement.find(quote) if quote else -1
        if i < 0 or c.get("action") not in ACTIONS:
            rejected.append(c)
            continue
        c["span"] = [i, i + len(quote)]
        ok.append(c)
    return ok, rejected


def extract(statement: str, witness_id: str, seed: dict | None = None) -> dict:
    msgs = [{"role": "user", "content": PROMPT.format(
        entities=json.dumps(ENTITIES), actions=json.dumps(ACTIONS), witness=witness_id, text=statement)}]
    try:
        r = llm.chat_json(msgs)
        claims, method = r["data"].get("claims", []), f"featherless:{r['model']}{' (cached)' if r['cached'] else ''}"
    except Exception as e:
        if not seed or witness_id not in seed:
            raise
        claims, method = json.loads(json.dumps(seed[witness_id])), f"seed (hand-annotated; LLM unavailable: {str(e)[:60]})"
    ok, rejected = verify(statement, claims)
    return {"witness": witness_id, "method": method, "claims": ok, "rejected": rejected}


def to_events(ex: dict, start_n: int = 0) -> list[dict]:
    order_t = {"before_impact": (-3.0, -0.2), "at_impact": (-0.5, 0.5), "after_impact": (0.2, 4.0), "unknown": (-6.0, 6.0)}
    out = []
    for i, c in enumerate(ex["claims"]):
        a, b = order_t.get(c.get("order", "unknown"), order_t["unknown"])
        out.append({"id": f"EV-W-{ex['witness'][-1]}{i + 1:02d}", "source": ex["witness"], "kind": "CLAIMED",
                    "t": {"start": a, "end": b, "sigma": 1.0}, "clock": "order", "actor": c["actor"], "action": c["action"],
                    "value": c.get("value"), "confidence": hedge_conf(c["quote"]), "quote": c["quote"], "span": c["span"],
                    "ref": f"{ex['witness']}.txt#c={c['span'][0]}-{c['span'][1]}", "derived_from": [],
                    "rule": "R_claim_extraction", "method": ex["method"]})
    return out


def run(case_dir: Path) -> list[dict]:
    ev_dir = case_dir / "evidence"
    seed_p = case_dir / "witness_extractions.seed.json"
    seed = json.loads(seed_p.read_text()) if seed_p.exists() else None
    events, extractions = [], []
    for f in sorted(ev_dir.glob("witness_*.txt")):
        ex = extract(f.read_text(encoding="utf-8").strip(), f.stem, seed)
        extractions.append(ex)
        events += to_events(ex)
    (case_dir / "witness_extractions.json").write_text(json.dumps(extractions, indent=2))
    return events


def parse_speed(value) -> float | None:
    m = re.findall(r"\d+(?:\.\d+)?", str(value or ""))
    return sum(map(float, m)) / len(m) if m else None
