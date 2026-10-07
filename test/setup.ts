import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Env as RadarEnv } from '../src/types';

declare global {
  namespace Cloudflare {
    interface Env extends RadarEnv { TEST_MIGRATIONS: D1Migration[] }
  }
}
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tweets'), env.DB.prepare('DELETE FROM email_receipts'), env.DB.prepare('DELETE FROM counters'),
    env.DB.prepare("UPDATE radar_state SET value='{}' WHERE id=1"),
    env.DB.prepare("UPDATE lease SET owner='',expires_at=0 WHERE id=1"),
  ]);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
