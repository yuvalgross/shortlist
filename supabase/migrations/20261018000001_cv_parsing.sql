-- Gate 1: profile from CV
-- Facts read from a CV land as status 'suggested'. They only become 'confirmed' when the user reviews them
-- (confirm_cv_upload). The profile snapshot, which the matching model reads, only contains confirmed facts.

-- ---------------------------------------------------------------------------
-- Upload lifecycle and audit
-- ---------------------------------------------------------------------------
alter table public.cv_uploads
  add column consent_at    timestamptz,
  add column error         text,
  add column parse_started_at timestamptz,
  add column parsed_at     timestamptz,
  add column confirmed_at  timestamptz,
  add column parse_model   text,
  add column parse_report  jsonb not null default '{}',  -- what the checks dropped and why
  add column text_chars    int;
alter table public.cv_uploads
  add constraint cv_uploads_status_chk
  check (parse_status in ('pending', 'parsing', 'parsed', 'failed', 'confirmed'));

-- ---------------------------------------------------------------------------
-- Review state on parsed facts, and a link back to the upload they came from
-- ---------------------------------------------------------------------------
alter table public.experiences
  add column status          public.fact_status not null default 'confirmed',
  add column work_mode       text,     -- onsite, hybrid, remote
  add column employment_type text;     -- full time, part time, freelance
alter table public.skills
  add column cv_upload_id uuid references public.cv_uploads (id) on delete set null;
alter table public.stories
  add column cv_upload_id uuid references public.cv_uploads (id) on delete set null;

create index on public.experiences (cv_upload_id);
create index on public.skills (cv_upload_id);
create index on public.stories (cv_upload_id);

-- ---------------------------------------------------------------------------
-- Snapshot: only confirmed experiences (skills and stories were already filtered)
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
                   'benchmark_role', c.benchmark_role, 'rewrite_level', c.rewrite_level)
                from scoring_configs c where c.user_id = uid and c.is_active)
  );
$$;
revoke all on function public.build_profile_snapshot(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Save a checked parse result. The web app has already dropped anything it could not
-- trace to a quote in the CV; this writes the rest in one transaction, as 'suggested'.
-- Re-parsing the same upload replaces its earlier unreviewed facts.
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
  inserted int;
  exp_ids jsonb := '[]';
  sugg_payload jsonb;
  prof jsonb := coalesce(p->'profile', '{}');
begin
  if uid is null then raise exception 'not signed in'; end if;
  if not exists (select 1 from cv_uploads where id = p_upload and user_id = uid) then
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
          coalesce(prof->'links', '[]'), coalesce(prof->'languages', '[]'), coalesce(prof->'education', '[]'),
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
    -- a role the user already confirmed (same company and title) is not added again
    select x.id into exp_id from experiences x where x.user_id = uid and x.status = 'confirmed'
       and lower(x.company) = lower(e->>'company') and lower(x.title) = lower(e->>'title') limit 1;
    if found then
      exp_ids := exp_ids || to_jsonb(exp_id::text);
      continue;
    end if;
    insert into experiences (user_id, cv_upload_id, title, ats_title, company, company_desc, location, work_mode,
                             employment_type, start_date, end_date, is_current, sort_order, source_type, source_quote, status)
    values (uid, p_upload, e->>'title', nullif(e->>'ats_title', ''), e->>'company', nullif(e->>'company_desc', ''),
            nullif(e->>'location', ''), nullif(e->>'work_mode', ''), nullif(e->>'employment_type', ''),
            nullif(e->>'start_date', '')::date, nullif(e->>'end_date', '')::date,
            coalesce((e->>'is_current')::boolean, false), n_exp, 'cv', e->>'quote', 'suggested')
    returning id into exp_id;
    exp_ids := exp_ids || to_jsonb(exp_id::text);
    n_exp := n_exp + 1;

    for r in select value from jsonb_array_elements(coalesce(e->'results', '[]')) loop
      insert into stories (user_id, cv_upload_id, experience_id, title, action, result, result_metric,
                           result_confidence, status, source_type, source_quote)
      values (uid, p_upload, exp_id, left(r->>'title', 120), r->>'text', nullif(r->>'result', ''),
              nullif(r->>'metric', ''), case when nullif(r->>'metric', '') is null then null else 'verified'::result_confidence end,
              'suggested', 'cv', r->>'quote');
      n_res := n_res + 1;
    end loop;
  end loop;

  for s in select value from jsonb_array_elements(coalesce(p->'skills', '[]')) loop
    insert into skills (user_id, cv_upload_id, name, category, status, source_type, source_quote)
    values (uid, p_upload, s->>'name', nullif(s->>'category', ''), 'suggested', 'cv', s->>'quote')
    on conflict (user_id, lower(name)) do nothing;
    get diagnostics inserted = row_count;
    n_skill := n_skill + inserted;
  end loop;

  for s in select value from jsonb_array_elements(coalesce(p->'suggestions', '[]')) loop
    sugg_payload := s->'payload';
    -- title suggestions point at a role by its position in this parse; store the saved role's id
    if sugg_payload ? 'experience_index' then
      if exp_ids->>((sugg_payload->>'experience_index')::int) is null then
        continue;
      end if;
      sugg_payload := sugg_payload || jsonb_build_object('experience_id', exp_ids->>((sugg_payload->>'experience_index')::int));
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
-- "Looks right, continue": everything the user kept from this upload becomes confirmed
-- ---------------------------------------------------------------------------
create or replace function public.confirm_cv_upload(p_upload uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  n_exp int; n_skill int; n_story int;
begin
  if uid is null then raise exception 'not signed in'; end if;
  if not exists (select 1 from cv_uploads where id = p_upload and user_id = uid and parse_status in ('parsed', 'confirmed')) then
    raise exception 'upload not ready to confirm';
  end if;
  update experiences set status = 'confirmed' where cv_upload_id = p_upload and user_id = uid and status = 'suggested';
  get diagnostics n_exp = row_count;
  update skills set status = 'confirmed' where cv_upload_id = p_upload and user_id = uid and status = 'suggested';
  get diagnostics n_skill = row_count;
  update stories set status = 'confirmed' where cv_upload_id = p_upload and user_id = uid and status = 'suggested';
  get diagnostics n_story = row_count;
  update cv_uploads set parse_status = 'confirmed', confirmed_at = now() where id = p_upload;
  return jsonb_build_object('experiences', n_exp, 'skills', n_skill, 'stories', n_story);
end $$;

-- ---------------------------------------------------------------------------
-- Suggestion buttons. Rejecting is a plain update (already allowed). Accepting applies the change.
-- ---------------------------------------------------------------------------
create or replace function public.accept_suggestion(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  sg suggestions%rowtype;
  exp_id uuid;
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
     where id = (sg.payload->>'experience_id')::uuid and user_id = uid;
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
-- Permissions: signed in users only
-- ---------------------------------------------------------------------------
revoke all on function public.apply_cv_parse(uuid, jsonb) from public, anon;
revoke all on function public.confirm_cv_upload(uuid) from public, anon;
revoke all on function public.accept_suggestion(uuid) from public, anon;
grant execute on function public.apply_cv_parse(uuid, jsonb) to authenticated;
grant execute on function public.confirm_cv_upload(uuid) to authenticated;
grant execute on function public.accept_suggestion(uuid) to authenticated;

comment on function public.apply_cv_parse(uuid, jsonb) is
  'SECURITY DEFINER on purpose: writes a checked parse atomically, including suggestions, for auth.uid() only.';
comment on function public.confirm_cv_upload(uuid) is
  'SECURITY DEFINER on purpose: confirms the caller''s own facts from one upload.';
comment on function public.accept_suggestion(uuid) is
  'SECURITY DEFINER on purpose: applies one of the caller''s own pending suggestions.';
