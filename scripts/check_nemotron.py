"""Check Nemotron endpoints: A) Meterless/Nightshift (auth), B) local Ollama (no auth). Never prints the token."""
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
PROMPT = "Reply with the single word: ready"
TIMEOUT = 60


def load_env(path: Path) -> dict:
    env = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip().strip("'\"")
    return env


def call(method: str, url: str, headers: dict, payload=None):
    """Return (status, text, seconds). status is None on connection failure (text holds the reason)."""
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            status, text = resp.status, resp.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        status, text = e.code, e.read().decode(errors="replace")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        status, text = None, str(getattr(e, "reason", e))
    return status, text, time.monotonic() - start


def chat(base: str, model: str, headers: dict) -> bool:
    url = base.rstrip("/") + "/chat/completions"
    hdrs = {"Content-Type": "application/json", **headers}
    payload = {"model": model, "messages": [{"role": "user", "content": PROMPT}]}
    status, text, secs = call("POST", url, hdrs, payload)
    if status == 200:
        try:
            body = json.loads(text)
            answered = body.get("model", "?")
            reply = body["choices"][0]["message"]["content"]
            print(f"PASS model={answered} latency={secs:.2f}s reply={reply.strip()[:60]!r}")
            return True
        except (ValueError, KeyError, IndexError, TypeError, AttributeError):
            pass
    shown = f"HTTP {status}" if status is not None else "connection error"
    print(f"FAIL {shown} {text[:200]}")
    return False


def check_meterless(env: dict) -> bool:
    print("== Check A: Meterless/Nightshift ==")
    missing = [k for k in ("METERLESS_BASE_URL", "METERLESS_RUNTIME_TOKEN", "METERLESS_MODEL") if not env.get(k)]
    if missing:
        print(f"FAIL missing in .env: {', '.join(missing)}")
        return False
    base = env["METERLESS_BASE_URL"].rstrip("/")
    headers = {
        "Authorization": f"Bearer {env['METERLESS_RUNTIME_TOKEN']}",
        "meterless-app": "sanctions-desk",
        "meterless-scope": "user",
    }
    status, text, secs = call("GET", base + "/models", headers)
    if status == 200:
        try:
            ids = [m.get("id") for m in json.loads(text).get("data", [])]
            print(f"models ({secs:.2f}s): {', '.join(str(i) for i in ids) or '(none)'}")
        except (ValueError, AttributeError):
            print("models: unreadable response")
    else:
        shown = f"HTTP {status}" if status is not None else "connection error"
        print(f"models FAIL {shown} {text[:200]}")
    return chat(base, env["METERLESS_MODEL"], headers)


def check_ollama(env: dict) -> bool:
    print("== Check B: local Ollama ==")
    base = env.get("OLLAMA_BASE_URL") or "http://localhost:11434/v1"
    model = env.get("OLLAMA_MODEL") or "nemotron-3.5-lightning:30b"
    return chat(base, model, {})


def main() -> int:
    env = load_env(ENV_PATH)
    results = [check_meterless(env), check_ollama(env)]
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
