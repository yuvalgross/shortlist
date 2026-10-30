-- Follow ups to 20261030000001_scoring_factors.
--
--   1. Dropping total_fit also dropped the shortlist index on it; this puts it back.
--   2. A per factor CV bar no longer has to sit at or above cv_threshold. The trigger already
--      takes the higher of the two, and the old check made any cv_threshold above 8.5 fail
--      because the default run and report bar (8.5) was always merged in.
--   3. adjust_points now fits every total the factor rules allow (pay below -3 plus a -3 cap
--      is -6; pay above 2 plus a small team bonus of 1 is 3).

-- ---------------------------------------------------------------------------
-- 1. Shortlist index
-- ---------------------------------------------------------------------------
create index if not exists job_matches_user_id_status_total_fit_idx
  on public.job_matches (user_id, status, total_fit desc);

-- ---------------------------------------------------------------------------
-- 2. Factor rules check: CV bars between 5 and 10
-- ---------------------------------------------------------------------------
-- Same function as in 20261030000001, except the cv_threshold_by_factor range.
-- cv stays in the signature so set_scoring_config does not need to change.
create or replace function public.check_factor_rules(r jsonb, cv numeric) returns void
language plpgsql immutable set search_path = public as $$
declare
  k text;
  v numeric;
begin
  if jsonb_typeof(r) <> 'object' then raise exception 'factor_rules must be an object'; end if;
  if jsonb_typeof(r->'pay_band') <> 'object' or jsonb_typeof(r->'team_size') <> 'object'
     or jsonb_typeof(r->'deductions') <> 'object' or jsonb_typeof(r->'cv_threshold_by_factor') <> 'object'
     or jsonb_typeof(r->'deduction_cap') <> 'number' then
    raise exception 'factor_rules needs pay_band, team_size, deductions, deduction_cap and cv_threshold_by_factor';
  end if;
  if (r->'pay_band'->>'below')::numeric not between -3 and 0
     or (r->'pay_band'->>'inside')::numeric not between -1 and 1
     or (r->'pay_band'->>'above')::numeric not between 0 and 2 then
    raise exception 'pay_band points are out of range (below -3 to 0, inside -1 to 1, above 0 to 2)';
  end if;
  if (r->'team_size'->>'build_small')::numeric not between 0 and 1
     or (r->'team_size'->>'ops_large')::numeric not between -1 and 0
     or (r->'team_size'->>'build_small_max')::int < 1
     or (r->'team_size'->>'ops_large_min')::int < (r->'team_size'->>'build_small_max')::int then
    raise exception 'team_size rules are out of range';
  end if;
  for k, v in select key, value::numeric from jsonb_each_text(r->'deductions') loop
    if k not in ('sales_ops', 'run_and_report', 'ops_years_gap') then raise exception 'unknown deduction %', k; end if;
    if v not between -1 and 0 then raise exception 'deduction % must be between -1 and 0', k; end if;
  end loop;
  if (r->>'deduction_cap')::numeric not between -3 and 0 then raise exception 'deduction_cap must be between -3 and 0'; end if;
  for k, v in select key, value::numeric from jsonb_each_text(r->'cv_threshold_by_factor') loop
    if k not in ('sales_ops', 'run_and_report', 'ops_years_gap', 'team_size_ops_large') then
      raise exception 'unknown factor % in cv_threshold_by_factor', k;
    end if;
    if v not between 5 and 10 then raise exception 'cv_threshold_by_factor % must be between 5 and 10', k; end if;
  end loop;
end $$;
revoke all on function public.check_factor_rules(jsonb, numeric) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. adjust_points range
-- ---------------------------------------------------------------------------
alter table public.job_matches drop constraint job_matches_adjust_points_check;
alter table public.job_matches
  add constraint job_matches_adjust_points_check check (adjust_points between -6 and 3);
