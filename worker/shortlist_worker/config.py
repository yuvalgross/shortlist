"""Worker settings, read from the environment only. Secrets never live in code or in the repo."""
from __future__ import annotations

import os
from dataclasses import dataclass


class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class Settings:
    supabase_url: str
    supabase_secret_key: str  # service role key: bypasses row level security, worker only
    anthropic_api_key: str | None  # needed from Gate 1

    @property
    def rest_url(self) -> str:
        return self.supabase_url.rstrip("/") + "/rest/v1"


def load_settings(env: dict[str, str] | None = None) -> Settings:
    env = dict(os.environ if env is None else env)
    missing = [k for k in ("SUPABASE_URL", "SUPABASE_SECRET_KEY") if not env.get(k)]
    if missing:
        raise ConfigError(f"Missing environment variables: {', '.join(missing)}")
    url = env["SUPABASE_URL"]
    if not url.startswith("https://"):
        raise ConfigError("SUPABASE_URL must start with https://")
    return Settings(
        supabase_url=url,
        supabase_secret_key=env["SUPABASE_SECRET_KEY"],
        anthropic_api_key=env.get("ANTHROPIC_API_KEY") or None,
    )
