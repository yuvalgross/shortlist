-- Gate 2: score one pasted job.
--
-- A user can paste a job ad and have it scored with their own rules. The pasted job and its company are
-- private to that user: other users never see what someone is applying to. Jobs the worker finds stay shared.
-- The web app calls score_pasted_job() with the checked result; the factor trigger from 20261030000001
-- turns the factor labels into points, and the flag trigger below marks companies that rejected the user lately.

-- ---------------------------------------------------------------------------
-- 1. Private rows for pasted jobs
-- ---------------------------------------------------------------------------
alter table public.companies add column added_by uuid references auth.users (id) on delete cascade;
alter table public.jobs      add column added_by uuid references auth.users (id) on delete cascade;
create index companies_added_by_idx on public.companies (added_by) where added_by is not null;
create index jobs_added_by_idx      on public.jobs (added_by) where added_by is not null;

-- A pasted job always sits under a company row of the same user.
alter table public.jobs add constraint jobs_pasted_url_chk check (added_by is null or length(url) between 1 and 2000);

drop policy companies_read_all on public.companies;
drop policy jobs_read_all on public.jobs;
create policy companies_read on public.companies for select to authenticated
  using (added_by is null or added_by = (select auth.uid()));
create policy jobs_read on public.jobs for select to authenticated
  using (added_by is null or added_by = (select auth.uid()));

-- Removing a pasted job: delete its company row; the job and its score go with it.
create policy companies_delete_own_pasted on public.companies for delete to authenticated
  using (added_by = (select auth.uid()));
grant delete on public.companies to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The profile the matching model reads, for the signed in user only
-- ---------------------------------------------------------------------------
create or replace function public.my_profile_snapshot() returns jsonb
language sql stable security definer set search_path = public as $$
  select public.build_profile_snapshot(auth.uid())
$$;
revoke all on function public.my_profile_snapshot() from public, anon;
grant execute on function public.my_profile_snapshot() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Save a scored pasted job
-- ---------------------------------------------------------------------------
-- p = {
--   company: {name, headcount?, headcount_source?},
--   job:     {title, url?, description, location_text?, remote_type?, salary_min?, salary_max?,
--             salary_currency?, salary_period?, salary_is_ote?},
--   match:   {role_fit, location_points, factors, reasons, location_note?, factor_scores?}
-- }
-- The score belongs to the user who pasted the job, so they can only ever change their own numbers.
create or replace function public.score_pasted_job(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  cfg uuid;
  co uuid;
  jb uuid;
  m uuid;
  c jsonb := coalesce(p->'company', '{}');
  j jsonb := coalesce(p->'job', '{}');
  s jsonb := coalesce(p->'match', '{}');
  v_name text := left(btrim(coalesce(c->>'name', '')), 200);
  v_title text := left(btrim(coalesce(j->>'title', '')), 300);
  v_desc text := coalesce(j->>'description', '');
  v_url text := left(btrim(coalesce(nullif(j->>'url', ''), 'pasted')), 2000);
begin
  if uid is null then raise exception 'not signed in'; end if;
  if v_name = '' then v_name := 'Unknown company'; end if;
  if v_title = '' then v_title := 'Untitled role'; end if;
  if length(v_desc) < 200 then raise exception 'the job text is too short to score'; end if;
  if length(v_desc) > 40000 then raise exception 'the job text is too long (40,000 characters at most)'; end if;
  if jsonb_typeof(s->'role_fit') is distinct from 'number' or jsonb_typeof(s->'location_points') is distinct from 'number' then
    raise exception 'role_fit and location_points are required';
  end if;

  select id into cfg from scoring_configs where user_id = uid and is_active;
  if cfg is null then cfg := public.set_scoring_config('{}'::jsonb); end if;

  insert into companies (name, headcount, headcount_source, headcount_checked_at, added_by)
  values (v_name,
          nullif(c->>'headcount', '')::int,
          case when nullif(c->>'headcount', '') is null then null else coalesce(c->>'headcount_source', 'other') end,
          case when nullif(c->>'headcount', '') is null then null else now() end,
          uid)
  returning id into co;

  insert into jobs (company_id, external_id, title, location_text, remote_type, url, description, status,
                    salary_min, salary_max, salary_currency, salary_period, salary_is_ote, found_via, added_by,
                    last_verified_at)
  values (co, 'pasted:' || gen_random_uuid(), v_title,
          left(nullif(j->>'location_text', ''), 300),
          case when j->>'remote_type' in ('onsite', 'hybrid', 'remote') then j->>'remote_type' end,
          v_url, v_desc, 'unverified',
          nullif(j->>'salary_min', '')::int, nullif(j->>'salary_max', '')::int,
          left(nullif(j->>'salary_currency', ''), 3), nullif(j->>'salary_period', ''),
          coalesce((j->>'salary_is_ote')::boolean, false), '{pasted}', uid, null)
  returning id into jb;

  insert into job_matches (user_id, job_id, config_id, role_fit, location_points, factors, reasons,
                           location_note, factor_scores)
  values (uid, jb, cfg, (s->>'role_fit')::numeric, (s->>'location_points')::numeric,
          coalesce(s->'factors', '{}'), coalesce(s->'reasons', '{"plus":[],"minus":[]}'),
          left(nullif(s->>'location_note', ''), 300), coalesce(s->'factor_scores', '{}'))
  returning id into m;

  return jsonb_build_object('match_id', m, 'job_id', jb, 'company_id', co);
end $$;
revoke all on function public.score_pasted_job(jsonb) from public, anon;
grant execute on function public.score_pasted_job(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Flag: this company rejected the user in the last 60 days (scan rule of 10-27: a done story).
--    A flag only, never points. Runs after the factor trigger, which resets flags.
-- ---------------------------------------------------------------------------
create or replace function public.job_match_rejection_flag() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cname text;
begin
  select lower(btrim(co.name)) into cname from jobs jb join companies co on co.id = jb.company_id where jb.id = new.job_id;
  if cname is not null and exists (
       select 1 from applications a
        where a.user_id = new.user_id and a.stage = 'rejected'
          and lower(btrim(a.company)) = cname
          and greatest(a.created_at, coalesce(a.user_edited_at, a.created_at)) >= now() - interval '60 days')
     and not ('rejected_here_recently' = any(new.flags)) then
    new.flags := array_append(new.flags, 'rejected_here_recently');
  end if;
  return new;
end $$;
revoke all on function public.job_match_rejection_flag() from public, anon, authenticated;

-- Trigger names run in alphabetical order: t_job_matches_factors first, then this one.
create trigger t_job_matches_rejection before insert or update on public.job_matches
  for each row execute function public.job_match_rejection_flag();
