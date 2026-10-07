import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { dashboard } from '../src/dashboard';
import { parseConfig } from '../src/config';
import { Store } from '../src/store';
import { poll } from '../src/poll';
import { defaultSettings, saveSettings } from '../src/settings';
import { operationalStatus } from '../src/status';
import type { Env } from '../src/types';

const bindings = (): Env => ({ ...env, ACTIVE_HOURS_ENABLED: 'false', WATCHED_ACCOUNTS: '["builder"]',
  ADMIN_TOKEN: 'controls-test-123456789012345678901234567890', TWITTERAPI_IO_KEY: 'test-twitter', LLM_API_KEY: 'test-llm',
  RESEND_API_KEY: 'test-email', EMAIL_FROM: 'radar@example.com', EMAIL_TO: 'me@example.com' });
const identity = { access: { aud: 'radar', getIdentity: async () => ({ email: 'owner@example.com' }) } };
const result = { fit: 'high', reason: 'Building software', funny: 'The backlog has acquired a backlog.',
  engaging: 'Which part took the longest?', thoughtProvoking: 'Maybe the hard part moved elsewhere.', recommended: 'funny' };
const manual = (b: Env, id: string) => worker.fetch(new Request('https://radar.example/test/tweet', { method: 'POST',
  headers: { Authorization: 'Bearer ' + b.ADMIN_TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ tweetId: id, username: 'builder', text: 'Software distribution feels hard.' }) }), b);

describe('usage metering and spend controls', () => {
  it('records actual input/output/cached tokens for both malformed and repaired replies', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      if (String(input).endsWith('/chat/completions')) {
        attempts++;
        return Response.json({ usage: { prompt_tokens: attempts === 1 ? 25 : 35, completion_tokens: attempts === 1 ? 10 : 20,
          prompt_tokens_details: { cached_tokens: attempts === 1 ? 20 : 5 } },
          choices: [{ message: { content: attempts === 1 ? 'malformed JSON' : JSON.stringify(result) } }] });
      }
      return Response.json({ id: 'mail-usage' });
    }));
    expect((await manual(bindings(), '501')).status).toBe(200);
    const status = await operationalStatus(bindings());
    expect(status.tokenUsage).toMatchObject({ input: 60, output: 30, total: 90, cachedInput: 25, reportedCalls: 2 });
    expect(status.counters.llmCalls).toBe(2);
  });
  it('does not invent token counts when a provider omits usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => String(input).endsWith('/chat/completions')
      ? Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] }) : Response.json({ id: 'mail-no-usage' })));
    await manual(bindings(), '502');
    const status = await operationalStatus(bindings());
    expect(status.counters.llmCalls).toBe(1); expect(status.tokenUsage.total).toBe(0); expect(status.tokenUsage.reportedCalls).toBe(0);
  });
  it('stops cron and force polling at a daily cap and blocks reservations across services', async () => {
    const b = { ...bindings(), MAX_DAILY_TWITTER_CALLS: '2' }; const store = new Store(env.DB);
    expect(await store.acquire()).toBe(true);
    await store.reserve('twitter_calls', 2, parseConfig(b)); await store.reserve('twitter_calls', 2, parseConfig(b));
    await expect(store.reserve('twitter_calls', 2, parseConfig(b))).rejects.toThrow('daily_limit_');
    await expect(store.reserve('llm_calls', 100, parseConfig(b))).rejects.toThrow('daily_limit_');
    await store.release();
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await poll(b)).toEqual({ status: 'daily_limit_paused' });
    expect(await poll(b, true)).toEqual({ status: 'daily_limit_paused' });
    expect((await new Store(env.DB).counters()).twitter_calls).toBe(2);
    expect((await operationalStatus(b)).dailyLimitPause).toMatchObject({ paused: true, reason: 'twitter' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('automatically clears the daily pause on the next UTC day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-07T23:59:00Z'));
      const b = { ...bindings(), MAX_DAILY_TWITTER_CALLS: '1' }; const store = new Store(env.DB);
      expect(await store.acquire()).toBe(true); await store.reserve('twitter_calls', 1, parseConfig(b)); await store.release();
      expect((await operationalStatus(b)).dailyLimitPause.paused).toBe(true);
      vi.setSystemTime(new Date('2026-10-08T00:00:01Z'));
      expect((await operationalStatus(b)).dailyLimitPause.paused).toBe(false);
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tweets: [], has_next_page: false, next_cursor: '' })));
      expect((await poll(b)).status).toBe('baseline_initialized');
    } finally { vi.useRealTimers(); }
  });
  it('lets individual service caps work independently when automatic global pause is off', async () => {
    const b = { ...bindings(), PAUSE_AT_DAILY_LIMITS: 'false', MAX_DAILY_LLM_CALLS: '1' }; const store = new Store(env.DB);
    expect(await store.acquire()).toBe(true); await store.reserve('llm_calls', 1, parseConfig(b));
    await store.reserve('twitter_calls', 1000, parseConfig(b)); await store.release();
    expect((await operationalStatus(b)).dailyLimitPause.paused).toBe(false);
  });
  it('the stop button blocks cron, forced polling, manual tests and already-running call reservations', async () => {
    const b = bindings(); const doc = await saveSettings(b, defaultSettings(b), 0, 'owner@example.com');
    const alreadyRunning = new Store(env.DB); expect(await alreadyRunning.acquire()).toBe(true);
    const stopped = await dashboard(new Request('https://radar.example/dashboard/api/stop', { method: 'POST',
      headers: { Origin: 'https://radar.example', 'X-Radar-Request': 'settings', 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: doc.revision }) }), b, identity);
    expect(stopped.status).toBe(200);
    await expect(alreadyRunning.reserve('twitter_calls', 1000, parseConfig(b))).rejects.toThrow('all_operations_disabled');
    await alreadyRunning.release();
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await poll(b)).toEqual({ status: 'all_operations_disabled' });
    expect(await poll(b, true)).toEqual({ status: 'all_operations_disabled' });
    const manualResponse = await manual(b, '503'); expect(manualResponse.status).toBe(409);
    expect(await manualResponse.json()).toEqual({ error: 'all_operations_disabled' });
    expect(fetch).not.toHaveBeenCalled();
    const resumed = { ...defaultSettings(b), operationsEnabled: true };
    await saveSettings(b, resumed, 2, 'owner@example.com');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tweets: [], has_next_page: false, next_cursor: '' })));
    expect((await poll(b)).status).toBe('baseline_initialized');
  });
  it('requires same-origin authentication for the emergency stop', async () => {
    const b = bindings(); const req = () => new Request('https://radar.example/dashboard/api/stop', { method: 'POST',
      headers: { Origin: 'https://evil.example', 'X-Radar-Request': 'settings', 'Content-Type': 'application/json' }, body: '{}' });
    expect((await dashboard(req(), b, identity)).status).toBe(403);
    expect((await dashboard(req(), b)).status).toBe(403);
  });
});
