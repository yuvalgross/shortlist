import pytest

from shortlist_worker.config import ConfigError, load_settings


def test_missing_keys_are_named():
    with pytest.raises(ConfigError, match="SUPABASE_URL, SUPABASE_SECRET_KEY"):
        load_settings({})


def test_rejects_plain_http():
    with pytest.raises(ConfigError, match="https"):
        load_settings({"SUPABASE_URL": "http://x.supabase.co", "SUPABASE_SECRET_KEY": "k"})


def test_loads_and_builds_rest_url():
    s = load_settings({"SUPABASE_URL": "https://x.supabase.co/", "SUPABASE_SECRET_KEY": "k"})
    assert s.rest_url == "https://x.supabase.co/rest/v1"
    assert s.anthropic_api_key is None
