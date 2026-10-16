-- Row level security, grants and the profile snapshot (Gate 0)
-- Rule: a signed in user can only ever touch rows where user_id = auth.uid().
-- Scores, CV results, runs and usage are written by the worker (service role) and are read only for users,
-- apart from a few columns users are allowed to change (match status, CV "sent", suggestion decision).

-- Start from nothing, then grant only what is needed.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- Tables the user fully owns (read, add, change, delete their own rows)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'profiles', 'cv_uploads', 'experiences', 'skills', 'stories', 'not_on_record',
    'targets', 'applications', 'transcripts', 'notification_prefs', 'user_watchlist'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
      t || '_own_rows', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Tables the worker writes; the user reads, and may change only listed columns
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'suggestions', 'job_matches', 'cv_documents', 'scan_runs', 'leads', 'usage_monthly', 'scoring_configs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (user_id = (select auth.uid()))', t || '_read_own', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- Suggestion buttons: accept or reject
create policy suggestions_decide_own on public.suggestions for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant update (status, decided_at) on public.suggestions to authenticated;

-- Review queue: approve, skip, flag "score looks wrong"
create policy job_matches_decide_own on public.job_matches for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant update (status, flag_reason) on public.job_matches to authenticated;

-- CVs: mark as sent, or delete one
create policy cv_documents_mark_own on public.cv_documents for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy cv_documents_delete_own on public.cv_documents for delete to authenticated
  using (user_id = (select auth.uid()));
grant update (sent) on public.cv_documents to authenticated;
grant delete on public.cv_documents to authenticated;

-- Leads: user may remove a lead
create policy leads_delete_own on public.leads for delete to authenticated using (user_id = (select auth.uid()));
grant delete on public.leads to authenticated;

-- Scoring config is versioned: users never edit a version in place, they call set_scoring_config().

-- ---------------------------------------------------------------------------
-- Shared tables: readable by signed in users, written only by the worker
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['companies', 'sources', 'jobs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read_all', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Scoring config: create a new version and make it the active one
-- ---------------------------------------------------------------------------
create or replace function public.set_scoring_config(cfg jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  next_version int;
  new_id uuid;
begin
  if uid is null then raise exception 'not signed in'; end if;
  if (cfg ? 'cv_threshold') and ((cfg->>'cv_threshold')::numeric not between 5 and 10) then
    raise exception 'cv_threshold must be between 5 and 10';
  end if;
  if (cfg ? 'weights') and (
      select coalesce(sum(value::numeric), 0) from jsonb_each_text(cfg->'weights')) <> 100 then
    raise exception 'weights must add up to 100';
  end if;

  select coalesce(max(version), 0) + 1 into next_version from scoring_configs where user_id = uid;
  update scoring_configs set is_active = false where user_id = uid and is_active;

  insert into scoring_configs (user_id, version, is_active, cv_threshold, queue_threshold, weights,
                               location_points, rubric_anchors, benchmark_role, daily_scan_limit,
                               cv_cap_per_run, rewrite_level)
  values (uid, next_version, true,
          coalesce((cfg->>'cv_threshold')::numeric, 8.0),
          coalesce((cfg->>'queue_threshold')::numeric, 7.0),
          coalesce(cfg->'weights', '{"skills":35,"seniority":20,"location":15,"salary":15,"industry":15}'),
          coalesce(cfg->'location_points', '[{"match":"home_city","points":1.5},{"match":"remote_home_region","points":1.5},{"match":"relocation","points":0}]'),
          coalesce(cfg->'rubric_anchors', '{}'),
          cfg->'benchmark_role',
          least(coalesce((cfg->>'daily_scan_limit')::int, 40), 80),
          least(coalesce((cfg->>'cv_cap_per_run')::int, 3), 5),
          coalesce(cfg->>'rewrite_level', 'balanced'))
  returning id into new_id;
  return new_id;
end $$;
grant execute on function public.set_scoring_config(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Profile snapshot: the compact JSON the matching model reads (and the cached prompt prefix)
-- Rebuilt automatically whenever the profile, skills, stories, exclusions, targets or active config change.
-- ---------------------------------------------------------------------------
create table public.profile_snapshots (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  snapshot  jsonb not null,
  built_at  timestamptz not null default now()
);
alter table public.profile_snapshots enable row level security;
alter table public.profile_snapshots force row level security;
create policy profile_snapshots_read_own on public.profile_snapshots for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.profile_snapshots to authenticated;

create or replace function public.build_profile_snapshot(uid uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'profile', (select to_jsonb(p) - 'user_id' - 'created_at' - 'updated_at' - 'phone' - 'contact_email'
                from profiles p where p.user_id = uid),
    'experiences', coalesce((select jsonb_agg(jsonb_build_object(
        'id', e.id, 'title', e.title, 'ats_title', e.ats_title, 'company', e.company,
        'company_desc', e.company_desc, 'location', e.location,
        'start', e.start_date, 'end', e.end_date, 'current', e.is_current) order by e.sort_order)
      from experiences e where e.user_id = uid), '[]'),
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
                   'benchmark_role', c.benchmark_role, 'rewrite_level', c.rewrite_level)
                from scoring_configs c where c.user_id = uid and c.is_active)
  );
$$;

create or replace function public.refresh_profile_snapshot(uid uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if uid is null or not exists (select 1 from auth.users where id = uid) then return; end if;
  insert into profile_snapshots (user_id, snapshot, built_at)
  values (uid, build_profile_snapshot(uid), now())
  on conflict (user_id) do update set snapshot = excluded.snapshot, built_at = excluded.built_at;
end $$;

create or replace function public.snapshot_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then perform refresh_profile_snapshot(old.user_id); end if;
  if tg_op in ('INSERT', 'UPDATE') and (tg_op = 'INSERT' or new.user_id is distinct from old.user_id) then
    perform refresh_profile_snapshot(new.user_id);
  end if;
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['profiles', 'experiences', 'skills', 'stories', 'not_on_record', 'targets', 'scoring_configs'] loop
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function public.snapshot_trigger()',
      't_' || t || '_snapshot', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Retention: transcripts past their delete_after date (scheduled by the worker or pg_cron)
-- ---------------------------------------------------------------------------
create or replace function public.purge_expired_transcripts() returns int
language sql security definer set search_path = public as $$
  with gone as (delete from transcripts where delete_after < current_date returning 1)
  select count(*)::int from gone;
$$;

-- Objects created in this file after the opening revoke picked up Supabase's default grants; take them back.
revoke all on public.profile_snapshots from anon, authenticated;
grant select on public.profile_snapshots to authenticated;
revoke all on function public.set_scoring_config(jsonb) from public, anon;
revoke all on function public.snapshot_trigger() from public, anon, authenticated;

-- Internal functions are for the worker only
revoke all on function public.build_profile_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.refresh_profile_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.purge_expired_transcripts() from public, anon, authenticated;
