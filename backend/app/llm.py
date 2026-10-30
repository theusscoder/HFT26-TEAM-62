"""OWNER: P3. Featherless client (OpenAI-compatible) for text and vision, with JSON mode and a disk cache.

The cache (data/llm_cache/) makes demos deterministic and lets the pipeline run with no key or no network:
a cached answer is reused for an identical (model, messages) request. If there is no key and no cache
entry, `chat_json` raises LLMUnavailable and callers fall back (e.g. to a seed file) and say so.

Env: FEATHERLESS_API_KEY, FEATHERLESS_TEXT_MODEL, FEATHERLESS_VISION_MODEL (backend/.env is loaded)."""
import base64
import hashlib
import json
import os
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "data" / "llm_cache"
BASE_URL = "https://api.featherless.ai/v1"


class LLMUnavailable(RuntimeError):
    pass


def _load_env():
    env = ROOT / "backend" / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


_load_env()
TEXT_MODEL = os.getenv("FEATHERLESS_TEXT_MODEL", "Qwen/Qwen2.5-32B-Instruct")
VISION_MODEL = os.getenv("FEATHERLESS_VISION_MODEL", "Qwen/Qwen2.5-VL-7B-Instruct")


def configured() -> bool:
    return bool(os.getenv("FEATHERLESS_API_KEY"))


def _key(model: str, messages: list) -> str:
    return hashlib.sha256(json.dumps([model, messages], sort_keys=True).encode()).hexdigest()[:24]


def chat_json(messages: list, model: str | None = None, temperature: float = 0.0, timeout: float = 90) -> dict:
    """Returns {"data": parsed_json, "model": ..., "cached": bool}. The model must answer with one JSON object."""
    model = model or TEXT_MODEL
    CACHE.mkdir(parents=True, exist_ok=True)
    cf = CACHE / f"{_key(model, messages)}.json"
    if cf.exists():
        return {**json.loads(cf.read_text()), "cached": True}
    if not configured():
        raise LLMUnavailable("FEATHERLESS_API_KEY not set and no cached answer")
    r = httpx.post(f"{BASE_URL}/chat/completions", timeout=timeout,
                   headers={"Authorization": f"Bearer {os.environ['FEATHERLESS_API_KEY']}"},
                   json={"model": model, "messages": messages, "temperature": temperature,
                         "response_format": {"type": "json_object"}})
    r.raise_for_status()
    text = r.json()["choices"][0]["message"]["content"]
    start, end = text.find("{"), text.rfind("}")
    data = json.loads(text[start:end + 1])
    out = {"data": data, "model": model}
    cf.write_text(json.dumps(out))
    return {**out, "cached": False}


def image_part(path: Path) -> dict:
    b64 = base64.b64encode(Path(path).read_bytes()).decode()
    return {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}


def health() -> dict:
    if not configured():
        return {"configured": False, "text_model": TEXT_MODEL, "vision_model": VISION_MODEL}
    try:
        r = chat_json([{"role": "user", "content": 'Reply with {"ok": true}'}])
        return {"configured": True, "ok": r["data"].get("ok") is True, "text_model": TEXT_MODEL, "vision_model": VISION_MODEL}
    except Exception as e:  # surfaced in the UI, never fatal
        return {"configured": True, "ok": False, "error": str(e)[:200]}


if __name__ == "__main__":
    print(health())
