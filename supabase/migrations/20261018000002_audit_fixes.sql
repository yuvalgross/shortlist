-- Gate 1 audit fixes (Oct 18 2026). Each block answers one finding in supabase/tests/audit.test.mjs.
-- None of the findings allowed one user to reach another user's data; they are integrity and performance fixes.

-- ---------------------------------------------------------------------------
-- 1. Snapshot: unreviewed ("suggested") rows never appear in the snapshot, so changes to them
--    must not rebuild it. Before this, a CV with 10 roles, 50 results and 30 skills rebuilt it 91 times.
-- ---------------------------------------------------------------------------
create or replace function public.snapshot_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  old_status text := case when tg_op in ('UPDATE', 'DELETE') then (to_jsonb(old)->>'status') end;
  new_status text := case when tg_op in ('INSERT', 'UPDATE') then (to_jsonb(new)->>'status') end;
  has_status boolean := (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ? 'status';
begin
  -- tables with a review status: only confirmed rows are in the snapshot
  if has_status and coalesce(old_status, '') <> 'confirmed' and coalesce(new_status, '') <> 'confirmed' then
    return null;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then perform refresh_profile_snapshot(old.user_id); end if;
  if tg_op in ('INSERT', 'UPDATE') and (tg_op = 'INSERT' or new.user_id is distinct from old.user_id) then
    perform refresh_profile_snapshot(new.user_id);
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Scoring config: lower bounds and allowed values, in the function and as table constraints
-- ---------------------------------------------------------------------------
alter table public.scoring_configs
  add constraint scoring_configs_cv_threshold_chk check (cv_threshold between 5 and 10),
  add constraint scoring_configs_queue_threshold_chk check (queue_threshold between 0 and 10),
  add constraint scoring_configs_daily_scan_limit_chk check (daily_scan_limit between 1 and 80),
  add constraint scoring_configs_cv_cap_chk check (cv_cap_per_run between 0 and 5),
  add constraint scoring_configs_rewrite_level_chk check (rewrite_level in ('light', 'balanced', 'strong'));

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

  select coalesce(max(version), 0) + 1 into next_version from scoring_configs where user_id = uid;
  update scoring_configs set is_active = false where user_id = uid and is_active;

  insert into scoring_configs (user_id, version, is_active, cv_threshold, queue_threshold, weights,
                               location_points, rubric_anchors, benchmark_role, daily_scan_limit,
                               cv_cap_per_run, rewrite_level)
  values (uid, next_version, true, v_cv, v_queue,
          coalesce(cfg->'weights', '{"skills":35,"seniority":20,"location":15,"salary":15,"industry":15}'),
          coalesce(cfg->'location_points', '[{"match":"home_city","points":1.5},{"match":"remote_home_region","points":1.5},{"match":"relocation","points":0}]'),
          coalesce(cfg->'rubric_anchors', '{}'),
          cfg->'benchmark_role',
          v_daily, v_cap, v_level)
  returning id into new_id;
  return new_id;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Indexes for every user_id and foreign key column (row level security filters on user_id)
-- ---------------------------------------------------------------------------
create index on public.cv_uploads (user_id, created_at desc);
create index on public.not_on_record (user_id);
create index on public.transcripts (user_id);
create index on public.leads (user_id);
create index on public.job_matches (job_id);
create index on public.job_matches (config_id);
create index on public.stories (experience_id);
create index on public.applications (job_id);
create index on public.cv_documents (job_id);
create index on public.cv_documents (application_id);
create index on public.transcripts (application_id);
create index on public.user_watchlist (company_id);

-- ---------------------------------------------------------------------------
-- 4. Deleting an upload removes the unreviewed facts that came from it (confirmed facts stay)
-- ---------------------------------------------------------------------------
create or replace function public.cv_upload_cleanup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from stories where cv_upload_id = old.id and status = 'suggested';
  delete from skills where cv_upload_id = old.id and status = 'suggested';
  delete from experiences where cv_upload_id = old.id and status = 'suggested';
  delete from suggestions where user_id = old.user_id and status = 'pending' and source_ref = old.id::text;
  return old;
end $$;
create trigger t_cv_uploads_cleanup before delete on public.cv_uploads
  for each row execute function public.cv_upload_cleanup();

-- ---------------------------------------------------------------------------
-- 6. A decided suggestion stays decided: the update policy only reaches pending rows
-- ---------------------------------------------------------------------------
drop policy suggestions_decide_own on public.suggestions;
create policy suggestions_decide_own on public.suggestions for update to authenticated
  using (user_id = (select auth.uid()) and status = 'pending')
  with check (user_id = (select auth.uid()) and status in ('accepted', 'rejected'));

-- ---------------------------------------------------------------------------
-- 7. The list columns on profiles are always JSON arrays
-- ---------------------------------------------------------------------------
alter table public.profiles
  add constraint profiles_links_chk check (jsonb_typeof(links) = 'array'),
  add constraint profiles_languages_chk check (jsonb_typeof(languages) = 'array'),
  add constraint profiles_education_chk check (jsonb_typeof(education) = 'array');

-- ---------------------------------------------------------------------------
-- 5, 7, 9. apply_cv_parse:
--   - the same role read from an earlier upload is replaced by this upload's version (newest unreviewed wins),
--     while a confirmed role is still never duplicated
--   - JSON null in a list field is treated as an empty list
--   - a negative experience_index is skipped instead of pointing at the last role
--   - the per role / per CV limits the web app applies are also enforced here
-- ---------------------------------------------------------------------------
create or replace function public.apply_cv_parse(p_upload uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  e jsonb;
  r jsonb;
  s jsonb;
  exp_id uuid;
  n_exp int := 0;
  n_res int := 0;
  n_skill int := 0;
  n_sugg int := 0;
  n_role_results int;
  inserted int;
  exp_ids jsonb := '[]';
  sugg_payload jsonb;
  sugg_index int;
  prof jsonb := coalesce(p->'profile', '{}');
begin
  if uid is null then raise exception 'not signed in'; end if;
  if not exists (select 1 from cv_uploads where id = p_upload and user_id = uid and parse_status <> 'confirmed') then
    raise exception 'upload not found';
  end if;

  -- replace earlier unreviewed facts from this upload
  delete from stories where cv_upload_id = p_upload and user_id = uid and status = 'suggested';
  delete from skills where cv_upload_id = p_upload and user_id = uid and status = 'suggested';
  delete from experiences where cv_upload_id = p_upload and user_id = uid and status = 'suggested';
  delete from suggestions where user_id = uid and status = 'pending' and source_ref = p_upload::text;

  -- profile: fill empty fields only, never overwrite what the user already has
  insert into profiles (user_id, full_name, headline, location, phone, contact_email, links, languages, education, certifications)
  values (uid,
          nullif(prof->>'full_name', ''), nullif(prof->>'headline', ''), nullif(prof->>'location', ''),
          nullif(prof->>'phone', ''), nullif(prof->>'email', ''),
          case when jsonb_typeof(prof->'links') = 'array' then prof->'links' else '[]'::jsonb end,
          case when jsonb_typeof(prof->'languages') = 'array' then prof->'languages' else '[]'::jsonb end,
          case when jsonb_typeof(prof->'education') = 'array' then prof->'education' else '[]'::jsonb end,
          nullif(prof->>'certifications', ''))
  on conflict (user_id) do update set
    full_name      = coalesce(profiles.full_name, excluded.full_name),
    headline       = coalesce(profiles.headline, excluded.headline),
    location       = coalesce(profiles.location, excluded.location),
    phone          = coalesce(profiles.phone, excluded.phone),
    contact_email  = coalesce(profiles.contact_email, excluded.contact_email),
    links          = case when profiles.links = '[]'::jsonb then excluded.links else profiles.links end,
    languages      = case when profiles.languages = '[]'::jsonb then excluded.languages else profiles.languages end,
    education      = case when profiles.education = '[]'::jsonb then excluded.education else profiles.education end,
    certifications = coalesce(profiles.certifications, excluded.certifications);

  for e in select value from jsonb_array_elements(coalesce(p->'experiences', '[]')) loop
    exit when n_exp >= 25;
    if coalesce(e->>'title', '') = '' or coalesce(e->>'company', '') = '' then continue; end if;

    -- a role the user already confirmed (same company and title) is not added again
    select x.id into exp_id from experiences x where x.user_id = uid and x.status = 'confirmed'
       and lower(x.company) = lower(e->>'company') and lower(x.title) = lower(e->>'title') limit 1;
    if found then
      exp_ids := exp_ids || to_jsonb(exp_id::text);
      continue;
    end if;
    -- the same role still unreviewed from an earlier upload: this upload's version replaces it
    delete from stories where user_id = uid and status = 'suggested' and experience_id in (
      select x.id from experiences x where x.user_id = uid and x.status = 'suggested'
        and lower(x.company) = lower(e->>'company') and lower(x.title) = lower(e->>'title'));
    delete from experiences x where x.user_id = uid and x.status = 'suggested'
      and lower(x.company) = lower(e->>'company') and lower(x.title) = lower(e->>'title');

    insert into experiences (user_id, cv_upload_id, title, ats_title, company, company_desc, location, work_mode,
                             employment_type, start_date, end_date, is_current, sort_order, source_type, source_quote, status)
    values (uid, p_upload, e->>'title', nullif(e->>'ats_title', ''), e->>'company', nullif(e->>'company_desc', ''),
            nullif(e->>'location', ''), nullif(e->>'work_mode', ''), nullif(e->>'employment_type', ''),
            nullif(e->>'start_date', '')::date, nullif(e->>'end_date', '')::date,
            coalesce((e->>'is_current')::boolean, false), n_exp, 'cv', nullif(e->>'quote', ''), 'suggested')
    returning id into exp_id;
    exp_ids := exp_ids || to_jsonb(exp_id::text);
    n_exp := n_exp + 1;

    n_role_results := 0;
    for r in select value from jsonb_array_elements(coalesce(e->'results', '[]')) loop
      exit when n_role_results >= 15;
      insert into stories (user_id, cv_upload_id, experience_id, title, action, result, result_metric,
                           result_confidence, status, source_type, source_quote)
      values (uid, p_upload, exp_id, left(coalesce(nullif(r->>'title', ''), 'Result'), 120), r->>'text', nullif(r->>'result', ''),
              nullif(r->>'metric', ''), case when nullif(r->>'metric', '') is null then null else 'verified'::result_confidence end,
              'suggested', 'cv', r->>'quote');
      n_res := n_res + 1;
      n_role_results := n_role_results + 1;
    end loop;
  end loop;

  for s in select value from jsonb_array_elements(coalesce(p->'skills', '[]')) loop
    exit when n_skill >= 80;
    if coalesce(s->>'name', '') = '' then continue; end if;
    insert into skills (user_id, cv_upload_id, name, category, status, source_type, source_quote)
    values (uid, p_upload, s->>'name', nullif(s->>'category', ''), 'suggested', 'cv', s->>'quote')
    on conflict (user_id, lower(name)) do nothing;
    get diagnostics inserted = row_count;
    n_skill := n_skill + inserted;
  end loop;

  for s in select value from jsonb_array_elements(coalesce(p->'suggestions', '[]')) loop
    exit when n_sugg >= 8;
    sugg_payload := coalesce(s->'payload', '{}');
    -- title suggestions point at a role by its position in this parse; store the saved role's id
    if sugg_payload ? 'experience_index' then
      sugg_index := (sugg_payload->>'experience_index')::int;
      if sugg_index is null or sugg_index < 0 or exp_ids->>sugg_index is null then
        continue;
      end if;
      sugg_payload := sugg_payload || jsonb_build_object('experience_id', exp_ids->>sugg_index);
    end if;
    insert into suggestions (user_id, kind, payload, fingerprint, source_quote, source_ref, status)
    values (uid, (s->>'kind')::suggestion_kind, sugg_payload, s->>'fingerprint', s->>'quote', p_upload::text, 'pending')
    on conflict (user_id, kind, fingerprint) do nothing;   -- a rejected suggestion never comes back
    get diagnostics inserted = row_count;
    n_sugg := n_sugg + inserted;
  end loop;

  update cv_uploads
     set parse_status = 'parsed', parsed_at = now(), error = null,
         parse_model = p->>'model', parse_report = coalesce(p->'report', '{}')
   where id = p_upload;

  return jsonb_build_object('experiences', n_exp, 'results', n_res, 'skills', n_skill, 'suggestions', n_sugg);
end $$;

-- ---------------------------------------------------------------------------
-- 8. Accepting a title suggestion for a role that no longer exists is an error, not a silent success
-- ---------------------------------------------------------------------------
create or replace function public.accept_suggestion(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  sg suggestions%rowtype;
  exp_id uuid;
  touched int;
begin
  if uid is null then raise exception 'not signed in'; end if;
  select * into sg from suggestions where id = p_id and user_id = uid and status = 'pending';
  if not found then raise exception 'suggestion not found'; end if;

  if sg.kind = 'skill' then
    insert into skills (user_id, name, category, status, source_type, source_ref, source_quote)
    values (uid, sg.payload->>'name', nullif(sg.payload->>'category', ''), 'confirmed', 'suggestion', sg.id::text, sg.source_quote)
    on conflict (user_id, lower(name)) do update set status = 'confirmed';
  elsif sg.kind = 'title' then
    update experiences set ats_title = sg.payload->>'ats_title'
     where id = nullif(sg.payload->>'experience_id', '')::uuid and user_id = uid;
    get diagnostics touched = row_count;
    if touched = 0 then raise exception 'the role this suggestion belongs to no longer exists'; end if;
  elsif sg.kind = 'story' then
    exp_id := nullif(sg.payload->>'experience_id', '')::uuid;
    if exp_id is not null and not exists (select 1 from experiences where id = exp_id and user_id = uid) then
      exp_id := null;
    end if;
    insert into stories (user_id, experience_id, title, action, result_metric, status, source_type, source_quote)
    values (uid, exp_id, left(sg.payload->>'title', 120), sg.payload->>'text', nullif(sg.payload->>'metric', ''),
            'confirmed', 'suggestion', sg.source_quote);
  else
    raise exception 'this suggestion type cannot be applied yet';
  end if;

  update suggestions set status = 'accepted', decided_at = now() where id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- 10. leads.updated_at was the one updated_at column without a touch trigger
-- ---------------------------------------------------------------------------
create trigger t_leads_touch before update on public.leads
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Permissions: the cleanup trigger function is internal
-- ---------------------------------------------------------------------------
revoke all on function public.cv_upload_cleanup() from public, anon, authenticated;
