"""Fetch a handful of real dashcam / first-person crash clips without downloading the whole archive.

Source: Hugging Face dataset smart-dashcam/motorcycle-accident-driving-datasets (68 motorcycle-crash clips filmed
from the rider's camera + 68 car-dashcam driving clips, 852x480, ~6 s). The tar is streamed and extraction stops
once enough clips are saved. Output: data/raw/dashcam/.

Run: backend/.venv/Scripts/python scripts/fetch_dashcam.py [--accidents 15] [--driving 4]"""
import argparse
import tarfile
from pathlib import Path

import httpx

URL = "https://huggingface.co/datasets/smart-dashcam/motorcycle-accident-driving-datasets/resolve/main/train.tar"
OUT = Path(__file__).resolve().parents[1] / "data" / "raw" / "dashcam"


class Stream:
    """File-like wrapper over an HTTP byte stream for tarfile's streaming mode."""
    def __init__(self, resp):
        self.it, self.buf = resp.iter_bytes(1 << 16), b""
    def read(self, n=-1):
        while n < 0 or len(self.buf) < n:
            try:
                self.buf += next(self.it)
            except StopIteration:
                break
        if n < 0:
            out, self.buf = self.buf, b""
        else:
            out, self.buf = self.buf[:n], self.buf[n:]
        return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--accidents", type=int, default=15)
    ap.add_argument("--driving", type=int, default=4)
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    want = {"accident": a.accidents, "driving": a.driving}
    got = {"accident": 0, "driving": 0}
    with httpx.stream("GET", URL, follow_redirects=True, timeout=None) as r:
        r.raise_for_status()
        with tarfile.open(fileobj=Stream(r), mode="r|*") as tar:
            for m in tar:
                name = Path(m.name).name
                kind = "accident" if name.startswith("accident") else "driving" if name.startswith("driving") else None
                if not m.isfile() or not name.endswith(".mp4") or kind is None or got[kind] >= want[kind]:
                    continue
                f = tar.extractfile(m)
                (OUT / name).write_bytes(f.read())
                got[kind] += 1
                print("saved", name, f"{m.size / 1e6:.1f} MB", flush=True)
                if all(got[k] >= want[k] for k in want):
                    break
    print("done", got)
