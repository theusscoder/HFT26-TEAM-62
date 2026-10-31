"""Append-only, hash-chained custody ledger (pattern from Sarvadristhi custody.py).
Each line carries the SHA-256 of the previous line; editing any line breaks every later link."""
import hashlib
import json
import threading
from datetime import datetime, timezone
from pathlib import Path

GENESIS = "0" * 64
_append_lock = threading.Lock()   # read-then-write must not interleave: the agent, the ticker and requests all append


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _digest(entry: dict) -> str:
    return hashlib.sha256(json.dumps(entry, sort_keys=True).encode()).hexdigest()


class Ledger:
    def __init__(self, path: Path):
        self.path = path

    def entries(self) -> list[dict]:
        if not self.path.exists():
            return []
        return [json.loads(l) for l in self.path.read_text().splitlines() if l.strip()]

    def append(self, action: str, **details) -> dict:
        with _append_lock:
            prev = self.entries()
            entry = {
                "seq": len(prev),
                "time": datetime.now(timezone.utc).isoformat(),
                "action": action,
                "details": details,
                "prev": _digest(prev[-1]) if prev else GENESIS,
            }
            with open(self.path, "a") as f:
                f.write(json.dumps(entry) + "\n")
            return entry

    def verify(self) -> dict:
        prev_hash = GENESIS
        for e in self.entries():
            if e["prev"] != prev_hash:
                return {"ok": False, "broken_at": e["seq"]}
            prev_hash = _digest(e)
        return {"ok": True, "entries": len(self.entries())}
