import type { Env } from './types';
export class ConfigError extends Error {
  constructor(public readonly field: string) { super(`Invalid configuration: ${field}`); }
}
export function bool(value: string | undefined, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ConfigError(field);
}
function integer(value: string | undefined, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new ConfigError(field);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new ConfigError(field);
  return parsed;
}
function time(value: string | undefined, fallback: string, field: string): string {
  const parsed = value ?? fallback;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(parsed)) throw new ConfigError(field);
  return parsed;
}
export function parseConfig(env: Env) {
  const timezone = env.ACTIVE_TIMEZONE ?? 'America/Moncton';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0); }
  catch { throw new ConfigError('ACTIVE_TIMEZONE'); }
  let raw: unknown;
  try { raw = JSON.parse(env.WATCHED_ACCOUNTS ?? '[]'); }
  catch { throw new ConfigError('WATCHED_ACCOUNTS'); }
  if (!Array.isArray(raw) || raw.length > 20 || !raw.every(v => typeof v === 'string' && /^@?[A-Za-z0-9_]{1,15}$/.test(v))) {
    throw new ConfigError('WATCHED_ACCOUNTS');
  }
  const accounts = [...new Set((raw as string[]).map(v => v.replace(/^@/, '').toLowerCase()))];
  let base: URL;
  try { base = new URL(env.LLM_BASE_URL ?? 'https://api.openai.com/v1'); }
  catch { throw new ConfigError('LLM_BASE_URL'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new ConfigError('LLM_BASE_URL');
  const model = env.LLM_MODEL ?? 'gpt-luna-6';
  if (!model.trim() || model.length > 150 || /[\r\n]/.test(model)) throw new ConfigError('LLM_MODEL');
  const start = time(env.ACTIVE_HOURS_START, '07:00', 'ACTIVE_HOURS_START');
  const end = time(env.ACTIVE_HOURS_END, '23:00', 'ACTIVE_HOURS_END');
  if (start === end) throw new ConfigError('ACTIVE_HOURS_END');
  return {
    enabled: bool(env.X_REPLY_RADAR_ENABLED, true, 'X_REPLY_RADAR_ENABLED'),
    activeHours: { enabled: bool(env.ACTIVE_HOURS_ENABLED, true, 'ACTIVE_HOURS_ENABLED'), start, end, timezone },
    pollIntervalMinutes: integer(env.POLL_INTERVAL_MINUTES, 2, 1, 60, 'POLL_INTERVAL_MINUTES'),
    sendSkipEmails: bool(env.SEND_SKIP_EMAILS, false, 'SEND_SKIP_EMAILS'),
    accounts,
    llmBaseUrl: base.toString().replace(/\/$/, ''), llmModel: model,
    emailFrom: env.EMAIL_FROM ?? '', emailTo: env.EMAIL_TO ?? '',
    maxTweets: integer(env.MAX_TWEETS_PER_POLL, 5, 1, 20, 'MAX_TWEETS_PER_POLL'),
    maxPages: integer(env.MAX_SEARCH_PAGES_PER_POLL, 3, 1, 5, 'MAX_SEARCH_PAGES_PER_POLL'),
    dailyTwitter: integer(env.MAX_DAILY_TWITTER_CALLS, 1000, 1, 10000, 'MAX_DAILY_TWITTER_CALLS'),
    dailyLlm: integer(env.MAX_DAILY_LLM_CALLS, 100, 1, 1000, 'MAX_DAILY_LLM_CALLS'),
    dailyEmails: integer(env.MAX_DAILY_EMAILS, 50, 1, 500, 'MAX_DAILY_EMAILS'),
  };
}
export type Config = ReturnType<typeof parseConfig>;
const formatters = new WeakMap<Config, Intl.DateTimeFormat>();
export function currentlyActive(config: Config, now: number): boolean {
  const hours = config.activeHours;
  if (!hours.enabled) return true;
  let formatter = formatters.get(config);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: hours.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    formatters.set(config, formatter);
  }
  const parts = formatter.formatToParts(now);
  const local = `${parts.find(p => p.type === 'hour')!.value}:${parts.find(p => p.type === 'minute')!.value}`;
  return hours.start < hours.end ? local >= hours.start && local < hours.end : local >= hours.start || local < hours.end;
}
export function requireSecret(env: Env, field: 'TWITTERAPI_IO_KEY' | 'RESEND_API_KEY' | 'LLM_API_KEY'): string {
  const value = env[field];
  if (!value?.trim()) throw new ConfigError(field);
  return value;
}
export function requireEmail(config: Config): void {
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(config.emailTo)) throw new ConfigError('EMAIL_TO');
  if (!config.emailFrom || /[\r\n]/.test(config.emailFrom) || !/@/.test(config.emailFrom)) throw new ConfigError('EMAIL_FROM');
}
