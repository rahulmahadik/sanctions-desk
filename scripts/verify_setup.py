"""Verify the full local setup. Standard library only. Never prints keys or tokens."""
import json
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"
PROMPT = "Reply with the single word: ready"
CHAT_TIMEOUT = 90
REQUIRED_CONTAINERS = ["postgres", "driver", "api", "ui", "ai-datasteward"]
OPTIONAL_CONTAINERS = {"ai-datasteward"}

counts = {"PASS": 0, "FAIL": 0, "WARN": 0}


def report(status: str, name: str, reason: str = "") -> None:
    counts[status] += 1
    print(f"{status:<4} {name}" + (f": {reason}" if reason else ""))


def load_env(path: Path) -> dict:
    env = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip().strip("'\"")
    return env


def run(cmd: list, timeout: int = 30):
    try:
        p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except FileNotFoundError:
        return 127, "", "not found"
    except subprocess.TimeoutExpired:
        return 124, "", "timed out"


def http(method: str, url: str, headers: dict, payload=None, timeout: int = 30):
    """Return (status, text, seconds). status is None on connection failure."""
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status, text = resp.status, resp.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        status, text = e.code, e.read().decode(errors="replace")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        status, text = None, str(getattr(e, "reason", e))
    return status, text, time.monotonic() - start


def err(status, text) -> str:
    shown = f"HTTP {status}" if status is not None else "connection error"
    return f"{shown} {text[:200]}"


# 1. Zetaris containers
def check_containers() -> None:
    rc, out, e = run(["docker", "ps", "--format", "{{.Names}} {{.Status}}"])
    if rc != 0:
        report("FAIL", "containers", f"docker ps failed: {e[:200]}")
        return
    rows = [line.split(" ", 1) for line in out.splitlines() if line.strip()]
    for kw in REQUIRED_CONTAINERS:
        pat = re.compile(rf"(^|[-_]){re.escape(kw)}([-_]\d+)?$")
        match = [(n, s) for n, s in (r + [""] * (2 - len(r)) for r in rows) if pat.search(n)]
        if not match:
            if kw in OPTIONAL_CONTAINERS:
                report("WARN", f"container {kw}", "not running; optional (not defined in the hackathon compose bundle)")
            else:
                report("FAIL", f"container {kw}", "not running")
            continue
        name, status = match[0]
        if not status.startswith("Up"):
            report("FAIL", f"container {kw}", f"{name} {status}")
        elif "unhealthy" in status:
            report("FAIL", f"container {kw}", f"{name} {status}")
        elif "health: starting" in status:
            report("WARN", f"container {kw}", f"{name} {status}")
        else:
            report("PASS", f"container {kw}", f"{name} {status}")


# 2. Zetaris REST
def zetaris_sql(env: dict, sql: str):
    url = env["ZETARIS_REST_URL"].rstrip("/") + "/sql-editor/sqls/run"
    headers = {
        "Authorization": f"Bearer {env['ZETARIS_API_KEY']}",
        "X-Org-ID": env["ZETARIS_ORG_ID"],
        "X-Request-ID": str(uuid.uuid4()),
        "Content-Type": "application/json",
    }
    body = {"queryId": str(uuid.uuid4()), "sql": sql, "source": "SqlEditor", "limit": 100}
    return http("POST", url, headers, body, timeout=60)


def check_zetaris(env: dict) -> None:
    missing = [k for k in ("ZETARIS_REST_URL", "ZETARIS_ORG_ID", "ZETARIS_API_KEY") if not env.get(k)]
    if missing:
        report("FAIL", "zetaris env", f"missing {', '.join(missing)}")
        return
    status, text, secs = zetaris_sql(env, "SELECT 1")
    try:
        ok = status == 200 and str(json.loads(text)["data"][0][0]) == "1"
    except (ValueError, KeyError, IndexError, TypeError):
        ok = False
    if ok:
        report("PASS", "zetaris SELECT 1", f"{secs:.2f}s")
    else:
        report("FAIL", "zetaris SELECT 1", err(status, text))
    status, text, secs = zetaris_sql(env, "SHOW LIGHTNING DATABASES")
    try:
        if status != 200:
            raise ValueError
        rows = json.loads(text)["data"]
        names = [str(r[0]) for r in rows if r]
        report("PASS", "zetaris SHOW LIGHTNING DATABASES",
               f"{len(names)} found ({secs:.2f}s): {', '.join(names) or '(none)'}")
    except (ValueError, KeyError, IndexError, TypeError):
        report("FAIL", "zetaris SHOW LIGHTNING DATABASES", err(status, text))


# chat helper
def chat(base: str, model: str, headers: dict):
    """Return (ok, answered_model, seconds, error, kind). kind is 'local'/'cloud' when the runtime says so."""
    url = base.rstrip("/") + "/chat/completions"
    hdrs = {"Content-Type": "application/json", **headers}
    payload = {"model": model, "messages": [{"role": "user", "content": PROMPT}]}
    status, text, secs = http("POST", url, hdrs, payload, timeout=CHAT_TIMEOUT)
    if status == 200:
        try:
            body = json.loads(text)
            body["choices"][0]["message"]
            route = (body.get("meterless") or {}).get("winning_route") or {}
            answered = (body.get("meterless") or {}).get("routed_model") or body.get("model", "?")
            return True, answered, secs, "", route.get("kind")
        except (ValueError, KeyError, IndexError, TypeError, AttributeError):
            pass
    return False, "", secs, err(status, text), None


# 3 + 4. Nightshift
def check_nightshift(env: dict) -> None:
    missing = [k for k in ("METERLESS_BASE_URL", "METERLESS_RUNTIME_TOKEN") if not env.get(k)]
    if missing:
        report("FAIL", "nightshift env", f"missing {', '.join(missing)}")
        return
    base = env["METERLESS_BASE_URL"].rstrip("/")
    headers = {
        "Authorization": f"Bearer {env['METERLESS_RUNTIME_TOKEN']}",
        "meterless-app": "sanctions-desk",
        "meterless-scope": "user",
    }
    status, text, secs = http("GET", base + "/models", headers, timeout=30)
    try:
        if status != 200:
            raise ValueError
        ids = [m["id"] for m in json.loads(text)["data"]]
    except (ValueError, KeyError, TypeError):
        report("FAIL", "nightshift /models", err(status, text))
        return
    report("PASS", "nightshift /models", f"{len(ids)} models ({secs:.2f}s)")
    print("     " + ", ".join(ids))
    targets = [i for i in ids if "nemotron" in i.lower()]
    if not targets:
        report("FAIL", "nightshift nemotron", "no model id contains 'nemotron'")
    answered_ok = aliased = cloud = 0
    for mid in targets:
        if "embed" in mid.lower():
            report("WARN", f"nightshift chat {mid}", "skipped: embedding model, not a chat model")
            continue
        ok, answered, t, e, kind = chat(base, mid, headers)
        if not ok:
            report("FAIL", f"nightshift chat {mid}", f"{e} ({t:.2f}s)")
            continue
        answered_ok += 1
        cloud += kind == "cloud"
        if answered == mid:
            report("PASS", f"nightshift chat {mid}", f"requested == answered ({kind or '?'}), {t:.2f}s")
        else:
            aliased += 1
            report("WARN", f"nightshift chat {mid}",
                   f"aliased: requested {mid}, answered by {answered} ({kind or '?'}), {t:.2f}s")
    if answered_ok and aliased == answered_ok:
        report("WARN", "nightshift routing", f"all {answered_ok} requests were answered by a different model than requested")
    if answered_ok and not cloud:
        report("WARN", "nightshift cloud lane", "no request was answered by a cloud route; "
               "attach the cloud lane to app 'sanctions-desk' in Nightshift if you expect one")
    elif cloud:
        report("PASS", "nightshift cloud lane", f"{cloud} request(s) answered by a cloud route")


# 5. Ollama
def check_ollama(env: dict) -> None:
    base = env.get("OLLAMA_BASE_URL") or "http://localhost:11434/v1"
    model = env.get("OLLAMA_MODEL") or "nemotron-3.5-lightning:30b"
    ok, answered, t, e, _ = chat(base, model, {})
    if ok and answered != model:
        report("WARN", f"ollama chat {model}", f"aliased: requested {model}, answered by {answered}, {t:.2f}s")
    elif ok:
        report("PASS", f"ollama chat {model}", f"requested == answered, {t:.2f}s")
    else:
        report("FAIL", f"ollama chat {model}", f"{e} ({t:.2f}s)")


# 6. Repo hygiene
def check_hygiene() -> None:
    rc, out, e = run(["git", "status", "--porcelain"])
    own = "scripts/verify_setup.py"
    lines = out.splitlines()
    dirty = [l for l in lines if l[2:].strip() != own]  # run() strips the first line's leading space
    if rc != 0:
        report("FAIL", "git status", e[:200])
    elif dirty:
        report("FAIL", "git status clean", f"{len(dirty)} change(s): " + "; ".join(dirty[:5]))
    elif lines:
        report("PASS", "git status clean", "ignoring this script itself while uncommitted")
    else:
        report("PASS", "git status clean")
    rc, _, _ = run(["git", "check-ignore", "-q", ".env"])
    report("PASS" if rc == 0 else "FAIL", ".env ignored", "" if rc == 0 else "git does not ignore .env")
    # pattern is assembled from pieces so this file does not match its own scan
    pattern = "|".join([
        "nvapi" + "-",
        r"(^|[^A-Za-z0-9])sk" + r"-[A-Za-z0-9_-]{20,}",
        r"api[_-]?key\s*=\s*[A-Za-z0-9]{16,}",
        "BEGIN (RSA|OPENSSH) PRIVATE " + "KEY",
    ])
    rc, out, e = run(["git", "grep", "-nE", "--untracked", "--exclude-standard", "-e", pattern,
                      "--", ".", ":(exclude).env.example",
                      # The redactor must contain key shapes to recognise them, and its tests use fake ones.
                      ":(exclude)packages/shared/src/redact.ts", ":(exclude)packages/shared/test/redact.test.ts"])
    if rc == 1:
        report("PASS", "secret scan", "no matches in tracked/untracked non-ignored files")
    elif rc == 0:
        files = sorted({l.split(":", 1)[0] for l in out.splitlines()})
        report("FAIL", "secret scan", f"matches in: {', '.join(files)} (values not shown)")
    else:
        report("FAIL", "secret scan", e[:200])


# 7. Toolchain
def check_toolchain() -> None:
    for tool in ("python3", "uv", "node", "npx", "git", "docker"):
        if not shutil.which(tool):
            report("FAIL", f"tool {tool}", "not found")
            continue
        rc, out, e = run([tool, "--version"])
        version = (out or e).splitlines()[0] if (out or e) else "?"
        if rc != 0:
            report("FAIL", f"tool {tool}", version[:100])
        elif tool == "node":
            m = re.search(r"v?(\d+)\.", version)
            if m and int(m.group(1)) >= 20:
                report("PASS", "tool node", f"{version} (>=20)")
            else:
                report("FAIL", "tool node", f"{version} (need >=20)")
        else:
            report("PASS", f"tool {tool}", version)


def main() -> int:
    env = load_env(ENV_PATH)
    if not env:
        report("FAIL", ".env", "missing or empty")
    check_containers()
    check_zetaris(env)
    check_nightshift(env)
    check_ollama(env)
    check_hygiene()
    check_toolchain()
    print(f"\nSummary: {counts['PASS']} PASS, {counts['WARN']} WARN, {counts['FAIL']} FAIL")
    return 1 if counts["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(main())
