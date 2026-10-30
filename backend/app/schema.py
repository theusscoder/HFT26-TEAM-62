"""Shared event contract. Every extractor (video, sensor, witness) emits these; every
reasoning step reads them. Times are seconds relative to T0 = impact."""
from typing import Literal

from pydantic import BaseModel, Field

Kind = Literal["OBSERVED", "CLAIMED", "INFERRED"]


class TimeWindow(BaseModel):
    start: float
    end: float
    sigma: float = 0.0  # clock/measurement uncertainty, seconds


class Event(BaseModel):
    id: str                              # EV-V-012 (V video, S sensor, W witness, I inferred)
    source: str                          # cctv | dashcam | sensor | witness_1 ...
    kind: Kind
    t: TimeWindow
    actor: str                           # car_A, car_B, ped_1, signal_main
    action: str                          # enter | brake | impact | signal | speed | stop | cross | exit
    value: str | None = None             # "green", "42 km/h"
    xy: list[float] | None = None        # bird's-eye metres
    confidence: float = Field(ge=0, le=1)
    ref: str                             # cctv.mp4#f=144 | witness_1.txt#c=120-168 | sensor.csv#r=48
    quote: str | None = None             # exact witness span (must exist in the text)
    derived_from: list[str] = []         # for INFERRED events
    rule: str | None = None              # rule that produced an INFERRED event


class Contradiction(BaseModel):
    id: str
    type: Literal["temporal", "state", "quantity", "presence", "witness"]
    events: list[str]
    summary: str
    explanation: str | None = None       # LLM suggestion, labelled as such in the UI
    severity: Literal["low", "medium", "high"] = "medium"


class Gap(BaseModel):
    start: float
    end: float
    covered_by: list[str]
    note: str
