# YATHARTH: Team CAPS LOCK build plan
CBIT Hacktoberfest '26 · PS: AI-Powered Timeline Reconstruction for Road Accident Forensics

> "Every accident leaves fragments. YATHARTH puts them back together: what happened, who is telling
> the truth, whether it could have been avoided, and who must be told right now."

---

## 1. The project in one page

You upload the evidence from one accident: CCTV video, dashcam video, a vehicle sensor CSV and witness statements.
YATHARTH then does the following:

| # | Act (demo order) | What the user sees |
|---|---|---|
| 0 | **Golden Hour** | The crash is detected and **classified by severity**. The involved vehicle's plate is read across frames, the family is alerted, and the nearest police station and government hospital appear on a map. Alerts go out only when the severity justifies them |
| 1 | **Replay Room** | Video, a bird's-eye map, the sensor graph and witness sentences all scrub together on one clock |
| 2 | **Contradiction Courtroom** | "Witness 2 says red; frame 144 shows green." Each source gets a reliability score, and gaps are flagged |
| 3 | **Could it have been avoided?** | A speed slider. A ghost car replays at the new speed and stops before the pedestrian, or doesn't |
| 4 | **Hit-and-run trace** | Partial plate + exit direction + reachable time window → toll logs → a 300 → 1 match → alert |

The trust layer runs through every act: every item is labelled OBSERVED / CLAIMED / INFERRED, every claim
links to its source (frame, quote or sensor row), confidence is shown everywhere, inputs are hashed into a custody log,
and the system never states legal fault.

---

## 2. Accident severity classification (decides who gets alerted)

### Why
A scraped bumper must not alert police and hospitals. False alarms destroy trust in the system. Real systems,
such as smartphone crash detection, combine impact strength with context and give the user a cancel countdown.

### Is there a dataset we can train on?
| Dataset | What it has | Use for severity? |
|---|---|---|
| ACCIDENT (CVPR-W 2026) | 2,027 real + 2,211 synthetic CCTV clips; time, location and **collision type** (rear-end, T-bone, head-on, sideswipe, single) | Gives collision type, not severity. Use it as a **feature** and for sample clips |
| CCD / DAD / Nexar | Dashcam crash clips, accident time | Clips only, no severity labels |
| CrashSight (CVPR-W 2026) | 250 crash videos with Q&A, including outcomes | Good for testing VLM outcome questions; too small to train on |
| Kaggle car-damage-severity (minor/moderate/severe photos) | Damage photos | Optional: a damage-photo classifier (check access first) |
| US-Accidents (Kaggle) | Severity 1–4, but tabular (weather, road), **no video** | Not for vision |

**Conclusion: there's no public video dataset with severity labels big enough to train on in 24 h.**
So we **don't train**. We build an **explainable, rule-based severity score** from signals we already
extract, add the VLM as a second opinion, and **validate it** on about 20 clips we label ourselves (the
accuracy number goes in the README and pitch).

### Signals (all from things we already compute)
| Signal | Source | Example |
|---|---|---|
| Peak deceleration (g) | Sensor CSV accelerometer | 1.2 g minor · 4 g moderate · 8 g+ severe |
| Speed change at impact (Δv) | Kinematic fit of tracks before/after impact (homography metres) | Δv < 10 km/h minor; > 25 km/h injury-likely |
| Vulnerable road user involved | YOLO class: person / motorcycle / bicycle in the impact pair | Escalates one level automatically |
| Person down / not moving | Person box becomes wide (lying), or YOLO-pose; no motion for > 5 s after impact | Strong severe signal |
| Vehicle stopped / rolled / spun | Track heading change > 90°, no motion after impact | Moderate → severe |
| Airbag / crash flag | Sensor CSV column | Severe |
| Fire, smoke, debris, overturned | Featherless VLM on post-impact keyframe (constrained JSON) | Severe |
| Collision type | ACCIDENT baseline / VLM: head-on, T-bone > rear-end | Weight |

### Score → level → action
```
score = Σ weight_i · signal_i   (weights in config, shown in the UI as a breakdown bar)
```
| Level | Meaning | Automatic action |
|---|---|---|
| **L0 Near-miss** | No contact or tiny Δv | Log only (still useful for the danger-zone map) |
| **L1 Minor** | Contact, low g, no VRU, everyone moving | Owner notified + incident report. No police or hospital |
| **L2 Moderate** | Medium g/Δv, or VRU involved but moving | Family + police alert, hospital **on standby** (shown on map) |
| **L3 Severe** | High g, person down, rollover, fire, airbag | Family + police + nearest govt hospital. **30-s cancel countdown**, then auto-send |

Safety rules:
- Plate confidence < 80 % → "Officer confirm" button instead of auto-send.
- Every alert shows **why**: "L3 because peak 7.9 g (sensor row 48) + pedestrian not moving 9 s (frames 160–430)".
- The severity card always shows the signal breakdown, so the judges can see it isn't a black box.

### Validation
Label 20 clips ourselves (ACCIDENT/CCD) as L0–L3 → report a confusion matrix + accuracy, with special
attention to **severe recall** (never miss a severe crash) and **minor false-alarm rate** (never call police for a scratch).

---

## 3. Architecture

```
INGEST   CCTV mp4 · dashcam mp4 · sensor CSV · witness .txt  → SHA-256 + custody ledger
   │
EXTRACT  (all outputs → one Event schema, OBSERVED / CLAIMED / INFERRED, with source ref)
   ├ Video   YOLO11 + ByteTrack → tracks → homography (4 clicked points) → metres → kinematic fit v, a ± σ
   │         impact = bbox overlap + flow spike · keyframes by rule → Featherless VLM (JSON) cross-checked
   │         signal light = HSV rule + VLM · clock = burned-in OCR (Sarvadristhi ocr.py)
   │         plates = plate detector → TrOCR / Awiros OCR → multi-frame vote (keep competing reads)
   ├ Sensor  rules: hard brake > 0.4 g · impact spike · stop < 1 km/h · indicator · airbag
   └ Witness LLM → {actor, action, order relation, hedge words, vantage, exact quote}; quote checked in code
   │
FUSE     T0 = impact · per-source clock offset ± σ · entity matching (user-correctable)
         Simple Temporal Network → feasible time window per event
   │
REASON   (rules decide, LLM only writes; Sarvadristhi reasoner pattern)
   ├ Contradictions: temporal (STN negative cycle) · state · quantity · presence · witness vs witness
   ├ Gaps: per-source coverage; reliability score per witness
   ├ Severity classifier (section 2)
   ├ Counterfactual: stopping distance d = v·t_r + v² / (2·μ·g) → ghost trajectory
   └ Hit-and-run: exit vector + speed range → road graph → toll arrival windows → partial-plate match
   │
ACT      registry dict → Telegram alert · cached Overpass police/hospital → routes · response packet PDF
   │
UI       React: Intake · Replay Room · Timeline · Courtroom · Avoidability · Golden Hour · Pursuit · Report · Ask
```

**Stack:** Python 3.11, FastAPI (single process), JSON files + SQLite, Ultralytics, supervision, OpenCV,
Featherless (OpenAI-compatible SDK) with local Ollama Qwen-VL as fallback, WeasyPrint.
React + Vite + Tailwind + shadcn/ui, react-three-fiber (2.5D replay), react-leaflet (maps), Recharts (sensor), Framer Motion.
No Docker. Run with `uvicorn` + `npm run dev`. The demo case is **pre-computed** so the live demo never waits on a GPU.

### Reused / plugged-in code
| From | What |
|---|---|
| Sarvadristhi | custody ledger, overlay/clock OCR, VLM constrained JSON + cross-check, rules→cited narrative, Ask-the-case, report template, evidence badges |
| ultralytics / roboflow supervision | detection, ByteTrack, ViewTransformer homography, speed estimation, annotators |
| ACCIDENT benchmark repo | clips + optical-flow / bbox impact baselines |
| subash9940/indian-number-plate-recognition + Awiros/anpr-ocr | Indian plate detect + OCR + voting |
| OSM Overpass (cached) + OSRM (cached) | police / hospital locations + routes |

---

## 4. Shared contract (freeze in hour 1)

`data/cases/<id>/` holds `evidence/`, `events.json`, `tracks.json`, `analysis.json`, `severity.json`, `plates.json`, `pursuit.json`, `custody.jsonl`

```json
{ "id": "EV-V-012", "source": "cctv|dashcam|sensor|witness_1",
  "kind": "OBSERVED|CLAIMED|INFERRED",
  "t": {"start": 4.6, "end": 4.9, "sigma": 0.2},          // seconds relative to T0 = impact
  "actor": "car_A", "action": "brake|enter|impact|signal|speed|stop|cross",
  "value": "green | 42 km/h", "xy": [12.3, 5.1], "confidence": 0.86,
  "ref": "cctv.mp4#f=144 | witness_1.txt#c=120-168 | sensor.csv#r=48",
  "derived_from": ["EV-S-003"], "rule": "R4_brake_threshold" }
```

API (FastAPI):
```
POST /api/cases                       create + upload evidence (hash on write)
POST /api/cases/{id}/run              run pipeline; WS /ws/cases/{id} streams stage progress
GET  /api/cases/{id}/events|tracks|analysis|severity|plates|pursuit|facilities
POST /api/cases/{id}/counterfactual   {actor, speed_kmh} → ghost trajectory + stop point
POST /api/cases/{id}/witness          edit a statement → re-run reasoning (live demo trick)
POST /api/cases/{id}/alert            send / cancel (Telegram)
POST /api/cases/{id}/ask              cited Q&A, refuses fault questions
GET  /api/cases/{id}/report.pdf
```
P3/P4 build against **mock JSON from minute one** (`frontend/src/mock/*.json`).

---

## 5. Team split: who builds what

### P1 · Vision engineer
- YOLO11 + ByteTrack → `tracks.json`; homography click tool; kinematic fit (speed ± σ)
- Impact detection, keyframe rules, signal HSV, clock OCR, annotated output MP4
- Plate pipeline → `plates.json` (crops, per-frame reads, vote, confidence)
- Severity vision signals: person-down, post-impact motion, heading change, VLM fire/overturn

### P2 · Reasoning / backend engineer
- FastAPI skeleton, case store, custody ledger, WebSocket progress
- Sensor rules, witness LLM extraction + quote check
- Time alignment + STN + contradictions + gaps + witness reliability
- Severity scorer + levels + alert policy; counterfactual physics; Ask-the-case; PDF report

### P3 · Frontend lead (the website)
- Design system: dark forensic theme, 1 accent colour + red/amber/green status only, Inter/Geist + mono for IDs
- App shell + routing, **Intake page** (drag-drop, live stage pipeline), **Case overview**
- **Replay Room** (video + sensor chart + witness panel + shared clock/scrubber)
- **Swimlane timeline** and **Contradiction Courtroom** (side-by-side frame vs quote)
- Ask panel, Report page

### P4 · Visual acts + data + story
- **Demo data:** clip choice, 3 witness statements with 5–6 planted contradictions, sensor CSV, ground truth, registry dict, toll_logs.csv, road GeoJSON, cached police/hospital JSON
- **Bird's-eye 2.5D scene** (r3f) used inside the Replay Room + **counterfactual slider/ghost car**
- **Golden Hour page**: severity card + plate identity card + emergency map + phone mockup + Telegram bot
- **Pursuit map**: reachability animation + toll funnel
- Evaluation numbers, README, 3-min video, slides, pitch

### Website pages
| Route | Page | Owner |
|---|---|---|
| `/` | Landing + case list | P3 |
| `/new` | Evidence intake + live processing pipeline | P3 |
| `/case/:id` | Overview: severity badge, key stats, act navigation | P3 |
| `/case/:id/replay` | Replay Room (video · 2.5D map · sensor · witnesses, synced) | P3 shell + P4 scene |
| `/case/:id/timeline` | Swimlanes + gaps | P3 |
| `/case/:id/courtroom` | Contradictions + witness reliability + edit-a-witness | P3 |
| `/case/:id/avoidable` | Counterfactual slider | P4 |
| `/case/:id/golden-hour` | Severity breakdown · plate card · alerts · police/hospital map | P4 |
| `/case/:id/pursuit` | Hit-and-run toll trace | P4 |
| `/case/:id/report` | Evidence-linked report + PDF + custody verify | P3 |

---

## 6. Milestones

| Time | Milestone | Done when |
|---|---|---|
| **M0** 7:00–8:30 PM | Foundation | Repo + all 4 commit · schema + API frozen · mock JSON committed · clip chosen · Featherless text + vision tested · design tokens set |
| **M1** 8:30 PM–1 AM | Extractors + shell | P1 `tracks.json` on demo clip · P2 sensor + witness events + API stubs · P3 shell, intake, timeline on mock · P4 all demo data files + registry + toll logs |
| **M2** 1–5 AM | Brains | P1 homography speeds + plates + impact · P2 STN, contradictions, gaps, **severity** · P3 Replay Room + Courtroom · P4 2.5D scene |
| **M3** 5–9 AM | Integration + acts | Real data end to end · counterfactual · Golden Hour (severity → plate → Telegram → map) · pursuit map |
| **M4** 9–11 AM | Polish + proof | Eval numbers (contradictions caught, alignment error, severity confusion matrix, plate accuracy) · PDF · empty/loading states · **feature freeze 11:00** |
| **M5** 11 AM–1 PM | Ship | Pre-computed demo case · deploy (Vercel UI + Render/local API) · 3-min video · README with architecture |
| **M6** 1–2:30 PM | Rehearse ×3, **submit by 2:30** | ✅ |

Cut order if behind: pursuit map → 2.5D (fall back to 2D canvas) → Ask panel. **Never cut:** timeline, courtroom, severity + Golden Hour.

---

## 7. Demo script (3 min)
1. 0:00 "1.68 lakh people died on Indian roads in 2022. For most families the truth comes years later."
2. 0:15 Drop 4 evidence files → pipeline stages light up, hashes logged.
3. 0:35 **Golden Hour**: L3 Severe (7.9 g + pedestrian down 9 s) → plate 5/6 frames → countdown → phone buzzes on stage → police + hospital routes on the map. Then show a second, minor clip: **L1, police NOT alerted.**
4. 1:05 **Replay Room** scrub → **Courtroom**: Witness 2 "red" vs frame 144 green. A judge edits a witness live → new contradiction appears.
5. 1:50 **Avoidable?** slider 62 → 40 km/h: ghost car stops 3.1 m short. "At 40, she walks home."
6. 2:20 **Car B fled** → partial plate → toll funnel 300 → 1 → caught.
7. 2:45 Export hashed report. "YATHARTH doesn't decide guilt. It makes sure the evidence is heard."

---

## 8. Decide in the first 30 minutes
- [ ] Map the 4 people to P1–P4
- [ ] Demo clip (pedestrian or bike, signal visible) + a second **minor** clip + a clear plate close-up
- [ ] Featherless vision model available? Otherwise Ollama Qwen-VL locally
- [ ] Telegram bot token + which teammate's phone buzzes
- [ ] Demo junction location (real Hyderabad junction for the map)
