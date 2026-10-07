import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deploymentConfig } from '../scripts/prepare-deploy.mjs';

const id = '11111111-2222-4333-8444-555555555555';
const source = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');

test('rejects missing and malformed production bindings before calling Cloudflare', () => {
  const placeholder = source.replace(/database_id\s*=\s*"[^"]+"/, 'database_id = "00000000-0000-0000-0000-000000000000"');
  assert.throws(() => deploymentConfig(placeholder), /CLOUDFLARE_D1_DATABASE_ID/);
  for (const invalid of ['', 'not-a-uuid', '00000000-0000-0000-0000-000000000000', `${id}"\nname="another-worker`]) {
    assert.throws(() => deploymentConfig(source, invalid), /CLOUDFLARE_D1_DATABASE_ID/);
  }
});
test('uses the production database while preserving source, cron and runtime-variable ownership', () => {
  const output = deploymentConfig(source, id);
  assert.match(output, new RegExp(`database_id = "${id}"`));
  assert.match(output, /name = "x-reply-radar"/);
  assert.match(output, /main = "src\/index.ts"/);
  assert.match(output, /keep_vars = true/);
  assert.match(output, /crons = \["\* \* \* \* \*"\]/);
  assert.match(output, /migrations_dir = "migrations"/);
  assert.doesNotMatch(output, /\[vars\]|X_REPLY_RADAR_ENABLED|WATCHED_ACCOUNTS|LLM_MODEL/);
  assert.match(source, /LLM_MODEL = "gpt-6-luna"/);
});
test('retains subsequent TOML sections after removing only the vars table', () => {
  const output = deploymentConfig(`${source}\n[limits]\ncpu_ms = 30000\n`, id);
  assert.match(output, /\[limits\]\ncpu_ms = 30000/);
  assert.doesNotMatch(output, /SEND_SKIP_EMAILS/);
});
test('supports a configured database ID without an environment override', () => {
  const configured = source.replace(/database_id\s*=\s*"[^"]+"/, `database_id = "${id}"`);
  assert.match(deploymentConfig(configured), new RegExp(id));
});
test('fails closed if variable preservation is disabled or database bindings are ambiguous', () => {
  assert.throws(() => deploymentConfig(source.replace('keep_vars = true', 'keep_vars = false'), id), /keep_vars/);
  assert.throws(() => deploymentConfig(`${source}\n[[d1_databases]]\ndatabase_id = "${id}"\n`, id), /exactly one/);
});
