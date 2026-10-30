# Demo kits

Each folder is a complete evidence set built on **real CCTV footage** (ACCIDENT benchmark, CC BY-NC-SA 4.0):
- `video.mp4`: the real clip;
- `witness_*.txt`: written statements with deliberately planted errors;
- `sensor.csv`: simulated telematics of the primary vehicle on its own device clock;
- `witnesses.json`: who each witness is and where they stood;
- `ground_truth.json`: the planted contradictions, used for the accuracy score;
- `kit.json`: title and summary for the home page.

Witness statements and telematics are **simulated** (the PS allows "written witness accounts" and "simulated sensor records"). The videos are real.

## Three ways to run a kit
1. **Website, one click:** Home → *Demo kits* → **Run this kit**.
2. **Website, as a real upload:** Home → drop all the files of a kit folder onto *Analyse a video* → **Analyse**.
3. **Script:** start the API, then:
   ```bash
   backend/.venv/Scripts/python scripts/upload.py demo_kits/02-atlanta-tbone
   ```
   Use `demo_kits/*` to run all three. Any other clip works the same way: `scripts/upload.py my_clip.mp4 --witness a.txt --sensor log.csv`.

Each run takes about 1 minute on a laptop CPU (the video stage). Expected results with **no API key** (offline extractor):

| Kit | Caught | False flags | Severity |
|---|---|---|---|
| 01-india-bus-divider | 5 / 5 | 0 | L1 Minor |
| 02-atlanta-tbone | 2 / 2 (+1 witness vs witness) | 0 | L1 Minor |
| 03-minor-rear-end | 1 / 1 (+1 witness vs witness) | 0 | L1 Minor (owner only) |
| 04-dashcam-rear-end | 2 / 2 | 0 | L1 Minor |
| 05-india-junction-tbone | video only | – | findings from footage alone |
| 06-india-auto-rickshaw | video only | – | findings from footage alone |

**Camera type is detected automatically** (background optical flow: a fixed CCTV's background is still, a dashcam's streams out from the vanishing point). Dashcam cases get a *Driver's view*: distance and time-to-collision to the hazard, the driver's reaction time, and whether a stop was possible.

Sources: 01-03, 05, 06 are from the ACCIDENT benchmark (CC BY-NC-SA 4.0; 05 and 06 are from its "World" set and show Indian road features, though the exact city isn't recorded). 04 is from Hugging Face `smart-dashcam/motorcycle-accident-driving-datasets` (licence "other"; research use, attributed). More dashcam clips: `scripts/fetch_dashcam.py` streams only the clips you ask for from that 709 MB archive.

## Presenter run sheet (3 minutes)

**0:00 The problem.** "Every crash leaves fragments: a camera, a few witnesses, the car's own data. They never agree. Families wait years for someone to work out which fragment is true."

**0:20 Upload, live.** Home → *Run this kit* on **02-atlanta-tbone**, a clip the system has never been tuned on. Point at the stages: *tracking → road auto-calibrated from car sizes → vision on key frames → telematics → witness claims → cross-check*.

**1:00 Reconstruction.** Open the pre-run **01-india-bus-divider** case (run it before the pitch).
- *Reconstruction → Top view*: press **braking**, then **impact**. "Speed-coloured path, one tick per second, the bus drifts into the divider beside the constable."
- Switch to **Bird's-eye 3D**. "The wall behind the bus is its speed, and you can see it braking." Click **Shopkeeper's view**, and the red line shows the bus was hidden from her at that instant.

**1:50 Contradictions.** "The constable said 50–60 km/h. Calibrated video and telematics say 16. It holds unless our speed scale is off by 200%, and it's ±15%." Then: "The shopkeeper said the policeman fell. He's upright in every frame." Show the CCTV frame beside the quote.

**2:20 Trust.** Overview → *Accuracy vs planted ground truth*: **5/5 caught, 0 false flags**. *How much to trust this case* shows how every layer was produced.

**2:40 Guardrail.** Ask the case → "Who is at fault?" → declined. "How fast was the bus?" → a cited answer. "We don't decide guilt. We make sure the evidence is heard."

**Backup:** if the live upload is slow, every kit can be pre-run and opened from the *Cases* list.
