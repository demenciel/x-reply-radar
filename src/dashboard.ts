import html from './dashboard.html';
import { ConfigError } from './config';
import { errorCode, log, RadarError } from './log';
import { operationalStatus } from './status';
import { settingsDocument, settingsEnv, saveSettings, SettingsError, SYSTEM_PROMPT } from './settings';
import type { Env, Tweet } from './types';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin' };
function json(value: unknown, status = 200) { return Response.json(value, { status, headers }); }
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) throw new RadarError('invalid_body');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const chunk = await reader.read(); if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 65_536) { await reader.cancel(); throw new RadarError('body_too_large'); }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw new RadarError('invalid_json'); }
}

export async function dashboard(request: Request, env: Env, ctx?: Pick<ExecutionContext, 'access'>): Promise<Response> {
  // ctx.access is attested by Cloudflare. User-supplied Access headers grant no access.
  if (!ctx?.access || (env.ACCESS_AUD && env.ACCESS_AUD !== ctx.access.aud)) {
    return json({ error: 'cloudflare_access_required', message: 'Sign in through Cloudflare Access to open this dashboard.' }, 403);
  }
  try {
    const identity = await ctx.access.getIdentity();
    if (!identity?.email) return json({ error: 'user_identity_required' }, 403);
    const path = new URL(request.url).pathname;
    const page = path === '/dashboard' || path === '/dashboard/';
    const stop = path === '/dashboard/api/stop';
    const api = path === '/dashboard/api/state' || path === '/dashboard/api/settings' || stop;
    if (!page && !api) return json({ error: 'not_found' }, 404);
    const method = stop ? 'POST' : path === '/dashboard/api/settings' ? 'PUT' : 'GET';
    if (request.method !== method) return new Response(null, { status: 405, headers: { ...headers, Allow: method } });
    if (page) {
      const nonce = crypto.randomUUID().replaceAll('-', '');
      return new Response(html.replaceAll('__NONCE__', nonce), { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
        'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' } });
    }
    if (method !== 'GET') {
      if (request.headers.get('Origin') !== new URL(request.url).origin || request.headers.get('X-Radar-Request') !== 'settings'
        || request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        return json({ error: 'invalid_request_origin' }, 403);
      }
      const body = await readBody(request);
      if (stop) {
        const doc = await settingsDocument(env);
        return json(await saveSettings(env, { ...doc.settings, operationsEnabled: false }, body.revision, identity.email));
      }
      return json(await saveSettings(env, body.settings, body.revision, identity.email));
    }
    const document = await settingsDocument(env);
    const recent = await env.DB.prepare('SELECT id,tweet,status,error_code,updated_at FROM tweets WHERE status<>? ORDER BY updated_at DESC LIMIT 6')
      .bind('baseline').all<{ id: string; tweet: string; status: string; error_code: string | null; updated_at: number }>();
    return json({ ...document, identity: { email: identity.email }, defaultPrompt: SYSTEM_PROMPT,
      status: await operationalStatus(settingsEnv(env, document.settings)),
      credentials: { twitter: Boolean(env.TWITTERAPI_IO_KEY), llm: Boolean(env.LLM_API_KEY), email: Boolean(env.RESEND_API_KEY) },
      recent: recent.results.map(row => {
        const tweet = JSON.parse(row.tweet) as Tweet;
        return { id: row.id, username: tweet.username, text: tweet.text, status: row.status,
          errorCode: row.error_code, updatedAt: new Date(row.updated_at).toISOString() };
      }) });
  } catch (error) {
    if (error instanceof SettingsError) return json({ error: 'invalid_settings', field: error.field, message: error.message }, 400);
    const code = errorCode(error);
    if (code === 'settings_conflict') return json({ error: code, message: 'Settings changed in another session. Reload before saving.' }, 409);
    if (['invalid_body', 'body_too_large', 'invalid_json'].includes(code)) return json({ error: code }, 400);
    log('dashboard_failed', { stage: 'dashboard', code, success: false });
    return json({ error: error instanceof ConfigError ? 'configuration_error' : 'dashboard_unavailable' }, 503);
  }
}
