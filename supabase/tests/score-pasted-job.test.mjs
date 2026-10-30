// Gate 2: scoring one pasted job. Pasted jobs stay private, the score goes through the factor trigger,
// and companies that rejected the user lately are flagged.
// Run: cd supabase/tests && node --test score-pasted-job.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.mjs';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
let as;
const asA = (sql, p) => as('authenticated', A, sql, p);
const asB = (sql, p) => as('authenticated', B, sql, p);
const asWorker = (sql, p) => as('service_role', null, sql, p);

const JD = 'We are hiring a GTM Engineer to build our outbound engine with Clay, n8n and HubSpot. '.repeat(5);
const payload = (over = {}) => ({
  company: { name: 'Kubermatic', headcount: 65, headcount_source: 'other' },
  job: { title: 'GTM Engineer', url: 'https://kubermatic.bamboohr.com/careers/43', description: JD, location_text: 'Remote CET' },
  match: {
    role_fit: 8, location_points: 1.5,
    factors: { team_size: 'build_small' },
    reasons: { plus: ['HubSpot and n8n'], minus: ['GA4 not on record'] },
    location_note: 'Remote anywhere in the EU',
  },
  ...over,
});
const SCAN_RULES = {
  factor_rules: {
    team_size: { build_small_max: 150, build_small: 0.5, ops_large_min: 300, ops_large: -0.5 },
    deductions: { sales_ops: -0.5, run_and_report: -0.5, ops_years_gap: -0.5 },
    deduction_cap: -1,
    cv_threshold_by_factor: { run_and_report: 8.5 },
  },
};
const score = (who, p) => who(`select score_pasted_job($1::jsonb) as r`, [JSON.stringify(p)]);

before(async () => {
  ({ as } = await freshDb([A, B]));
  const r = await asA(`select set_scoring_config($1::jsonb)`, [JSON.stringify(SCAN_RULES)]);
  assert.equal(r.error, undefined, r.error);
});

test('Kubermatic replay: role 8, remote +1.5, small team +0.5 = 10', async () => {
  const r = await score(asA, payload());
  assert.equal(r.error, undefined, r.error);
  const m = await asA(`select total_fit::float8 as total, adjust_points::float8 as adjust, cv_threshold_applied::float8 as bar, flags
                         from job_matches where id = $1`, [r.rows[0].r.match_id]);
  assert.deepEqual(m.rows[0], { total: 10, adjust: 0.5, bar: 8, flags: ['pay_not_stated'] });
  const cfg = await asA(`select count(*)::int as n from scoring_configs where is_active`);
  assert.equal(cfg.rows[0].n, 1);
});

test('a second paste reuses the active config', async () => {
  const r = await score(asA, payload({
    company: { name: 'Lucanet', headcount: 1100 },
    match: { role_fit: 7, location_points: 1.5, factors: { team_size: 'neutral', run_and_report: true } },
  }));
  assert.equal(r.error, undefined, r.error);
  const cfg = await asA(`select count(*)::int as n from scoring_configs`);
  assert.equal(cfg.rows[0].n, 1);
  // Lucanet replay from the 10-23 run: role 7, remote Germany +1.5, run and report minus 0.5 = 8, CV bar 8.5
  const m = await asA(`select total_fit::float8 as total, cv_threshold_applied::float8 as bar from job_matches where id = $1`, [r.rows[0].r.match_id]);
  assert.deepEqual(m.rows[0], { total: 8, bar: 8.5 });
});

test('pasted jobs and their companies are invisible to other users', async () => {
  const jobs = await asB(`select count(*)::int as n from jobs`);
  const cos = await asB(`select count(*)::int as n from companies`);
  const matches = await asB(`select count(*)::int as n from job_matches`);
  assert.deepEqual([jobs.rows[0].n, cos.rows[0].n, matches.rows[0].n], [0, 0, 0]);
  const own = await asA(`select count(*)::int as n from jobs where added_by = $1`, [A]);
  assert.equal(own.rows[0].n, 2);
});

test('jobs the worker found stay visible to everyone', async () => {
  const co = await asWorker(`insert into companies (name) values ('Shared Co') returning id`);
  await asWorker(`insert into jobs (company_id, external_id, title, url) values ($1, 'x1', 'AE', 'https://x.test')`, [co.rows[0].id]);
  const r = await asB(`select title from jobs`);
  assert.deepEqual(r.rows.map((x) => x.title), ['AE']);
});

test('users still cannot insert jobs or companies directly', async () => {
  let r = await asA(`insert into companies (name, added_by) values ('Sneaky', $1)`, [A]);
  assert.match(r.error ?? '', /permission denied/);
  r = await asA(`insert into job_matches (user_id, job_id, config_id, role_fit) select $1, id, (select id from scoring_configs limit 1), 10 from jobs limit 1`, [A]);
  assert.match(r.error ?? '', /permission denied/);
});

test('a user can remove their own pasted job, never a shared or someone else\'s', async () => {
  const mine = await asA(`select id from companies where name = 'Lucanet'`);
  let r = await asB(`delete from companies where id = $1`, [mine.rows[0].id]);
  assert.equal(r.affected, 0);
  r = await asA(`delete from companies where name = 'Shared Co'`);
  assert.equal(r.affected, 0);
  r = await asA(`delete from companies where id = $1`, [mine.rows[0].id]);
  assert.equal(r.affected, 1);
  const left = await asA(`select count(*)::int as n from job_matches`);
  assert.equal(left.rows[0].n, 1);
});

test('bad input is refused with a plain message', async () => {
  let r = await score(asA, payload({ job: { title: 'X', description: 'too short' } }));
  assert.match(r.error ?? '', /too short/);
  r = await score(asA, payload({ match: { location_points: 1 } }));
  assert.match(r.error ?? '', /role_fit and location_points/);
  r = await score(asA, payload({ match: { role_fit: 11, location_points: 0 } }));
  assert.match(r.error ?? '', /check constraint|violates/);
  r = await score(asA, payload({ company: { name: 'NoSize' }, match: { role_fit: 7, location_points: 0, factors: { team_size: 'build_small' } } }));
  assert.match(r.error ?? '', /needs the company headcount/);
  r = await as('anon', null, `select score_pasted_job('{}'::jsonb)`);
  assert.match(r.error ?? '', /permission denied/);
});

test('a company that rejected the user in the last 60 days is flagged, never scored down', async () => {
  await asA(`insert into applications (user_id, company, role, stage) values ($1, 'Cosuno', 'GTM & Growth Engineer', 'rejected')`, [A]);
  await asA(`insert into applications (user_id, company, role, stage, created_at) values ($1, 'Oldco', 'AE', 'rejected', now() - interval '90 days')`, [A]);
  const r = await score(asA, payload({ company: { name: ' cosuno ', headcount: 120 } }));
  assert.equal(r.error, undefined, r.error);
  const m = await asA(`select total_fit::float8 as total, flags from job_matches where id = $1`, [r.rows[0].r.match_id]);
  assert.equal(m.rows[0].total, 10);
  assert.ok(m.rows[0].flags.includes('rejected_here_recently'));
  const old = await score(asA, payload({ company: { name: 'Oldco', headcount: 50 } }));
  const m2 = await asA(`select flags from job_matches where id = $1`, [old.rows[0].r.match_id]);
  assert.ok(!m2.rows[0].flags.includes('rejected_here_recently'));
  // another user's rejection does not flag A
  await asB(`insert into applications (user_id, company, role, stage) values ($1, 'Kubermatic', 'GTM Engineer', 'rejected')`, [B]);
  const k = await score(asA, payload());
  const m3 = await asA(`select flags from job_matches where id = $1`, [k.rows[0].r.match_id]);
  assert.ok(!m3.rows[0].flags.includes('rejected_here_recently'));
});

test('my_profile_snapshot returns only the caller\'s own profile', async () => {
  await asA(`insert into profiles (user_id, full_name) values ($1, 'Ann')`, [A]);
  const a = await asA(`select my_profile_snapshot() as s`);
  assert.equal(a.rows[0].s.profile.full_name, 'Ann');
  const b = await asB(`select my_profile_snapshot() as s`);
  assert.equal(b.rows[0].s.profile, null);
});

// Replay of fit lines the scan recorded in claude/job-scan-log.md. Role fit and labels as the scan gave them;
// the database must produce the same total. Rules apply as they stood on the scan date
// (Checkpoint GTM was scored on 10-27, before the team size rule of 10-28, so its team size is left unknown).
const REPLAY = [
  ['Kubermatic 10-29', 8, 1.5, { team_size: 'build_small' }, 65, 10],
  ['Cygrid 10-21', 8.5, 1.5, {}, null, 10],
  ['REMATIQ 10-14', 8, 1.5, {}, null, 9.5],
  ['Checkpoint GTM 10-27', 8, 1.5, { pay_band: 'inside', pay_band_source: 'posting' }, null, 9.5],
  ['Platform Engineering 10-13', 7.5, 1.5, {}, null, 9],
  ['Legartis 10-19', 7, 1.5, {}, null, 8.5],
  ['Lucanet 10-23', 7, 1.5, { run_and_report: true }, null, 8],
  ['vCluster Labs 10-29 (UK listing, GBP not compared)', 7.5, 0, {}, null, 7.5],
  ['NavVis 10-27 (Munich, needs a move)', 7.5, 0, {}, null, 7.5],
  ['OpenUp 10-23 (Amsterdam hybrid)', 7, 0, {}, null, 7],
  ['Brighter AI 10-22', 5, 1.5, {}, null, 6.5],
  ['Coverflex 10-22 (EUR 30k to 38k)', 6.5, 1.5, { pay_band: 'below', pay_band_source: 'posting' }, null, 6.5],
  ['Dandy 10-22 (ops years gap and run shape)', 5.5, 1.5, { ops_years_gap: true, run_and_report: true }, null, 6],
  ['ML6 10-19 rule example', 8, 0, { run_and_report: true, ops_years_gap: true }, null, 7],
];

test('scan replay: every recorded total comes out the same', async () => {
  const out = [];
  for (const [name, role, loc, factors, hc, expected] of REPLAY) {
    const r = await score(asA, payload({
      company: { name, ...(hc ? { headcount: hc } : {}) },
      match: { role_fit: role, location_points: loc, factors },
    }));
    assert.equal(r.error, undefined, `${name}: ${r.error}`);
    const m = await asA(`select total_fit::float8 as total from job_matches where id = $1`, [r.rows[0].r.match_id]);
    out.push([name, m.rows[0].total, expected]);
  }
  for (const [name, got, expected] of out) assert.equal(got, expected, name);
});

test('a user with no rules yet gets the neutral defaults on the first paste: no team size or deduction points', async () => {
  const r = await score(asB, payload({ match: { role_fit: 7, location_points: 1.5, factors: { team_size: 'build_small', run_and_report: true } } }));
  assert.equal(r.error, undefined, r.error);
  const m = await asB(`select total_fit::float8 as total, cv_threshold_applied::float8 as bar from job_matches where id = $1`, [r.rows[0].r.match_id]);
  assert.deepEqual(m.rows[0], { total: 8.5, bar: 8 });
});

test('Cyprus +1.25 keeps both decimals, and wide but valid rules do not break saving', async () => {
  let r = await score(asA, payload({ company: { name: 'Limassol Co' }, match: { role_fit: 8, location_points: 1.25, factors: {} } }));
  assert.equal(r.error, undefined, r.error);
  let m = await asA(`select total_fit::float8 as total, location_points::float8 as loc from job_matches where id = $1`, [r.rows[0].r.match_id]);
  assert.deepEqual(m.rows[0], { total: 9.25, loc: 1.25 });
  const cfg = await asB(`select set_scoring_config($1::jsonb)`, [JSON.stringify({ factor_rules: {
    pay_band: { below: -3, inside: 0, above: 2 }, team_size: { build_small: 1, ops_large: -1 }, deduction_cap: -3,
    deductions: { sales_ops: -1, run_and_report: -1, ops_years_gap: -1 } } })]);
  assert.equal(cfg.error, undefined, cfg.error);
  r = await score(asB, payload({ company: { name: 'Big pay', headcount: 50 }, job: { title: 'GTM', description: JD, salary_min: 100000 },
    match: { role_fit: 5, location_points: 0, factors: { pay_band: 'above', pay_band_source: 'posting', team_size: 'build_small' } } }));
  assert.equal(r.error, undefined, r.error);
  r = await score(asB, payload({ company: { name: 'Low pay', headcount: 900 }, job: { title: 'Ops', description: JD },
    match: { role_fit: 9, location_points: 0, factors: { pay_band: 'below', pay_band_source: 'posting', team_size: 'ops_large', sales_ops: true, run_and_report: true, ops_years_gap: true } } }));
  assert.equal(r.error, undefined, r.error);
  m = await asB(`select total_fit::float8 as total, adjust_points::float8 as adj from job_matches where id = $1`, [r.rows[0].r.match_id]);
  assert.deepEqual(m.rows[0], { total: 3, adj: -6 });
});
