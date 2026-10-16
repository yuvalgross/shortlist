-- Supabase security advisor, first run on the live project (Gate 0)
-- 1. Pin the search path of the updated_at trigger function (lint 0011).
alter function public.touch_updated_at() set search_path = '';

-- 2. set_scoring_config is SECURITY DEFINER and callable by signed in users ON PURPOSE (lint 0029 is expected):
--    it only ever writes rows for auth.uid(), validates thresholds and weights, and caps scan and CV limits.
--    Letting users insert scoring_configs directly would skip those checks.
comment on function public.set_scoring_config(jsonb) is
  'Intentionally SECURITY DEFINER: the only way users change scoring, so validation and caps cannot be skipped. Writes only for auth.uid().';
