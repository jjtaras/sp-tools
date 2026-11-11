"""
Where the checklist tool finds its per-machine and SP-owned settings, the same way the rest of
sp-tools does:

  .env (repo root, gitignored)   INNERGY_API_KEY, optional INNERGY_BASE_URL, SP_CONFIG_DIR
  $SP_CONFIG_DIR/checklist/      settings.json (people, defaults), PRODUCTION_CHECKLIST_TEMPLATE.pdf

Anything missing fails loudly. There are no built-in fallbacks.
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))


def _load_env():
    path = os.path.join(REPO_ROOT, ".env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            os.environ.setdefault(key.strip(), value)


_load_env()


def require_env(name):
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"{name} is not set. Add it to {os.path.join(REPO_ROOT, '.env')} (see .env.example).")
    return value


def config_dir():
    path = require_env("SP_CONFIG_DIR")
    if not os.path.isdir(path):
        raise SystemExit(f"SP_CONFIG_DIR does not exist or is not a folder: {path}")
    return path


def checklist_path(*parts):
    return os.path.join(config_dir(), "checklist", *parts)


def settings():
    path = checklist_path("settings.json")
    if not os.path.exists(path):
        raise SystemExit(f"Missing checklist settings: {path}")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def innergy():
    """(base_url, api_key) for Innergy."""
    return os.environ.get("INNERGY_BASE_URL", "https://app.innergy.com"), require_env("INNERGY_API_KEY")
