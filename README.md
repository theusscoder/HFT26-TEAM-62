# YATHARTH: evidence-driven accident reconstruction

CBIT Hacktoberfest '26 · Team CAPS LOCK · PS #5: AI-Powered Timeline Reconstruction for Road Accident Forensics.

YATHARTH takes the evidence from one road accident (CCTV video, a vehicle's telematics and witness statements) and builds:
- one timeline on a shared clock (T0 = impact)
- the contradictions between sources, each with its evidence
- a calibrated top-down **Track Map** of what moved where and how fast

Every conclusion links to a frame, a quote or a sensor row, and is labelled OBSERVED, CLAIMED or INFERRED. Rules decide; the LLM only extracts and explains.

Plan and team split: [TEAM_PLAN.md](TEAM_PLAN.md) · first-pass plan: [PLAN.md](PLAN.md)

## Hero case (real footage)
`data/cases/hero/` is a real CCTV clip from the ACCIDENT benchmark: a bus veers into a road divider where a traffic constable is on duty.
- **Video:** YOLO11 + ByteTrack tracks every road user. The bus's abrupt stop is detected at 6.74 s, and the human annotation says 6.5 s.
- **Calibration:** a road homography (zebra crossing and divider edge) turns pixels into metres and km/h, ±15%.
- **Telematics:** simulated from the calibrated bus track, on its own device clock. Fusion aligns it on the impact spike.
- **Witnesses:** 3 statements with 5 planted contradictions (`ground_truth.json`).
- **Result:** **5/5 caught, 0 false flags**, plus one witness-vs-witness conflict.

## Run it

Python **3.11 or 3.12** (torch has no wheels for 3.14 yet) and Node 18+.

```bash
cd backend
py -3.12 -m venv .venv                      # mac/linux: python3.12 -m venv .venv
.venv/Scripts/pip install -r requirements.txt -r requirements-cv.txt
.venv/Scripts/python -m uvicorn app.main:app --port 8000
```

```bash
cd frontend
npm install
npm run dev                                  # http://localhost:5173/case/hero
```

Rebuild the hero case after changing any pipeline code (no video re-run needed):

```bash
cd backend && .venv/Scripts/python -m app.make_case hero
```

New case from any clip (downloads: `python scripts/fetch_data.py`):

```bash
cd backend && .venv/Scripts/python -m app.make_case atlanta --video ../data/raw/accident/real_videos/J4QZ5vJy-3E_00.mp4 --title "Atlanta junction" --impact-label 6.0
```
Then open **Road calibration** in the website, click 4 road points, enter their metres, and apply. Everything downstream recomputes.

Optional: `backend/.env` with `FEATHERLESS_API_KEY=...` makes witness extraction use the Featherless LLM. Without it, the hand-annotated seed extraction (same schema) is used, and the UI says which one ran.

## Pipeline

```
evidence/ ──► video.py      YOLO11 + ByteTrack → tracks.json, video_events.json, annotated.mp4
          ──► build_case.py T0 = impact, events on T0, tracks_ui.json, custody ledger
          ──► calibration.py homography → tracks_metric.json (metres, km/h ± σ)
          ──► sensor.py     telematics rules (brake, impact spike, stop)      [sensor_sim.py if no CSV]
          ──► witness.py    Featherless LLM → fixed claim vocabulary, quotes verified in code
          ──► fusion.py     align clocks · map entities · contradiction rules · gaps · reliability · hypotheses
          ──► make_case.py  severity (L0–L3) · ground-truth score · merged events.json
```

| File | Owner | Next steps |
|---|---|---|
| `backend/app/pipeline/video.py`, `calibration.py`, `pages/Calibrate.tsx` | P1 Vision | ID merging, signal light, clock OCR, plates, person-down |
| `backend/app/pipeline/fusion.py`, `sensor.py` | P2 Reasoning | STN conflict sets, sensitivity, entity matching UI, hypotheses |
| `backend/app/llm.py`, `pipeline/witness.py`, `alerts.py` | P3 Language | Live Featherless runs, VLM keyframes (bus vs car), Telegram alert, weather |
| `frontend/src/components/TrackMap.tsx`, `pages/*` | P4 Frontend | Full 3D (react-three-fiber), Response screen, red-team box, polish |

## Data and licences
- ACCIDENT benchmark videos: CC BY-NC-SA 4.0 (non-commercial, attribution). Picek et al., CVPRW 2026. https://github.com/accidentbench/ACCIDENT
- Witness statements, telematics, registry and toll data in this repo are **fictional / simulated** and labelled as such.
- YOLO11 (Ultralytics, AGPL-3.0), ByteTrack (MIT).
