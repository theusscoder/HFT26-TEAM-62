"""Detailed Accident Report draft and hit-and-run evidence packet, filled by code from the case artifacts, each line
with its evidence link. Drafts for an officer to verify. PDF comes from the browser's print dialog."""
import html

BANNER = "DRAFT FOR OFFICER VERIFICATION. Not a filing. Automated analysis; no finding of legal fault."
FICTIONAL = "Registry and toll entries in this document are FICTIONAL demo data."
NOT_DETERMINED = "Not determined from the evidence."


def _render(title: str, sections: dict[str, str], fictional: bool) -> str:
    banners = f"<p><strong>{html.escape(BANNER)}</strong></p>" + (f"<p><strong>{html.escape(FICTIONAL)}</strong></p>" if fictional else "")
    body = "".join(f"<h2>{html.escape(k)}</h2><pre>{html.escape(v)}</pre>" for k, v in sections.items())
    return ("<!doctype html><html lang='en'><head><meta charset='utf-8'><title>" + html.escape(title) + "</title><style>"
            "body{font-family:Georgia,serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}"
            "h2{font-size:1.05rem;border-bottom:1px solid #999;margin-top:1.6rem}pre{white-space:pre-wrap;font:inherit;margin:.5rem 0}"
            "@media print{body{margin:0}}</style></head><body><h1>" + html.escape(title) + "</h1>" + banners + body + "</body></html>")


def _hashes(custody: list[dict]) -> list[tuple]:
    seen = {(d["details"].get("stored") or d["details"].get("file"), d["details"].get("sha256")) for d in custody if d.get("action") in ("evidence_registered", "evidence_received", "evidence_changed")}
    return sorted(seen, key=str)


def _event_line(e: dict, names: dict | None = None) -> str:
    actor = (names or {}).get(e["actor"], e["actor"])
    what = f'"{e["quote"]}"' if e.get("quote") else f"{actor} {e['action'].replace('_', ' ')} {e.get('value') or ''}".strip()
    ref = e.get("ref") or ("from " + ", ".join(e.get("derived_from", [])[:3]) if e.get("derived_from") else "")
    return f"- T{e['t']['start']:+.2f} s  [{e['kind']}]  {what}  ({ref}; confidence {round(e['confidence'] * 100)}%)"


def _clock_at_impact(events: list[dict]) -> str:
    found = next((e for e in events if e["action"] == "time_of_day" and e["kind"] == "INFERRED"), None)
    return found["value"] if found else NOT_DETERMINED


def dar(case: dict, events: list[dict], analysis: dict, severity: dict | None, custody: list[dict]) -> dict:
    disputed = {i for c in analysis.get("contradictions", []) for i in c["events"]}
    key = [e for e in events if e["source"] in ("sensor", "fusion") and e["id"] not in disputed]
    said = [e for e in events if e["kind"] == "CLAIMED"]
    hashes = _hashes(custody)
    names = (analysis.get("entities") or {}).get("names", {})
    loc = case.get("location", {})
    score = analysis.get("score")
    sections = {
        "1. Case": f"{case['id']}: {case['title']}\nData: {case.get('license') or ('simulated' if case.get('simulated') else 'as supplied')}",
        "2. Time and place": f"Location: {loc.get('name') or NOT_DETERMINED}\n"
                             f"Coordinates: {f'''{loc['lat']}, {loc['lon']}''' if loc.get('lat') is not None else NOT_DETERMINED}\n"
                             f"Clock at impact: {_clock_at_impact(events)}\n"
                             f"Weather: {(case.get('weather') or {}).get('road_state', NOT_DETERMINED)}",
        "3. Evidence and custody": "\n".join(f"- {f}: SHA-256 {h}" for f, h in hashes) or NOT_DETERMINED,
        "4. Established sequence (undisputed)": "\n".join(_event_line(e, names) for e in key) or NOT_DETERMINED,
        "5. Witness statements": "\n".join(_event_line(e, names) for e in said) or "None.",
        "6. Contradictions between sources": "\n".join(f"- [{c['type']}, {c['severity']}] {c['summary']}" for c in analysis.get("contradictions", [])) or "None found.",
        "7. Evidence gaps": "\n".join(f"- T{g['start']:+.2f} to T{g['end']:+.2f} s: {g['note']}" for g in analysis.get("gaps", [])) or "None found.",
        "8. Crash severity": f"{severity['level']} {severity['label']} ({severity['score']}/100). Rates the crash, not injuries.\n"
                             + "\n".join(f"- +{b['points']}: {b['why']} ({b.get('ref') or 'no reference'})" for b in severity["breakdown"]) if severity else NOT_DETERMINED,
    }
    if score:
        sections["9. Test score"] = f"{score['caught']} of {score['planted']} planted contradictions caught, {score['false_flags']} false flags. The statements were written to test the system."
    sections["Officer verification"] = "Verified by: ____________    Date: ____________\nThis draft assigns no fault."
    fictional = any(c["type"] == "registry" for c in analysis.get("contradictions", []))
    return {"kind": "dar", "status": "draft_for_officer_verification", "sections": sections, "fictional": fictional,
            "html": _render(f"Detailed Accident Report (draft): {case['id']}", sections, fictional)}


def packet(case: dict, plates: dict | None, pursuit: dict | None, events: list[dict], custody: list[dict]) -> dict:
    lines = []
    for v in (plates or {}).get("vehicles", []):
        lines.append(f"- {v.get('track')}: {v['plate']} at {round(v['confidence'] * 100)}%; reads {', '.join(v['reads'])}; unverified candidate")
    trail = []
    if pursuit and pursuit.get("summary"):
        trail.append(pursuit["summary"])
    if pursuit and pursuit.get("funnel"):
        trail.append(f"FICTIONAL toll data. Partial plate {pursuit.get('partial_plate') or 'not read'}; heading {pursuit['exit']['heading']}.")
        trail += [f"- {f['stage']}: {f['count']}" for f in pursuit["funnel"]]
        m = pursuit.get("match")
        trail.append(f"Candidate: {m['plate']} at {m['toll']}, {m['time']}. Needs authorised verification." if m else "No single candidate remains.")
    hashes = _hashes(custody)
    timeline = [e for e in events if e["source"] in ("sensor", "fusion")][:15]
    sections = {
        "1. Purpose": "A request for authorised follow-up by the police. It does not identify any person.",
        "2. Case": f"{case['id']}: {case['title']}",
        "3. Candidate plates (unverified)": "\n".join(lines) or "No plate was read.",
        "4. Toll trail": "\n".join(trail) or "No toll data.",
        "5. Timeline": "\n".join(_event_line(e) for e in timeline) or NOT_DETERMINED,
        "6. Evidence hashes": "\n".join(f"- {f}: {h}" for f, h in hashes) or NOT_DETERMINED,
    }
    fictional = bool(pursuit and pursuit.get("funnel"))
    return {"kind": "packet", "status": "draft_for_officer_verification", "sections": sections, "fictional": fictional,
            "html": _render(f"Evidence packet (draft): {case['id']}", sections, fictional)}
