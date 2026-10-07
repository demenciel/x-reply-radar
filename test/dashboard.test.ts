import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { dashboard } from '../src/dashboard';
import { defaultSettings, loadRuntimeEnv, saveSettings, settingsDocument } from '../src/settings';
import { replyPrompt, SYSTEM_PROMPT } from '../src/prompt';
import { poll } from '../src/poll';
import type { Env } from '../src/types';

const bindings = (): Env => ({ ...env, ADMIN_TOKEN: 'test-admin-123456789012345678901234567890', ACCESS_AUD: 'radar-audience',
  ACTIVE_HOURS_ENABLED: 'false', TWITTERAPI_IO_KEY: 'private-twitter-key', LLM_API_KEY: 'private-llm-key',
  RESEND_API_KEY: 'private-email-key', EMAIL_FROM: 'Radar <radar@example.com>', EMAIL_TO: 'me@example.com' });
const context = (aud = 'radar-audience', email: string | undefined = 'owner@example.com') => ({ access: { aud,
  getIdentity: async () => email ? { email } : undefined } });
function request(path = '', method = 'GET', body?: unknown, patch: Record<string, string> = {}) {
  return new Request('https://radar.example/dashboard' + path, { method, headers: {
    Origin: 'https://radar.example', 'Content-Type': 'application/json', 'X-Radar-Request': 'settings', ...patch },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
describe('Cloudflare Access dashboard', () => {
  it('redirects the home page, refuses missing Access context, and rejects spoofed headers or bearer tokens', async () => {
    const b = bindings();
    const root = await worker.fetch(new Request('https://radar.example/'), b);
    expect(root.status).toBe(302); expect(root.headers.get('Location')).toBe('/dashboard');
    for (const path of ['', '/api/state', '/api/settings']) {
      const response = await dashboard(request(path, path.endsWith('settings') ? 'PUT' : 'GET', undefined, {
        Authorization: 'Bearer ' + b.ADMIN_TOKEN, 'Cf-Access-Authenticated-User-Email': 'owner@example.com',
        'Cf-Access-Jwt-Assertion': 'forged' }), b);
      expect(response.status).toBe(403);
    }
    expect((await dashboard(request(), b, context('another-app'))).status).toBe(403);
    expect((await dashboard(request(), b, context('radar-audience', ''))).status).toBe(403);
  });
  it('serves a nonce protected page and safely returns settings without secret credentials', async () => {
    const b = bindings(); const page = await dashboard(request(), b, context());
    const html = await page.text();
    expect(page.status).toBe(200); expect(html).not.toContain('__NONCE__');
    expect(page.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(page.headers.get('Content-Security-Policy')).not.toContain('unsafe-inline');
    const response = await dashboard(request('/api/state'), b, context());
    const data = await response.json() as { revision: number; credentials: unknown; settings: { emailTo: string } };
    expect(data.revision).toBe(0); expect(data.settings.emailTo).toBe('me@example.com');
    expect(data.credentials).toEqual({ twitter: true, llm: true, email: true });
    const text = JSON.stringify(data);
    for (const secret of [b.ADMIN_TOKEN, b.LLM_API_KEY, b.TWITTERAPI_IO_KEY, b.RESEND_API_KEY]) expect(text).not.toContain(secret);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('blocks cross-origin and non-JSON mutations before writing settings', async () => {
    const b = bindings(); const body = { settings: defaultSettings(b), revision: 0 };
    for (const patch of ([{ Origin: 'https://evil.example' }, { 'X-Radar-Request': '' }, { 'Content-Type': 'text/plain' }] as Record<string, string>[])) {
      expect((await dashboard(request('/api/settings', 'PUT', body, patch), b, context())).status).toBe(403);
    }
    expect((await settingsDocument(b)).revision).toBe(0);
    expect((await dashboard(request('/api/settings', 'POST', body), b, context())).status).toBe(405);
  });
  it('rejects oversized streamed input', async () => {
    const response = await dashboard(request('/api/settings', 'PUT', { filler: 'x'.repeat(66_000) }), bindings(), context());
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'body_too_large' });
  });
  it('atomically saves and identifies a stale edit without silently overwriting', async () => {
    const b = bindings(); const s = { ...defaultSettings(b), enabled: false, accounts: ['@Builder', 'builder'], llmContext: 'I build tiny apps.' };
    const responses = await Promise.all([dashboard(request('/api/settings', 'PUT', { settings: s, revision: 0 }), b, context()),
      dashboard(request('/api/settings', 'PUT', { settings: { ...s, pollIntervalMinutes: 12 }, revision: 0 }), b, context())]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    const doc = await settingsDocument(b); expect(doc.revision).toBe(1); expect(doc.updatedBy).toBe('owner@example.com');
    expect(doc.settings.accounts).toEqual(['builder']);
    await expect(saveSettings(b, s, 0, 'owner@example.com')).rejects.toThrow('settings_conflict');
    const next = await saveSettings(b, { ...s, pollIntervalMinutes: 7 }, 1, 'owner@example.com');
    expect(next.revision).toBe(2);
    expect((await loadRuntimeEnv({ ...b, LLM_CONTEXT: 'different deployment default' })).LLM_CONTEXT).toBe('I build tiny apps.');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await poll({ ...b, X_REPLY_RADAR_ENABLED: 'true' })).toEqual({ status: 'disabled' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ['pollIntervalMinutes', 0], ['timezone', 'not/a/timezone'], ['llmBaseUrl', 'http://provider.example'],
    ['llmBaseUrl', 'https://user:password@provider.example'], ['llmPrompt', ''], ['llmContext', 'x'.repeat(6001)],
    ['accounts', ['invalid-name!']], ['emailTo', 'a@example.com,b@example.com'], ['emailFrom', 'radar@example.com\r\nBcc: attacker@example.com'],
    ['dailyEmails', 501], ['enabled', 'true'],
  ])('rejects invalid %s and preserves the previous revision', async (field, value) => {
    const b = bindings(); const response = await dashboard(request('/api/settings', 'PUT', {
      settings: { ...defaultSettings(b), [field]: value }, revision: 0 }), b, context());
    expect(response.status).toBe(400); expect((await response.json() as { field: string }).field).toBe(field);
    expect((await settingsDocument(b)).revision).toBe(0);
  });
  it('appends the immutable reply contract to the editable voice and context', () => {
    const prompt = replyPrompt('Use dry humor.', 'I work on small SaaS tools.');
    expect(prompt).toContain('Use dry humor.'); expect(prompt).toContain('I work on small SaaS tools.');
    expect(prompt).toContain('REQUIRED OUTPUT CONTRACT'); expect(prompt).toContain('220');
    expect(replyPrompt(SYSTEM_PROMPT, '')).not.toContain('BACKGROUND CONTEXT FROM THE OWNER');
  });
});
