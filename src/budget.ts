import type { Config } from './config';
import type { Counters } from './types';

export function dailyPauseReason(config: Config, counters: Counters): 'twitter' | 'llm' | 'email' | null {
  if (!config.pauseAtDailyLimits) return null;
  if (counters.twitter_calls >= config.dailyTwitter) return 'twitter';
  if (counters.llm_calls >= config.dailyLlm) return 'llm';
  if (counters.email_attempts >= config.dailyEmails) return 'email';
  return null;
}
