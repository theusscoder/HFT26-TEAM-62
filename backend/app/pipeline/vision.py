"""OWNER: P3. Featherless vision on SELECTED frames only (PS: "vision models to analyze selected video frames").

Keyframes are chosen by rule, not by the model: the first frame (for the burned-in clock), 1.5 s before impact,
the impact frame and 1.5 s after. The primary vehicle is boxed in red. The model must answer a fixed JSON schema;
its answers are cross-checked against the detector and never override measurements:
  - vehicle type    -> display name of the primary (YOLO says "car", the frame shows a bus)
  - signal state    -> evidence for signal claims (state contradictions)
  - overlay clock   -> case clock when no other source exists
  - people on ground-> corroborates (never replaces) the box-aspect posture rule
Without a key the keyframes are still written (the UI shows them) and vision.json says the model did not run."""
import json
from pathlib import Path

import cv2

from .. import llm

QUESTION = """You are shown one frame from a road CCTV / dashcam clip. The vehicle of interest, if any, has a RED box.
Answer ONLY with one JSON object, no prose:
{"boxed_vehicle_type": "car|bus|truck|van|motorcycle|auto-rickshaw|bicycle|none",
 "boxed_vehicle_colour": "<one word or null>",
 "signal_visible": true|false, "signal_state": "red|amber|green|not_visible",
 "people_on_ground": true|false, "fire_or_smoke": true|false, "vehicle_overturned": true|false,
 "weather": "clear|rain|fog|night|unknown", "road_surface": "dry|wet|unknown",
 "overlay_clock": "<HH:MM:SS if a timestamp is burned into the image, else null>",
 "uncertain_about": ["<short items>"]}
Describe only what is visible. Do not guess intentions or fault."""


SEQUENCE_Q = """These {n} frames come from one {cam} clip, in time order: {names}. {ego}
Look at how the road users move between the frames, then answer ONLY with one JSON object:
{{"first_change": {{"who": "<short description, e.g. 'grey SUV ahead', 'the camera vehicle', 'white car from the right'>",
                   "action": "braked_suddenly|cut_in|changed_lane|turned_across|ran_signal|reversed|lost_control|stopped_in_lane|none_visible"}},
 "struck": "<who was hit>", "striking": "<who hit them>", "most_likely_hurt": "<who>",
 "vehicle_left_scene": true|false,
 "sequence": "<two sentences: what happened, in order, only what is visible>",
 "confidence": "high|medium|low"}}
The road user that moved last or hit from behind is not automatically the cause: a vehicle that cuts in or brakes hard in a
running lane changes the situation first. Describe; do not assign legal fault.{facts}"""
FACTS_HEAD = """

Measured from tracking every frame (positions, speeds, lanes). These are more reliable than three still frames; your answer
must not contradict them:
"""


def measured_facts(case_dir: Path) -> list[str]:
    """The case's own measurements, in words, to ground the vision model."""
    import json as _json
    ins = _json.loads((case_dir / "insights.json").read_text()) if (case_dir / "insights.json").exists() else []
    ent = _json.loads((case_dir / "entities.json").read_text()) if (case_dir / "entities.json").exists() else {}
    names = ent.get("names", {})
    out = [f"{names.get(i, i).replace(' (primary)', '')} is one of the road users in the collision" for i in [ent.get("primary"), *ent.get("involved", [])] if i]
    out += [f"{k['title']}: {k['detail']}" for k in sorted(ins, key=lambda k: -k.get("importance", 0))[:6]]
    return out


def sequence(case_dir: Path, frames: list[dict], dashcam: bool) -> dict | None:
    """One look at before / impact / after together: who changed the situation first, who struck whom, who is hurt."""
    use = [f for f in frames if f["name"] in ("before", "impact", "after")]
    if len(use) < 2:
        return None
    q = SEQUENCE_Q.format(n=len(use), cam="dashcam (camera mounted on a moving vehicle)" if dashcam else "fixed CCTV",
                          names=", ".join(f"{f['name']} (T{f['t']:+.1f} s)" for f in use),
                          ego="The camera vehicle itself is not visible; refer to it as 'the camera vehicle'." if dashcam else "The vehicle of interest has a red box.",
                          facts=(FACTS_HEAD + "\n".join(f"- {f}" for f in measured_facts(case_dir))) if measured_facts(case_dir) else "")
    msgs = [{"role": "user", "content": [{"type": "text", "text": q}, *[llm.image_part(case_dir / f["file"]) for f in use]]}]
    try:
        r = llm.chat_json(msgs, model=llm.VISION_MODEL)
        return {**r["data"], "frames": [f["name"] for f in use], "cached": r["cached"]}
    except Exception as e:
        return {"error": str(e)[:120]}


def keyframes(case_dir: Path, case: dict, primary_ui: dict | None) -> list[dict]:
    video = case_dir / "evidence" / "cctv.mp4"
    out_dir = case_dir / "keyframes"
    out_dir.mkdir(exist_ok=True)
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    t0, dur = case["t0_video_s"], case["video"]["duration"]
    picks = [("first", 0.0), ("before", max(0, t0 - 1.5)), ("impact", t0), ("after", min(dur - 0.05, t0 + 1.5))]
    # Read frames in order and time them the way the tracker did; seeking by frame number lands a few frames late on
    # many MP4s, and the red box would then sit on the wrong vehicle.
    grabbed, f = {}, 0
    while len(grabbed) < len(picks):
        ok, img = cap.read()
        if not ok:
            break
        tf = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000 or f / fps
        for name, tv in picks:
            if name not in grabbed and tf >= tv - 0.5 / fps:
                grabbed[name] = img.copy()
        f += 1
    frames = []
    for name, tv in picks:
        img = grabbed.get(name)
        if img is None:
            continue
        if primary_ui and name != "first":
            rel = tv - t0
            q = min(primary_ui["points"], key=lambda q: abs(q["t"] - rel))
            if abs(q["t"] - rel) < 0.3:
                x1, y1, x2, y2 = map(int, q["box"])
                cv2.rectangle(img, (x1, y1), (x2, y2), (0, 0, 255), 3)
        f = out_dir / f"kf_{name}.jpg"
        cv2.imwrite(str(f), img, [cv2.IMWRITE_JPEG_QUALITY, 85])
        frames.append({"name": name, "file": f"keyframes/{f.name}", "video_t": round(tv, 2), "t": round(tv - t0, 2)})
    cap.release()
    return frames


def run(case_dir: Path, case: dict, primary_id: str | None, yolo_class: str | None) -> dict:
    ui = json.loads((case_dir / "tracks_ui.json").read_text())
    prim_ui = next((t for t in ui["tracks"] if t["id"] == primary_id), None)
    frames = keyframes(case_dir, case, prim_ui)
    res = {"model": llm.VISION_MODEL, "frames": frames, "primary_type": None, "signal_state": None, "signal_frame": None,
           "overlay_clock": None, "agree_with_detector": None, "primary_colour": None}
    ran = 0
    for fr in frames:
        msgs = [{"role": "user", "content": [{"type": "text", "text": QUESTION}, llm.image_part(case_dir / fr["file"])]}]
        try:
            r = llm.chat_json(msgs, model=llm.VISION_MODEL)
            fr["answer"], fr["cached"] = r["data"], r["cached"]
            ran += 1
        except Exception as e:
            fr["answer"], fr["error"] = None, str(e)[:120]
    answered = [f for f in frames if f.get("answer")]
    if answered:
        types = [f["answer"].get("boxed_vehicle_type") for f in answered if f["name"] != "first" and f["answer"].get("boxed_vehicle_type") not in (None, "none")]
        if types:
            res["primary_type"] = max(set(types), key=types.count)
            res["agree_with_detector"] = res["primary_type"] == yolo_class
        colours = [str(f["answer"]["boxed_vehicle_colour"]).lower() for f in answered if f["name"] != "first" and f["answer"].get("boxed_vehicle_colour")]
        if colours:
            res["primary_colour"] = max(set(colours), key=colours.count)
        sig = [f for f in answered if f["name"] in ("before", "impact") and f["answer"].get("signal_visible")]
        if sig:
            res["signal_state"], res["signal_frame"] = sig[-1]["answer"].get("signal_state"), sig[-1]["file"]
        first = next((f for f in answered if f["name"] == "first"), None)
        if first and first["answer"].get("overlay_clock"):
            res["overlay_clock"] = first["answer"]["overlay_clock"]
    res["method"] = f"featherless:{llm.VISION_MODEL} on {ran}/{len(frames)} keyframes" if ran else \
        f"not run ({frames[0].get('error', 'no frames') if frames else 'no frames'}); keyframes saved for review"
    (case_dir / "vision.json").write_text(json.dumps(res, indent=2))
    return res
