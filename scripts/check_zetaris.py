"""Smoke-test the Zetaris REST API: run SELECT 1 and print PASS/FAIL. Never prints the key."""
import json
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"


def load_env(path: Path) -> dict:
    env = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip().strip("'\"")
    return env


def main() -> int:
    env = load_env(ENV_PATH)
    url = env["ZETARIS_REST_URL"].rstrip("/") + "/sql-editor/sqls/run"
    body = json.dumps(
        {"queryId": str(uuid.uuid4()), "sql": "SELECT 1", "source": "SqlEditor", "limit": 1}
    ).encode()
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {env['ZETARIS_API_KEY']}",
            "X-Org-ID": env["ZETARIS_ORG_ID"],
            "X-Request-ID": str(uuid.uuid4()),
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            status, text = resp.status, resp.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        status, text = e.code, e.read().decode(errors="replace")
    except urllib.error.URLError as e:
        print(f"FAIL: connection error: {e.reason}")
        return 1

    try:
        ok = str(json.loads(text)["data"][0][0]) == "1"
    except (ValueError, KeyError, IndexError, TypeError):
        ok = False

    if ok:
        print("PASS")
        return 0
    print(f"FAIL: HTTP {status} {text[:200]}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
