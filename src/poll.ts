import { bool, currentlyActive, parseConfig, requireSecret, type Config } from './config';
import { errorCode, log } from './log';
import { Store } from './store';
import { buildSearchQuery, searchTweets } from './twitter';
import { processTweet } from './pipeline';
import type { Env, RadarState, Scan } from './types';
import { loadRuntimeEnv } from './settings';
import { dailyPauseReason } from './budget';

const HOUR = 3_600_000;
const OVERLAP = 5 * 60_000;
function due(state: RadarState, config: Config, now: number): boolean {
  return now - Math.max(state.lastSuccessfulPollAt ?? 0, state.lastAttemptPollAt ?? 0) >= config.pollIntervalMinutes * 60_000;
}
export async function poll(env: Env, force = false): Promise<{status: string; processed?: number}> {
  const started = Date.now();
  env = await loadRuntimeEnv(env);
  if (!bool(env.ALL_OPS_ENABLED, true, 'ALL_OPS_ENABLED')) return { status: 'all_operations_disabled' };
  // Read settings once so dashboard pause/resume applies on the next invocation. No writes or paid calls while paused.
  if (!bool(env.X_REPLY_RADAR_ENABLED, true, 'X_REPLY_RADAR_ENABLED') && !force) {
    log('radar_disabled', { stage: 'gate', success: true }); return { status: 'disabled' };
  }
  const config = parseConfig(env);
  if (!currentlyActive(config, started)) {
    log('outside_active_hours', { stage: 'gate', success: true }); return { status: 'inactive' };
  }
  const store = new Store(env.DB);
  if (dailyPauseReason(config, await store.counters())) return { status: 'daily_limit_paused' };
  if (!due(await store.state(), config, started)) return { status: 'interval_not_elapsed' };
  if (!await store.acquire()) return { status: 'locked' };
  try {
    let state = await store.state();
    const now = Date.now();
    // Recheck after acquiring the lock: another invocation may have completed while we waited.
    if (!due(state, config, now)) return { status: 'interval_not_elapsed' };
    if (!currentlyActive(config, now)) return { status: 'inactive' };
    if (dailyPauseReason(config, await store.counters())) return { status: 'daily_limit_paused' };
    state.lastAttemptPollAt = now;
    await store.saveState(state);
    await store.cleanup();
    if (!config.accounts.length) return { status: 'no_accounts' };
    const apiKey = requireSecret(env, 'TWITTERAPI_IO_KEY');
    const firstPoll = !state.initializedAt;
    const accounts = Object.fromEntries(config.accounts.map(account => [account, state.accounts?.[account] ?? now]));
    const accountsKey = config.accounts.slice().sort().join(',');
    let scan: Scan = state.scan && state.scan.accountsKey === accountsKey && state.scan.until > now - HOUR
      ? state.scan : { since: Math.max(state.watermark ? state.watermark - OVERLAP : now - HOUR, now - HOUR),
        until: now, cursor: '', accountsKey };
    if (state.watermark && state.watermark < now - HOUR) log('poll_gap_clamped', { stage: 'discovery', success: true });
    const pages = firstPoll ? 1 : config.maxPages;
    for (let page = 0; page < pages; page++) {
      await store.reserve('twitter_calls', config.dailyTwitter, config);
      const response = await searchTweets(apiKey, buildSearchQuery(config.accounts, scan.since, scan.until), scan.cursor);
      for (const tweet of response.tweets) {
        if (!Object.hasOwn(accounts, tweet.username) || tweet.isReply || tweet.isRetweet) continue;
        const timestamp = Date.parse(tweet.createdAt);
        if (timestamp > scan.until) continue;
        // First successful poll establishes a per-account timestamp baseline, including zero-result accounts.
        if (firstPoll || timestamp <= accounts[tweet.username]!) {
          await store.enqueue(tweet, 'baseline'); continue;
        }
        if (timestamp < scan.since) continue;
        await store.enqueue(tweet);
      }
      scan = { ...scan, cursor: response.cursor };
      state = { ...state, accounts, initializedAt: state.initializedAt ?? now };
      if (firstPoll || !scan.cursor) {
        state.watermark = scan.until;
        delete state.scan;
      } else state.scan = scan;
      await store.saveState(state); // Checkpoint after each page; replay is safely deduplicated.
      if (firstPoll || !scan.cursor) break;
    }
    // Discovery and durable enqueue define a successful poll. Generation retries are independent.
    state.lastSuccessfulPollAt = Date.now();
    await store.saveState(state);
    const pending = await store.pending(config.maxTweets);
    for (const row of pending) await processTweet(row, store, env, config);
    log(firstPoll ? 'baseline_initialized' : 'poll_complete', {
      stage: 'poll', processed: pending.length, durationMs: Date.now() - started, success: true,
    });
    return { status: firstPoll ? 'baseline_initialized' : 'polled', processed: pending.length };
  } catch (error) {
    if (errorCode(error) === 'all_operations_disabled') return { status: 'all_operations_disabled' };
    if (errorCode(error).startsWith('daily_limit_')) return { status: 'daily_limit_paused' };
    log('poll_failed', { stage: 'poll', code: errorCode(error), durationMs: Date.now() - started, success: false });
    throw error;
  } finally { await store.release(); }
}
