"""Telugu and Hindi voice statements to text. AI4Bharat's IndicConformer, as the ONNX export at
huggingface.co/parismitaglobalsolutions/indicconformer-sherpa-onnx (Apache-2.0), runs locally on the CPU.
Needs sherpa-onnx and ffmpeg. The model downloads to data/models/ on first use (about 190 MB per language)."""
import shutil
import subprocess
import tempfile
import urllib.request
import wave
from functools import lru_cache
from pathlib import Path

import numpy as np

BASE = "https://huggingface.co/parismitaglobalsolutions/indicconformer-sherpa-onnx/resolve/main"
MODELS = Path(__file__).resolve().parents[2] / "data" / "models" / "indicconformer"
SAMPLE_RATE = 16000


def _download(url: str, target: Path) -> None:
    if target.is_file():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_suffix(target.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as response, part.open("wb") as out:
        shutil.copyfileobj(response, out)
    part.replace(target)


@lru_cache(maxsize=2)
def _recognizer(language: str):
    import sherpa_onnx

    model, tokens = MODELS / language / "model.int8.onnx", MODELS / "tokens.txt"
    _download(f"{BASE}/{language}/model.int8.onnx", model)
    _download(f"{BASE}/tokens.txt", tokens)
    return sherpa_onnx.OfflineRecognizer.from_nemo_ctc(model=str(model), tokens=str(tokens), num_threads=4, provider="cpu")


def _samples(audio: Path) -> np.ndarray:
    with tempfile.TemporaryDirectory() as folder:
        wav_path = Path(folder) / "audio.wav"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(audio), "-ac", "1", "-ar", str(SAMPLE_RATE), "-sample_fmt", "s16", str(wav_path)],
                       check=True, capture_output=True, timeout=300)
        with wave.open(str(wav_path), "rb") as w:
            pcm = w.readframes(w.getnframes())
    return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0


def transcribe(audio: Path, language: str = "te") -> str:
    recognizer = _recognizer(language)
    stream = recognizer.create_stream()
    stream.accept_waveform(SAMPLE_RATE, _samples(audio))
    recognizer.decode_stream(stream)
    return stream.result.text.strip()
