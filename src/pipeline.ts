import { createGenerator } from './generator';
import { buildEmail, sendEmail } from './email';
import { cheapSkip } from './filter';
import { requireEmail, requireSecret, type Config } from './config';
import { errorCode, log, RadarError } from './log';
import { SEND_RETRY_WINDOW_MS, Store } from './store';
import type { EmailPayload, Env, ReplyResult, Tweet, TweetRow } from './types';

const MAX_ATTEMPTS = 3;
function skipped(reason: string): ReplyResult {
  return { fit: 'skip', reason, funny: '', engaging: '', thoughtProvoking: '', recommended: 'funny' };
}
export async function processTweet(row: TweetRow, store: Store, env: Env, config: Config): Promise<void> {
  const tweet = JSON.parse(row.tweet) as Tweet;
  const start = Date.now();
  let stage = row.status === 'seen' ? 'generation' : 'email';
  try {
    await store.renew();
    if (!tweet.test && !config.accounts.includes(tweet.username)) {
      await store.update(row.id, { status: 'skipped', error_code: 'account_removed' });
      return;
    }
    if (row.status === 'seen') {
      if (row.generation_attempts >= MAX_ATTEMPTS) {
        await store.update(row.id, { status: 'failed', error_code: 'generation_attempts_exhausted' }); return;
      }
      const reason = cheapSkip(tweet.text);
      let result: ReplyResult;
      if (reason) result = skipped(reason);
      else {
        const key = requireSecret(env, 'LLM_API_KEY');
        // Reserve the first paid call before counting a generation attempt.
        await store.reserve('llm_calls', config.dailyLlm);
        row.generation_attempts++;
        await store.update(row.id, { generation_attempts: row.generation_attempts });
        let first = true;
        const generateReplies = createGenerator(config, key, async () => {
          if (first) { first = false; await store.renew(); }
          else await store.reserve('llm_calls', config.dailyLlm);
        });
        result = await generateReplies(tweet);
      }
      if (result.fit === 'skip' && !config.sendSkipEmails) {
        await store.update(row.id, { status: 'skipped', result: JSON.stringify(result), error_code: null });
        log('tweet_skipped', { tweetId: row.id, username: tweet.username, stage, durationMs: Date.now() - start, success: true });
        return;
      }
      await store.update(row.id, { status: 'generated', result: JSON.stringify(result), error_code: null });
      row.status = 'generated'; row.result = JSON.stringify(result);
    }
    stage = 'email';
    if (row.status === 'generated') {
      if (!row.result) throw new RadarError('missing_saved_result');
      // If skips were enabled at generation time but are now disabled, suppress before first send.
      const result = JSON.parse(row.result) as ReplyResult;
      if (result.fit === 'skip' && !config.sendSkipEmails) {
        await store.update(row.id, { status: 'skipped' }); return;
      }
      requireEmail(config);
      row.payload = JSON.stringify(buildEmail(tweet, result, config));
      await store.update(row.id, { payload: row.payload });
    }
    const key = requireSecret(env, 'RESEND_API_KEY');
    if (!row.payload) throw new RadarError('missing_saved_email');
    if (row.send_started_at && Date.now() - row.send_started_at >= SEND_RETRY_WINDOW_MS) {
      await store.update(row.id, { status: 'uncertain', error_code: 'email_retry_window_expired' }); return;
    }
    if (row.email_attempts >= MAX_ATTEMPTS) {
      await store.update(row.id, { status: 'uncertain', error_code: 'email_attempts_exhausted' }); return;
    }
    await store.reserve('email_attempts', config.dailyEmails);
    row.send_started_at ??= Date.now();
    row.email_attempts++;
    // Persist before sending. Retries use precisely the same payload and tweet-based key.
    await store.beginSend(row.id, row.send_started_at, row.email_attempts);
    row.status = 'sending';
    const emailId = await sendEmail(row.id, JSON.parse(row.payload) as EmailPayload, key);
    await store.emailed(row.id, emailId);
    log('tweet_emailed', { tweetId: row.id, username: tweet.username, stage, durationMs: Date.now() - start, success: true });
  } catch (error) {
    const code = errorCode(error);
    log('tweet_failed', { tweetId: row.id, username: tweet.username, stage, code, durationMs: Date.now() - start, success: false });
    if (code === 'lease_lost') throw error;
    const budget = code.startsWith('daily_limit_');
    const exhausted = !budget && (stage === 'generation' ? row.generation_attempts >= MAX_ATTEMPTS : row.email_attempts >= MAX_ATTEMPTS);
    await store.update(row.id, {
      status: exhausted ? (row.status === 'sending' ? 'uncertain' : 'failed') : row.status,
      next_attempt_at: budget ? Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) + 86_400_000
        : Date.now() + 60_000 * 2 ** Math.max(row.generation_attempts, row.email_attempts, 1),
      error_code: code,
    });
  }
}
