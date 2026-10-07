import { expect, it, vi } from 'vitest';
import { externalFetch } from '../src/http';

it('constructs a provider request accepted by the Workers runtime', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init: RequestInit) => {
    const request = new Request(url, init);
    expect(request.redirect).toBe('manual');
    expect(request.method).toBe('POST');
    expect(request.headers.get('Authorization')).toBe('Bearer test-key');
    return Response.json({ ok: true });
  }));
  const response = await externalFetch('https://provider.example/v1', {
    method: 'POST', headers: { Authorization: 'Bearer test-key' }, body: '{}',
  }, 'llm');
  expect(await response.json()).toEqual({ ok: true });
});

it.each([301, 302, 303, 307, 308])('rejects a %s redirect without contacting its destination', async status => {
  const fetch = vi.fn(async (url: string | URL, init: RequestInit) => {
    new Request(url, init);
    return new Response(null, { status, headers: { Location: 'https://other.example' } });
  });
  vi.stubGlobal('fetch', fetch);
  await expect(externalFetch('https://provider.example/v1', {
    headers: { Authorization: 'Bearer test-key' },
  }, 'llm')).rejects.toThrow('llm_redirect_rejected');
  expect(fetch).toHaveBeenCalledTimes(1);
});
