import type { Counters, RadarState, Tweet, TweetRow, TweetStatus } from './types';
import { RadarError } from './log';

const LEASE_MS = 90_000;
const DAY = 86_400_000;
export const SEND_RETRY_WINDOW_MS = 23 * 3_600_000;
export class Store {
  private readonly owner = crypto.randomUUID();
  constructor(private readonly db: D1Database) {}
  async acquire(): Promise<boolean> {
    const now = Date.now();
    const result = await this.db.prepare('UPDATE lease SET owner=?, expires_at=? WHERE id=1 AND expires_at<=?')
      .bind(this.owner, now + LEASE_MS, now).run();
    return result.meta.changes === 1;
  }
  async renew(): Promise<void> {
    const now = Date.now();
    const result = await this.db.prepare('UPDATE lease SET expires_at=? WHERE id=1 AND owner=? AND expires_at>?')
      .bind(now + LEASE_MS, this.owner, now).run();
    if (result.meta.changes !== 1) throw new RadarError('lease_lost');
  }
  async release(): Promise<void> {
    await this.db.prepare('UPDATE lease SET owner=\'\', expires_at=0 WHERE id=1 AND owner=?').bind(this.owner).run();
  }
  private guard = 'EXISTS (SELECT 1 FROM lease WHERE id=1 AND owner=? AND expires_at>?)';
  async state(): Promise<RadarState> {
    const row = await this.db.prepare('SELECT value FROM radar_state WHERE id=1').first<{value: string}>();
    if (!row) throw new RadarError('database_not_initialized');
    return JSON.parse(row.value) as RadarState;
  }
  async saveState(state: RadarState): Promise<void> {
    const result = await this.db.prepare(`UPDATE radar_state SET value=? WHERE id=1 AND ${this.guard}`)
      .bind(JSON.stringify(state), this.owner, Date.now()).run();
    if (result.meta.changes !== 1) throw new RadarError('lease_lost');
  }
  async enqueue(tweet: Tweet, status: TweetStatus = 'seen'): Promise<void> {
    await this.renew();
    const now = Date.now();
    await this.db.prepare(`INSERT OR IGNORE INTO tweets(id,tweet,status,created_at,updated_at)
      SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM email_receipts WHERE id=?) AND ${this.guard}`)
      .bind(tweet.id, JSON.stringify(tweet), status, now, now, tweet.id, this.owner, now).run();
  }
  async get(id: string): Promise<TweetRow | null> {
    return this.db.prepare('SELECT * FROM tweets WHERE id=?').bind(id).first<TweetRow>();
  }
  async receipt(id: string): Promise<{email_id: string | null} | null> {
    return this.db.prepare('SELECT email_id FROM email_receipts WHERE id=?').bind(id).first();
  }
  async beginSend(id: string, startedAt: number, attempts: number): Promise<void> {
    const now = Date.now();
    const results = await this.db.batch([
      this.db.prepare(`UPDATE tweets SET status='sending',send_started_at=?,email_attempts=?,updated_at=?
        WHERE id=? AND ${this.guard}`).bind(startedAt, attempts, now, id, this.owner, now),
      this.db.prepare(`INSERT OR IGNORE INTO email_receipts(id,first_attempt_at)
        SELECT ?,? WHERE ${this.guard}`).bind(id, startedAt, this.owner, now),
    ]);
    if (results[0]?.meta.changes !== 1) throw new RadarError('lease_lost');
  }
  async pending(limit: number): Promise<TweetRow[]> {
    const result = await this.db.prepare(`SELECT * FROM tweets
      WHERE status IN ('seen','generated','sending') AND next_attempt_at<=?
      ORDER BY created_at,id LIMIT ?`).bind(Date.now(), limit).all<TweetRow>();
    return result.results;
  }
  async update(id: string, patch: Partial<Omit<TweetRow, 'id' | 'tweet' | 'created_at'>>): Promise<void> {
    // Internal column allowlist; no request input reaches SQL identifiers.
    const allowed = new Set(['status','result','payload','generation_attempts','email_attempts','send_started_at',
      'next_attempt_at','email_id','error_code','updated_at']);
    const entries = Object.entries({ ...patch, updated_at: Date.now() });
    if (!entries.every(([key]) => allowed.has(key))) throw new RadarError('invalid_state_update');
    const result = await this.db.prepare(`UPDATE tweets SET ${entries.map(([key]) => `${key}=?`).join(',')}
      WHERE id=? AND ${this.guard}`)
      .bind(...entries.map(([, value]) => value), id, this.owner, Date.now()).run();
    if (result.meta.changes !== 1) throw new RadarError('lease_lost');
  }
  async reserve(kind: 'twitter_calls' | 'llm_calls' | 'email_attempts', limit: number): Promise<void> {
    await this.renew();
    const day = new Date().toISOString().slice(0, 10);
    await this.db.prepare('INSERT OR IGNORE INTO counters(day) VALUES (?)').bind(day).run();
    const result = await this.db.prepare(`UPDATE counters SET ${kind}=${kind}+1
      WHERE day=? AND ${kind}<? AND ${this.guard}`).bind(day, limit, this.owner, Date.now()).run();
    if (result.meta.changes !== 1) throw new RadarError(`daily_limit_${kind}`);
  }
  async emailed(id: string, emailId: string): Promise<void> {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    // D1 batch is transactional: accepted mail and its daily count persist together.
    const results = await this.db.batch([
      this.db.prepare(`UPDATE tweets SET status='emailed',email_id=?,updated_at=?,error_code=NULL
        WHERE id=? AND status='sending' AND ${this.guard}`).bind(emailId, now, id, this.owner, now),
      this.db.prepare(`UPDATE email_receipts SET email_id=? WHERE id=? AND ${this.guard}`)
        .bind(emailId, id, this.owner, now),
      this.db.prepare(`INSERT INTO counters(day,emails_sent) SELECT ?,1 WHERE ${this.guard}
        ON CONFLICT(day) DO UPDATE SET emails_sent=emails_sent+1`).bind(day, this.owner, now),
    ]);
    if (results[0]?.meta.changes !== 1) throw new RadarError('lease_lost');
  }
  async counters(): Promise<Counters> {
    return await this.db.prepare('SELECT twitter_calls,llm_calls,email_attempts,emails_sent FROM counters WHERE day=?')
      .bind(new Date().toISOString().slice(0, 10)).first<Counters>()
      ?? { twitter_calls: 0, llm_calls: 0, email_attempts: 0, emails_sent: 0 };
  }
  async summary(): Promise<Record<string, number>> {
    const rows = await this.db.prepare('SELECT status,COUNT(*) AS count FROM tweets GROUP BY status')
      .all<{status: string; count: number}>();
    return Object.fromEntries(rows.results.map(row => [row.status, row.count]));
  }
  async cleanup(): Promise<void> {
    await this.renew();
    const now = Date.now();
    // Never retry an ambiguous email beyond the provider's idempotency retention.
    await this.db.prepare(`UPDATE tweets SET status='uncertain',error_code='email_retry_window_expired',updated_at=?
      WHERE status='sending' AND send_started_at<=? AND ${this.guard}`)
      .bind(now, now - SEND_RETRY_WINDOW_MS, this.owner, now).run();
    await this.db.prepare(`UPDATE tweets SET status='failed',error_code='retry_age_expired',updated_at=?
      WHERE status IN ('seen','generated') AND created_at<? AND ${this.guard}`)
      .bind(now, now - DAY, this.owner, now).run();
    // Thirty-day tombstones protect manual tests; live search never looks back beyond one hour.
    await this.db.prepare(`DELETE FROM tweets WHERE status NOT IN ('seen','generated','sending')
      AND updated_at<? AND ${this.guard}`).bind(now - 30 * DAY, this.owner, now).run();
    await this.db.prepare(`DELETE FROM counters WHERE day<? AND ${this.guard}`)
      .bind(new Date(now - 30 * DAY).toISOString().slice(0, 10), this.owner, now).run();
  }
}
