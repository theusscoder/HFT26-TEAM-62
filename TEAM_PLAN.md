# YATHARTH: final structure and team split

Replaces the earlier 14-page version. **6 screens, not 14.** Pages were only ever a way to organise
features. Judges remember a few screens that work, so related features now sit together on one screen.

---

## 1. Real data (not synthetic-only)

**Hard truth:** no public dataset has a CCTV view **and** a dashcam view **and** sensor data of the **same real crash**.
So we use real footage for each modality, plus one synchronised scenario for the multi-source timeline.

| Use | Dataset | Real? | What we take | Where |
|---|---|---|---|---|
| **CCTV (hero)** | ACCIDENT benchmark, real split (CVPRW 2026) | ✅ 2,027 real traffic-camera clips | 2–3 junction crashes with an impact-time label | [Kaggle](https://www.kaggle.com/datasets/picekl/accident) · [GitHub](https://github.com/accidentbench/ACCIDENT) · annotations CC BY 4.0 |
| **CCTV (backup)** | CADP (CMU) | ✅ 1,416 YouTube CCTV segments, 205 fully annotated | Extra junction clips | [V7 listing](https://www.v7labs.com/open-datasets/cadp) |
| **Dashcam** | Nexar Collision Prediction (2025) | ✅ 1,500 real ~40 s dashcam clips, with event time | Collision clips with clear plates/signals | [Hugging Face](https://huggingface.co/datasets/nexar-ai/nexar_collision_prediction) (open licence, ethical-use terms) |
| **Synchronised multi-view + ground truth** | DeepAccident (AAAI-24) | ❌ CARLA-simulated, but the **roadside camera + car cameras + exact truth** of one crash | One red-light scenario to score contradiction detection | [paper](https://arxiv.org/abs/2304.01168) · deepaccident.github.io |
| **Sensor log** | Derived from the clip's tracks (+ nuScenes CAN bus to validate speed method) | Simulated, allowed by the PS ("simulated sensor records") | Telematics CSV matching the hero clip | — |
| **Witness statements** | Written by us, with 6 planted contradictions | Allowed by the PS ("written witness accounts") | Ground-truth file for scoring | — |

**Demo plan:** the hero case is a **real CCTV crash (ACCIDENT)** + **a real dashcam clip (Nexar)**. The CSV is generated to match the CCTV tracks, plus 3 witness statements. DeepAccident is used only for the scoring slide ("on a case with known truth we caught 6/6").

Download tonight: the ACCIDENT real clips first (small), a handful of Nexar collision clips (stream individual files, not all 31 GB), and DeepAccident mini only if time allows.

---

## 2. Real phone notifications (not simulated)

An officer clicks **Approve** on the dashboard and a **real notification lands on a real phone within about 2 s**. No auto-send.

| Channel | Cost / setup | Use |
|---|---|---|
| **Telegram bot** (primary) | Free, about 5 min (BotFather token + chat id) | Rich alert: text + crash frame image + map link |
| **ntfy.sh** (backup) | Free, no account; install the ntfy app and subscribe to a topic | One `POST https://ntfy.sh/<topic>`; instant push |
| Twilio SMS (optional) | Trial credit; verified numbers only | Real SMS for the "family" phone |

Flow: severity is computed → the dashboard shows **who may be notified** → the officer reviews and clicks Approve → the backend sends → delivery status returns ✓ → custody log entry. Fictional registry; recipients are teammates' phones.

---

## 3. NON-NEGOTIABLES (what the PS asks; all must work)

| ID | PS ask | How we deliver it | Screen |
|---|---|---|---|
| **N1** | Accept video clips, witness accounts, sensor records | Upload all three; SHA-256 + custody log | ① Intake |
| **N2** | Extract events, timestamps, object movements | Video: YOLO+ByteTrack tracks, impact, brake lights, signal, clock OCR. Witness: Featherless LLM → events with verified quotes. Sensor: threshold rules | ① Intake (live stages) |
| **N3** | Chronological incident timeline | One clock (T0 = impact) with per-source offsets; STN gives a time window per event | ③ Timeline |
| **N4** | Contradictions **and** gaps between sources | Rule engine: temporal (STN conflict), state (signal/brake), quantity (speed), presence, witness vs witness. Gaps = moments covered by ≤1 source | ③ Timeline + ④ Contradictions |
| **N5** | Link conclusions to evidence; observation vs inference | Every item carries `ref` (frame / quote / CSV row) and an OBSERVED / CLAIMED / INFERRED badge; inferences list their inputs + rule | everywhere |
| **N6** | Explicit confidence metrics | Per-event confidence, witness reliability, speed ± error, "ordering flips only if clock off > X s" | ③ ④ ② |
| **N7** | Communicate uncertainty, no legal conclusions | "consistent with / not supported by"; refuses fault questions | everywhere |
| **N8** | Featherless: vision on selected frames, LLM for witnesses | Rule-picked keyframes → Featherless VLM JSON; witness extraction via Featherless LLM | backend |
| **B1** | **BONUS:** annotated visual reconstruction of vehicle movements | (a) Annotated video (boxes, IDs, trails, km/h) and (b) bird's-eye trajectory map with confidence corridors, synced | ② Reconstruction |

## 4. ADD-ONS (our differentiators, tagged)

| Tag | Add-on | Screen | Priority |
|---|---|---|---|
| **A1** | Severity classification L0–L3 (explainable score) → decides who may be alerted | ⑤ Response | High |
| **A2** | Plate reading across frames (vote, competing reads) → fictional registry | ⑤ Response | High |
| **A3** | Real phone alert with officer approval (Telegram / ntfy) | ⑤ Response | High |
| **A4** | Emergency map: nearest police station + govt hospital with routes | ⑤ Response | Medium |
| **A5** | "Could it have been avoided?" speed / brake / wet-road slider | ② Reconstruction | High |
| **A6** | Competing hypotheses (supported / contradicted) | ④ Contradictions | Medium |
| **A7** | Weather at crash time (Open-Meteo) → road friction | ② / ④ | Medium |
| **A8** | Hit-and-run: partial plate → toll trail (fictional log) | ⑤ Response | Medium |
| **A9** | Red-team: judge types a fake witness statement → new contradiction appears live | ④ Contradictions | High (demo) |
| **A10** | Scoring vs ground truth ("caught N of 6, M false flags") | ⑥ Report | High (credibility) |
| **A11** | Report export (PDF) with hashes | ⑥ Report | Medium |
| **A12** | Voice witness (Telugu/Hindi) | ① Intake | Low |

---

## 5. The 6 screens

| # | Screen | What it holds | Covers |
|---|---|---|---|
| ① | **Intake** | Drop files → hashes → live pipeline stages | N1 N2 A12 |
| ② | **Reconstruction** | Annotated video + bird's-eye map + speed graph + witness quotes on one clock; "avoidable?" slider | B1 N6 A5 A7 |
| ③ | **Timeline** | Swimlanes per source, time windows, gaps shaded, contradiction links | N3 N4 N6 |
| ④ | **Contradictions** | Each conflict with frame / quote / CSV row side by side, reliability, hypotheses, red-team box | N4 N5 A6 A9 |
| ⑤ | **Response** | Severity → plate → registry → **Approve → real phone alert** → police/hospital map → hit-and-run | A1–A4 A8 |
| ⑥ | **Report** | Evidence-linked findings, custody verification, scoring card, PDF | N5 A10 A11 |

---

## 6. Team split

Order inside each list = build order. **Non-negotiables first.** Nobody starts an add-on until the M2 checkpoint passes.

### P1 · Vision
1. Download ACCIDENT real clips + Nexar collision clips; pick the hero CCTV + dashcam clip — **N1**
2. YOLO + ByteTrack → `tracks.json` — **N2**
3. Homography (4 clicks) → metres → speed ± error — **N2 N6**
4. Impact frame, brake lights, signal colour (HSV), clock OCR → video events — **N2**
5. Annotated output video (boxes, IDs, trails, km/h) — **B1**
6. Rule-picked keyframes handed to P3's VLM — **N8**
7. Plate crops + multi-frame vote — **A2**
8. Person-down / post-impact motion signals for severity — **A1**

### P2 · Reasoning
1. Sensor rules → events (CSV generated from P1's tracks) — **N1 N2**
2. Clock alignment, T0 = impact, offsets ± σ — **N3**
3. Entity matching (witness "red car" ↔ track #3) — **N3**
4. STN timeline windows — **N3**
5. Contradiction engine (5 types) + gaps — **N4**
6. Confidence, reliability, sensitivity — **N6**
7. Inference records with inputs + rule — **N5**
8. Scoring vs ground truth — **A10**
9. Severity score from real signals — **A1**
10. Physics what-if + weather friction — **A5 A7**
11. Hypotheses — **A6**

### P3 · Language + integrations
1. Featherless client (text + vision, JSON mode, cache) — **N8** *(was in progress; resumes here)*
2. Witness statements: write 3 with 6 planted contradictions + `ground_truth.json` — **N1 A10**
3. Witness extraction + quote verification — **N2 N5**
4. Keyframe VLM descriptions, cross-checked against P1's detector — **N8 N2**
5. Wording guard + refusal of fault questions — **N7**
6. **Real alerts:** Telegram bot + ntfy backup, approval endpoint, delivery status — **A3**
7. Registry (fictional) + plate lookup — **A2**
8. Weather (Open-Meteo) — **A7**
9. Police/hospital data (Overpass, cached) + routes (OSRM, cached) — **A4**
10. Toll log + partial-plate search — **A8**
11. PDF report — **A11**

### P4 · Frontend
1. Intake screen: real upload, hashes, live stages — **N1 N2**
2. Reconstruction screen: real `<video>` synced to the shared clock + bird's-eye map + speed graph — **B1 N6**
3. Timeline screen: swimlanes, windows, gaps, contradiction links — **N3 N4**
4. Contradictions screen: side-by-side evidence, badges, refs — **N4 N5**
5. Report screen: findings + custody + scoring card — **N5 A10**
6. Response screen: severity breakdown, plate card, **Approve & send** button with delivery ticks, map — **A1–A4**
7. Avoidable slider inside Reconstruction — **A5**
8. Red-team box, hypotheses panel, hit-and-run panel — **A9 A6 A8**
9. Polish: one visual language, loading/empty states

---

## 7. Milestones

| Milestone | Time | Who delivers what | You can see |
|---|---|---|---|
| **M0 Setup** | 7–9 PM | P1 clips chosen · P3 Featherless works + witness statements written · P2 CSV generator · P4 intake upload works | Real clips + statements in `data/cases/hero/` |
| **M1 Extraction** | 9 PM–1 AM | P1 tracks + speeds + video events · P2 sensor events + alignment · P3 witness events · P4 real video in Reconstruction | Press play: real crash video, real cars on the bird's-eye map, speed graph, witness quotes on time |
| **M2 ✅ Non-negotiables done** | 1–5 AM | P2 STN + contradictions + gaps + confidence · P3 VLM keyframes · P1 annotated video · P4 Timeline + Contradictions + Report | **Every PS requirement + the bonus works on real footage.** Safe to submit |
| **M3 Response add-ons** | 5–9 AM | A1 severity, A2 plates, A3 real alerts, A4 map, A5 slider, A9 red-team, A10 score | Officer clicks Approve → **phone buzzes**. A minor clip shows "no police alert" |
| **M4 Remaining add-ons + polish** | 9 AM–12 PM | A6 A7 A8 A11 (A12 if time) + polish. **Freeze at 12** | Full website |
| **M5 Ship** | 12–3 PM | Precompute, 3-min video, README, rehearse ×3, **submit by 2:30** | ✅ |
