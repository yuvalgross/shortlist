// Gate 0 database tests: runs every migration in an embedded Postgres and checks data isolation.
// Run: cd supabase/tests && npm test
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
let db;

async function as(role, uid, sql, params = []) {
  await db.exec('begin');
  try {
    await db.query(`set local role ${role}`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? '']);
    const res = await db.query(sql, params);
    await db.exec('commit');
    return { rows: res.rows, affected: res.affectedRows ?? 0 };
  } catch (error) {
    await db.exec('rollback');
    return { error: error.message };
  }
}
const asA = (sql, p) => as('authenticated', A, sql, p);
const asB = (sql, p) => as('authenticated', B, sql, p);
const asWorker = (sql, p) => as('service_role', null, sql, p);
const asAnon = (sql, p) => as('anon', null, sql, p);

before(async () => {
  db = await PGlite.create({ extensions: { vector } });
  await db.exec(readFileSync(join(here, 'supabase-shim.sql'), 'utf8'));
  for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'));
  }
  await db.query(`insert into auth.users (id, email) values ($1, 'a@test.dev'), ($2, 'b@test.dev')`, [A, B]);
});

test('user A can write and read their own profile, skills, stories and applications', async () => {
  let r = await asA(`insert into profiles (user_id, full_name, phone, contact_email) values ($1, 'Alex', '+49 000', 'alex@test.dev')`, [A]);
  assert.equal(r.error, undefined, r.error);
  r = await asA(`insert into skills (user_id, name, source_type, source_quote) values ($1, 'Clay', 'cv', 'Built a Clay table')`, [A]);
  assert.equal(r.error, undefined, r.error);
  r = await asA(`insert into skills (user_id, name, source_type, status) values ($1, 'TheirStack', 'suggestion', 'rejected')`, [A]);
  assert.equal(r.error, undefined, r.error);
  r = await asA(`insert into stories (user_id, title, result_metric) values ($1, 'Outbound rebuild', 'MQL rate up 42%')`, [A]);
  assert.equal(r.error, undefined, r.error);
  r = await asA(`insert into applications (user_id, company, role, track) values ($1, 'Acme', 'GTM Engineer', 'GTM')`, [A]);
  assert.equal(r.error, undefined, r.error);
  r = await asA(`select count(*)::int as n from skills`);
  assert.equal(r.rows[0].n, 2);
});

test('user B sees none of user A rows', async () => {
  for (const t of ['profiles', 'skills', 'stories', 'applications', 'profile_snapshots']) {
    const r = await asB(`select count(*)::int as n from ${t}`);
    assert.equal(r.error, undefined, `${t}: ${r.error}`);
    assert.equal(r.rows[0].n, 0, `B could read ${t}`);
  }
});

test('user B cannot write rows in user A name, or change A rows', async () => {
  let r = await asB(`insert into skills (user_id, name, source_type) values ($1, 'Fake', 'user')`, [A]);
  assert.match(r.error ?? '', /row-level security/);
  r = await asB(`update applications set stage = 'rejected'`);
  assert.equal(r.affected, 0);
  r = await asB(`delete from stories`);
  assert.equal(r.affected, 0);
  r = await asA(`select stage from applications`);
  assert.equal(r.rows[0].stage, 'applied');
});

test('anonymous visitors cannot read anything', async () => {
  for (const t of ['profiles', 'skills', 'jobs', 'job_matches']) {
    const r = await asAnon(`select * from ${t}`);
    assert.match(r.error ?? '', /permission denied/, `anon read ${t}`);
  }
});

test('scoring config is versioned and validated', async () => {
  let r = await asA(`select set_scoring_config('{"cv_threshold": 8}'::jsonb) as id`);
  assert.equal(r.error, undefined, r.error);
  r = await asA(`select set_scoring_config('{"cv_threshold": 8.5, "weights": {"skills":40,"seniority":20,"location":15,"salary":15,"industry":10}}'::jsonb) as id`);
  assert.equal(r.error, undefined, r.error);
  r = await asA(`select version, is_active, cv_threshold from scoring_configs order by version`);
  assert.deepEqual(r.rows.map((x) => [x.version, x.is_active, Number(x.cv_threshold)]), [[1, false, 8], [2, true, 8.5]]);
  r = await asA(`select set_scoring_config('{"weights": {"skills":90,"seniority":20}}'::jsonb)`);
  assert.match(r.error ?? '', /add up to 100/);
  r = await asA(`update scoring_configs set cv_threshold = 5`);
  assert.match(r.error ?? '', /permission denied/);
  r = await asB(`select count(*)::int as n from scoring_configs`);
  assert.equal(r.rows[0].n, 0);
});

test('matches: worker writes, user reads and decides, score columns are locked', async () => {
  let r = await asWorker(`insert into companies (name, ats, ats_slug, list_url, status) values ('Acme', 'ashby', 'acme', 'https://api.ashbyhq.com/posting-api/job-board/acme', 'works') returning id`);
  assert.equal(r.error, undefined, r.error);
  const companyId = r.rows[0].id;
  r = await asWorker(`insert into jobs (company_id, external_id, title, url, status) values ($1, 'j1', 'GTM Engineer', 'https://jobs.ashbyhq.com/acme/j1', 'open') returning id`, [companyId]);
  const jobId = r.rows[0].id;
  r = await asWorker(`select id from scoring_configs where user_id = $1 and is_active`, [A]);
  const configId = r.rows[0].id;
  r = await asWorker(`insert into job_matches (user_id, job_id, config_id, role_fit, location_points) values ($1, $2, $3, 9.5, 1.5) returning total_fit`, [A, jobId, configId]);
  assert.equal(r.error, undefined, r.error);
  assert.equal(Number(r.rows[0].total_fit), 10, 'total fit must be capped at 10');

  r = await asA(`insert into job_matches (user_id, job_id, config_id, role_fit) values ($1, $2, $3, 10)`, [A, jobId, configId]);
  assert.match(r.error ?? '', /permission denied/, 'user must not create their own scores');
  r = await asA(`update job_matches set status = 'flagged', flag_reason = 'Needs German'`);
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.affected, 1);
  r = await asA(`update job_matches set role_fit = 10`);
  assert.match(r.error ?? '', /permission denied/, 'user must not change scores');
  r = await asB(`select count(*)::int as n from job_matches`);
  assert.equal(r.rows[0].n, 0);
  r = await asB(`select count(*)::int as n from jobs`);
  assert.equal(r.rows[0].n, 1, 'shared jobs are readable by every signed in user');
  r = await asB(`insert into jobs (company_id, external_id, title, url) values ($1, 'j2', 'x', 'y')`, [companyId]);
  assert.match(r.error ?? '', /permission denied/);
});

test('suggestions: user decides, cannot edit content, rejected ones cannot come back', async () => {
  let r = await asWorker(`insert into suggestions (user_id, kind, payload, fingerprint, source_quote) values ($1, 'skill', '{"name":"SQL"}', 'skill:sql', 'custom SQL views (2022)')`, [A]);
  assert.equal(r.error, undefined, r.error);
  r = await asA(`update suggestions set status = 'rejected', decided_at = now()`);
  assert.equal(r.affected, 1);
  r = await asA(`update suggestions set payload = '{"name":"Snowflake"}'`);
  assert.match(r.error ?? '', /permission denied/);
  r = await asWorker(`insert into suggestions (user_id, kind, payload, fingerprint) values ($1, 'skill', '{"name":"SQL"}', 'skill:sql')`, [A]);
  assert.match(r.error ?? '', /duplicate key/);
});

test('profile snapshot rebuilds on change, skips rejected facts and private contact details', async () => {
  const r = await asA(`select snapshot from profile_snapshots`);
  assert.equal(r.rows.length, 1);
  const s = r.rows[0].snapshot;
  assert.deepEqual(s.skills.map((x) => x.name), ['Clay']);
  assert.equal(s.stories[0].metric, 'MQL rate up 42%');
  assert.equal(s.scoring.version, 2);
  assert.equal(s.profile.full_name, 'Alex');
  assert.equal(s.profile.phone, undefined);
  assert.equal(s.profile.contact_email, undefined);
  await asA(`insert into not_on_record (user_id, claim) values ($1, 'fluent German')`, [A]);
  const r2 = await asA(`select snapshot from profile_snapshots`);
  assert.deepEqual(r2.rows[0].snapshot.not_on_record, ['fluent German']);
  const r3 = await asA(`select refresh_profile_snapshot($1)`, [A]);
  assert.match(r3.error ?? '', /permission denied/, 'users cannot call internal functions');
});

test('storage: users only reach files in their own folder', async () => {
  let r = await asA(`insert into storage.objects (bucket_id, name, owner) values ('cv-uploads', $1, $2)`, [`${A}/cv.pdf`, A]);
  assert.equal(r.error, undefined, r.error);
  r = await asA(`insert into storage.objects (bucket_id, name, owner) values ('cv-uploads', $1, $2)`, [`${B}/cv.pdf`, A]);
  assert.match(r.error ?? '', /row-level security/);
  r = await asA(`insert into storage.objects (bucket_id, name, owner) values ('cv-outputs', $1, $2)`, [`${A}/tailored.pdf`, A]);
  assert.match(r.error ?? '', /row-level security/, 'only the worker writes tailored CVs');
  r = await asB(`select count(*)::int as n from storage.objects`);
  assert.equal(r.rows[0].n, 0);
});

test('transcripts past their delete date are purged', async () => {
  await asA(`insert into transcripts (user_id, body, delete_after) values ($1, 'old call', current_date - 1), ($1, 'new call', current_date + 30)`, [A]);
  const r = await asWorker(`select purge_expired_transcripts() as n`);
  assert.equal(r.rows[0].n, 1);
  const left = await asA(`select body from transcripts`);
  assert.deepEqual(left.rows.map((x) => x.body), ['new call']);
});

test('deleting an account removes every row that belongs to it', async () => {
  await db.query(`delete from auth.users where id = $1`, [A]);
  const tables = ['profiles', 'skills', 'stories', 'applications', 'scoring_configs', 'job_matches',
    'suggestions', 'not_on_record', 'profile_snapshots', 'transcripts'];
  for (const t of tables) {
    const r = await db.query(`select count(*)::int as n from ${t} where user_id = $1`, [A]);
    assert.equal(r.rows[0].n, 0, `${t} still has rows`);
  }
  const jobs = await db.query(`select count(*)::int as n from jobs`);
  assert.equal(jobs.rows[0].n, 1, 'shared jobs stay');
});
