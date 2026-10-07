import { ConfigError, parseConfig } from './config';
import { RadarError } from './log';
import { SYSTEM_PROMPT } from './prompt';
import type { Env } from './types';

export interface Settings {
  operationsEnabled: boolean;
  enabled: boolean;
  accounts: string[];
  pollIntervalMinutes: number;
  activeHoursEnabled: boolean;
  activeHoursStart: string;
  activeHoursEnd: string;
  timezone: string;
  llmBaseUrl: string;
  llmModel: string;
  llmContext: string;
  llmPrompt: string;
  emailFrom: string;
  emailTo: string;
  sendSkipEmails: boolean;
  pauseAtDailyLimits: boolean;
  maxTweetsPerPoll: number;
  maxSearchPagesPerPoll: number;
  dailyTwitterCalls: number;
  dailyLlmCalls: number;
  dailyEmails: number;
}
export interface SettingsDocument {
  settings: Settings;
  revision: number;
  updatedAt: string | null;
  updatedBy: string | null;
}
interface SettingsRow { value: string; revision: number; updated_at: number; updated_by: string }
const fields: Record<keyof Settings, keyof Env> = {
  operationsEnabled: 'ALL_OPS_ENABLED',
  enabled: 'X_REPLY_RADAR_ENABLED', accounts: 'WATCHED_ACCOUNTS', pollIntervalMinutes: 'POLL_INTERVAL_MINUTES',
  activeHoursEnabled: 'ACTIVE_HOURS_ENABLED', activeHoursStart: 'ACTIVE_HOURS_START', activeHoursEnd: 'ACTIVE_HOURS_END',
  timezone: 'ACTIVE_TIMEZONE', llmBaseUrl: 'LLM_BASE_URL', llmModel: 'LLM_MODEL', llmContext: 'LLM_CONTEXT',
  llmPrompt: 'LLM_SYSTEM_PROMPT', emailFrom: 'EMAIL_FROM', emailTo: 'EMAIL_TO', sendSkipEmails: 'SEND_SKIP_EMAILS',
  pauseAtDailyLimits: 'PAUSE_AT_DAILY_LIMITS',
  maxTweetsPerPoll: 'MAX_TWEETS_PER_POLL', maxSearchPagesPerPoll: 'MAX_SEARCH_PAGES_PER_POLL',
  dailyTwitterCalls: 'MAX_DAILY_TWITTER_CALLS', dailyLlmCalls: 'MAX_DAILY_LLM_CALLS', dailyEmails: 'MAX_DAILY_EMAILS',
};
export class SettingsError extends Error {
  constructor(public readonly field: string, message: string) { super(message); }
}
export function settingsEnv(env: Env, settings: Settings): Env {
  const overrides: Record<string, string> = {};
  for (const [field, variable] of Object.entries(fields)) {
    const value = settings[field as keyof Settings];
    overrides[variable] = field === 'accounts' ? JSON.stringify(value) : String(value);
  }
  return { ...env, ...overrides };
}
export function defaultSettings(env: Env): Settings {
  const config = parseConfig(env);
  return { operationsEnabled: config.operationsEnabled, enabled: config.enabled, accounts: config.accounts, pollIntervalMinutes: config.pollIntervalMinutes,
    activeHoursEnabled: config.activeHours.enabled, activeHoursStart: config.activeHours.start,
    activeHoursEnd: config.activeHours.end, timezone: config.activeHours.timezone,
    llmBaseUrl: config.llmBaseUrl, llmModel: config.llmModel, llmContext: config.llmContext, llmPrompt: config.llmPrompt,
    emailFrom: config.emailFrom, emailTo: config.emailTo, sendSkipEmails: config.sendSkipEmails,
    pauseAtDailyLimits: config.pauseAtDailyLimits,
    maxTweetsPerPoll: config.maxTweets, maxSearchPagesPerPoll: config.maxPages,
    dailyTwitterCalls: config.dailyTwitter, dailyLlmCalls: config.dailyLlm, dailyEmails: config.dailyEmails };
}
export function validateSettings(value: unknown, env: Env): Settings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SettingsError('settings', 'Expected a settings object.');
  const input = value as Record<string, unknown>;
  const keys = Object.keys(fields) as (keyof Settings)[];
  if (Object.keys(input).length !== keys.length || !keys.every(key => Object.hasOwn(input, key))) {
    throw new SettingsError('settings', 'Send the complete settings form with no unknown fields.');
  }
  const booleans = new Set<keyof Settings>(['operationsEnabled', 'enabled', 'activeHoursEnabled', 'sendSkipEmails', 'pauseAtDailyLimits']);
  const numbers = new Set<keyof Settings>(['pollIntervalMinutes', 'maxTweetsPerPoll', 'maxSearchPagesPerPoll',
    'dailyTwitterCalls', 'dailyLlmCalls', 'dailyEmails']);
  for (const key of keys) {
    if (key === 'accounts') {
      if (!Array.isArray(input[key]) || !(input[key] as unknown[]).every(account => typeof account === 'string')) {
        throw new SettingsError(key, 'Enter a list of X usernames.');
      }
    } else if (booleans.has(key)) {
      if (typeof input[key] !== 'boolean') throw new SettingsError(key, 'Choose on or off.');
    } else if (numbers.has(key)) {
      if (typeof input[key] !== 'number' || !Number.isSafeInteger(input[key])) throw new SettingsError(key, 'Enter a whole number.');
    } else if (typeof input[key] !== 'string') throw new SettingsError(key, 'Enter text.');
  }
  const settings = input as unknown as Settings;
  if (settings.llmBaseUrl.length > 2048) throw new SettingsError('llmBaseUrl', 'API URL is limited to 2,048 characters.');
  if (settings.llmContext.length > 6000) throw new SettingsError('llmContext', 'Context is limited to 6,000 characters.');
  if (!settings.llmPrompt.trim() || settings.llmPrompt.length > 18000) throw new SettingsError('llmPrompt', 'Prompt must contain 1–18,000 characters.');
  if (settings.emailTo.length > 254 || (settings.emailTo && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(settings.emailTo))) {
    throw new SettingsError('emailTo', 'Enter one valid recipient email address.');
  }
  if (settings.emailFrom.length > 320 || /[\r\n]/.test(settings.emailFrom) || (settings.emailFrom && !/@/.test(settings.emailFrom))) {
    throw new SettingsError('emailFrom', 'Use an email address or Name <email@domain.com>.');
  }
  try {
    const parsed = parseConfig(settingsEnv(env, settings));
    return { ...settings, accounts: parsed.accounts, llmBaseUrl: parsed.llmBaseUrl,
      llmModel: parsed.llmModel.trim(), emailTo: settings.emailTo.trim(), emailFrom: settings.emailFrom.trim() };
  } catch (error) {
    if (error instanceof ConfigError) {
      const field = keys.find(key => fields[key] === error.field) ?? 'settings';
      throw new SettingsError(field, 'Check this setting’s format and permitted range.');
    }
    throw error;
  }
}
async function storedSettings(env: Env): Promise<SettingsRow | null> {
  return env.DB.prepare('SELECT value,revision,updated_at,updated_by FROM app_settings WHERE id=1').first<SettingsRow>();
}
export async function loadRuntimeEnv(env: Env): Promise<Env> {
  const row = await storedSettings(env);
  if (!row) return env;
  return settingsEnv(env, validateSettings(JSON.parse(row.value), env));
}
export async function settingsDocument(env: Env): Promise<SettingsDocument> {
  const row = await storedSettings(env);
  if (!row) return { settings: defaultSettings(env), revision: 0, updatedAt: null, updatedBy: null };
  return { settings: validateSettings(JSON.parse(row.value), env), revision: row.revision,
    updatedAt: new Date(row.updated_at).toISOString(), updatedBy: row.updated_by };
}
export async function saveSettings(env: Env, value: unknown, revision: unknown, email: string): Promise<SettingsDocument> {
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || revision >= 2_147_483_647) {
    throw new SettingsError('revision', 'Reload settings before saving.');
  }
  const settings = validateSettings(value, env);
  const now = Date.now();
  const result = await env.DB.prepare(`INSERT INTO app_settings(id,value,revision,updated_at,updated_by)
    SELECT 1,?,?,?,? WHERE ?=0 OR EXISTS (SELECT 1 FROM app_settings WHERE id=1)
    ON CONFLICT(id) DO UPDATE SET value=excluded.value,revision=excluded.revision,
      updated_at=excluded.updated_at,updated_by=excluded.updated_by WHERE app_settings.revision=?`)
    .bind(JSON.stringify(settings), revision + 1, now, email, revision, revision).run();
  if (result.meta.changes !== 1) throw new RadarError('settings_conflict');
  return { settings, revision: revision + 1, updatedAt: new Date(now).toISOString(), updatedBy: email };
}
export { SYSTEM_PROMPT };
