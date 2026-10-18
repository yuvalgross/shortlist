// Gate 1 database tests: saving a parsed CV, reviewing it, and suggestion buttons.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.mjs';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
let as;
let uploadId;

const parse = {
  model: 'claude-sonnet-5-5',
  report: { dropped: [{ item: 'skill: ZoomInfo', reason: 'not on record' }] },
  profile: {
    full_name: 'Alex M', headline: 'GTM Engineer', location: 'Berlin, Germany', phone: '+49 000', email: 'alex@test.dev',
    links: [{ label: 'LinkedIn', url: 'https://linkedin.com/in/alex' }],
    languages: [{ language: 'English', level: 'C2' }], education: [], certifications: 'Clay Certification',
  },
  experiences: [
    {
      title: 'GTM Engineer', company: 'Acme', start_date: '2024-11-01', end_date: '', is_current: true,
      work_mode: 'hybrid', quote: 'GTM Engineer, Acme, Nov 2024 to Present',
      results: [
        { title: 'Signal engine', text: 'Built a signal engine that lifted MQL rate 42%', metric: 'MQL rate up 42%', quote: 'lifted MQL rate 42%' },
        { title: 'Data cleanup', text: 'Cleaned HubSpot data', metric: '', quote: 'Cleaned HubSpot data' },
      ],
    },
    { title: 'Account Executive', company: 'Beta', start_date: '', end_date: '', is_current: false, quote: 'Account Executive, Beta', results: [] },
  ],
  skills: [
    { name: 'Clay', category: 'tool', quote: 'Clay' },
    { name: 'HubSpot', category: 'tool', quote: 'HubSpot' },
  ],
  suggestions: [
    { kind: 'skill', payload: { name: 'Salesforce', category: 'tool' }, fingerprint: 'skill:salesforce', quote: 'configured Salesforce flows' },
    { kind: 'skill', payload: { name: 'Gong' }, fingerprint: 'skill:gong', quote: 'reviewed calls in Gong' },
  ],
};

before(async () => {
  ({ as } = await freshDb([A, B]));
  const r = await as('authenticated', A,
    `insert into cv_uploads (user_id, storage_path, file_name, parse_status, consent_at) values ($1, $2, 'cv.pdf', 'parsing', now()) returning id`,
    [A, `${A}/cv.pdf`]);
  assert.equal(r.error, undefined, r.error);
  uploadId = r.rows[0].id;
});

const asA = (sql, p) => as('authenticated', A, sql, p);
const asB = (sql, p) => as('authenticated', B, sql, p);

test('user B cannot save a parse onto user A upload', async () => {
  const r = await asB(`select apply_cv_parse($1, $2::jsonb)`, [uploadId, JSON.stringify(parse)]);
  assert.match(r.error ?? '', /upload not found/);
});

test('saving a parse writes everything as suggested, in one go', async () => {
  const r = await asA(`select apply_cv_parse($1, $2::jsonb) as c`, [uploadId, JSON.stringify(parse)]);
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(r.rows[0].c, { experiences: 2, results: 2, skills: 2, suggestions: 2 });

  const exp = await asA(`select title, status, start_date, is_current from experiences order by sort_order`);
  assert.deepEqual(exp.rows.map((x) => [x.title, x.status]), [['GTM Engineer', 'suggested'], ['Account Executive', 'suggested']]);
  const st = await asA(`select result_metric, result_confidence, status, experience_id is not null as linked from stories order by title desc`);
  assert.deepEqual(st.rows.map((x) => [x.result_metric, x.result_confidence, x.status, x.linked]),
    [['MQL rate up 42%', 'verified', 'suggested', true], [null, null, 'suggested', true]]);
  const up = await asA(`select parse_status, parse_model, parse_report->'dropped'->0->>'reason' as reason from cv_uploads`);
  assert.deepEqual(up.rows[0], { parse_status: 'parsed', parse_model: 'claude-sonnet-5-5', reason: 'not on record' });
});

test('unreviewed facts stay out of what the matching model reads', async () => {
  const r = await asA(`select snapshot from profile_snapshots`);
  const s = r.rows[0].snapshot;
  assert.deepEqual(s.experiences, []);
  assert.deepEqual(s.skills, []);
  assert.deepEqual(s.stories, []);
  assert.equal(s.profile.full_name, 'Alex M');
  assert.equal(s.profile.phone, undefined);
});

test('parsing the same upload again replaces unreviewed facts instead of duplicating them', async () => {
  const r = await asA(`select apply_cv_parse($1, $2::jsonb) as c`, [uploadId, JSON.stringify(parse)]);
  assert.equal(r.error, undefined, r.error);
  const n = await asA(`select (select count(*) from experiences)::int as e, (select count(*) from stories)::int as s,
                              (select count(*) from skills)::int as k, (select count(*) from suggestions)::int as g`);
  assert.deepEqual(n.rows[0], { e: 2, s: 2, k: 2, g: 2 });
});

test('a parse never overwrites profile fields the user already has', async () => {
  await asA(`update profiles set headline = 'My own headline'`);
  const changed = { ...parse, profile: { ...parse.profile, headline: 'Parsed headline', full_name: 'Someone Else' } };
  await asA(`select apply_cv_parse($1, $2::jsonb)`, [uploadId, JSON.stringify(changed)]);
  const p = await asA(`select headline, full_name from profiles`);
  assert.deepEqual(p.rows[0], { headline: 'My own headline', full_name: 'Alex M' });
});

test('user can delete a wrongly read role before confirming; the rest gets confirmed', async () => {
  const del = await asA(`delete from experiences where title = 'Account Executive'`);
  assert.equal(del.affected, 1);
  const b = await asB(`select confirm_cv_upload($1)`, [uploadId]);
  assert.match(b.error ?? '', /not ready to confirm/);
  const r = await asA(`select confirm_cv_upload($1) as c`, [uploadId]);
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(r.rows[0].c, { experiences: 1, skills: 2, stories: 2 });
  const s = (await asA(`select snapshot from profile_snapshots`)).rows[0].snapshot;
  assert.deepEqual(s.experiences.map((x) => x.title), ['GTM Engineer']);
  assert.deepEqual(s.skills.map((x) => x.name), ['Clay', 'HubSpot']);
  assert.equal(s.stories.find((x) => x.metric)?.metric, 'MQL rate up 42%');
});

test('re-parsing after confirming keeps confirmed facts and does not duplicate confirmed roles', async () => {
  // a confirmed upload cannot be re-read (that would reopen the review); the same CV as a new upload can
  const again = await asA(`select apply_cv_parse($1, $2::jsonb) as c`, [uploadId, JSON.stringify(parse)]);
  assert.match(again.error ?? '', /not found/, 'a confirmed upload is closed for re-reading');
  const ins = await asA(`insert into cv_uploads (user_id, storage_path, file_name, parse_status, consent_at)
    values ($1, $2, 'cv-again.pdf', 'parsing', now()) returning id`, [A, `${A}/cv-again.pdf`]);
  assert.equal(ins.error, undefined, ins.error);
  const second = ins.rows[0].id;
  const r = await asA(`select apply_cv_parse($1, $2::jsonb) as c`, [second, JSON.stringify(parse)]);
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.rows[0].c.experiences, 1, 'only the role the user had deleted comes back, as suggested');
  const n = await asA(`select title, status from experiences order by status, title`);
  assert.deepEqual(n.rows.map((x) => [x.title, x.status]), [['GTM Engineer', 'confirmed'], ['Account Executive', 'suggested']]);
  const stories = await asA(`select count(*)::int as n from stories where status = 'confirmed'`);
  assert.equal(stories.rows[0].n, 2, 'confirmed results stay and are not duplicated');
});

test('accepting a suggestion adds the skill; another user cannot accept it', async () => {
  const id = (await asA(`select id from suggestions where fingerprint = 'skill:salesforce'`)).rows[0].id;
  const b = await asB(`select accept_suggestion($1)`, [id]);
  assert.match(b.error ?? '', /not found/);
  const r = await asA(`select accept_suggestion($1)`, [id]);
  assert.equal(r.error, undefined, r.error);
  const sk = await asA(`select status, source_type, source_quote from skills where name = 'Salesforce'`);
  assert.deepEqual(sk.rows[0], { status: 'confirmed', source_type: 'suggestion', source_quote: 'configured Salesforce flows' });
  const again = await asA(`select accept_suggestion($1)`, [id]);
  assert.match(again.error ?? '', /not found/, 'an accepted suggestion cannot be applied twice');
});

test('a rejected suggestion does not come back on the next parse', async () => {
  await asA(`update suggestions set status = 'rejected', decided_at = now() where fingerprint = 'skill:gong'`);
  await asA(`select apply_cv_parse($1, $2::jsonb)`, [uploadId, JSON.stringify(parse)]);
  const g = await asA(`select status from suggestions where fingerprint = 'skill:gong'`);
  assert.deepEqual(g.rows.map((x) => x.status), ['rejected']);
});

test('a title suggestion is linked to the saved role and accepting it sets the ATS title', async () => {
  const up = await asA(`insert into cv_uploads (user_id, storage_path, file_name, parse_status) values ($1, $2, 'cv2.pdf', 'parsing') returning id`,
    [A, `${A}/cv2.pdf`]);
  const second = {
    model: 'm', report: {}, profile: {}, skills: [],
    experiences: [{ title: 'Senior AE, Strategic', company: 'Gamma', start_date: '2022-03-01', end_date: '', is_current: true, quote: 'Senior AE, Strategic, Gamma', results: [] }],
    suggestions: [
      { kind: 'title', payload: { experience_index: 0, original_title: 'Senior AE, Strategic', ats_title: 'Senior Account Executive' }, fingerprint: 'title:gamma:senior ae:senior account executive', quote: 'Senior AE, Strategic' },
      { kind: 'title', payload: { experience_index: 5, ats_title: 'Ghost' }, fingerprint: 'title:ghost', quote: 'x' },
    ],
  };
  const r = await asA(`select apply_cv_parse($1, $2::jsonb) as c`, [up.rows[0].id, JSON.stringify(second)]);
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.rows[0].c.suggestions, 1, 'a suggestion pointing at a role that does not exist is skipped');
  const sg = await asA(`select id, payload->>'experience_id' as exp from suggestions where kind = 'title'`);
  const exp = await asA(`select id from experiences where company = 'Gamma'`);
  assert.equal(sg.rows[0].exp, exp.rows[0].id);
  await asA(`select accept_suggestion($1)`, [sg.rows[0].id]);
  const t = await asA(`select title, ats_title from experiences where company = 'Gamma'`);
  assert.deepEqual(t.rows[0], { title: 'Senior AE, Strategic', ats_title: 'Senior Account Executive' });
});

test('signed out visitors cannot call any of the new functions', async () => {
  for (const sql of [`select apply_cv_parse($1, '{}'::jsonb)`, `select confirm_cv_upload($1)`, `select accept_suggestion($1)`]) {
    const r = await as('anon', null, sql, [uploadId]);
    assert.match(r.error ?? '', /permission denied/, sql);
  }
});
