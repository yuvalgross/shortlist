-- Gate 1 review fixes (Oct 18 2026, evening). Each block answers a failing test in supabase/tests/review.test.mjs.
-- None crossed user boundaries.
--  D1  two stints with the same title at one company in one CV were collapsed into one
--  D2  a skill listed by an older unreviewed upload stayed 'suggested' after confirming the newer one
--  D3  roles from an older unreviewed upload stayed 'suggested' after "Looks right, continue"
--  D4  a second CV's new bullets under an already confirmed role were dropped silently
--  and sort_order now follows the role's position in the CV (it restarted per upload and interleaved)


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
  position_in_cv int := 0;
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
    position_in_cv := position_in_cv + 1;

    -- a role the user already confirmed (same company and title) is not added again
    select x.id into exp_id from experiences x where x.user_id = uid and x.status = 'confirmed'
       and lower(x.company) = lower(e->>'company') and lower(x.title) = lower(e->>'title') limit 1;
    if found then
      -- the role is not added again, but bullets this CV adds under it are saved for review
      exp_ids := exp_ids || to_jsonb(exp_id::text);
      n_role_results := 0;
      for r in select value from jsonb_array_elements(coalesce(e->'results', '[]')) loop
        exit when n_role_results >= 15;
        n_role_results := n_role_results + 1;
        continue when exists (select 1 from stories st where st.user_id = uid and st.experience_id = exp_id
                                and lower(st.source_quote) = lower(r->>'quote'));
        insert into stories (user_id, cv_upload_id, experience_id, title, action, result, result_metric,
                             result_confidence, status, source_type, source_quote)
        values (uid, p_upload, exp_id, left(coalesce(nullif(r->>'title', ''), 'Result'), 120), r->>'text', nullif(r->>'result', ''),
                nullif(r->>'metric', ''), case when nullif(r->>'metric', '') is null then null else 'verified'::result_confidence end,
                'suggested', 'cv', r->>'quote');
        n_res := n_res + 1;
      end loop;
      continue;
    end if;
    -- the same role still unreviewed from an EARLIER upload: this upload's version replaces it.
    -- Rows of this upload are left alone, so two stints with the same title at one company both stay.
    delete from stories where user_id = uid and status = 'suggested' and experience_id in (
      select x.id from experiences x where x.user_id = uid and x.status = 'suggested'
        and x.cv_upload_id is distinct from p_upload
        and lower(x.company) = lower(e->>'company') and lower(x.title) = lower(e->>'title'));
    delete from experiences x where x.user_id = uid and x.status = 'suggested'
      and x.cv_upload_id is distinct from p_upload
      and lower(x.company) = lower(e->>'company') and lower(x.title) = lower(e->>'title');

    insert into experiences (user_id, cv_upload_id, title, ats_title, company, company_desc, location, work_mode,
                             employment_type, start_date, end_date, is_current, sort_order, source_type, source_quote, status)
    values (uid, p_upload, e->>'title', nullif(e->>'ats_title', ''), e->>'company', nullif(e->>'company_desc', ''),
            nullif(e->>'location', ''), nullif(e->>'work_mode', ''), nullif(e->>'employment_type', ''),
            nullif(e->>'start_date', '')::date, nullif(e->>'end_date', '')::date,
            coalesce((e->>'is_current')::boolean, false), position_in_cv, 'cv', nullif(e->>'quote', ''), 'suggested')
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
    -- the same skill twice in one CV counts once
    continue when exists (select 1 from skills k where k.user_id = uid and k.cv_upload_id = p_upload
                            and lower(k.name) = lower(s->>'name'));
    insert into skills (user_id, cv_upload_id, name, category, status, source_type, source_quote)
    values (uid, p_upload, s->>'name', nullif(s->>'category', ''), 'suggested', 'cv', s->>'quote')
    -- a skill still waiting for review moves to the newest upload that lists it
    on conflict (user_id, lower(name)) do update
      set cv_upload_id = excluded.cv_upload_id, source_quote = excluded.source_quote
      where skills.status = 'suggested';
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


-- "Looks right, continue" confirms everything the review screen showed: every unreviewed fact of this user,
-- whichever upload it came from, and closes every upload that was waiting for review.
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
  update experiences set status = 'confirmed' where user_id = uid and status = 'suggested';
  get diagnostics n_exp = row_count;
  update skills set status = 'confirmed' where user_id = uid and status = 'suggested';
  get diagnostics n_skill = row_count;
  update stories set status = 'confirmed' where user_id = uid and status = 'suggested';
  get diagnostics n_story = row_count;
  update cv_uploads set parse_status = 'confirmed', confirmed_at = now()
   where user_id = uid and (id = p_upload or parse_status = 'parsed');
  return jsonb_build_object('experiences', n_exp, 'skills', n_skill, 'stories', n_story);
end $$;

revoke all on function public.apply_cv_parse(uuid, jsonb) from public, anon;
revoke all on function public.confirm_cv_upload(uuid) from public, anon;
grant execute on function public.apply_cv_parse(uuid, jsonb) to authenticated;
grant execute on function public.confirm_cv_upload(uuid) to authenticated;
