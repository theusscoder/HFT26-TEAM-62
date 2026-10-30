"""OWNER: P3. "Ask the case": answers ONLY from stored evidence, every sentence cites event / contradiction ids,
and fault / blame / liability questions are refused (PS: communicate uncertainty, no legal conclusions).

Flow: refusal guard -> keyword retrieval over events, contradictions, hypotheses and gaps -> answer.
With a Featherless key the LLM writes the answer from the retrieved items only; code drops any sentence that cites
an id it was not given, then the wording guard removes verdict language. Without a key a template answer is built
from the same items, so the feature always works."""
import json
import re
from pathlib import Path

from . import llm

REFUSE = re.compile(r"\b(fault|blame|guilty|liable|liability|responsible|responsibility|who caused|whose mistake|negligen\w*|punish\w*|arrest\w*|"
                    r"compensat\w*|convict\w*|sue|lawsuit|criminal|innocent|should be (fined|jailed|charged))\b", re.I)
IDENTITY = re.compile(r"\b(who (?:was|is) the (?:driver|owner|rider)|driver'?s? name|owner'?s? name|name of the (?:driver|owner)|identify the (?:driver|owner)|address of|phone number|whose (?:car|vehicle|bus|truck)|who owns)\b", re.I)
INJURY = re.compile(r"\b(injur\w*|hurt|die|dies|dying|dead|died|death|fatal\w*|killed|wounded|casualt\w*|hospitali[sz]ed|survive\w*|bleeding)\b", re.I)
VERDICT_WORDS = re.compile(r"\b(guilty|at fault|is to blame|caused the (crash|accident)|negligent|reckless|liable|innocent)\b", re.I)
SYN = {"speed": ["speed", "fast", "km", "slow", "quick"], "brake": ["brake", "braking", "slow", "stop", "decel"], "signal": ["signal", "light", "red", "green", "amber"],
       "time": ["time", "clock", "when", "o'clock", "pm", "am"], "witness": ["witness", "said", "saw", "statement", "claim"],
       "impact": ["impact", "hit", "crash", "collision", "collide"], "turn": ["turn", "swerve", "left", "right", "veer"],
       "person": ["officer", "policeman", "pedestrian", "person", "people", "fell", "injur"], "gap": ["gap", "missing", "unknown", "uncovered"]}


def guard(text: str) -> str:
    """Replace verdict language with neutral evidential wording."""
    return VERDICT_WORDS.sub("[not determined by this tool]", text)


def _items(d: Path) -> list[dict]:
    ev = json.loads((d / "events.json").read_text())
    an = json.loads((d / "analysis.json").read_text())
    names = an.get("entities", {}).get("names", {})
    nm = lambda a: names.get(a, a)
    wm = json.loads((d / "witnesses.json").read_text()) if (d / "witnesses.json").exists() else {}
    src = lambda s: f"{wm[s]['name']} ({s})" if s in wm else s
    items = []
    for e in ev:
        if e["source"] == "cctv" and e["confidence"] < 0.5:
            continue
        txt = f"{e['kind'].lower()} by {src(e['source'])}: {nm(e['actor'])} {e['action'].replace('_', ' ')}" + (f" ({e['value']})" if e.get("value") else "") + \
              (f' — "{e["quote"]}"' if e.get("quote") else "") + f" at T{e['t']['start']:+.1f}s"
        items.append({"id": e["id"], "text": txt, "kind": e["kind"]})
    for c in an["contradictions"]:
        items.append({"id": c["id"], "text": f"contradiction ({c['type']}): {c['summary']} Holds unless {c.get('holds_unless') or 'n/a'}.", "kind": "CONTRADICTION"})
    for h in an["hypotheses"]:
        items.append({"id": h["id"], "text": f"hypothesis '{h['text']}' is {h['status']} (for: {', '.join(x for x in h['for'] if x) or '-'}; against: {', '.join(h['against']) or '-'})", "kind": "HYPOTHESIS"})
    for i, g in enumerate(an["gaps"]):
        items.append({"id": f"G{i + 1}", "text": f"evidence gap T{g['start']:+.1f}s to T{g['end']:+.1f}s: {g['note']}", "kind": "GAP"})
    return items


def _retrieve(q: str, items: list[dict], k: int = 8, name_words: set = frozenset()) -> list[dict]:
    words = set(re.findall(r"[a-z]+", q.lower()))
    expand = set(words)
    for key, syn in SYN.items():
        if words & set(syn) or key in words:
            expand |= set(syn)
    scored = []
    for it in items:
        t = it["text"].lower()
        s = sum(1 for w in expand if len(w) > 2 and w in t)
        s += {"CONTRADICTION": 1.5, "HYPOTHESIS": 1.0, "INFERRED": 3.0, "OBSERVED": 0.5}.get(it["kind"], 0) if s else 0
        if s > 1:
            scored.append((s, it))
    scored.sort(key=lambda x: -x[0])
    # A question about a named person/source only gets items that mention them.
    focus = [w for w in words if w in name_words]
    if focus:
        scored = [(sc, it) for sc, it in scored if any(w in it["text"].lower() for w in focus)]
    return [it for _, it in scored[:k]]


def ask(d: Path, question: str) -> dict:
    if REFUSE.search(question):
        return {"refused": True, "reason": "legal_fault", "method": "guard",
                "answer": [{"text": "This tool does not decide fault, blame or liability. That is for investigators and courts. "
                                    "It can tell you what the evidence shows: speeds, braking, timings, who said what, and where the sources disagree.", "cites": []}],
                "suggestions": ["How fast was the primary vehicle going?", "Did it brake before the impact?", "Which witness statements are contradicted?"]}
    if IDENTITY.search(question):
        return {"refused": True, "reason": "identity", "method": "guard",
                "answer": [{"text": "Ask the case answers about the evidence, not about who someone is. A registered owner may not be the driver. It can describe the vehicles and what they did.", "cites": []}],
                "suggestions": ["What did the primary vehicle do before the impact?"]}
    if INJURY.search(question):
        return {"refused": True, "reason": "injury", "method": "guard",
                "answer": [{"text": "This tool rates the crash, not injuries. Footage and telematics can't establish a medical outcome. It can say whether a person is seen falling or moving afterwards.", "cites": []}],
                "suggestions": ["Did anyone fall?", "How severe was the crash?"]}
    wm = json.loads((d / "witnesses.json").read_text()) if (d / "witnesses.json").exists() else {}
    name_words = {w for m in wm.values() for w in re.findall(r"[a-z]{4,}", m.get("name", "").lower())} - {"duty", "traffic"}
    items = _retrieve(question, _items(d), name_words=name_words)
    if not items:
        return {"refused": False, "method": "retrieval", "answer": [{"text": "No stored evidence matches that question. Nothing is answered from outside the case file.", "cites": []}]}
    allowed = {it["id"] for it in items}
    try:
        msgs = [{"role": "user", "content": "Answer the question using ONLY these evidence items. Every sentence must cite item ids in brackets. "
                 "Say 'consistent with' / 'not supported by', never fault or blame. If the items do not answer it, say so.\n"
                 'Return JSON {"sentences": [{"text": "...", "cites": ["EV-..", "C1"]}]}\n'
                 f"Question: {question}\nItems:\n" + "\n".join(f"[{it['id']}] {it['text']}" for it in items)}]
        r = llm.chat_json(msgs)
        sents = [{"text": guard(s["text"]), "cites": [c for c in s.get("cites", []) if c in allowed]} for s in r["data"].get("sentences", [])]
        sents = [s for s in sents if s["cites"]]  # uncited sentences are dropped
        if sents:
            return {"refused": False, "method": f"featherless:{r['model']}", "answer": sents, "evidence": items}
    except Exception:
        pass
    return {"refused": False, "method": "template (no LLM)", "evidence": items,
            "answer": [{"text": guard(it["text"][0].upper() + it["text"][1:]), "cites": [it["id"]]} for it in items[:5]]}
