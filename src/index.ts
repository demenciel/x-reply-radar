import { ConfigError, parseConfig } from './config';
import { dashboard } from './dashboard';
import { loadRuntimeEnv } from './settings';
import { operationalStatus } from './status';
import { errorCode, log, RadarError } from './log';
import { Store } from './store';
import { poll } from './poll';
import { processTweet } from './pipeline';
import { postUrl } from './intent';
import { object } from './http';
import type { Env, Tweet } from './types';

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
async function authorized(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) return false;
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ') || header.length > 1024) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(header.slice(7))),
    crypto.subtle.digest('SHA-256', encoder.encode(env.ADMIN_TOKEN)),
  ]);
  const a = new Uint8Array(left); const b = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}
async function readTestTweet(request: Request): Promise<Tweet> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new RadarError('test_requires_json');
  if (!request.body) throw new RadarError('test_invalid_body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 32_768) { await reader.cancel(); throw new RadarError('test_body_too_large'); }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let data: Record<string, unknown>;
  try { data = object(JSON.parse(new TextDecoder().decode(bytes))); }
  catch { throw new RadarError('test_invalid_json'); }
  if (typeof data.tweetId !== 'string' || !/^\d{1,30}$/.test(data.tweetId)
    || typeof data.username !== 'string' || !/^@?[A-Za-z0-9_]{1,15}$/.test(data.username)
    || typeof data.text !== 'string' || !data.text.trim() || data.text.length > 12000) throw new RadarError('test_invalid_fields');
  const username = data.username.replace(/^@/, '').toLowerCase();
  return { id: data.tweetId, username, text: data.text, createdAt: new Date().toISOString(),
    isReply: false, isRetweet: false, isQuote: false, url: postUrl(username, data.tweetId), test: true };
}
export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET') return new Response(null, { status: 302, headers: { Location: '/dashboard', 'Cache-Control': 'no-store' } });
    if (url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/')) return dashboard(request, env, ctx);
    if (!['/health','/status','/poll','/test/tweet'].includes(url.pathname)) return json({ error: 'not_found' }, 404);
    if (!await authorized(request, env)) return json({ error: 'unauthorized' }, 401);
    const method = url.pathname === '/health' || url.pathname === '/status' ? 'GET' : 'POST';
    if (request.method !== method) return new Response(null, { status: 405, headers: { Allow: method } });
    try {
      if (url.pathname === '/poll') return json(await poll(env, url.searchParams.get('force') === 'true'));
      env = await loadRuntimeEnv(env);
      if (url.pathname === '/health') {
        // A readiness check includes configuration and an actual database read.
        parseConfig(env); await new Store(env.DB).state();
        return json({ ok: true, service: 'x-reply-radar' });
      }
      if (url.pathname === '/status') {
        return json(await operationalStatus(env));
      }
      const tweet = await readTestTweet(request);
      const config = parseConfig(env); const store = new Store(env.DB);
      if (!config.operationsEnabled) return json({ error: 'all_operations_disabled' }, 409);
      if (!await store.acquire()) return json({ status: 'locked', retry: 'Try again after the current poll finishes' }, 409);
      try {
        await store.cleanup(); await store.enqueue(tweet);
        const row = await store.get(tweet.id);
        if (!row) {
          const receipt = await store.receipt(tweet.id);
          if (receipt) return json({ tweetId: tweet.id, status: receipt.email_id ? 'emailed' : 'uncertain', duplicateSuppressed: true });
          throw new RadarError('missing_tweet');
        }
        if (['seen','generated','sending'].includes(row.status) && row.next_attempt_at <= Date.now()) {
          await processTweet(row, store, env, config);
        }
        const saved = await store.get(tweet.id);
        return json({ tweetId: tweet.id, status: saved?.status, errorCode: saved?.error_code,
          nextAttemptAt: saved?.next_attempt_at ? new Date(saved.next_attempt_at).toISOString() : null,
          result: saved?.result ? JSON.parse(saved.result) : null });
      } finally { await store.release(); }
    } catch (error) {
      if (error instanceof ConfigError) {
        log('configuration_error', { stage: 'config', field: error.field, success: false });
        return json({ error: 'configuration_error', field: error.field }, 503);
      }
      const code = errorCode(error);
      log('request_failed', { stage: 'http', code, success: false });
      return json({ error: code }, code === 'all_operations_disabled' ? 409 : code.startsWith('test_') ? 400 : 503);
    }
  },
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try { await poll(env); }
    catch (error) {
      if (error instanceof ConfigError) log('configuration_error', { stage: 'config', field: error.field, success: false });
      else log('scheduled_failed', { stage: 'scheduled', code: errorCode(error), success: false });
      // Reject so Cloudflare reports this scheduled run as failed.
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
