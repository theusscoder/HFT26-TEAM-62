# YATHARTH: evidence-driven accident reconstruction

> CBIT Hacktoberfest '26 · Team **CAPS LOCK** (`HFT26-TEAM-62`) · fork of [cbitosc/HFT26-TEAM-62](https://github.com/cbitosc/HFT26-TEAM-62)

## 📋 Team Information

| Attribute | Details |
| :--- | :--- |
| **Team Name** | **CAPS LOCK** |
| **Team Number** | `TEAM-62` (`HFT26-TEAM-62`) |
| **Registration ID** | `HFEST26-SARZMANC` |
| **Problem Track** | **PS #5 · AI-Powered Timeline Reconstruction for Road Accident Forensics** |
| **Domain** | `Computer Vision & Intelligent Systems` |
| **Team Leader** | Shridhar Udayagiri (theusscode@gmail.com) |
| **Institution** | Keshav Memorial Institute of Technology |

### 👥 Team Members

| # | Name | Email | Institution |
| :--- | :--- | :--- | :--- |
| 1 | Priyansu Mohanty | priyanshu.mohantyy@gmail.com | Keshav Memorial Institute of Technology |
| 2 | Chinmayee Wuriti | wuritichinmayee@gmail.com | Keshav Memorial Institute of Technology |
| 3 | Aditya Tipirneni | saiadityatipirneni@gmail.com | Keshav Memorial Institute of Technology |

---

CBIT Hacktoberfest '26 · Team CAPS LOCK · PS #5: AI-Powered Timeline Reconstruction for Road Accident Forensics.

YATHARTH takes the evidence from one road accident (CCTV video, a vehicle's telematics and witness statements) and builds:
- one timeline on a shared clock (T0 = impact)
- the contradictions between sources, each with its evidence
- a calibrated top-down **Track Map** of what moved where and how fast

Every conclusion links to a frame, a quote or a sensor row, and is labelled OBSERVED, CLAIMED or INFERRED. Rules decide; the LLM only extracts and explains.

Plan and team split: [TEAM_PLAN.md](TEAM_PLAN.md) · first-pass plan: [PLAN.md](PLAN.md) · requirement-by-requirement status, what is real and what is simulated: [docs/EVALUATION.md](docs/EVALUATION.md)

## The whole app
| Page | What it does |
|---|---|
| `/` | 3D Hyderabad with a beacon per case; click one for its side panel and export |
| `/cameras` | The camera agent watches each feed and opens a case when it detects a crash. **Scan now** runs one feed on demand |
| `/police`, `/hospital` | Officer assignment and tracking; incoming cases, with the FIR and report arriving before the patient |
| `/operations` | One incident at a time, from detection to response |
| `/telegram` | Connect the bot, see who is subscribed, send a test |
| `/case/<id>` | Everything in "What each screen is for" below, plus the response timeline |

**Location:** logged automatically, never asked for: linked case → registered camera (`data/cameras.json`, by camera id or feed file) → GPS in the video metadata → GPS in the telematics log → an estimate on the road network, labelled "Estimated". See `backend/app/geotag.py`.

**Telugu:** the EN / తెలుగు switch translates every dashboard. Translations are stored in `data/i18n/te.json`, and hand-checked ones in `te_reviewed.json` take priority. Numbers, plates and IDs are never translated. Text not yet stored is translated on first view when `FEATHERLESS_API_KEY` is set.

**Telegram:** in the bot, `/police`, `/hospital`, `/family` or `/all` subscribes a chat. `ALERT_PHONES` in `backend/.env` adds phones that have shared their number with the bot. See `backend/.env.example`. Only one computer can poll a bot at a time, so set `TELEGRAM_LINKER=off` on the others.

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

## Analyse any video (website)
Open **New case** and drop a road CCTV or dashcam clip (.mp4 / .mov / .avi / .mkv), and optionally add witness statements (`.txt`), a telematics log (`.csv`) and kit metadata. The pipeline runs in the background with live stage progress, and the case opens when it's done. Without measured road points, the road is **auto-calibrated from object sizes** (±30%), and you can refine it on *Road calibration*.

### Demo kits (`demo_kits/`)
Drop all of a folder's files onto New case at once:

| Kit | Clip | What it shows |
|---|---|---|
| `01-india-bus-divider` | Bus veers into a divider beside a traffic constable | 3 witnesses, telematics, 5 planted contradictions (speed, braking, phantom cut-in, "policeman fell", wrong time) |
| `02-atlanta-tbone` | Black SUV T-bones a red car at a signalised junction | Auto-calibration on an unseen clip; 2 planted contradictions plus a witness-vs-witness conflict |
| `03-minor-rear-end` | Low-speed bump on a residential street | Severity gating: **L1**, owner only, no police or hospital |

Results with the offline extractor (no API key): **5/5, 2/2 and 1/1 planted contradictions caught, 0 false flags**.

### What each screen is for
| Screen | Answers |
|---|---|
| Overview | What happened, how severe, **how much to trust each layer** (calibration, extraction method, vision, sensor clock, gaps) |
| Evidence replay | The annotated footage, with what every source says at this instant |
| **Reconstruction** | *Top view*: a calibrated plan with speed-coloured paths and 1 s ticks. *Bird's-eye 3D*: true-scale vehicles, a **speed curtain** (wall height = speed), the impact beacon, **witness line of sight** (green = could see, red = blocked) and camera presets (follow the vehicle, stand where a witness stood) |
| Timeline | *Story*: three phases (approach, critical seconds, aftermath), every witness claim marked consistent / contradicted / unverifiable. *Swimlanes*: one lane per source |
| Contradictions | Claimed vs measured side by side, the CCTV key frame, **robustness** ("holds unless …"), possible explanation (labelled as a suggestion), witness reliability, competing explanations |
| Ask the case | Answers only from stored evidence, every sentence cited; fault and blame questions are refused |

### Demo on Windows in 4 steps
1. `setup_demo.bat`: venv, pip and npm install, then the pre-demo check (once).
2. Telegram → **@BotFather** → `/newbot` → copy the token.
3. `link_telegram.bat`: paste the token, open the bot on the demo phone (enter your number when asked), press **START**, tap **Share my number**. A test alert arrives.
4. `run_demo.bat`: check, start API and website, open **Evidence replay**, press Play. `reset_demo.bat` does the same after clearing earlier alerts, tracking and TS-DB links (use it before every rehearsal).

**Suspect alert + continuous tracking:** the demo phone stands in for the suspect vehicle's registered number. On **Approve & send** it gets a formal notice, the suspect is linked in the TS police DB, and **Live tracking** starts. The FASTag feed is replayed at 10× (1×/10×/60× on the page); after the recorded log, a simulated feed continues along a plausible route until **Stop tracking**. Each sighting alerts police (position, speed, next likely plazas; implausible ones as possible cloned plate) and texts the suspect number. State is in `data/cases/<id>/tracking.json` and resumes after a restart.

Bots can't message a phone number directly; the phone opens the bot once, then every alert (hospital, police, victim, suspect, Golden hour) goes to that chat. Each one names the mock number it is addressed to. `scripts/preflight.py --send-test` checks everything and sends a test.

### Response & alerts (A2 plates + A3 alerts)
Shown on **Evidence replay**: while the footage plays, the plates of the victim and the vehicle of interest lock at their clearest frame ("Number detected"), each opens a profile card from the TS police DB, and once the plate of the vehicle of interest is read a 5 s countdown sends the alerts. Its card lists the notice to the registered number and the police stations notified, plus live tracking; the victim card lists the victim/family notices and the hospitals notified / in action. (Full dossiers: `/case/<id>/dossiers`, mock DB: `/ts-police-db`.)
- **Every vehicle gets a plate.** OCR runs when `fast-plate-ocr` or `easyocr` is installed (optional `PLATE_MODEL` = YOLO plate-detector weights), with a multi-frame vote. CCTV rarely resolves plates, so an unreadable plate is **demo-assigned** from the mock DB, labelled as such, with confidence 0. Involved vehicles are highlighted.
- **Roles by rule, officer can override:** striking vehicle (fusion primary) or vehicle that fled (hit-and-run partial plate) = *suspect*; other involved road users = *victims*. A suspect is a lead, not a finding.
- **Dossiers from the mock TS police DB:** owner, registered phone, address, DL, insurance, PUC, FASTag, challans, accident records, other vehicles of the same owner. Partial plates (`TS07G?5521`) are resolved against the DB.
- **Suspect's FASTag analysis:** 30-day pattern (top plazas, time of day, last seen) plus the post-incident trail. Each passage is checked for reachability from the incident site, so an impossible one is flagged as a possible cloned plate. A funnel shows the toll feed narrowing to the vehicle.
- **Alerts, officer approval required:** nearest trauma hospitals (at least one govt) get the medical picture only. The jurisdiction police station gets the suspect dossier. The victim's and suspect's registered numbers get notices. On approval, the suspect's plate and number are **linked in the TS police DB** (`data/ts_police_db/case_links.json`). Every send goes into the custody ledger.
- Delivery: `TELEGRAM_BOT_TOKEN` + `DEMO_CHAT_ID_HOSPITAL / _POLICE / _VICTIM / _SUSPECT` (falls back to `DEMO_CHAT_ID_1`), or `NTFY_TOPIC`. With neither, alerts are built and logged as *simulated*.
- The mock DB is generated by `python scripts/make_ts_police_db.py` (fixed seed). Owners and numbers are fictional (`+91 5xxxx` is not a real mobile range); facility names are real places with approximate coordinates and fictional phone numbers. Toll times are re-based to each case's incident time.
- Code: `backend/app/{ts_police_db,response,response_api,notify}.py`, `backend/app/pipeline/plate_reader.py`, `frontend/src/pages/{Response,TSPoliceDB}.tsx`. Existing screens are untouched apart from two nav entries; Golden hour now also finds plates in the TS DB.

### Featherless (sponsor) usage
`backend/.env` → `FEATHERLESS_API_KEY=...` (plus optional `FEATHERLESS_TEXT_MODEL`, `FEATHERLESS_VISION_MODEL`). With a key:
- witness statements go to the LLM (fixed claim vocabulary, quotes verified in code);
- rule-picked key frames (first, T−1.5 s, impact, T+1.5 s) go to the vision model (vehicle type, signal colour, people on the ground, burned-in clock), which is cross-checked against the detector;
- Ask writes cited answers, and uncited sentences are dropped.

Every answer is cached in `data/llm_cache/`, so demos are deterministic. Without a key, an offline rule-based extractor and template answers keep everything working, and the UI says which method ran.

## Pipeline

```
evidence/ ──► video.py      YOLO11 + ByteTrack → tracks.json, video_events.json, annotated.mp4
          ──► build_case.py T0 = impact, events on T0, tracks_ui.json, custody ledger
          ──► calibration.py homography from 4 road points, or auto from object sizes → tracks_metric.json (m, km/h ± σ)
          ──► vision.py     rule-picked key frames → Featherless vision model (type, signal, clock), cross-checked
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
