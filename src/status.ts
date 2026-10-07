import { currentlyActive, parseConfig } from './config';
import { Store } from './store';
import type { Env } from './types';
import { dailyPauseReason } from './budget';

export async function operationalStatus(env: Env) {
  const config = parseConfig(env); const store = new Store(env.DB); const state = await store.state();
  const counters = await store.counters();
  const reason = dailyPauseReason(config, counters);
  const resetAt = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) + 86_400_000;
  let next = Math.max(Date.now(), Math.max(state.lastSuccessfulPollAt ?? 0, state.lastAttemptPollAt ?? 0) + config.pollIntervalMinutes * 60_000);
  if (reason) next = Math.max(next, resetAt);
  while (config.operationsEnabled && config.enabled && !currentlyActive(config, next)) next += 60_000;
  return { operationsEnabled: config.operationsEnabled, enabled: config.enabled, activeHours: { ...config.activeHours, currentlyActive: currentlyActive(config, Date.now()) },
    pollIntervalMinutes: config.pollIntervalMinutes,
    initializedAt: state.initializedAt ? new Date(state.initializedAt).toISOString() : null,
    lastSuccessfulPollAt: state.lastSuccessfulPollAt ? new Date(state.lastSuccessfulPollAt).toISOString() : null,
    lastAttemptPollAt: state.lastAttemptPollAt ? new Date(state.lastAttemptPollAt).toISOString() : null,
    nextEligiblePollAt: config.operationsEnabled && config.enabled && config.accounts.length ? new Date(next).toISOString() : null,
    watchedAccountCount: config.accounts.length, sendSkipEmails: config.sendSkipEmails,
    dailyLimitPause: { enabled: config.pauseAtDailyLimits, paused: Boolean(reason), reason, resetsAt: new Date(resetAt).toISOString() },
    tokenUsage: { input: counters.input_tokens, cachedInput: counters.cached_input_tokens,
      output: counters.output_tokens, total: counters.total_tokens, reportedCalls: counters.usage_reports, day: new Date().toISOString().slice(0, 10) },
    counters: { day: new Date().toISOString().slice(0, 10), twitterApiCalls: counters.twitter_calls,
      llmCalls: counters.llm_calls, emailAttempts: counters.email_attempts, emailsSent: counters.emails_sent },
    limits: { maxTweetsPerPoll: config.maxTweets, maxSearchPagesPerPoll: config.maxPages,
      dailyTwitterCalls: config.dailyTwitter, dailyLlmCalls: config.dailyLlm, dailyEmailAttempts: config.dailyEmails },
    workflowCounts: await store.summary(), discoveryBacklog: Boolean(state.scan) };
}
