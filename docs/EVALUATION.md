# YATHARTH: self-evaluation against PS #5

For the team preparing to present. Everything below was checked by running it: a browser crawl of every page in English and Telugu, API calls to each feature, a live camera scan through to real Telegram delivery, and automated tests (`backend/tests/test_ps_requirements.py` checks each requirement on the shipped cases).

## What the problem statement asks

| ID | Ask | Status | Where to show it | Evidence |
|---|---|---|---|---|
| N1 | Accept video, witness accounts, sensor records | Done | New case, or demo kits | Files are hashed into a tamper-evident custody chain; the chain verifies on every shipped case |
| N2 | Extract events, timestamps, movements | Done | Evidence replay | YOLO11 + ByteTrack, sensor rules, witness extraction by LLM with verified quotes |
| N3 | Chronological timeline | Done | Timeline | One clock with T0 at impact; per-source offsets; events in order on every case |
| N4 | Contradictions and gaps | Done | Contradictions | Each contradiction cites at least two real events |
| N5 | Link conclusions to evidence; observation vs inference | Done | Everywhere | Every event is OBSERVED, CLAIMED or INFERRED with a reference or a rule |
| N6 | Explicit confidence | Done | Timeline, Contradictions | Per-event confidence, witness reliability, speed ± error |
| N7 | Communicate uncertainty, no legal conclusions | Done | Ask the case: try "Who is at fault?" | Fault questions are refused; generated findings are scanned for legal terms in the tests |
| N8 | Vision models on selected frames, LLM for witnesses | Done | Overview, Emergency response | Qwen3-VL on rule-picked keyframes; DeepSeek-V3 for witnesses; answers are cached, so they replay offline |
| B1 | Bonus: annotated visual reconstruction | Done | Reconstruction | Annotated video, 3D twin on the real road surface, overlap with the footage shown as a percentage |

Detection against planted errors: hero 5 of 5, dashcam 2 of 2, rear-end 1 of 1, no false flags. These statements were written to test the system, so this shows it working on these cases, not general accuracy.

## Add-ons

| ID | Add-on | Status |
|---|---|---|
| A1 | Explainable severity L0–L3 | Done |
| A2 | Plate reading across frames | Done, but OCR isn't installed in the current environment: run `read_plates.bat` first. Without it, new cases read no plates and show the plate on record |
| A3 | Real phone alerts | Done on Telegram to subscribed chats. Automatic on camera cases, officer-approved on Plates & dossiers. SMS needs a Twilio or Fast2SMS key |
| A4 | Nearest police and hospital with road ETAs | Done |
| A5 | "Could it be avoided?" | Done |
| A6 | Competing hypotheses | Done |
| A7 | Weather and road friction | Done, Open-Meteo |
| A8 | Hit-and-run trace | Done, on a fictional toll log |
| A9 | Red team: type a false statement, see it caught | Done |
| A10 | Score against planted errors | Done |
| A11 | Report export | Done |
| A12 | Telugu and Hindi voice statements | Done, needs the local model and ffmpeg |

Beyond the plan: 3D Hyderabad home map, camera agent, police board, hospital desk, response timeline, intercept simulation, Telugu dashboard and family alerts, and automatic location logging.

**Location logging:** no screen asks for a location. `backend/app/geotag.py` takes it from a linked case, then the camera's registered position, then GPS in the video's metadata, then GPS in the telematics log. With none of those it estimates a spot on the road network and labels it "Estimated". The source shows in the case header, reports and police alerts, and the first logging goes in the custody ledger.

## What is real and what isn't

Be ready for "is this real?". The honest answer is strong, and getting caught out isn't.

**Real, measured from the data**
- Footage from the ACCIDENT benchmark and public clips, and everything derived from it: tracks, speeds, contradictions, severity, 3D fit.
- Vision and language model answers.
- The Hyderabad map: OpenStreetMap roads, 257,242 buildings, hospitals, police stations, drive times.
- Weather, the custody chain, Telegram delivery.

**Simulated**
- Camera positions in `data/cameras.json`. They are assigned, so "auto-logged from camera CAM-HYD-0417" shows the mechanism, not a surveyed installation. GPS extraction from video metadata and telematics is real but none of the shipped clips carry real GPS.
- Camera feeds. The six feeds are recorded crash clips looping at made-up Hyderabad locations; none was filmed there. Some show their original overlays, including an Atlanta traffic camera label and a video watermark. A real camera's RTSP or HTTP address can go in `data/cameras.json`, but no live stream has been tested.
- All people and records: names, licences, registrations, insurance, phone numbers, driver photos (AI-generated faces). No real person is identified.
- Face-match percentages in records. These are generated, not computed. The Face check panel does run a real comparison, on photos supplied with consent.
- Plates marked "matched in the vehicle registry" or "resolved from the partial read". Most CCTV plates here can't be read. The label on each plate says which it is.
- FIR numbers and sections, certificates, hospital acceptance, ambulance progress and treatment reports, when filed by the system. Actions taken by staff on screen are recorded as such.
- Dispatch, officer assignment, pursuits and signal control. The police and hospital boards replay five incidents on a loop; "New from the cameras" shows actual agent cases.
- The step-by-step analysis on case pages is a timed replay of stored results, not processing speed. The camera wall's stages for a new case are live.
- Detection in the camera agent is a rough trigger. In dense traffic it can open cases for near-misses, which the analysis then rates low.

## Known limits

- **Telegram bot conflict:** another computer is polling `@cbit_alerts_notif_bot`. Alerts still reach subscribed chats, but button taps in the bot can go to that computer, and phones can't link until it stops. See the warning on `/telegram`.
- **Estimated locations:** a clip with no registered camera and no GPS gets a placeholder spot on the road network, labelled "Estimated". Don't send anyone to it without checking.
- **Internet:** the 2D maps need online map tiles, and new translations and new vision answers need the model. The 3D home, cached model answers and built translations work offline. Telegram needs internet.
- **Telugu:** translations are machine-generated apart from `data/i18n/te_reviewed.json`, so have a Telugu speaker read the main screens. Exported reports and certificates stay in English.
- **Speed accuracy** is about ±15–30%, depending on calibration.
- **The synthetic Gachibowli case** has no footage; it demonstrates multi-source fusion and the intercept.

## Before a demo

1. Start with `run_demo.bat`, or check the API on :8000 and the web on :5173.
2. Open `/telegram` and press "Send a test to every chat".
3. Rehearse: city map, click a hit-and-run beacon, Open case, Contradictions, Ask "Who is at fault?", Response timeline, then Police and Hospital. On `/cameras`, "Scan now" opens a new case in about two minutes and sends real alerts.

Tag `demo-stable-1` marks an earlier working version: `git checkout demo-stable-1`.
