import type { EmailPayload, ReplyResult, Tweet } from './types';
import type { Config } from './config';
import { buildReplyIntent } from './intent';
import { externalFetch, object, responseJson } from './http';
import { RadarError } from './log';

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}
export function buildEmail(tweet: Tweet, result: ReplyResult, config: Config): EmailPayload {
  const original = escapeHtml(tweet.text);
  const author = escapeHtml(tweet.name ? `${tweet.name} (@${tweet.username})` : `@${tweet.username}`);
  let html = `<div style="max-width:600px;margin:auto;padding:20px;font:16px/1.5 Arial,sans-serif;color:#171717"><p style="font-size:12px;color:#666">NEW X POST</p><h2>${author}</h2><p style="white-space:pre-wrap;overflow-wrap:anywhere">${original}</p><p><a href="${escapeHtml(tweet.url)}">View original post</a></p><p><strong>FIT: ${result.fit.toUpperCase()}</strong></p>`;
  let text = `NEW X POST\n${tweet.name ?? ''} @${tweet.username}\n\n${tweet.text}\n\nView original post: ${tweet.url}\n\nFIT: ${result.fit.toUpperCase()}\n`;
  if (result.fit !== 'skip') {
    const drafts = [
      { key: 'funny', label: 'Funny', reply: result.funny },
      { key: 'engaging', label: 'Engaging', reply: result.engaging },
      { key: 'thought-provoking', label: 'Thought-provoking', reply: result.thoughtProvoking },
    ];
    for (const draft of drafts) {
      const recommended = draft.key === result.recommended;
      const heading = `${draft.label.toUpperCase()}${recommended ? ' — RECOMMENDED' : ''}`;
      const intent = buildReplyIntent(tweet.id, draft.reply);
      html += `<div style="margin:18px 0;padding:16px;border:2px solid ${recommended ? '#126b42' : '#ddd'};border-radius:8px;background:${recommended ? '#f0faf4' : '#fff'}"><h3 style="font-size:14px;margin:0 0 12px">${heading}</h3><p style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(draft.reply)}</p><a style="display:inline-block;padding:12px 18px;background:#171717;color:white;text-decoration:none;border-radius:5px" href="${escapeHtml(intent)}">Reply with this</a><p style="font-size:12px;color:#666;margin-bottom:4px">Copy-paste fallback:</p><p style="white-space:pre-wrap;overflow-wrap:anywhere;margin-top:0">${escapeHtml(draft.reply)}</p></div>`;
      text += `\n${heading}\n${draft.reply}\nReply with this: ${intent}\nCopy-paste fallback:\n${draft.reply}\n`;
    }
  } else { html += '<p>This post was skipped. No reply drafts were generated.</p>'; text += '\nSkipped. No reply drafts generated.\n'; }
  html += '<p style="font-size:12px;color:#666">Review before sending. The link opens a draft; you press Reply in X. If your app drops the prefill, use the copy-paste text above.</p></div>';
  return { from: config.emailFrom, to: [config.emailTo],
    subject: `New post: @${tweet.username} — ${result.fit === 'skip' ? 'Skipped' : 'Reply opportunity'}`, html, text };
}
export async function sendEmail(id: string, payload: EmailPayload, apiKey: string): Promise<string> {
  const response = await externalFetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json',
      'Idempotency-Key': `x-reply-radar/${id}` }, body: JSON.stringify(payload),
  }, 'email');
  if (!response.ok) throw new RadarError(`email_http_${response.status}`);
  const body = object(await responseJson(response, 'email'));
  if (typeof body.id !== 'string' || !body.id) throw new RadarError('email_missing_id');
  return body.id;
}
