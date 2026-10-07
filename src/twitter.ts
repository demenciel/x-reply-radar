import type { Tweet } from './types';
import { externalFetch, object, responseJson } from './http';
import { RadarError } from './log';
import { postUrl } from './intent';

export function buildSearchQuery(accounts: string[], since: number, until: number): string {
  if (!accounts.length || !accounts.every(account => /^[a-z0-9_]{1,15}$/i.test(account))) throw new RadarError('invalid_search_accounts');
  return `(${accounts.map(account => `from:${account}`).join(' OR ')}) -filter:replies -filter:retweets since_time:${Math.floor(since / 1000)} until_time:${Math.ceil(until / 1000)}`;
}
export function normalizeTweet(value: unknown): Tweet {
  const raw = object(value);
  const author = object(raw.author);
  if (typeof raw.id !== 'string' || !/^\d{1,30}$/.test(raw.id) || typeof raw.text !== 'string'
    || typeof author.userName !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(author.userName)
    || typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))
    || typeof raw.isReply !== 'boolean') throw new RadarError('twitter_invalid_tweet');
  const username = author.userName.toLowerCase();
  return {
    id: raw.id, username, name: typeof author.name === 'string' ? author.name : undefined,
    text: raw.text, createdAt: new Date(raw.createdAt).toISOString(),
    isReply: raw.isReply || (typeof raw.inReplyToId === 'string' && /^\d+$/.test(raw.inReplyToId)),
    isRetweet: raw.retweeted_tweet != null || raw.isRetweet === true || /^RT @\w+:/.test(raw.text),
    isQuote: raw.quoted_tweet != null || raw.isQuote === true,
    url: postUrl(username, raw.id),
  };
}
export async function searchTweets(key: string, query: string, cursor: string): Promise<{tweets: Tweet[]; cursor: string}> {
  const url = new URL('https://api.twitterapi.io/twitter/tweet/advanced_search');
  url.searchParams.set('query', query);
  url.searchParams.set('queryType', 'Latest');
  url.searchParams.set('cursor', cursor);
  const response = await externalFetch(url, { headers: { 'X-API-Key': key } }, 'twitter');
  if (!response.ok) throw new RadarError(`twitter_http_${response.status}`);
  const body = object(await responseJson(response, 'twitter'));
  if (!Array.isArray(body.tweets) || body.tweets.length > 100 || typeof body.has_next_page !== 'boolean'
    || typeof body.next_cursor !== 'string') throw new RadarError('twitter_invalid_page');
  if (body.has_next_page && (!body.next_cursor || body.next_cursor === cursor)) throw new RadarError('twitter_invalid_cursor');
  return { tweets: body.tweets.map(normalizeTweet), cursor: body.has_next_page ? body.next_cursor : '' };
}
