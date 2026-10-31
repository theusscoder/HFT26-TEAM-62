"""Diagnose plate reading on the hero case: saves crops to data/cases/hero/plate_debug/ and tests TrOCR on a clean
synthetic plate (known text) to separate 'model not working' from 'footage too coarse'. Output: plate_debug/report.txt"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import torch
from huggingface_hub import snapshot_download
from PIL import Image
from transformers import TrOCRProcessor, VisionEncoderDecoderModel
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parents[1]
d = ROOT / "data" / "cases" / "hero"
out = d / "plate_debug"
out.mkdir(exist_ok=True)
lines = []
log = lambda *a: (lines.append(" ".join(str(x) for x in a)), print(*a))
path = snapshot_download("subash1652007/indian-plate-ocr")
det = YOLO(f"{path}/yolo_best.pt")
proc = TrOCRProcessor.from_pretrained(f"{path}/trocr_plate")
model = VisionEncoderDecoderModel.from_pretrained(f"{path}/trocr_plate").eval()
log("generation_config:", model.generation_config.to_dict().get("decoder_start_token_id"), model.config.decoder_start_token_id, "eos", model.config.eos_token_id, "pad", model.config.pad_token_id)


def read(img_bgr, tag):
    pil = Image.fromarray(cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB))
    pv = proc(images=pil, return_tensors="pt").pixel_values
    res = {}
    for name, kw in (("beam3", dict(max_length=20, num_beams=3)), ("greedy", dict(max_new_tokens=16)),
                     ("greedy+start", dict(max_new_tokens=16, decoder_start_token_id=model.config.decoder_start_token_id or proc.tokenizer.cls_token_id))):
        try:
            with torch.no_grad():
                ids = model.generate(pv, **kw)
            res[name] = (proc.batch_decode(ids, skip_special_tokens=True)[0], proc.batch_decode(ids, skip_special_tokens=False)[0], ids[0].tolist()[:12])
        except Exception as e:
            res[name] = f"ERR {type(e).__name__}: {e}"[:160]
    log(f"[{tag}] {img_bgr.shape[1]}x{img_bgr.shape[0]} ->", json.dumps(res))


# 1) synthetic clean plate with known text
syn = np.full((110, 520, 3), 255, np.uint8)
cv2.rectangle(syn, (3, 3), (516, 106), (0, 0, 0), 4)
cv2.putText(syn, "TS 09 UB 4471", (18, 76), cv2.FONT_HERSHEY_DUPLEX, 1.9, (0, 0, 0), 4)
cv2.imwrite(str(out / "synthetic_TS09UB4471.png"), syn)
read(syn, "synthetic TS09UB4471")

# 2) real crops of the involved vehicles at their largest boxes
tracks = json.loads((d / "tracks.json").read_text())["tracks"]
cap = cv2.VideoCapture(str(d / "evidence" / "cctv.mp4"))
for tid in ("car_38", "motorcycle_3"):
    pts = sorted([p for p in tracks[tid]["points"]], key=lambda p: -(p["box"][2] - p["box"][0]) * (p["box"][3] - p["box"][1]))[:4]
    for p in pts:
        cap.set(cv2.CAP_PROP_POS_FRAMES, p["f"])
        ok, frame = cap.read()
        if not ok:
            continue
        x1, y1, x2, y2 = (int(v) for v in p["box"])
        veh = frame[max(0, y1):y2, max(0, x1):x2]
        cv2.imwrite(str(out / f"{tid}_f{p['f']}_vehicle.png"), veh)
        up = cv2.resize(veh, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
        r = det(up, conf=0.1, imgsz=640, verbose=False)[0]
        boxes = list(zip(r.boxes.xyxy.tolist(), r.boxes.conf.tolist()))
        log(f"{tid} f{p['f']}: vehicle {veh.shape[1]}x{veh.shape[0]}, plate boxes {[(list(map(int, b)), round(c, 2)) for b, c in boxes]}")
        for k, (b, c) in enumerate(boxes[:2]):
            bx1, by1, bx2, by2 = (int(v) for v in b)
            pc = up[by1:by2, bx1:bx2]
            if pc.size == 0:
                continue
            cv2.imwrite(str(out / f"{tid}_f{p['f']}_plate{k}.png"), pc)
            big = cv2.resize(pc, None, fx=max(1, 200 / pc.shape[1]), fy=max(1, 200 / pc.shape[1]), interpolation=cv2.INTER_CUBIC)
            read(big, f"{tid} f{p['f']} plate{k} conf {c:.2f}")
(out / "report.txt").write_text("\n".join(lines), encoding="utf-8")
print("saved", out)
