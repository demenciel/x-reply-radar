import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { currentlyActive, parseConfig } from '../src/config';
import { cheapSkip } from '../src/filter';
import { buildReplyIntent } from '../src/intent';
import { validateReplyResult } from '../src/generator';

describe('runtime gates', () => {
  it.each(['0','61','-1','2.5','NaN','',' 2','true'])('rejects invalid interval %s', value => {
    expect(() => parseConfig({ ...env, POLL_INTERVAL_MINUTES: value })).toThrow('POLL_INTERVAL_MINUTES');
  });
  it('validates booleans, timezones, hours, HTTPS providers and account injection', () => {
    for (const patch of [{ X_REPLY_RADAR_ENABLED: 'yes' }, { ACTIVE_TIMEZONE: 'Made/Up' },
      { ACTIVE_HOURS_START: '24:00' }, { ACTIVE_HOURS_START: '23:00', ACTIVE_HOURS_END: '23:00' },
      { LLM_BASE_URL: 'http://example.com/v1' }, { WATCHED_ACCOUNTS: '["x) OR from:hacker"]' },
      { WATCHED_ACCOUNTS: JSON.stringify(Array(21).fill('user')) }]) {
      expect(() => parseConfig({ ...env, ...patch })).toThrow();
    }
    expect(parseConfig({ ...env, WATCHED_ACCOUNTS: '["@Levelsio","levelsio"]' }).accounts).toEqual(['levelsio']);
  });
  it('uses Moncton DST and inclusive start/exclusive end', () => {
    const config = parseConfig(env);
    expect(currentlyActive(config, Date.parse('2026-07-07T10:00:00Z'))).toBe(true);
    expect(currentlyActive(config, Date.parse('2026-01-07T10:00:00Z'))).toBe(false);
    expect(currentlyActive(config, Date.parse('2026-01-07T11:00:00Z'))).toBe(true);
    expect(currentlyActive(config, Date.parse('2026-01-08T03:00:00Z'))).toBe(false);
  });
  it('handles overnight active windows', () => {
    const config = parseConfig({ ...env, ACTIVE_HOURS_START: '18:00', ACTIVE_HOURS_END: '02:00' });
    expect(currentlyActive(config, Date.parse('2026-07-07T23:00:00Z'))).toBe(true);
    expect(currentlyActive(config, Date.parse('2026-07-08T04:00:00Z'))).toBe(true);
    expect(currentlyActive(config, Date.parse('2026-07-08T05:00:00Z'))).toBe(false);
  });
});
it('round-trips reply target and text including punctuation, Unicode and line breaks', () => {
  const text = "Builder's dilemma & the café\nShip it?";
  const url = new URL(buildReplyIntent('1234567890123456789', text));
  expect(url.searchParams.get('in_reply_to')).toBe('1234567890123456789');
  expect(url.searchParams.get('text')).toBe(text);
  expect(url.origin).toBe('https://x.com');
});
it('cheap filtering preserves potentially relevant mixed topics', () => {
  expect(cheapSkip('Football world cup results')).toBeTruthy();
  expect(cheapSkip('AI marketing for football teams')).toBeNull();
  expect(cheapSkip('AI safety alignment debate')).toBeTruthy();
  expect(cheapSkip('Something worth thinking about')).toBeNull();
});
it('rejects invalid schema, unsafe voice and invented personal context', () => {
  const valid = { fit: 'high', reason: 'Builder topic', funny: 'The backlog has acquired a backlog.',
    engaging: 'Which part took the longest?', thoughtProvoking: 'Maybe the hard part moved elsewhere.', recommended: 'funny' };
  expect(validateReplyResult(valid)).toEqual(valid);
  for (const funny of ['great point.', 'Great point.', 'Hello. lower case.', 'Hello 😎', '#Hello',
    'I built this last year.', 'Our customers love this.', 'A'.repeat(221)]) {
    expect(() => validateReplyResult({ ...valid, funny }), funny).toThrow();
  }
  expect(() => validateReplyResult({ ...valid, extra: true })).toThrow();
  expect(() => validateReplyResult({ ...valid, fit: 'skip' })).toThrow();
});
