// Database audit (2026-10-18): each test asserts the behaviour we WANT. A failing test is a confirmed finding.
// Run: cd supabase/tests && node --test audit.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.mjs';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
let db, as;
const asA = (sql, p) => as('authenticated', A, sql, p);
const asB = (sql, p) => as('authenticated', B, sql, p);
const asWorker = (sql, p) => as('service_role', null, sql, p);

const baseParse = (over = {}) => ({
  model: 'm', report: {}, profile: {}, experiences: [], skills: [], suggestions: [], ...over,
});
const role = (title, company, results = []) => ({
  title, company, start_date: '2022-01-01', end_date: '', is_current: true, quote: `${title}, ${company}`, results,
});

async function newUpload(uid, name = 'cv.pdf') {
  const r = await as('authenticated', uid,
    `insert into cv_uploads (user_id, storage_path, file_name, parse_status, consent_at) values ($1, $2, $3, 'parsing', now()) returning id`,
    [uid, `${uid}/${name}`, name]);
  assert.equal(r.error, undefined, r.error);
  return r.rows[0].id;
}

before(async () => {
  ({ db, as } = await freshDb([A, B]));
  // count snapshot rebuilds (superuser-only test instrumentation, never part of a migration)
  await db.exec(`
    create table audit_snapshot_hits (n int not null default 0);
    insert into audit_snapshot_hits values (0);
    create function audit_count_hit() returns trigger language plpgsql as $$
    begin update audit_snapshot_hits set n = n + 1; return null; end $$;
    create trigger t_audit_hits after insert or update on public.profile_snapshots for each row execute function audit_count_hit();
  `);
});

// ---------------------------------------------------------------------------
// 1. RLS and grants
// ---------------------------------------------------------------------------
test('every public table has RLS enabled and forced, and a policy matrix is printed', async () => {
  const tables = (await db.query(`
    select c.relname as t, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
      coalesce((select string_agg(p.polname || ':' || p.polcmd::text || case when pg_get_expr(p.polqual, p.polrelid) = 'true' then '(TRUE)' else '' end, ' ' order by p.polname)
                from pg_policy p where p.polrelid = c.oid), '-') as policies,
      (select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants g
        where g.table_schema = 'public' and g.table_name = c.relname and g.grantee = 'authenticated') as auth_grants,
      (select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants g
        where g.table_schema = 'public' and g.table_name = c.relname and g.grantee = 'anon') as anon_grants
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname not like 'audit_%'
    order by c.relname`)).rows;
  console.log('\nPOLICY MATRIX (polcmd: * all, r select, a insert, w update, d delete)');
  for (const r of tables) console.log(`  ${r.t.padEnd(20)} rls=${r.rls} forced=${r.forced} | ${r.policies} | authenticated: ${r.auth_grants ?? '-'} | anon: ${r.anon_grants ?? '-'}`);
  for (const r of tables) {
    assert.ok(r.rls && r.forced, `${r.t} has RLS off or not forced`);
    assert.notEqual(r.policies, '-', `${r.t} has RLS on but no policy (silently blocks)`);
    assert.equal(r.anon_grants, null, `${r.t} is granted to anon`);
  }
});

test('anon cannot execute any public function', async () => {
  const r = await db.query(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname not like 'audit_%' and has_function_privilege('anon', p.oid, 'execute')`);
  assert.deepEqual(r.rows.map((x) => x.proname), []);
});

// ---------------------------------------------------------------------------
// 2. SECURITY DEFINER functions with foreign ids
// ---------------------------------------------------------------------------
let upA, expB;
test('crafted suggestion payloads cannot touch another user rows via accept_suggestion', async () => {
  upA = await newUpload(A);
  const upB = await newUpload(B);
  await asB(`select apply_cv_parse($1, $2::jsonb)`, [upB, JSON.stringify(baseParse({ experiences: [role('CTO', 'BetaCorp')] }))]);
  expB = (await asB(`select id from experiences`)).rows[0].id;

  // A writes suggestions that point at B's experience. apply_cv_parse accepts any payload the caller sends.
  const p = baseParse({
    suggestions: [
      { kind: 'title', payload: { experience_id: expB, ats_title: 'Hacked' }, fingerprint: 't1', quote: 'q' },
      { kind: 'story', payload: { experience_id: expB, title: 'Planted', text: 'x' }, fingerprint: 's1', quote: 'q' },
    ],
  });
  const r = await asA(`select apply_cv_parse($1, $2::jsonb) as c`, [upA, JSON.stringify(p)]);
  assert.equal(r.error, undefined, r.error);
  const ids = (await asA(`select id, kind from suggestions order by kind`)).rows;
  for (const s of ids) {
    const a = await asA(`select accept_suggestion($1)`, [s.id]);
    assert.equal(a.error, undefined, a.error);
  }
  const b = await asB(`select ats_title, (select count(*)::int from stories) as stories from experiences`);
  assert.equal(b.rows[0].ats_title, null, 'B ats_title changed by A');
  assert.equal(b.rows[0].stories, 0, 'A planted a story on B');
  const aStory = await asA(`select experience_id from stories where title = 'Planted'`);
  assert.equal(aStory.rows[0].experience_id, null, 'story should be unlinked, not linked to B');
});

test('a user cannot insert suggestions or edit payload directly', async () => {
  let r = await asA(`insert into suggestions (user_id, kind, payload, fingerprint) values ($1, 'skill', '{"name":"X"}', 'x')`, [A]);
  assert.match(r.error ?? '', /permission denied/);
  r = await asA(`update suggestions set payload = '{}'`);
  assert.match(r.error ?? '', /permission denied/);
});

test('a decided suggestion cannot be flipped back to pending and re-applied (story duplicates)', async () => {
  const id = (await asA(`select id from suggestions where kind = 'story'`)).rows[0].id;
  const flip = await asA(`update suggestions set status = 'pending' where id = $1`, [id]);
  const again = await asA(`select accept_suggestion($1)`, [id]);
  const n = await asA(`select count(*)::int as n from stories where title = 'Planted'`);
  assert.deepEqual({ flipped: flip.affected, reaccepted: !again.error, stories: n.rows[0].n },
    { flipped: 0, reaccepted: false, stories: 1 }, 'user reverted a decided suggestion and applied it again');
});

test('a title suggestion whose role no longer exists does not get marked accepted silently', async () => {
  const up = await newUpload(A, 'cv-dangle.pdf');
  const r = await asA(`select apply_cv_parse($1, $2::jsonb)`, [up, JSON.stringify(baseParse({
    experiences: [role('Growth Guy', 'Delta')],
    suggestions: [{ kind: 'title', payload: { experience_index: 0, ats_title: 'Growth Manager' }, fingerprint: 'title:delta', quote: 'q' }],
  }))]);
  assert.equal(r.error, undefined, r.error);
  await asA(`delete from experiences where company = 'Delta'`);
  const id = (await asA(`select id from suggestions where fingerprint = 'title:delta'`)).rows[0].id;
  const a = await asA(`select accept_suggestion($1)`, [id]);
  assert.ok(a.error, 'accepting a suggestion that changes nothing should fail, not report success');
});

test('negative experience_index in a crafted payload is skipped, not resolved to the last role', async () => {
  const up = await newUpload(A, 'cv-neg.pdf');
  const r = await asA(`select apply_cv_parse($1, $2::jsonb) as c`, [up, JSON.stringify(baseParse({
    experiences: [role('R1', 'Co1'), role('R2', 'Co2')],
    suggestions: [{ kind: 'title', payload: { experience_index: -1, ats_title: 'Z' }, fingerprint: 'title:neg', quote: 'q' }],
  }))]);
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.rows[0].c.suggestions, 0, 'experience_index -1 was accepted (jsonb negative index = last element)');
});

// ---------------------------------------------------------------------------
// 3. apply_cv_parse data integrity
// ---------------------------------------------------------------------------
test('a bad date fails the whole parse cleanly (no partial writes, upload not marked parsed)', async () => {
  const up = await newUpload(A, 'cv-date.pdf');
  const r = await asA(`select apply_cv_parse($1, $2::jsonb)`, [up, JSON.stringify(baseParse({
    experiences: [role('Ok', 'OkCo'), { ...role('Bad', 'BadCo'), start_date: '2024-13-01' }],
  }))]);
  assert.ok(r.error, 'expected the cast to throw');
  const n = await asA(`select count(*)::int as n from experiences where cv_upload_id = $1`, [up]);
  assert.equal(n.rows[0].n, 0);
  const st = await asA(`select parse_status from cv_uploads where id = $1`, [up]);
  assert.equal(st.rows[0].parse_status, 'parsing');
});

test('a role without company/title fails cleanly (not null) instead of inserting junk', async () => {
  const up = await newUpload(A, 'cv-null.pdf');
  const r = await asA(`select apply_cv_parse($1, $2::jsonb)`, [up, JSON.stringify(baseParse({
    experiences: [{ start_date: '', end_date: '', is_current: false, quote: 'q', results: [] }],
  }))]);
  assert.match(r.error ?? '', /null value/);
});

test('duplicate skills inside one payload: unique expression index exists and ON CONFLICT works', async () => {
  const idx = await db.query(`select indexdef from pg_indexes where tablename = 'skills' and indexname = 'skills_user_name_uq'`);
  assert.match(idx.rows[0]?.indexdef ?? '', /lower\(name\)/);
  const up = await newUpload(A, 'cv-dupskill.pdf');
  const r = await asA(`select apply_cv_parse($1, $2::jsonb) as c`, [up, JSON.stringify(baseParse({
    skills: [{ name: 'Clay', quote: 'Clay' }, { name: 'clay', quote: 'clay' }, { name: 'CLAY', quote: 'CLAY' }],
  }))]);
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.rows[0].c.skills, 1);
});

test('suggestions without a fingerprint are refused (no silent duplicates)', async () => {
  const up = await newUpload(A, 'cv-nofp.pdf');
  const r = await asA(`select apply_cv_parse($1, $2::jsonb)`, [up, JSON.stringify(baseParse({
    suggestions: [{ kind: 'skill', payload: { name: 'Q' }, quote: 'q' }],
  }))]);
  assert.match(r.error ?? '', /null value/);
});

test('the same role read from two different uploads is not shown twice in review', async () => {
  const u1 = await newUpload(A, 'cv-dup1.pdf');
  const u2 = await newUpload(A, 'cv-dup2.pdf');
  for (const u of [u1, u2]) {
    const r = await asA(`select apply_cv_parse($1, $2::jsonb)`, [u, JSON.stringify(baseParse({ experiences: [role('AE', 'DupCo')] }))]);
    assert.equal(r.error, undefined, r.error);
  }
  const n = await asA(`select count(*)::int as n from experiences where lower(company) = 'dupco'`);
  assert.equal(n.rows[0].n, 1, 'dedupe only looks at confirmed roles; two uploads produce two suggested copies');
});

test('deleting a cv_uploads row does not leave orphaned suggested facts that can never be confirmed', async () => {
  const up = await newUpload(A, 'cv-orphan.pdf');
  const r = await asA(`select apply_cv_parse($1, $2::jsonb)`, [up, JSON.stringify(baseParse({
    experiences: [role('Orphan', 'OrphanCo', [{ title: 'r', text: 't', metric: '', quote: 'q' }])],
    skills: [{ name: 'OrphanSkill', quote: 'q' }],
  }))]);
  assert.equal(r.error, undefined, r.error);
  const del = await asA(`delete from cv_uploads where id = $1`, [up]);
  assert.equal(del.affected, 1);
  const n = await asA(`select
      (select count(*)::int from experiences where status = 'suggested' and cv_upload_id is null) as e,
      (select count(*)::int from skills where status = 'suggested' and cv_upload_id is null) as k,
      (select count(*)::int from stories where status = 'suggested' and cv_upload_id is null) as s`);
  assert.deepEqual(n.rows[0], { e: 0, k: 0, s: 0 }, 'suggested rows outlive their upload (FK is on delete set null)');
});

test('profile links given as JSON null do not poison the links column', async () => {
  await asB(`delete from profiles`);
  const up = await newUpload(B, 'cv-links.pdf');
  const r = await asB(`select apply_cv_parse($1, $2::jsonb)`, [up, JSON.stringify(baseParse({ profile: { links: null, languages: null, education: null } }))]);
  assert.equal(r.error, undefined, r.error);
  const p = await asB(`select jsonb_typeof(links) as l, jsonb_typeof(languages) as g, jsonb_typeof(education) as e from profiles`);
  assert.deepEqual(p.rows[0], { l: 'array', g: 'array', e: 'array' });
});

test('accepting a skill suggestion for a previously rejected skill confirms it', async () => {
  await asA(`insert into skills (user_id, name, source_type, status) values ($1, 'ZoomInfo', 'user', 'rejected')`, [A]);
  const up = await newUpload(A, 'cv-rej.pdf');
  await asA(`select apply_cv_parse($1, $2::jsonb)`, [up, JSON.stringify(baseParse({
    suggestions: [{ kind: 'skill', payload: { name: 'zoominfo' }, fingerprint: 'skill:zoominfo', quote: 'q' }],
  }))]);
  const id = (await asA(`select id from suggestions where fingerprint = 'skill:zoominfo'`)).rows[0].id;
  const r = await asA(`select accept_suggestion($1)`, [id]);
  assert.equal(r.error, undefined, r.error);
  const s = await asA(`select status, count(*)::int as n from skills where lower(name) = 'zoominfo' group by status`);
  assert.deepEqual(s.rows, [{ status: 'confirmed', n: 1 }]);
});

// ---------------------------------------------------------------------------
// 4. Snapshot trigger
// ---------------------------------------------------------------------------
test('apply_cv_parse rebuilds the snapshot a bounded number of times, not once per row', async () => {
  const up = await newUpload(A, 'cv-bulk.pdf');
  const experiences = Array.from({ length: 10 }, (_, i) => role(`Role${i}`, `Bulk${i}`,
    Array.from({ length: 5 }, (_, j) => ({ title: `r${j}`, text: 't', metric: '', quote: 'q' }))));
  const skills = Array.from({ length: 30 }, (_, i) => ({ name: `BulkSkill${i}`, quote: 'q' }));
  await db.query(`update audit_snapshot_hits set n = 0`);
  const r = await asA(`select apply_cv_parse($1, $2::jsonb) as c`, [up, JSON.stringify(baseParse({ experiences, skills }))]);
  assert.equal(r.error, undefined, r.error);
  const hits = (await db.query(`select n from audit_snapshot_hits`)).rows[0].n;
  console.log(`  snapshot rebuilds for 10 roles + 50 results + 30 skills: ${hits}`);
  assert.ok(hits <= 2, `snapshot rebuilt ${hits} times in one apply_cv_parse call`);
});

test('deleting a story, skill, experience or exclusion rebuilds the snapshot', async () => {
  await asA(`insert into skills (user_id, name, source_type) values ($1, 'SnapSkill', 'user')`, [A]);
  await asA(`insert into not_on_record (user_id, claim) values ($1, 'SnapClaim')`, [A]);
  let s = (await asA(`select snapshot from profile_snapshots`)).rows[0].snapshot;
  assert.ok(s.skills.some((x) => x.name === 'SnapSkill'));
  assert.ok(s.not_on_record.includes('SnapClaim'));
  await asA(`delete from skills where name = 'SnapSkill'`);
  await asA(`delete from not_on_record where claim = 'SnapClaim'`);
  s = (await asA(`select snapshot from profile_snapshots`)).rows[0].snapshot;
  assert.ok(!s.skills.some((x) => x.name === 'SnapSkill'));
  assert.ok(!s.not_on_record.includes('SnapClaim'));
});

// ---------------------------------------------------------------------------
// 5. Storage
// ---------------------------------------------------------------------------
test('storage: nested own path ok, no-folder path and other-folder path refused, no update (move/overwrite) path', async () => {
  let r = await asA(`insert into storage.objects (bucket_id, name, owner) values ('cv-uploads', $1, $2)`, [`${A}/sub/cv.pdf`, A]);
  assert.equal(r.error, undefined, r.error);
  r = await asA(`insert into storage.objects (bucket_id, name, owner) values ('cv-uploads', 'cv.pdf', $1)`, [A]);
  assert.match(r.error ?? '', /row-level security/);
  r = await asA(`insert into storage.objects (bucket_id, name, owner) values ('cv-uploads', $1, $2)`, [`${B}/x.pdf`, A]);
  assert.match(r.error ?? '', /row-level security/);
  r = await asB(`delete from storage.objects where name like $1`, [`${A}/%`]);
  assert.equal(r.affected, 0);
  const pol = await db.query(`select polname from pg_policy where polrelid = 'storage.objects'::regclass and polcmd = 'w'`);
  assert.deepEqual(pol.rows, [], 'no update policy means no overwrite/move, as intended');
  const b = await db.query(`select id, file_size_limit, allowed_mime_types from storage.buckets order by id`);
  assert.ok(b.rows.every((x) => x.file_size_limit > 0 && x.allowed_mime_types?.length));
});

// ---------------------------------------------------------------------------
// 6/7. Direct status writes by the owner (documented behaviour)
// ---------------------------------------------------------------------------
test('owner can set cv_uploads.parse_status and experiences.status directly (own data, by design)', async () => {
  const up = await newUpload(A, 'cv-direct.pdf');
  let r = await asA(`update cv_uploads set parse_status = 'parsed', parsed_text = 'fake', parse_report = '{"dropped":[]}' where id = $1`, [up]);
  assert.equal(r.affected, 1);
  r = await asA(`select confirm_cv_upload($1) as c`, [up]);
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(r.rows[0].c, { experiences: 0, skills: 0, stories: 0 });
  r = await asA(`update cv_uploads set parse_status = 'bogus' where id = $1`, [up]);
  assert.match(r.error ?? '', /check constraint/);
  r = await asA(`insert into experiences (user_id, title, company) values ($1, 'Manual', 'ManualCo') returning status`, [A]);
  assert.equal(r.rows[0].status, 'confirmed');
  r = await asA(`update experiences set status = 'confirmed' where company = 'Bulk0'`);
  assert.equal(r.affected, 1);
});

// ---------------------------------------------------------------------------
// set_scoring_config validation
// ---------------------------------------------------------------------------
test('set_scoring_config rejects nonsense values that the caps are meant to stop', async () => {
  const bad = [
    `{"weights": {"skills": 200, "seniority": -100}}`,
    `{"daily_scan_limit": -5}`,
    `{"daily_scan_limit": 0}`,
    `{"cv_cap_per_run": -1}`,
    `{"queue_threshold": 50}`,
    `{"queue_threshold": -3}`,
    `{"rewrite_level": "nuclear"}`,
  ];
  const accepted = [];
  for (const cfg of bad) {
    const r = await asA(`select set_scoring_config($1::jsonb)`, [cfg]);
    if (!r.error) accepted.push(cfg);
  }
  assert.deepEqual(accepted, [], 'accepted configs');
});

// ---------------------------------------------------------------------------
// 10. Indexes and updated_at coverage
// ---------------------------------------------------------------------------
test('every user_id and foreign key column has a supporting index', async () => {
  const r = await db.query(`
    with cols as (
      select c.conrelid::regclass::text as t, a.attname as col
      from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace
      union
      select a.attrelid::regclass::text, a.attname from pg_attribute a join pg_class k on k.oid = a.attrelid
      where k.relnamespace = 'public'::regnamespace and k.relkind = 'r' and a.attname = 'user_id'
    )
    select t, col from cols
    where not exists (
      select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
      where i.indrelid = cols.t::regclass and a.attname = cols.col)
    order by 1, 2`);
  console.log('  unindexed user_id / FK columns: ' + r.rows.map((x) => `${x.t}.${x.col}`).join(', '));
  assert.deepEqual(r.rows, []);
});

test('every table with updated_at has a touch trigger', async () => {
  const r = await db.query(`
    select a.attrelid::regclass::text as t from pg_attribute a join pg_class k on k.oid = a.attrelid
    where k.relnamespace = 'public'::regnamespace and k.relkind = 'r' and a.attname = 'updated_at'
      and not exists (select 1 from pg_trigger g where g.tgrelid = a.attrelid and g.tgfoid = 'public.touch_updated_at'::regproc)`);
  assert.deepEqual(r.rows.map((x) => x.t), []);
});

test('enum values the app writes exist in the schema', async () => {
  const want = {
    fact_status: ['confirmed', 'suggested', 'rejected'],
    fact_source: ['cv', 'user', 'suggestion'],
    result_confidence: ['verified', 'estimate'],
    suggestion_kind: ['skill', 'title'],
    suggestion_status: ['pending', 'accepted', 'rejected'],
  };
  for (const [t, vals] of Object.entries(want)) {
    const r = await db.query(`select enum_range(null::public.${t})::text[] as v`);
    for (const v of vals) assert.ok(r.rows[0].v.includes(v), `${t} lacks ${v}`);
  }
  for (const s of ['pending', 'parsing', 'parsed', 'failed', 'confirmed']) {
    const r = await asA(`update cv_uploads set parse_status = $1 where id = $2`, [s, upA]);
    assert.equal(r.error, undefined, `${s}: ${r.error}`);
  }
});
