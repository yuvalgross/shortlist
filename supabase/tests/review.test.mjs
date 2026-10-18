// Cold-read review (2026-10-18, after the Gate 1 audit). Each test asserts the behaviour we WANT.
// A failing test is a confirmed finding; a passing one is a cleared suspicion kept as a regression guard.
// Run: cd supabase/tests && node --test review.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.mjs';

const A = '11111111-1111-1111-1111-111111111111';
let db, as;
const asA = (sql, p) => as('authenticated', A, sql, p);

const baseParse = (over = {}) => ({ model: 'm', report: {}, profile: {}, experiences: [], skills: [], suggestions: [], ...over });
const role = (title, company, results = [], over = {}) => ({
  title, company, start_date: '2022-01-01', end_date: '', is_current: true, quote: `${title}, ${company}`, results, ...over,
});
const bullet = (text) => ({ title: text.slice(0, 20), text, metric: '', quote: text });

async function newUpload(name) {
  const r = await asA(
    `insert into cv_uploads (user_id, storage_path, file_name, parse_status, consent_at) values ($1, $2, $3, 'parsing', now()) returning id`,
    [A, `${A}/${name}`, name]);
  assert.equal(r.error, undefined, r.error);
  return r.rows[0].id;
}
async function apply(up, p) {
  const r = await asA(`select apply_cv_parse($1, $2::jsonb) as c`, [up, JSON.stringify(p)]);
  assert.equal(r.error, undefined, r.error);
  return r.rows[0].c;
}

before(async () => {
  ({ db, as } = await freshDb([A]));
  await db.exec(`
    create table review_snapshot_hits (n int not null default 0);
    insert into review_snapshot_hits values (0);
    create function review_count_hit() returns trigger language plpgsql as $$
    begin update review_snapshot_hits set n = n + 1; return null; end $$;
    create trigger t_review_hits after insert or update on public.profile_snapshots for each row execute function review_count_hit();
  `);
});
const hits = async () => (await db.query(`select n from review_snapshot_hits`)).rows[0].n;
const resetHits = () => db.query(`update review_snapshot_hits set n = 0`);

// ---------------------------------------------------------------------------
// D1. The cross-upload dedupe added by the audit (same company + title, status suggested) also fires
// INSIDE one parse: a CV with two stints at the same company under the same title loses the first.
// ---------------------------------------------------------------------------
test('D1. two stints with the same title at the same company in one CV are both saved', async () => {
  const up = await newUpload('cv-two-stints.pdf');
  const c = await apply(up, baseParse({
    experiences: [
      role('Account Executive', 'Acme', [bullet('Closed 40 deals in 2021')], { start_date: '2020-01-01', end_date: '2021-12-01', is_current: false }),
      role('Account Executive', 'Acme', [bullet('Closed 70 deals in 2018')], { start_date: '2017-01-01', end_date: '2018-12-01', is_current: false }),
    ],
    suggestions: [{ kind: 'title', payload: { experience_index: 0, ats_title: 'Enterprise Account Executive' }, fingerprint: 'title:acme:ae', quote: 'q' }],
  }));
  const n = await asA(`select (select count(*)::int from experiences where cv_upload_id = $1) as e,
                              (select count(*)::int from stories where cv_upload_id = $1) as s`, [up]);
  // BUG: the second iteration deletes the first stint (and its bullet) as a "duplicate from an earlier upload"
  assert.deepEqual(n.rows[0], { e: 2, s: 2 }, `apply_cv_parse reported ${JSON.stringify(c)} but saved ${JSON.stringify(n.rows[0])}`);
  // and the title suggestion still points at a role that exists
  const sg = (await asA(`select id, payload->>'experience_id' as exp from suggestions where fingerprint = 'title:acme:ae'`)).rows[0];
  const exists = await asA(`select count(*)::int as n from experiences where id = $1`, [sg.exp]);
  assert.equal(exists.rows[0].n, 1, 'title suggestion points at a deleted role');
});

// ---------------------------------------------------------------------------
// D2. Two unreviewed uploads sharing a skill: the skill stays tied to the first upload (on conflict do nothing),
// so confirming the second upload (the only review screen the user sees) leaves it 'suggested' forever.
// ---------------------------------------------------------------------------
test('D2. confirming the latest upload confirms the skills it lists even when an older unreviewed upload listed them first', async () => {
  const u1 = await newUpload('cv-skill1.pdf');
  const u2 = await newUpload('cv-skill2.pdf');
  await apply(u1, baseParse({ skills: [{ name: 'Clay', quote: 'Clay' }] }));
  await apply(u2, baseParse({ skills: [{ name: 'Clay', quote: 'Clay' }, { name: 'HubSpot', quote: 'HubSpot' }] }));
  const r = await asA(`select confirm_cv_upload($1) as c`, [u2]);
  assert.equal(r.error, undefined, r.error);
  const s = await asA(`select name, status from skills where name in ('Clay', 'HubSpot') order by name`);
  // BUG: Clay stays 'suggested' (cv_upload_id = u1); it is shown in the list but never reaches the snapshot
  assert.deepEqual(s.rows, [{ name: 'Clay', status: 'confirmed' }, { name: 'HubSpot', status: 'confirmed' }]);
});

// ---------------------------------------------------------------------------
// D3. Roles from an older unreviewed upload that the newer CV does not mention stay 'suggested' with no way to confirm
// ---------------------------------------------------------------------------
test('D3. after "Looks right, continue" nothing on the review screen is still waiting for review', async () => {
  const u1 = await newUpload('cv-old.pdf');
  const u2 = await newUpload('cv-new.pdf');
  await apply(u1, baseParse({ experiences: [role('Old Role', 'OldCo', [bullet('did old things')])] }));
  await apply(u2, baseParse({ experiences: [role('New Role', 'NewCo')] }));
  const r = await asA(`select confirm_cv_upload($1)`, [u2]);
  assert.equal(r.error, undefined, r.error);
  const left = await asA(`select title from experiences where status = 'suggested' and cv_upload_id in ($1, $2) order by title`, [u1, u2]);
  // BUG: "Old Role" keeps its TO REVIEW tag; the confirm button is gone because the latest upload is confirmed
  assert.deepEqual(left.rows, [], 'rows the user saw and approved remain unreviewed');
});

// ---------------------------------------------------------------------------
// D4. Re-upload after confirming: new bullets under an already confirmed role are dropped silently
// ---------------------------------------------------------------------------
test('D4. a second CV adding a bullet to a confirmed role saves that bullet for review (design choice, low)', async () => {
  const u1 = await newUpload('cv-base.pdf');
  await apply(u1, baseParse({ experiences: [role('GTM Engineer', 'Zeta', [bullet('Built the signal engine')])] }));
  await asA(`select confirm_cv_upload($1)`, [u1]);
  const u2 = await newUpload('cv-more.pdf');
  const c = await apply(u2, baseParse({ experiences: [role('GTM Engineer', 'Zeta', [bullet('Built the signal engine'), bullet('Cut lead response time by 60%')])] }));
  assert.equal(c.experiences, 0, 'confirmed role is not duplicated');
  const s = await asA(`select count(*)::int as n from stories where action = 'Cut lead response time by 60%'`);
  // Recorded: the new bullet never reaches the user. apply_cv_parse `continue`s past a confirmed role before its results.
  assert.equal(s.rows[0].n, 1);
});

// ---------------------------------------------------------------------------
// D5. The claim statement in start.ts, as SQL: only one of two concurrent clicks starts a parse;
// a stale 'parsing' row is claimable.
// ---------------------------------------------------------------------------
test('D5. claim semantics: second click refused, stale parse claimable', async () => {
  const up = await newUpload('cv-claim.pdf');
  await asA(`update cv_uploads set parse_status = 'failed' where id = $1`, [up]);
  const claim = (staleBefore) => asA(
    `update cv_uploads set parse_status = 'parsing', error = null, parse_started_at = now()
      where id = $1 and parse_status <> 'confirmed'
        and (parse_status <> 'parsing' or parse_started_at is null or parse_started_at < $2::timestamptz)
      returning id`, [up, staleBefore]);
  const sixMinAgo = () => new Date(Date.now() - 6 * 60 * 1000).toISOString();
  let r = await claim(sixMinAgo());
  assert.equal(r.rows.length, 1, 'first click starts');
  r = await claim(sixMinAgo());
  assert.equal(r.rows.length, 0, 'second click while running is refused');
  await asA(`update cv_uploads set parse_started_at = now() - interval '7 minutes' where id = $1`, [up]);
  r = await claim(sixMinAgo());
  assert.equal(r.rows.length, 1, 'a stale parse can be claimed again');
  await asA(`update cv_uploads set parse_status = 'confirmed' where id = $1`, [up]);
  r = await claim(sixMinAgo());
  assert.equal(r.rows.length, 0, 'a confirmed upload is never re-read');
});

// ---------------------------------------------------------------------------
// D6. Snapshot trigger transitions after the audit rewrite
// ---------------------------------------------------------------------------
test('D6. snapshot rebuilds on suggested->confirmed, confirmed->rejected and delete of confirmed; not on suggested churn', async () => {
  const up = await newUpload('cv-snap.pdf');
  await apply(up, baseParse({ skills: [{ name: 'SnapA', quote: 'q' }, { name: 'SnapB', quote: 'q' }] }));
  await resetHits();
  await asA(`update skills set source_quote = 'edited' where name = 'SnapA'`);
  await asA(`delete from skills where name = 'SnapB'`);
  assert.equal(await hits(), 0, 'suggested-only changes must not rebuild');
  await asA(`update skills set status = 'confirmed' where name = 'SnapA'`);
  assert.equal(await hits(), 1, 'suggested -> confirmed rebuilds');
  let snap = (await asA(`select snapshot from profile_snapshots`)).rows[0].snapshot;
  assert.ok(snap.skills.some((s) => s.name === 'SnapA'));
  await asA(`update skills set status = 'rejected' where name = 'SnapA'`);
  assert.equal(await hits(), 2, 'confirmed -> rejected rebuilds');
  snap = (await asA(`select snapshot from profile_snapshots`)).rows[0].snapshot;
  assert.ok(!snap.skills.some((s) => s.name === 'SnapA'));
  await asA(`update skills set status = 'confirmed' where name = 'SnapA'`);
  await asA(`delete from skills where name = 'SnapA'`);
  assert.equal(await hits(), 4, 'delete of a confirmed row rebuilds');
});

// ---------------------------------------------------------------------------
// D7. The app's reject path under the new update policy, and accept of a skill that already exists as suggested
// ---------------------------------------------------------------------------
test('D7. rejectSuggestion (plain update) and accept_suggestion both work under the pending-only policy', async () => {
  const up = await newUpload('cv-sugg.pdf');
  await apply(up, baseParse({
    skills: [{ name: 'Gong', quote: 'Gong' }],
    suggestions: [
      { kind: 'skill', payload: { name: 'Gong' }, fingerprint: 'skill:gong', quote: 'q' },
      { kind: 'skill', payload: { name: 'Outreach' }, fingerprint: 'skill:outreach', quote: 'q' },
    ],
  }));
  const ids = Object.fromEntries((await asA(`select fingerprint, id from suggestions where fingerprint in ('skill:gong', 'skill:outreach')`)).rows.map((r) => [r.fingerprint, r.id]));
  let r = await asA(`update suggestions set status = 'rejected', decided_at = now() where id = $1 and status = 'pending'`, [ids['skill:outreach']]);
  assert.equal(r.affected, 1, 'reject as the app does it');
  r = await asA(`select accept_suggestion($1)`, [ids['skill:gong']]);
  assert.equal(r.error, undefined, r.error);
  const g = await asA(`select status from skills where name = 'Gong'`);
  assert.equal(g.rows[0].status, 'confirmed', 'accepting a suggestion for a skill already suggested from the CV confirms it');
});

// ---------------------------------------------------------------------------
// D8. New user: pages query with no rows; apply_cv_parse creates the profile row; user adds a skill that exists
// ---------------------------------------------------------------------------
test('D8. new user flow pieces: empty profile, parse creates profile, duplicate skill insert is a unique violation', async () => {
  const B = '33333333-3333-3333-3333-333333333333';
  await db.query(`insert into auth.users (id, email) values ($1, 'b@test.dev')`, [B]);
  const asB = (sql, p) => as('authenticated', B, sql, p);
  let r = await asB(`select count(*)::int as n from profiles`);
  assert.equal(r.rows[0].n, 0);
  r = await asB(`insert into cv_uploads (user_id, storage_path, file_name, parse_status, consent_at) values ($1, $2, 'cv.pdf', 'pending', now()) returning id`, [B, `${B}/cv.pdf`]);
  const up = r.rows[0].id;
  r = await asB(`select apply_cv_parse($1, $2::jsonb)`, [up, JSON.stringify(baseParse({ profile: { full_name: 'New Person' }, skills: [{ name: 'Clay', quote: 'Clay' }] }))]);
  assert.equal(r.error, undefined, r.error);
  r = await asB(`select full_name from profiles`);
  assert.equal(r.rows[0].full_name, 'New Person');
  // addSkill for a name that already exists as 'suggested': the app ignores 23505 and the skill stays suggested
  r = await asB(`insert into skills (user_id, name, status, source_type) values ($1, 'clay', 'confirmed', 'user')`, [B]);
  assert.match(r.error ?? '', /duplicate key/);
  r = await asB(`select status from skills where lower(name) = 'clay'`);
  assert.equal(r.rows[0].status, 'suggested', 'documented: typing an already-suggested skill does not confirm it (low)');
});
