"""The live feed: every incident on one map of Hyderabad, the dispatch agent's moves, hospitals receiving, and a city-wide
knowledge graph.

Real: each incident's footage and its analysis (severity, findings, contradictions), the road network, hospitals and police
stations. PLACED FOR THE DEMO: four of the five clips were filmed elsewhere, so they're put on Hyderabad roads (the Gachibowli
case is the only one located here). MOCK: the identity chain (victim's registration, licence and face match) comes from a
mock database, data/fictional/live_identities.json; no real person is identified."""
import json
from pathlib import Path

from . import city_ops, intercept

ROOT = Path(__file__).resolve().parents[2]
CASES = ROOT / "data" / "cases"
IDS = ROOT / "data" / "fictional" / "live_identities.json"
# case id: lat, lon, seconds into the feed, place name, really there?
PLACES = {"demo": (17.4401, 78.3489, 30, "Gachibowli X-roads", True), "hero": (17.4455, 78.3489, 150, "IIIT junction, Gachibowli", False),
          "india-junction": (17.4486, 78.3622, 300, "HITEC City junction", False), "dashcam": (17.4305, 78.3432, 470, "ORR service road, Nanakramguda", False),
          "rear-end": (17.4382, 78.3652, 640, "Kondapur residential lane", False)}


def _j(p: Path, default=None):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


def run() -> dict:
    ids = _j(IDS, {})
    fixed, cards = [], {}
    for cid, (lat, lon, t, place, real) in PLACES.items():
        d = CASES / cid
        case = _j(d / "case.json")
        if not case:
            continue
        sev, an, vis = _j(d / "severity.json", {}), _j(d / "analysis.json", {}), _j(d / "vision.json", {})
        ins = _j(d / "insights.json", []) or []
        frame = next((f for f in vis.get("frames", []) if f["name"] == "impact"), None)
        top = sorted(ins, key=lambda k: -k.get("importance", 0))[:3]
        what = [k["title"] + ": " + k["detail"] for k in top] or [c["summary"] for c in an.get("contradictions", [])[:2]]
        vj = next((f.get("answer") for f in vis.get("frames", []) if f["name"] == "impact" and f.get("answer")), None)
        fixed.append({"id": cid, "t": t, "lat": lat, "lon": lon, "level": sev.get("level", "L2"), "title": case.get("title", cid), "real": True, "case": cid})
        cards[cid] = {"case": cid, "title": case.get("title", cid), "place": place, "really_here": real, "level": sev.get("level"), "label": sev.get("label"), "score": sev.get("score"),
                      "camera": (case.get("camera") or {}).get("type", "cctv"), "thumb": frame["file"] if frame else None,
                      "video": "annotated.mp4" if (d / "evidence" / "annotated.mp4").exists() else ("cctv.mp4" if (d / "evidence" / "cctv.mp4").exists() else None),
                      "what": what, "contradictions": len(an.get("contradictions", [])),
                      "vlm": ({"people_on_ground": vj.get("people_on_ground"), "vehicle": vj.get("boxed_vehicle_type"), "weather": vj.get("weather")} if vj else None),
                      "identity": ids.get(cid)}
    ops = city_ops.run(7, fixed=fixed, sims=0)
    for s in ops["served"]:
        card = cards.get(s["incident"])
        if card is not None:
            u = next(u for u in ops["units"] if u["id"] == s["unit"])
            card.setdefault("responders", []).append({"unit": u["id"], "kind": u["kind"], "base": u["base"], "eta_s": s["eta_s"], "arrive": s["arrive"]})
    graph = city_graph(cards, ops)
    return {**ops, "cards": cards, "graph": graph, "placed_note": "Only the Gachibowli case happened here; the other clips are placed on Hyderabad roads for the demo.",
            "mock_note": "Identity chain from a MOCK database. No real person is identified."}


def city_graph(cards: dict, ops: dict) -> dict:
    nodes, edges = {}, []

    def node(i, label, kind, t=0.0):
        nodes.setdefault(i, {"id": i, "label": label, "type": kind, "t": t})

    def edge(a, b, label, t=0.0):
        edges.append({"source": a, "target": b, "label": label, "t": t})

    node("Vision", "Vision agent (Qwen-VL)", "agent")
    node("Dispatch", "Dispatch agent", "agent")
    node("Records", "Records agent (mock DB)", "agent")
    t_of = {i["id"]: i["t"] for i in ops["incidents"]}
    for cid, c in cards.items():
        t = t_of.get(cid, 0)
        node(cid, f"{c['level'] or ''} · {c['title'][:22]}", "case", t)
        edge("Vision", cid, "judged victim", t)
        idn = c.get("identity") or {}
        if idn.get("plate"):
            node(f"plate:{cid}", f"Plate {idn['plate']}", "record", t)
            edge(cid, f"plate:{cid}", "victim's plate", t)
            edge("Records", f"plate:{cid}", "registration", t)
        if idn.get("licence"):
            node(f"dl:{cid}", f"Licence {idn['licence']['holder']}", "outcome", t)
            edge("Records", f"dl:{cid}", "face → licence (mock)", t)
        for r in c.get("responders", []):
            node(r["unit"], f"{r['unit']} · {r['base'][:18]}", "unit", t)
            edge("Dispatch", r["unit"], "sent", t)
            edge(r["unit"], cid, f"{r['eta_s'] // 60} min by road", t)
            if r["kind"] == "ambulance":
                node(f"h:{r['base']}", r["base"][:26], "spot", t)
                edge(r["unit"], f"h:{r['base']}", "taking patient to", r["arrive"])
    return {"nodes": list(nodes.values()), "edges": edges}
