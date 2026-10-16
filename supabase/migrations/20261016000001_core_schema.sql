-- Shortlist core schema (Gate 0)
-- Every table that holds a user's data carries user_id and is locked with row level security.
-- Shared tables (companies, sources, jobs) are readable by signed in users and written only by the worker (service role).

create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.fact_status as enum ('confirmed', 'suggested', 'rejected');
create type public.fact_source as enum ('cv', 'user', 'suggestion');
create type public.result_confidence as enum ('verified', 'estimate');
create type public.suggestion_kind as enum ('skill', 'story', 'result', 'title', 'target', 'weight', 'form_answer', 'tag');
create type public.suggestion_status as enum ('pending', 'accepted', 'rejected');
create type public.source_status as enum ('works', 'partial', 'blocked', 'empty', 'untested');
create type public.job_status as enum ('open', 'closed', 'unverified');
create type public.match_status as enum ('queued', 'approved', 'skipped', 'flagged', 'dismissed');
create type public.app_stage as enum ('applied', 'interview', 'offer', 'rejected', 'closed', 'pool');
create type public.app_track as enum ('GTM', 'AE', 'Other');

-- ---------------------------------------------------------------------------
-- Helper: updated_at
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Profile: who the user is
-- ---------------------------------------------------------------------------
create table public.profiles (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  full_name      text,
  headline       text,
  location       text,                      -- e.g. "Berlin, Germany"
  phone          text,
  contact_email  text,
  links          jsonb not null default '[]', -- [{label, url}]
  languages      jsonb not null default '[]', -- [{language, level}]
  seniority      text,
  notice_period  text,
  education      jsonb not null default '[]', -- [{school, degree, year}]
  certifications text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table public.cv_uploads (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  storage_path  text not null,              -- cv-uploads/<user_id>/<file>
  file_name     text not null,
  mime_type     text,
  parsed_text   text,
  parse_status  text not null default 'pending', -- pending, parsed, failed
  created_at    timestamptz not null default now()
);

create table public.experiences (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  cv_upload_id  uuid references public.cv_uploads (id) on delete set null,
  title         text not null,
  ats_title     text,                       -- standard title ATS filters recognise
  company       text not null,
  company_desc  text,                       -- one line, e.g. "Conference, CloserStill events group"
  location      text,
  start_date    date,
  end_date      date,
  is_current    boolean not null default false,
  sort_order    int not null default 0,
  source_type   public.fact_source not null default 'cv',
  source_quote  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Every skill knows where it came from, so the engine can promise it never invents one.
create table public.skills (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  name          text not null,
  category      text,                       -- tool, method, domain, language
  years         numeric(4,1),
  status        public.fact_status not null default 'confirmed',
  source_type   public.fact_source not null,
  source_ref    text,                       -- cv_upload id + line, or experience id
  source_quote  text,                       -- the exact CV line
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index skills_user_name_uq on public.skills (user_id, lower(name));

-- Proof bank (STAR stories). Only claims stored here or in experiences may appear on a CV.
create table public.stories (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  experience_id      uuid references public.experiences (id) on delete set null,
  title              text not null,
  situation          text,
  task               text,
  action             text,
  result             text,
  result_metric      text,                  -- e.g. "MQL rate up 42%"
  result_confidence  public.result_confidence,
  tags               text[] not null default '{}',
  locked_wording     text,                  -- wording the user wants kept verbatim
  status             public.fact_status not null default 'confirmed',
  source_type        public.fact_source not null default 'user',
  source_quote       text,
  embedding          vector(1024),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Claims the engine must never make for this user (mirrors "Not on your record" in cv-library.md).
create table public.not_on_record (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  claim       text not null,                -- e.g. "TheirStack", "fluent German"
  note        text,
  created_at  timestamptz not null default now()
);

-- Suggestion buttons. Rejected suggestions stay, so the fingerprint stops them from coming back.
create table public.suggestions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  kind          public.suggestion_kind not null,
  payload       jsonb not null,             -- the proposed change
  fingerprint   text not null,              -- stable hash of kind + normalised payload
  source_quote  text,                       -- the CV or profile line it came from
  source_ref    text,
  context_job_id uuid,                      -- set when raised on a specific job
  status        public.suggestion_status not null default 'pending',
  created_at    timestamptz not null default now(),
  decided_at    timestamptz
);
create unique index suggestions_fingerprint_uq on public.suggestions (user_id, kind, fingerprint);

-- ---------------------------------------------------------------------------
-- What the user is after, and how fit is scored
-- ---------------------------------------------------------------------------
create table public.targets (
  user_id           uuid primary key references auth.users (id) on delete cascade,
  titles            jsonb not null default '[]',  -- [{title, priority}] priority 1 = top
  seniority         text,
  exclude_terms     text[] not null default '{}', -- "pure SDR", "agency"
  locations         jsonb not null default '[]',  -- ordered [{place, kind: city|remote_country|remote_region}]
  work_setups       text[] not null default '{remote,hybrid}',
  open_to_relocation text[] not null default '{}', -- places the user would move to
  salary_min        int,
  salary_currency   text not null default 'EUR',
  keep_no_salary    boolean not null default true,
  industries        text[] not null default '{}',
  company_sizes     text[] not null default '{}',
  company_blocklist text[] not null default '{}',
  required_language_skip text[] not null default '{}', -- skip roles whose main language is one of these, e.g. {German}
  updated_at        timestamptz not null default now()
);

-- Versioned. Each match records the version that scored it.
create table public.scoring_configs (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  version          int not null,
  is_active        boolean not null default true,
  cv_threshold     numeric(3,1) not null default 8.0,   -- total fit needed for a tailored CV
  queue_threshold  numeric(3,1) not null default 7.0,   -- total fit shown in the daily queue
  weights          jsonb not null default '{"skills":35,"seniority":20,"location":15,"salary":15,"industry":15}',
  location_points  jsonb not null default '[{"match":"home_city","points":1.5},{"match":"remote_home_region","points":1.5},{"match":"relocation","points":0}]',
  rubric_anchors   jsonb not null default '{}',          -- user wording for what 5, 7, 9 mean
  benchmark_role   jsonb,                                -- the user's "perfect role" reference
  daily_scan_limit int not null default 40,
  cv_cap_per_run   int not null default 3,
  rewrite_level    text not null default 'balanced',     -- light, balanced, strong
  created_at       timestamptz not null default now()
);
create unique index scoring_configs_version_uq on public.scoring_configs (user_id, version);
create unique index scoring_configs_one_active on public.scoring_configs (user_id) where is_active;

-- ---------------------------------------------------------------------------
-- Shared job data (written by the worker only)
-- ---------------------------------------------------------------------------
create table public.companies (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  domain       text,
  city         text,
  ats          text,                          -- ashby, greenhouse, lever, recruitee, personio, workable, smartrecruiters, teamtailor, join, factorial, own
  ats_slug     text,
  list_url     text,                          -- the current job LIST (proof of open), not a posting page
  status       public.source_status not null default 'untested',
  last_checked timestamptz,
  notes        text,
  created_at   timestamptz not null default now()
);
create unique index companies_ats_slug_uq on public.companies (ats, ats_slug) where ats_slug is not null;

create table public.sources (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  url          text,
  kind         text not null,                 -- board, aggregator, api, vc_board, connector, funding
  best_for     text,
  status       public.source_status not null default 'untested',
  last_checked timestamptz,
  notes        text
);

create table public.jobs (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies (id) on delete cascade,
  external_id      text not null,             -- the ATS job id
  title            text not null,
  location_text    text,
  remote_type      text,                      -- onsite, hybrid, remote
  url              text not null,             -- company's own posting, never an aggregator redirect
  description      text,
  posted_at        timestamptz,
  ats_updated_at   timestamptz,
  first_seen_at    timestamptz not null default now(),
  last_verified_at timestamptz,               -- last time it was seen in the company's current job list
  status           public.job_status not null default 'unverified',
  content_hash     text,
  found_via        text[] not null default '{}',
  embedding        vector(1024)
);
create unique index jobs_company_external_uq on public.jobs (company_id, external_id);

-- Users can follow extra companies on top of the shared watchlist.
create table public.user_watchlist (
  user_id    uuid not null references auth.users (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  added_at   timestamptz not null default now(),
  primary key (user_id, company_id)
);

-- ---------------------------------------------------------------------------
-- Per user results
-- ---------------------------------------------------------------------------
create table public.job_matches (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  job_id           uuid not null references public.jobs (id) on delete cascade,
  config_id        uuid not null references public.scoring_configs (id),
  role_fit         numeric(3,1) not null check (role_fit between 0 and 10),
  location_points  numeric(3,1) not null default 0 check (location_points between 0 and 3),
  total_fit        numeric(3,1) generated always as (least(10, role_fit + location_points)) stored,
  factor_scores    jsonb not null default '{}',
  reasons          jsonb not null default '{"plus":[],"minus":[]}',
  location_note    text,                      -- "Berlin hybrid, no move" / "needs a move to Hamburg"
  status           public.match_status not null default 'queued',
  flag_reason      text,
  created_at       timestamptz not null default now()
);
create unique index job_matches_uq on public.job_matches (user_id, job_id, config_id);

create table public.applications (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  job_id         uuid references public.jobs (id) on delete set null,
  company        text not null,
  role           text not null,
  track          public.app_track not null default 'Other',
  stage          public.app_stage not null default 'applied',
  applied_at     date,
  note           text,
  next_step      text,
  user_edited_at timestamptz,               -- set when the user edits; the worker never overwrites these rows
  created_at     timestamptz not null default now()
);

create table public.cv_documents (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  job_id           uuid references public.jobs (id) on delete set null,
  application_id   uuid references public.applications (id) on delete set null,
  storage_path     text not null,           -- cv-outputs/<user_id>/<file>
  file_name        text not null,
  cv_score         numeric(3,1),
  rubric           jsonb,                   -- {ats, proof, wording, writing, focus}
  keyword_coverage jsonb,                   -- {covered, total, missing:[{keyword, reason}]}
  changes          jsonb,
  engine_issues    jsonb,
  location_line    text,
  sent             boolean not null default false,
  created_at       timestamptz not null default now()
);

create table public.scan_runs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users (id) on delete cascade,  -- null for the shared source sweep
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  head        text,                         -- "3 new verified, 1 CV"
  summary     text,
  stats       jsonb not null default '{}',
  source_log  jsonb not null default '[]'
);

create table public.leads (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  company    text not null,
  city       text,
  score      numeric(3,1),
  signals    jsonb not null default '[]',   -- [{signal, date, source_url}] no people on the board
  updated_at timestamptz not null default now()
);

create table public.transcripts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  application_id uuid references public.applications (id) on delete set null,
  title          text,
  body           text not null,
  delete_after   date not null default (current_date + 180),
  created_at     timestamptz not null default now()
);

create table public.notification_prefs (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  timezone       text not null default 'Europe/Berlin',
  digest_time    time not null default '07:30',
  weekdays_only  boolean not null default true,
  channels       jsonb not null default '{"email":true}',
  updated_at     timestamptz not null default now()
);

create table public.usage_monthly (
  user_id       uuid not null references auth.users (id) on delete cascade,
  month         date not null,              -- first day of the month
  cvs_used      int not null default 0,
  briefs_used   int not null default 0,
  jobs_scanned  int not null default 0,
  primary key (user_id, month)
);

-- updated_at triggers
create trigger t_profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger t_experiences_touch before update on public.experiences for each row execute function public.touch_updated_at();
create trigger t_skills_touch before update on public.skills for each row execute function public.touch_updated_at();
create trigger t_stories_touch before update on public.stories for each row execute function public.touch_updated_at();
create trigger t_targets_touch before update on public.targets for each row execute function public.touch_updated_at();
create trigger t_notif_touch before update on public.notification_prefs for each row execute function public.touch_updated_at();

-- Helpful indexes
create index on public.experiences (user_id, sort_order);
create index on public.stories (user_id);
create index on public.suggestions (user_id, status);
create index on public.job_matches (user_id, status, total_fit desc);
create index on public.applications (user_id, stage);
create index on public.cv_documents (user_id, created_at desc);
create index on public.jobs (status, last_verified_at desc);
create index on public.scan_runs (user_id, started_at desc);
