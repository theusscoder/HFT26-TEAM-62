"""Witness reliability from conditions, known before checking a word of the statement: distance, hedging, how
long they saw it, and whether the claim is the kind people estimate badly. fusion's score (share of checkable
claims that held up) says how a witness did; this one says how much to expect. Each reduction gives a reason."""
import re

MAX_WEIGHT = 0.9
NEAR_M = 3.0
FAR_M = 30.0
HEDGE_FACTOR = 0.8
MID_FACTOR = 0.9
FAR_FACTOR = 0.7
BRIEF_FACTOR = 0.7
ESTIMATE_FACTOR = 0.6

_HEDGE = re.compile(r"\b(i think|maybe|around|about|probably|i guess|not sure|approximately|at least)\b", re.I)
_BRIEF = re.compile(r"\b(a moment|briefly|glimpse|only saw|just saw)\b", re.I)


def weigh_statement(statement: str, meta: dict) -> dict:
    weight, reasons = MAX_WEIGHT, []
    distance = meta.get("distance_m")
    if distance is not None:
        if distance > FAR_M:
            weight *= FAR_FACTOR
            reasons.append(f"far from the impact, about {distance:g} m")
        elif distance > NEAR_M:
            weight *= MID_FACTOR
            reasons.append(f"some distance from the impact, about {distance:g} m")
        else:
            reasons.append(f"close to the impact, about {distance:g} m")
    if _HEDGE.search(statement):
        weight *= HEDGE_FACTOR
        reasons.append("hedged wording")
    if _BRIEF.search(statement):
        weight *= BRIEF_FACTOR
        reasons.append("saw it only briefly")
    return {"weight": round(weight, 2), "reasons": reasons}


def weigh_claim(base: float, action: str, reasons: list[str]) -> dict:
    if action == "speed":
        return {"weight": round(base * ESTIMATE_FACTOR, 2),
                "reasons": [*reasons, "speed estimates by eye are unreliable (Loftus & Palmer, 1974)"]}
    return {"weight": base, "reasons": reasons}
