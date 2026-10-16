"""Command line entry point. Gate 0 has one command: `check`, which proves the worker can reach the database."""
from __future__ import annotations

import argparse
import sys

import httpx

from .config import ConfigError, load_settings

# Tables the worker must be able to read once the migrations have run.
REQUIRED_TABLES = ("companies", "sources", "jobs", "profiles", "scoring_configs", "job_matches", "profile_snapshots")


def check() -> int:
    try:
        settings = load_settings()
    except ConfigError as exc:
        print(f"Config problem: {exc}")
        return 2

    headers = {
        "apikey": settings.supabase_secret_key,
        "Authorization": f"Bearer {settings.supabase_secret_key}",
    }
    problems = []
    try:
        with httpx.Client(timeout=15) as client:
            for table in REQUIRED_TABLES:
                r = client.get(f"{settings.rest_url}/{table}", params={"select": "*", "limit": "0"}, headers=headers)
                if r.status_code != 200:
                    problems.append(f"{table}: HTTP {r.status_code} {r.text[:120]}")
    except httpx.HTTPError as exc:
        print(f"Cannot reach Supabase at {settings.supabase_url}: {exc}")
        return 1
    if problems:
        print("Database check failed:\n  " + "\n  ".join(problems))
        return 1
    print(f"Database check OK: {len(REQUIRED_TABLES)} tables reachable. Anthropic key {'set' if settings.anthropic_api_key else 'not set yet'}.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="shortlist-worker")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check", help="verify settings and database access")
    args = parser.parse_args(argv)
    if args.command == "check":
        return check()
    return 1


if __name__ == "__main__":
    sys.exit(main())
