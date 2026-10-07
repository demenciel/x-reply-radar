export function buildReplyIntent(tweetId: string, replyText: string): string {
  if (!/^\d{1,30}$/.test(tweetId)) throw new Error('Invalid tweet ID');
  const url = new URL('https://x.com/intent/tweet');
  url.searchParams.set('in_reply_to', tweetId);
  url.searchParams.set('text', replyText);
  return url.toString();
}
export function postUrl(username: string, tweetId: string): string {
  return `https://x.com/${username}/status/${tweetId}`;
}
