import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { poll } from '../src/poll';
import { Store, SEND_RETRY_WINDOW_MS } from '../src/store';
import { normalizeTweet } from '../src/twitter';
import type { Env } from '../src/types';

const config = (): Env => ({ ...env, ACTIVE_HOURS_ENABLED: 'false', ADMIN_TOKEN: 'test-token-12345678901234567890123456789',
  TWITTERAPI_IO_KEY: 'twitter-test', LLM_API_KEY: 'llm-test', RESEND_API_KEY: 'email-test',
  EMAIL_FROM: 'Radar <radar@example.com>', EMAIL_TO: 'me@example.com', WATCHED_ACCOUNTS: '["builder"]' });
const replies = { fit: 'high', reason: 'Product building', funny: 'The backlog has acquired a backlog.',
  engaging: 'Which part took the longest?', thoughtProvoking: 'Maybe the hard part moved elsewhere.', recommended: 'funny' };
const rawTweet = (id: string, createdAt = new Date(Date.now() - 1000).toISOString()) => ({ id, author: { userName: 'builder', name: 'Builder' },
  text: 'AI makes building software easier. Distribution still feels hard.', createdAt, isReply: false,
  inReplyToId: null, quoted_tweet: null, retweeted_tweet: null });
const page = (tweets: unknown[], cursor = '') => Response.json({ tweets, has_next_page: Boolean(cursor), next_cursor: cursor });
function mockServices(tweets: unknown[] = [], modelResult: unknown = replies) {
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    // Exercise actual Workerd Request validation before replacing provider responses.
    new Request(input, init);
    const url = String(input);
    if (url.startsWith('https://api.twitterapi.io/')) return page(tweets);
    if (url.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body));
      if (body.model === 'gpt-6-luna' && (body.max_completion_tokens !== 600 || body.max_tokens !== undefined
        || (body.temperature !== undefined && body.reasoning_effort !== 'none'))) {
        return Response.json({ error: { code: 'unsupported_parameter' } }, { status: 400 });
      }
      return Response.json({ choices: [{ message: { content: JSON.stringify(modelResult) } }] });
    }
    if (url === 'https://api.resend.com/emails') return Response.json({ id: 'mail-1' });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', mock); return mock;
}
async function seedBaseline() {
  const store = new Store(env.DB); expect(await store.acquire()).toBe(true);
  const now = Date.now();
  await store.saveState({ initializedAt: now - 300_000, watermark: now - 120_000,
    lastSuccessfulPollAt: now - 120_001, accounts: { builder: now - 300_000 } });
  await store.release();
}
async function manual(id: string, patch: Partial<Env> = {}, text = 'AI software distribution is hard.') {
  const bindings = { ...config(), ...patch };
  const request = new Request('https://radar.example/test/tweet', { method: 'POST',
    headers: { Authorization: `Bearer ${bindings.ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tweetId: id, username: 'builder', text }) });
  return worker.fetch(request, bindings);
}

describe('gates and authentication', () => {
  it('disabled cron exits without touching DB or external services, even if other config is invalid', async () => {
    const fetch = mockServices();
    expect(await poll({ ...config(), DB: undefined as unknown as D1Database, X_REPLY_RADAR_ENABLED: 'false', POLL_INTERVAL_MINUTES: 'bad' }))
      .toEqual({ status: 'disabled' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('inactive hours exit before DB and APIs', async () => {
    const fetch = mockServices();
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-07T05:00:00Z'));
    expect(await poll({ ...config(), DB: undefined as unknown as D1Database, ACTIVE_HOURS_ENABLED: 'true' })).toEqual({ status: 'inactive' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('invalid intervals fail closed with no paid calls', async () => {
    const fetch = mockServices();
    await expect(poll({ ...config(), POLL_INTERVAL_MINUTES: '0' })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('protects every endpoint and exposes operational status without keys', async () => {
    const bindings = config(); const fetch = mockServices();
    for (const endpoint of ['/health','/status','/poll','/test/tweet']) {
      expect((await worker.fetch(new Request(`https://radar.example${endpoint}`), bindings)).status).toBe(401);
    }
    const response = await worker.fetch(new Request('https://radar.example/status', {
      headers: { Authorization: `Bearer ${bindings.ADMIN_TOKEN}` },
    }), bindings);
    const status = await response.json() as Record<string, unknown>;
    expect(status.pollIntervalMinutes).toBe(2);
    expect(JSON.stringify(status)).not.toContain('test-token');
    expect(JSON.stringify(status)).not.toContain('llm-test');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('force bypasses disabled state but preserves active hours', async () => {
    const fetch = mockServices();
    expect((await poll({ ...config(), X_REPLY_RADAR_ENABLED: 'false' }, true)).status).toBe('baseline_initialized');
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-07T05:00:00Z'));
    expect((await poll({ ...config(), ACTIVE_HOURS_ENABLED: 'true', X_REPLY_RADAR_ENABLED: 'false' }, true)).status).toBe('inactive');
  });
});

describe('discovery and lock correctness', () => {
  it('records a baseline, suppresses history and polls from persisted elapsed time', async () => {
    const fetch = mockServices([rawTweet('100', new Date(Date.now() - 60_000).toISOString())]);
    expect((await poll(config())).status).toBe('baseline_initialized');
    expect((await new Store(env.DB).get('100'))?.status).toBe('baseline');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await poll(config())).status).toBe('interval_not_elapsed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('serializes simultaneous cron/manual poll attempts atomically', async () => {
    const fetch = mockServices();
    const results = await Promise.all([poll(config()), poll(config())]);
    expect(results.map(r => r.status)).toContain('baseline_initialized');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('queues new originals, including quotes, but excludes replies and reposts', async () => {
    await seedBaseline();
    const fetch = mockServices([rawTweet('101'), { ...rawTweet('102'), isReply: true },
      { ...rawTweet('103'), retweeted_tweet: { id: '90' } }, { ...rawTweet('104'), quoted_tweet: { id: '91' } }]);
    expect((await poll(config())).processed).toBe(2);
    expect((await new Store(env.DB).get('101'))?.status).toBe('emailed');
    expect((await new Store(env.DB).get('104'))?.status).toBe('emailed');
    expect(await new Store(env.DB).get('102')).toBeNull();
    expect(await new Store(env.DB).get('103')).toBeNull();
    const searchUrl = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(searchUrl.searchParams.get('queryType')).toBe('Latest');
    expect(searchUrl.searchParams.get('query')).toContain('-filter:replies -filter:retweets since_time:');
  });
  it('checkpoints pagination without losing unprocessed tweets when per-poll limits are reached', async () => {
    await seedBaseline();
    const fetch = mockServices();
    fetch.mockImplementationOnce(async () => page([rawTweet('110'), rawTweet('111')], 'page-2'));
    expect((await poll({ ...config(), MAX_SEARCH_PAGES_PER_POLL: '1', MAX_TWEETS_PER_POLL: '1' })).processed).toBe(1);
    let state = await new Store(env.DB).state();
    expect(state.scan?.cursor).toBe('page-2');
    expect((await new Store(env.DB).get('111'))?.status).toBe('seen');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_100);
    await poll({ ...config(), MAX_SEARCH_PAGES_PER_POLL: '1' });
    const secondSearch = fetch.mock.calls.filter(call => String(call[0]).includes('advanced_search'))[1];
    expect(new URL(String(secondSearch?.[0])).searchParams.get('cursor')).toBe('page-2');
    state = await new Store(env.DB).state();
    expect(state.scan).toBeUndefined();
    expect((await new Store(env.DB).get('111'))?.status).toBe('emailed');
  });
  it('baselines newly added accounts and ignores unexpected authors', async () => {
    await seedBaseline();
    mockServices([{ ...rawTweet('120', new Date(Date.now() - 30_000).toISOString()), author: { userName: 'newuser' } },
      { ...rawTweet('121'), author: { userName: 'outsider' } }]);
    await poll({ ...config(), WATCHED_ACCOUNTS: '["builder","newuser"]' });
    expect((await new Store(env.DB).get('120'))?.status).toBe('baseline');
    expect(await new Store(env.DB).get('121')).toBeNull();
  });
  it('does not advance successful poll state on Twitter failure; applies cooldown', async () => {
    await seedBaseline();
    const before = await new Store(env.DB).state();
    const fetch = mockServices(); fetch.mockImplementationOnce(async () => new Response('failure', { status: 500 }));
    await expect(poll(config())).rejects.toThrow('twitter_http_500');
    expect((await new Store(env.DB).state()).lastSuccessfulPollAt).toBe(before.lastSuccessfulPollAt);
    expect((await poll(config())).status).toBe('interval_not_elapsed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('fences a stale lock owner after a replacement acquires the lease', async () => {
    const stale = new Store(env.DB); expect(await stale.acquire()).toBe(true);
    await env.DB.prepare('UPDATE lease SET expires_at=0').run();
    const current = new Store(env.DB); expect(await current.acquire()).toBe(true);
    await expect(stale.saveState({ initializedAt: 1 })).rejects.toThrow('lease_lost');
    await stale.release();
    await current.saveState({ initializedAt: 2 });
    await current.release();
  });
});

describe('pipeline durability and costs', () => {
  it('manual test works while disabled and deduplicates repeated requests', async () => {
    const fetch = mockServices();
    const response = await manual('200', { X_REPLY_RADAR_ENABLED: 'false' });
    expect((await response.json() as {status: string}).status).toBe('emailed');
    await manual('200');
    expect(fetch).toHaveBeenCalledTimes(2);
    const init = fetch.mock.calls[1]?.[1];
    expect((init?.headers as Record<string,string>)['Idempotency-Key']).toBe('x-reply-radar/200');
    const payload = JSON.parse(String(init?.body));
    expect(payload.html.match(/Reply with this/g)).toHaveLength(3);
    expect(payload.text).toContain('Copy-paste fallback:');
    expect(payload.html).toContain('FUNNY — RECOMMENDED');
  });
  it('escapes source HTML in emails', async () => {
    const fetch = mockServices(); await manual('201', {}, 'AI software <script>alert("x")</script>');
    const payload = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(payload.html).not.toContain('<script>');
    expect(payload.html).toContain('&lt;script&gt;');
  });
  it('rejects obvious irrelevant posts without an LLM call', async () => {
    const fetch = mockServices();
    expect((await (await manual('202', {}, 'Football world cup results')).json() as {status: string}).status).toBe('skipped');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('skips model-rejected posts in one call, with optional skip emails', async () => {
    const skip = { fit: 'skip', reason: 'Forced reply', funny: '', engaging: '', thoughtProvoking: '', recommended: 'funny' };
    const fetch = mockServices([], skip);
    await manual('203'); expect(fetch).toHaveBeenCalledTimes(1);
    expect((await new Store(env.DB).get('203'))?.status).toBe('skipped');
    await manual('204', { SEND_SKIP_EMAILS: 'true' }); expect(fetch).toHaveBeenCalledTimes(3);
    expect((await new Store(env.DB).get('204'))?.status).toBe('emailed');
  });
  it('repairs malformed generation once and persists failures for a later retry', async () => {
    const fetch = mockServices();
    fetch.mockImplementationOnce(async () => Response.json({ choices: [{ message: { content: 'not JSON' } }] }));
    await manual('205'); expect(fetch).toHaveBeenCalledTimes(3);
    expect((await new Store(env.DB).get('205'))?.status).toBe('emailed');
    fetch.mockImplementation(async () => Response.json({ choices: [{ message: { content: 'not JSON' } }] }));
    await manual('206');
    const row = await new Store(env.DB).get('206');
    expect(row?.status).toBe('seen'); expect(row?.generation_attempts).toBe(1);
    expect(row?.next_attempt_at).toBeGreaterThan(Date.now());
    expect((await new Store(env.DB).counters()).llm_calls).toBe(4);
  });
  it('retries uncertain mail with identical payload after config changes without regenerating', async () => {
    const fetch = mockServices();
    fetch.mockImplementationOnce(async () => Response.json({ choices: [{ message: { content: JSON.stringify(replies) } }] }));
    fetch.mockImplementationOnce(async () => { throw new Error('simulated timeout'); });
    await manual('207');
    expect((await new Store(env.DB).get('207'))?.status).toBe('sending');
    const originalPayload = fetch.mock.calls[1]?.[1]?.body;
    await env.DB.prepare('UPDATE tweets SET next_attempt_at=0 WHERE id=?').bind('207').run();
    await manual('207', { EMAIL_TO: 'other@example.com', EMAIL_FROM: 'Other <other@example.com>' });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2]?.[1]?.body).toBe(originalPayload);
    expect((await new Store(env.DB).get('207'))?.status).toBe('emailed');
  });
  it('never resends ambiguous mail after the idempotency window', async () => {
    const fetch = mockServices();
    fetch.mockImplementationOnce(async () => Response.json({ choices: [{ message: { content: JSON.stringify(replies) } }] }));
    fetch.mockImplementationOnce(async () => new Response('server error', { status: 500 }));
    await manual('208');
    await env.DB.prepare('UPDATE tweets SET send_started_at=?,next_attempt_at=0 WHERE id=?')
      .bind(Date.now() - SEND_RETRY_WINDOW_MS - 1, '208').run();
    await manual('208');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await new Store(env.DB).get('208'))?.status).toBe('uncertain');
  });
  it('suppresses repeat manual alerts even after retained payloads are removed', async () => {
    const fetch = mockServices(); await manual('230');
    await env.DB.prepare('UPDATE tweets SET updated_at=? WHERE id=?').bind(Date.now() - 31 * 86_400_000, '230').run();
    const response = await manual('230');
    expect(await response.json()).toEqual({ tweetId: '230', status: 'emailed', duplicateSuppressed: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await new Store(env.DB).get('230')).toBeNull();
  });
  it('caps generation attempts and daily paid calls', async () => {
    const fetch = mockServices();
    fetch.mockImplementation(async () => new Response('LLM unavailable', { status: 500 }));
    for (let i = 0; i < 4; i++) {
      await env.DB.prepare('UPDATE tweets SET next_attempt_at=0 WHERE id=?').bind('209').run();
      await manual('209');
    }
    expect(fetch).toHaveBeenCalledTimes(3);
    expect((await new Store(env.DB).get('209'))?.status).toBe('failed');
    await manual('210', { MAX_DAILY_LLM_CALLS: '3' });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect((await new Store(env.DB).get('210'))?.error_code).toBe('daily_limit_llm_calls');
  });
  it('enforces the Twitter request budget before making another request', async () => {
    const fetch = mockServices();
    await poll({ ...config(), MAX_DAILY_TWITTER_CALLS: '1' });
    await env.DB.prepare("UPDATE radar_state SET value=json_set(value,'$.lastSuccessfulPollAt',0,'$.lastAttemptPollAt',0)").run();
    await expect(poll({ ...config(), MAX_DAILY_TWITTER_CALLS: '1' })).rejects.toThrow('daily_limit_twitter_calls');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('caps email send attempts without regenerating saved replies', async () => {
    const fetch = mockServices();
    fetch.mockImplementation(async (input: string | URL | Request) => String(input).endsWith('/chat/completions')
      ? Response.json({ choices: [{ message: { content: JSON.stringify(replies) } }] })
      : new Response('email unavailable', { status: 500 }));
    for (let i = 0; i < 4; i++) {
      await env.DB.prepare('UPDATE tweets SET next_attempt_at=0 WHERE id=?').bind('240').run();
      await manual('240');
    }
    expect(fetch).toHaveBeenCalledTimes(4); // One LLM call, three sends.
    expect((await new Store(env.DB).get('240'))?.status).toBe('uncertain');
    expect((await new Store(env.DB).counters()).email_attempts).toBe(3);
    expect((await new Store(env.DB).counters()).emails_sent).toBe(0);
  });
  it('blocks an email above its daily cap before contacting Resend', async () => {
    const fetch = mockServices();
    await manual('241', { MAX_DAILY_EMAILS: '1' });
    await manual('242', { MAX_DAILY_EMAILS: '1' });
    expect(fetch).toHaveBeenCalledTimes(3); // Two generations, only one email.
    expect((await new Store(env.DB).get('242'))?.status).toBe('generated');
    expect((await new Store(env.DB).get('242'))?.error_code).toBe('daily_limit_email_attempts');
  });
  it('rejects malformed vendor pages and test bodies', async () => {
    expect(() => normalizeTweet({ ...rawTweet('220'), createdAt: 'invalid' })).toThrow();
    const bindings = config();
    const response = await worker.fetch(new Request('https://radar.example/test/tweet', {
      method: 'POST', headers: { Authorization: `Bearer ${bindings.ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tweetId: '1', username: 'unsafe/name', text: 'AI' }),
    }), bindings);
    expect(response.status).toBe(400);
  });
});
