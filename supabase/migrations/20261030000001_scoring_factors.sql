-- Gate 2 groundwork: the fit factors the scan applies after role fit and location.
--
-- Mirrors the scan's standing rules (job-scan-log.md and job-sources.md section 5):
--   pay band (2026-10-15)          band top below the floor minus 1.5, floor inside 0, band bottom at or above plus 0.5
--   sales ops (2026-10-19)         minus 0.5
--   run and report (2026-10-19)    minus 0.5
--   ops years gap (2026-10-19)     minus 0.5
--   team size (2026-10-28)         build shape role under about 150 people plus 0.5,
--                                  Ops titled role over about 300 people minus 0.5
--   cap (2026-10-19, widened 10-28) sales ops, run and report, ops years and the team size minus
--                                  together take at most minus 1
--   CV bar (2026-10-28)            8.5 instead of 8 when the run and report deduction applies
--
-- The worker writes labels in job_matches.factors; the trigger turns them into points from the
-- user's active scoring config, so the points always match the config that scored the match.

-- ---------------------------------------------------------------------------
-- 1. Inputs the factors need
-- ---------------------------------------------------------------------------
alter table public.companies
  add column headcount            int check (headcount is null or headcount > 0),
  add column headcount_source     text check (headcount_source is null or headcount_source in ('apollo', 'company_site', 'other')),
  add column headcount_checked_at timestamptz;

alter table public.jobs
  add column salary_min      int check (salary_min is null or salary_min >= 0),
  add column salary_max      int check (salary_max is null or salary_max >= 0),
  add column salary_currency text,
  add column salary_period   text check (salary_period is null or salary_period in ('year', 'month', 'hour')),
  add column salary_is_ote   boolean not null default false,
  add constraint jobs_salary_range_chk check (salary_min is null or salary_max is null or salary_min <= salary_max);

-- ---------------------------------------------------------------------------
-- 2. Factor rules per scoring config (versioned with the rest of the config)
-- ---------------------------------------------------------------------------
create or replace function public.default_factor_rules() returns jsonb
language sql immutable set search_path = public as $$
  select '{
    "pay_band":  {"below": -1.5, "inside": 0, "above": 0.5},
    "team_size": {"build_small_max": 150, "build_small": 0.5, "ops_large_min": 300, "ops_large": -0.5},
    "deductions": {"sales_ops": -0.5, "run_and_report": -0.5, "ops_years_gap": -0.5},
    "deduction_cap": -1,
    "cv_threshold_by_factor": {"run_and_report": 8.5}
  }'::jsonb
$$;
revoke all on function public.default_factor_rules() from public, anon, authenticated;

alter table public.scoring_configs
  add column factor_rules jsonb not null default public.default_factor_rules();

-- Checks one factor_rules object; raises with a plain message when something is off.
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
    if v < cv or v > 10 then raise exception 'cv_threshold_by_factor % must be between cv_threshold and 10', k; end if;
  end loop;
end $$;
revoke all on function public.check_factor_rules(jsonb, numeric) from public, anon, authenticated;

alter table public.scoring_configs
  add constraint scoring_configs_factor_rules_chk check (jsonb_typeof(factor_rules) = 'object');

-- Same function as in 20261018000002, plus factor_rules.
create or replace function public.set_scoring_config(cfg jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  next_version int;
  new_id uuid;
  v_cv numeric := coalesce((cfg->>'cv_threshold')::numeric, 8.0);
  v_queue numeric := coalesce((cfg->>'queue_threshold')::numeric, 7.0);
  v_daily int := coalesce((cfg->>'daily_scan_limit')::int, 40);
  v_cap int := coalesce((cfg->>'cv_cap_per_run')::int, 3);
  v_level text := coalesce(cfg->>'rewrite_level', 'balanced');
  v_rules jsonb;
begin
  if uid is null then raise exception 'not signed in'; end if;
  if v_cv not between 5 and 10 then raise exception 'cv_threshold must be between 5 and 10'; end if;
  if v_queue not between 0 and 10 then raise exception 'queue_threshold must be between 0 and 10'; end if;
  if v_queue > v_cv then raise exception 'queue_threshold cannot be above cv_threshold'; end if;
  if v_daily not between 1 and 80 then raise exception 'daily_scan_limit must be between 1 and 80'; end if;
  if v_cap not between 0 and 5 then raise exception 'cv_cap_per_run must be between 0 and 5'; end if;
  if v_level not in ('light', 'balanced', 'strong') then raise exception 'rewrite_level must be light, balanced or strong'; end if;
  if cfg ? 'weights' then
    if jsonb_typeof(cfg->'weights') <> 'object' then raise exception 'weights must be an object'; end if;
    if exists (select 1 from jsonb_each_text(cfg->'weights') where value::numeric < 0) then
      raise exception 'weights cannot be negative';
    end if;
    if (select coalesce(sum(value::numeric), 0) from jsonb_each_text(cfg->'weights')) <> 100 then
      raise exception 'weights must add up to 100';
    end if;
  end if;

  -- Missing parts of factor_rules fall back to the defaults, one level deep.
  v_rules := public.default_factor_rules();
  if cfg ? 'factor_rules' then
    if jsonb_typeof(cfg->'factor_rules') <> 'object' then raise exception 'factor_rules must be an object'; end if;
    select jsonb_object_agg(d.key,
             case when jsonb_typeof(d.value) = 'object' and jsonb_typeof(cfg->'factor_rules'->d.key) = 'object'
                  then d.value || (cfg->'factor_rules'->d.key)
                  else coalesce(cfg->'factor_rules'->d.key, d.value) end)
      into v_rules
      from jsonb_each(v_rules) d;
    if exists (select 1 from jsonb_object_keys(cfg->'factor_rules') k where k not in (select jsonb_object_keys(v_rules))) then
      raise exception 'factor_rules has an unknown part';
    end if;
  end if;
  perform public.check_factor_rules(v_rules, v_cv);

  select coalesce(max(version), 0) + 1 into next_version from scoring_configs where user_id = uid;
  update scoring_configs set is_active = false where user_id = uid and is_active;

  insert into scoring_configs (user_id, version, is_active, cv_threshold, queue_threshold, weights,
                               location_points, rubric_anchors, benchmark_role, daily_scan_limit,
                               cv_cap_per_run, rewrite_level, factor_rules)
  values (uid, next_version, true, v_cv, v_queue,
          coalesce(cfg->'weights', '{"skills":35,"seniority":20,"location":15,"salary":15,"industry":15}'),
          coalesce(cfg->'location_points', '[{"match":"home_city","points":1.5},{"match":"remote_home_region","points":1.5},{"match":"relocation","points":0}]'),
          coalesce(cfg->'rubric_anchors', '{}'),
          cfg->'benchmark_role',
          v_daily, v_cap, v_level, v_rules)
  returning id into new_id;
  return new_id;
end $$;
revoke all on function public.set_scoring_config(jsonb) from public, anon;
grant execute on function public.set_scoring_config(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Factors on each match
-- ---------------------------------------------------------------------------
-- factors (written by the worker), labels only:
--   pay_band         below | inside | above | not_stated
--   pay_band_source  call | posting | board        (needed for below, inside, above; never a market estimate)
--   pay_low_hint     true when the posting or headcount points to a band under the floor but none is stated
--   team_size        build_small | ops_large | neutral | unknown
--   sales_ops, run_and_report, ops_years_gap   true when the deduction applies
-- factor_points, adjust_points, cv_threshold_applied and flags are computed by the trigger below.
alter table public.job_matches
  add column factors              jsonb not null default '{}' check (jsonb_typeof(factors) = 'object'),
  add column factor_points        jsonb not null default '{}',
  add column adjust_points        numeric(3,1) not null default 0 check (adjust_points between -4.5 and 2.5),
  add column cv_threshold_applied numeric(3,1),
  add column flags                text[] not null default '{}';

alter table public.job_matches drop column total_fit;
alter table public.job_matches
  add column total_fit numeric(3,1)
    generated always as (least(10, greatest(0, role_fit + location_points + adjust_points))) stored;

update public.job_matches m set cv_threshold_applied = c.cv_threshold
  from public.scoring_configs c where c.id = m.config_id;

create or replace function public.job_match_factors() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  f jsonb := new.factors;
  r jsonb;
  cv numeric;
  hc int;
  k text;
  pay numeric := 0;
  bonus numeric := 0;
  minus numeric := 0;
  pts jsonb := '{}';
  fl text[] := '{}';
  bar numeric;
begin
  if tg_op = 'UPDATE' and new.factors is not distinct from old.factors and new.config_id = old.config_id then
    return new;
  end if;

  select c.factor_rules, c.cv_threshold into r, cv
    from scoring_configs c where c.id = new.config_id and c.user_id = new.user_id;
  if r is null then raise exception 'scoring config % does not belong to this user', new.config_id; end if;

  for k in select jsonb_object_keys(f) loop
    if k not in ('pay_band', 'pay_band_source', 'pay_low_hint', 'team_size', 'sales_ops', 'run_and_report', 'ops_years_gap') then
      raise exception 'unknown factor %', k;
    end if;
  end loop;

  -- Pay band: points only from a stated band
  if coalesce(f->>'pay_band', 'not_stated') not in ('below', 'inside', 'above', 'not_stated') then
    raise exception 'pay_band must be below, inside, above or not_stated';
  end if;
  if f ? 'pay_band_source' and f->>'pay_band_source' not in ('call', 'posting', 'board') then
    raise exception 'pay_band_source must be call, posting or board';
  end if;
  if coalesce(f->>'pay_band', 'not_stated') = 'not_stated' then
    fl := array_append(fl, 'pay_not_stated');
  else
    if not f ? 'pay_band_source' then raise exception 'a pay band needs pay_band_source (call, posting or board)'; end if;
    pay := (r->'pay_band'->>(f->>'pay_band'))::numeric;
    pts := pts || jsonb_build_object('pay_band', pay);
    if f->>'pay_band' = 'below' then fl := array_append(fl, 'pay_below_floor'); end if;
  end if;
  if coalesce((f->>'pay_low_hint')::boolean, false) and coalesce(f->>'pay_band', 'not_stated') = 'not_stated' then
    fl := array_append(fl, 'pay_likely_below_floor');
  end if;

  -- Team size: points only with a known headcount that fits the rule
  select co.headcount into hc from jobs j join companies co on co.id = j.company_id where j.id = new.job_id;
  if coalesce(f->>'team_size', 'unknown') not in ('build_small', 'ops_large', 'neutral', 'unknown') then
    raise exception 'team_size must be build_small, ops_large, neutral or unknown';
  end if;
  if f->>'team_size' in ('build_small', 'ops_large', 'neutral') and hc is null then
    raise exception 'team_size needs the company headcount; use unknown when it is not known';
  end if;
  if f->>'team_size' = 'build_small' then
    if hc >= (r->'team_size'->>'build_small_max')::int then
      raise exception 'build_small needs a headcount under %', r->'team_size'->>'build_small_max';
    end if;
    bonus := (r->'team_size'->>'build_small')::numeric;
    pts := pts || jsonb_build_object('team_size', bonus);
  elsif f->>'team_size' = 'ops_large' then
    if hc <= (r->'team_size'->>'ops_large_min')::int then
      raise exception 'ops_large needs a headcount over %', r->'team_size'->>'ops_large_min';
    end if;
    minus := minus + (r->'team_size'->>'ops_large')::numeric;
    pts := pts || jsonb_build_object('team_size', (r->'team_size'->>'ops_large')::numeric);
  elsif coalesce(f->>'team_size', 'unknown') = 'unknown' then
    fl := array_append(fl, 'team_size_unknown');
  end if;

  -- Deductions, capped together with the team size minus
  for k in select key from jsonb_each_text(r->'deductions') loop
    if f ? k then
      if jsonb_typeof(f->k) <> 'boolean' then raise exception '% must be true or false', k; end if;
      if (f->>k)::boolean then
        minus := minus + (r->'deductions'->>k)::numeric;
        pts := pts || jsonb_build_object(k, (r->'deductions'->>k)::numeric);
      end if;
    end if;
  end loop;
  if minus < (r->>'deduction_cap')::numeric then
    pts := pts || jsonb_build_object('deduction_cap', (r->>'deduction_cap')::numeric);
    minus := (r->>'deduction_cap')::numeric;
  end if;

  -- CV bar: the highest bar among the factors that apply
  bar := cv;
  for k in select key from jsonb_each_text(r->'cv_threshold_by_factor') loop
    if (k = 'team_size_ops_large' and f->>'team_size' = 'ops_large')
       or (k <> 'team_size_ops_large' and coalesce((f->>k)::boolean, false)) then
      bar := greatest(bar, (r->'cv_threshold_by_factor'->>k)::numeric);
    end if;
  end loop;

  new.factor_points := pts;
  new.adjust_points := pay + bonus + minus;
  new.cv_threshold_applied := bar;
  new.flags := fl;
  return new;
end $$;
revoke all on function public.job_match_factors() from public, anon, authenticated;

create trigger t_job_matches_factors before insert or update on public.job_matches
  for each row execute function public.job_match_factors();

-- ---------------------------------------------------------------------------
-- 4. The snapshot the matching model reads now carries the factor rules
-- ---------------------------------------------------------------------------
create or replace function public.build_profile_snapshot(uid uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'profile', (select to_jsonb(p) - 'user_id' - 'created_at' - 'updated_at' - 'phone' - 'contact_email'
                from profiles p where p.user_id = uid),
    'experiences', coalesce((select jsonb_agg(jsonb_build_object(
        'id', e.id, 'title', e.title, 'ats_title', e.ats_title, 'company', e.company,
        'company_desc', e.company_desc, 'location', e.location, 'work_mode', e.work_mode,
        'start', e.start_date, 'end', e.end_date, 'current', e.is_current) order by e.sort_order)
      from experiences e where e.user_id = uid and e.status = 'confirmed'), '[]'),
    'skills', coalesce((select jsonb_agg(jsonb_build_object('name', s.name, 'category', s.category, 'years', s.years) order by s.name)
      from skills s where s.user_id = uid and s.status = 'confirmed'), '[]'),
    'stories', coalesce((select jsonb_agg(jsonb_build_object(
        'id', st.id, 'title', st.title, 'experience_id', st.experience_id, 'action', st.action,
        'result', st.result, 'metric', st.result_metric, 'confidence', st.result_confidence,
        'tags', st.tags, 'locked_wording', st.locked_wording) order by st.created_at)
      from stories st where st.user_id = uid and st.status = 'confirmed'), '[]'),
    'not_on_record', coalesce((select jsonb_agg(n.claim order by n.claim) from not_on_record n where n.user_id = uid), '[]'),
    'targets', (select to_jsonb(t) - 'user_id' - 'updated_at' from targets t where t.user_id = uid),
    'scoring', (select jsonb_build_object('version', c.version, 'cv_threshold', c.cv_threshold,
                   'queue_threshold', c.queue_threshold, 'weights', c.weights,
                   'location_points', c.location_points, 'rubric_anchors', c.rubric_anchors,
                   'benchmark_role', c.benchmark_role, 'rewrite_level', c.rewrite_level,
                   'factor_rules', c.factor_rules)
                from scoring_configs c where c.user_id = uid and c.is_active)
  );
$$;
revoke all on function public.build_profile_snapshot(uuid) from public, anon, authenticated;
