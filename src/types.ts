export interface Env {
  DB: D1Database;
  TWITTERAPI_IO_KEY?: string;
  RESEND_API_KEY?: string;
  LLM_API_KEY?: string;
  ADMIN_TOKEN?: string;
  EMAIL_FROM?: string;
  EMAIL_TO?: string;
  X_REPLY_RADAR_ENABLED?: string;
  ACTIVE_HOURS_ENABLED?: string;
  ACTIVE_HOURS_START?: string;
  ACTIVE_HOURS_END?: string;
  ACTIVE_TIMEZONE?: string;
  POLL_INTERVAL_MINUTES?: string;
  SEND_SKIP_EMAILS?: string;
  WATCHED_ACCOUNTS?: string;
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  MAX_TWEETS_PER_POLL?: string;
  MAX_SEARCH_PAGES_PER_POLL?: string;
  MAX_DAILY_TWITTER_CALLS?: string;
  MAX_DAILY_LLM_CALLS?: string;
  MAX_DAILY_EMAILS?: string;
}
export interface Tweet {
  id: string;
  username: string;
  name?: string;
  text: string;
  createdAt: string;
  isReply: boolean;
  isRetweet: boolean;
  isQuote: boolean;
  url: string;
  test?: boolean;
}
export interface ReplyResult {
  fit: 'high' | 'medium' | 'skip';
  reason: string;
  funny: string;
  engaging: string;
  thoughtProvoking: string;
  recommended: 'funny' | 'engaging' | 'thought-provoking';
}
export interface EmailPayload {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
}
export type TweetStatus = 'baseline' | 'seen' | 'generated' | 'sending' | 'emailed' | 'skipped' | 'failed' | 'uncertain';
export interface TweetRow {
  id: string;
  tweet: string;
  status: TweetStatus;
  result: string | null;
  payload: string | null;
  generation_attempts: number;
  email_attempts: number;
  send_started_at: number | null;
  next_attempt_at: number;
  created_at: number;
  updated_at: number;
  email_id: string | null;
  error_code: string | null;
}
export interface Scan { since: number; until: number; cursor: string; accountsKey: string }
export interface RadarState {
  initializedAt?: number;
  lastSuccessfulPollAt?: number;
  lastAttemptPollAt?: number;
  watermark?: number;
  accounts?: Record<string, number>;
  scan?: Scan;
}
export interface Counters {
  twitter_calls: number;
  llm_calls: number;
  email_attempts: number;
  emails_sent: number;
}
