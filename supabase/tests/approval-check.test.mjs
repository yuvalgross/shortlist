// Smoke test: the approval check runs and passes on a fake parsed account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb } from './helpers.mjs';
const A = '11111111-1111-1111-1111-111111111111';
test('approval check query runs', async () => {
  const { db } = await freshDb([A]);
  const cvText = 'Yuval Gross\nOutbound GTM Engineer • Berlin Nov 2024 to Present\nOEB Global Conference\n• Built from zero: Signal engine grew program revenue from about €295k to €390k.\n• Signal triggers: MQL rate +42%, close rate 40% vs 12%.\nSKILLS Clay, HubSpot';
  const up = (await db.query(`insert into cv_uploads (user_id, storage_path, file_name, parse_status, parsed_text, parse_model, parse_report) values ($1,'x','cv.pdf','parsed',$2,'claude-sonnet-5-5','{"dropped":[],"usage":{"input_tokens":3000,"output_tokens":2000}}') returning id`, [A, cvText])).rows[0].id;
  const e = (await db.query(`insert into experiences (user_id, cv_upload_id, title, company, start_date, is_current, source_quote, status) values ($1,$2,'Outbound GTM Engineer','OEB Global Conference','2024-11-01',true,'Outbound GTM Engineer • Berlin Nov 2024 to Present','suggested') returning id`, [A, up])).rows[0].id;
  await db.query(`insert into stories (user_id, cv_upload_id, experience_id, title, source_quote, result_metric, status) values ($1,$2,$3,'Built from zero','Built from zero: Signal engine grew program revenue from about €295k to €390k.','€295k to €390k','suggested'), ($1,$2,$3,'Signal triggers','Signal triggers: MQL rate +42%, close rate 40% vs 12%.','MQL rate +42%','suggested')`, [A, up, e]);
  await db.query(`insert into skills (user_id, cv_upload_id, name, source_type, source_quote, status) values ($1,$2,'Clay','cv','SKILLS Clay, HubSpot','suggested')`, [A, up]);
  await db.query(`insert into not_on_record (user_id, claim) values ($1, 'ZoomInfo')`, [A]);
  const sql = readFileSync(new URL('../checks/gate-1-approval.sql', import.meta.url), 'utf8').replace('REPLACE_WITH_EMAIL', 'u0@test.dev');
  const rows = (await db.query(sql)).rows;

  assert.equal(rows.length, 10);
  assert.ok(rows.filter((r) => r.n !== 5).every((r) => r.pass), 'all checks except role count pass on the fake data');
});
