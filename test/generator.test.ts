import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config';
import { createGenerator } from '../src/generator';

it.each([
  ['gpt-6-luna', { max_completion_tokens: 600, reasoning_effort: 'none', temperature: 0.6 }],
  ['gpt-6-sol', { max_completion_tokens: 600, reasoning_effort: 'none', temperature: 0.6 }],
  ['gpt-6.1-sol', { max_completion_tokens: 2048, reasoning_effort: 'low' }],
  ['gpt-6-astra', { max_completion_tokens: 2048, reasoning_effort: 'low' }],
  ['custom-provider-model', { max_tokens: 600, temperature: 0.6 }],
])('sends compatible parameters, editable voice and context for %s', async (model, parameters) => {
  const beforeCall = vi.fn(async () => {});
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(model);
    for (const key of ['max_completion_tokens', 'max_tokens', 'reasoning_effort', 'temperature']) {
      expect(body[key]).toEqual((parameters as Record<string, unknown>)[key]);
    }
    expect(body.messages[0].content).toContain('Be curious and concise.');
    expect(body.messages[0].content).toContain('I build small products.');
    expect(body.messages[0].content).toContain('REQUIRED OUTPUT CONTRACT');
    expect(body.messages[1].content).toContain('An interesting new product.');
    return Response.json({ choices: [{ message: { content: JSON.stringify({ fit: 'skip', reason: 'Not enough context',
      funny: '', engaging: '', thoughtProvoking: '', recommended: 'funny' }) } }] });
  });
  vi.stubGlobal('fetch', fetch);
  const generate = createGenerator(parseConfig({ ...env, LLM_MODEL: model, LLM_CONTEXT: 'I build small products.',
    LLM_SYSTEM_PROMPT: 'Be curious and concise.' }), 'test-key', beforeCall);
  expect((await generate({ id: '123', username: 'builder', text: 'An interesting new product.', createdAt: new Date().toISOString(),
    isReply: false, isRetweet: false, isQuote: false, url: 'https://x.com/builder/status/123', test: false })).fit).toBe('skip');
  expect(beforeCall).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
});
