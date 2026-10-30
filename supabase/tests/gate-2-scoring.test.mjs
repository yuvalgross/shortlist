// Gate 2 groundwork: fit factors after role fit and location, as the scan applies them.
// Run: cd supabase/tests && node --test gate-2-scoring.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.mjs';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
let as, configA, small, big, unknownSize;
// Yuval's scan rules, which he sets in Rules; new users start with these switched off (20261031000001).
const SCAN_RULES = {
  factor_rules: {
    team_size: { build_small_max: 150, build_small: 0.5, ops_large_min: 300, ops_large: -0.5 },
    deductions: { sales_ops: -0.5, run_and_report: -0.5, ops_years_gap: -0.5 },
    deduction_cap: -1,
    cv_threshold_by_factor: { run_and_report: 8.5 },
  },
};

const asA = (sql, p) => as('authenticated', A, sql, p);
const asWorker = (sql, p) => as('service_role', null, sql, p);

async function job(companyId, ext) {
  const r = await asWorker(`insert into jobs (company_id, external_id, title, url, status) values ($1, $2, 'GTM Engineer', 'https://x.test/' || $2, 'open') returning id`, [companyId, ext]);
  assert.equal(r.error, undefined, r.error);
  return r.rows[0].id;
}
async function company(name, headcount) {
  const r = await asWorker(`insert into companies (name, headcount, headcount_source) values ($1, $2, $3) returning id`,
    [name, headcount, headcount == null ? null : 'apollo']);
  assert.equal(r.error, undefined, r.error);
  return r.rows[0].id;
}
let n = 0;
async function match(companyId, roleFit, locationPoints, factors) {
  const jobId = await job(companyId, `j${n++}`);
  return asWorker(
    `insert into job_matches (user_id, job_id, config_id, role_fit, location_points, factors)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     returning total_fit::float8 as total, adjust_points::float8 as adjust, cv_threshold_applied::float8 as bar, factor_points, flags`,
    [A, jobId, configA, roleFit, locationPoints, JSON.stringify(factors)]);
}

before(async () => {
  ({ as } = await freshDb([A, B]));
  const r = await asA(`select set_scoring_config($1::jsonb) as id`, [JSON.stringify(SCAN_RULES)]);
  assert.equal(r.error, undefined, r.error);
  configA = r.rows[0].id;
  small = await company('Small', 60);
  big = await company('Big', 900);
  unknownSize = await company('Unknown', null);
});

test('the scan standing rules are stored as set', async () => {
  const r = await asA(`select factor_rules from scoring_configs where id = $1`, [configA]);
  const f = r.rows[0].factor_rules;
  assert.deepEqual(f.pay_band, { below: -1.5, inside: 0, above: 0.5 });
  assert.deepEqual(f.team_size, { build_small_max: 150, build_small: 0.5, ops_large_min: 300, ops_large: -0.5 });
  assert.deepEqual(f.deductions, { sales_ops: -0.5, run_and_report: -0.5, ops_years_gap: -0.5 });
  assert.equal(f.deduction_cap, -1);
  assert.deepEqual(f.cv_threshold_by_factor, { run_and_report: 8.5 });
});

test('ML6 example from the 10-19 rule: role 8, move +0, run and report and ops years gap = 7, CV bar 8.5', async () => {
  const r = await match(big, 8, 0, { run_and_report: true, ops_years_gap: true, team_size: 'neutral' });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.rows[0].total, 7);
  assert.equal(r.rows[0].bar, 8.5);
  assert.deepEqual(r.rows[0].factor_points, { run_and_report: -0.5, ops_years_gap: -0.5 });
});

test('small team build role: role 7, Berlin +1.5, small team +0.5 = 9, normal CV bar', async () => {
  const r = await match(small, 7, 1.5, { team_size: 'build_small', pay_band: 'inside', pay_band_source: 'call' });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.rows[0].total, 9);
  assert.equal(r.rows[0].bar, 8);
  assert.deepEqual(r.rows[0].flags, []);
});

test('the minus 1 cap covers sales ops, run and report, ops years and the team size minus together', async () => {
  const r = await match(big, 8, 1.5, { sales_ops: true, run_and_report: true, ops_years_gap: true, team_size: 'ops_large' });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.rows[0].adjust, -1);
  assert.equal(r.rows[0].total, 8.5);
  assert.equal(r.rows[0].factor_points.deduction_cap, -1);
});

test('pay below the floor is not part of the cap and is flagged', async () => {
  const r = await match(big, 8, 1.5, { pay_band: 'below', pay_band_source: 'posting', run_and_report: true, ops_years_gap: true, sales_ops: true, team_size: 'neutral' });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.rows[0].adjust, -2.5);
  assert.equal(r.rows[0].total, 7);
  assert.ok(r.rows[0].flags.includes('pay_below_floor'));
});

test('pay above the floor adds 0.5; total stays capped at 10', async () => {
  const r = await match(small, 9, 1.5, { pay_band: 'above', pay_band_source: 'posting', team_size: 'build_small' });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.rows[0].total, 10);
});

test('no stated band: no points, flagged, and the low band hint becomes its own flag', async () => {
  const r = await match(unknownSize, 7, 1.5, { pay_low_hint: true });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.rows[0].total, 8.5);
  assert.deepEqual(r.rows[0].flags.sort(), ['pay_likely_below_floor', 'pay_not_stated', 'team_size_unknown']);
});

test('team size points need a known headcount that fits the rule', async () => {
  let r = await match(unknownSize, 7, 0, { team_size: 'build_small' });
  assert.match(r.error ?? '', /needs the company headcount/);
  r = await match(big, 7, 0, { team_size: 'build_small' });
  assert.match(r.error ?? '', /under 150/);
  r = await match(small, 7, 0, { team_size: 'ops_large' });
  assert.match(r.error ?? '', /over 300/);
});

test('a pay band needs its source, and unknown labels are refused', async () => {
  let r = await match(small, 7, 0, { pay_band: 'below' });
  assert.match(r.error ?? '', /pay_band_source/);
  r = await match(small, 7, 0, { pay_band: 'estimated', pay_band_source: 'posting' });
  assert.match(r.error ?? '', /pay_band must be/);
  r = await match(small, 7, 0, { vibes: true });
  assert.match(r.error ?? '', /unknown factor/);
  r = await match(small, 7, 0, { sales_ops: 'yes' });
  assert.match(r.error ?? '', /true or false/);
});

test('users cannot write factors or points; deciding a match keeps the score', async () => {
  let r = await asA(`update job_matches set factors = '{}'::jsonb`);
  assert.match(r.error ?? '', /permission denied/);
  r = await asA(`update job_matches set adjust_points = 2`);
  assert.match(r.error ?? '', /permission denied/);
  const before = (await asWorker(`select id, total_fit from job_matches where user_id = $1 order by id`, [A])).rows;
  await asWorker(`update companies set headcount = null`);
  r = await asA(`update job_matches set status = 'flagged', flag_reason = 'test'`);
  assert.equal(r.error, undefined, r.error);
  const after = (await asWorker(`select id, total_fit from job_matches where user_id = $1 order by id`, [A])).rows;
  assert.deepEqual(after, before);
});

test('a match cannot point at another user config', async () => {
  const cfgB = (await as('authenticated', B, `select set_scoring_config('{}'::jsonb) as id`)).rows[0].id;
  const jobId = await job(small, 'cross');
  const r = await asWorker(`insert into job_matches (user_id, job_id, config_id, role_fit) values ($1, $2, $3, 7)`, [A, jobId, cfgB]);
  assert.match(r.error ?? '', /does not belong/);
});

test('set_scoring_config merges partial factor rules and validates them', async () => {
  let r = await asA(`select set_scoring_config('{"factor_rules": {"team_size": {"build_small_max": 100}}}'::jsonb) as id`);
  assert.equal(r.error, undefined, r.error);
  r = await asA(`select factor_rules from scoring_configs where is_active`);
  assert.equal(r.rows[0].factor_rules.team_size.build_small_max, 100);
  assert.equal(r.rows[0].factor_rules.team_size.build_small, 0);
  assert.equal(r.rows[0].factor_rules.deduction_cap, -1);

  for (const [cfg, msg] of [
    ['{"factor_rules": {"cv_threshold_by_factor": {"run_and_report": 7.5}}}', /between cv_threshold and 10/],
    ['{"factor_rules": {"deductions": {"sales_ops": 0.5}}}', /between -1 and 0/],
    ['{"factor_rules": {"deductions": {"vibes": -0.5}}}', /unknown deduction/],
    ['{"factor_rules": {"bonus": {}}}', /unknown part/],
    ['{"factor_rules": {"team_size": {"ops_large_min": 50}}}', /team_size rules/],
    ['{"factor_rules": []}', /must be an object/],
  ]) {
    r = await asA(`select set_scoring_config($1::jsonb)`, [cfg]);
    assert.match(r.error ?? '', msg, cfg);
  }
});

test('the profile snapshot carries the active factor rules', async () => {
  const r = await asA(`select snapshot from profile_snapshots`);
  assert.equal(r.rows[0].snapshot.scoring.factor_rules.team_size.build_small_max, 100);
});

test('new users start with the personal rules switched off; pay band stays on', async () => {
  const r = await as('authenticated', B, `select set_scoring_config('{}'::jsonb) as id`);
  const f = (await as('authenticated', B, `select factor_rules from scoring_configs where id = $1`, [r.rows[0].id])).rows[0].factor_rules;
  assert.deepEqual(f.pay_band, { below: -1.5, inside: 0, above: 0.5 });
  assert.deepEqual(f.deductions, { sales_ops: 0, run_and_report: 0, ops_years_gap: 0 });
  assert.equal(f.team_size.build_small, 0);
  assert.equal(f.team_size.ops_large, 0);
  assert.deepEqual(f.cv_threshold_by_factor, {});
});
