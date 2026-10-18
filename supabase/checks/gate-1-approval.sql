-- Gate 1 approval check. READ ONLY. Run after an account has uploaded a CV and the parse finished.
-- Replace the email in the first CTE. Each row is one check with pass/fail and detail.
with me as (
  select id from auth.users where email = 'REPLACE_WITH_EMAIL'
), up as (
  select u.* from cv_uploads u join me on u.user_id = me.id order by u.created_at desc limit 1
), norm as (
  select lower(regexp_replace(translate(up.parsed_text, '•·', '  '), '\s+', ' ', 'g')) as cv from up
), bullets as (
  -- every bullet in the CV text (cv_engine CVs use "•")
  -- first line after each "•"; header separators like "Title • City" are short, so length filters them out
  select trim(split_part(b, E'\n', 1)) as bullet
  -- only the work history: skills lines also start with "•" but are not results
  from up, regexp_split_to_table(coalesce(substring(up.parsed_text from 'WORK EXPERIENCE.*'), up.parsed_text), '•') with ordinality as t(b, i)
  where i > 1 and length(trim(split_part(b, E'\n', 1))) > 40
), stories_of as (
  select s.* from stories s join me on s.user_id = me.id where s.cv_upload_id = (select id from up)
), facts as (
  select 'experience' as kind, e.title || ' @ ' || e.company as item, e.source_quote as quote
    from experiences e join me on e.user_id = me.id where e.cv_upload_id = (select id from up)
  union all select 'result', s.title, s.source_quote from stories_of s
  union all select 'skill', k.name, k.source_quote from skills k join me on k.user_id = me.id where k.cv_upload_id = (select id from up)
)
select 1 as n, 'upload finished' as check_name,
       (select parse_status in ('parsed', 'confirmed') from up) as pass,
       (select parse_status || coalesce(' / ' || error, '') || ' / model ' || coalesce(parse_model, '?') from up) as detail
union all
select 2, 'every saved fact quotes the CV word for word',
       -- a role may have no quote (its line was not found in the CV, so it is not shown); everything else needs one
       not exists (select 1 from facts, norm where (facts.quote is null and facts.kind <> 'experience')
                   or position(lower(regexp_replace(translate(facts.quote, '•·', '  '), '\s+', ' ', 'g')) in norm.cv) = 0),
       (select count(*) || ' facts checked' from facts)
union all
select 3, 'bullet coverage (share of CV bullets saved as results)',
       (select count(*) filter (where exists (select 1 from stories_of s where position(lower(left(s.source_quote, 40)) in lower(b.bullet)) > 0))::numeric
               / nullif(count(*), 0) >= 0.9 from bullets b),
       (select count(*) filter (where exists (select 1 from stories_of s where position(lower(left(s.source_quote, 40)) in lower(b.bullet)) > 0))
               || ' of ' || count(*) || ' bullets' from bullets b)
union all
select 4, 'results with a number', true,
       (select count(*) filter (where result_metric is not null) || ' of ' || count(*) || ' results' from stories_of)
union all
select 5, 'roles found (expected: OEB/CloserStill, Pragma GTM, CoachHub, Luns, plus Boogie and DotC if listed)',
       (select count(*) >= 4 from experiences e join me on e.user_id = me.id where e.cv_upload_id = (select id from up)),
       (select string_agg(e.company || ' ' || coalesce(to_char(e.start_date, 'YYYY-MM'), '?') || ' to '
               || case when e.is_current then 'present' else coalesce(to_char(e.end_date, 'YYYY-MM'), '?') end, '; ' order by e.sort_order)
          from experiences e join me on e.user_id = me.id where e.cv_upload_id = (select id from up))
union all
select 6, 'dates match cv-library.md (OEB 2024-11, Pragma 2023-08, CoachHub 2021-11 to 2024-09, Luns 2017-01 to 2020-01)',
       (select bool_and(case
          when e.company ilike '%coachhub%' then e.start_date = '2021-11-01' and e.end_date in ('2024-09-01', '2024-08-01')
          when e.company ilike '%luns%' then e.start_date = '2017-01-01' and e.end_date = '2020-01-01'
          when e.company ilike '%pragma%' then e.start_date = '2023-08-01' and e.is_current
          when e.company ilike '%oeb%' or e.company ilike '%closerstill%' then e.start_date = '2024-11-01' and e.is_current
          else true end)
          from experiences e join me on e.user_id = me.id where e.cv_upload_id = (select id from up)),
       'CoachHub end accepts Sep or Aug 2024 (both appear in older CVs)'
union all
select 7, 'locked metrics present when the CV has them (921k, 2.4x, 42%, 390k, 17 to 5, 1.1M)',
       (select bool_and(found) from (
          select m, (position(m in (select cv from norm)) = 0)
                    or exists (select 1 from stories_of s where position(m in lower(s.source_quote)) > 0) as found
          from unnest(array['921k', '2.4x', '42%', '390k', '17 tools', '1.1m']) m) t),
       'a metric only counts as missing if it is in the CV text but in no saved result'
union all
select 8, 'nothing from Not on your record became a skill',
       not exists (select 1 from skills k join me on k.user_id = me.id, not_on_record n
                   where n.user_id = me.id and k.status <> 'rejected'
                     and (lower(k.name) = lower(n.claim) or lower(n.claim) like lower(k.name) || ' or %')),
       (select count(*) || ' claims on the list' from not_on_record n join me on n.user_id = me.id)
union all
select 9, 'what the checks removed (review by hand)', true,
       (select coalesce(jsonb_array_length(parse_report->'dropped'), 0) || ' dropped, '
               || coalesce(jsonb_array_length(parse_report->'metrics_removed'), 0) || ' numbers removed, '
               || coalesce(jsonb_array_length(parse_report->'conflicts'), 0) || ' conflicts' from up)
union all
select 10, 'tokens used by this parse (multiply by the current model price for cost)', true,
       (select (parse_report->'usage'->>'input_tokens') || ' in, ' || (parse_report->'usage'->>'output_tokens') || ' out' from up)
order by n;
