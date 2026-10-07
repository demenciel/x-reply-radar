import type { ReplyResult, Tweet } from './types';
import type { Config } from './config';
import { RadarError } from './log';
import { externalFetch, object, responseJson } from './http';
import { SYSTEM_PROMPT } from './prompt';

export function validateReplyResult(input: unknown): ReplyResult {
  const value = object(input);
  const keys = ['fit','reason','funny','engaging','thoughtProvoking','recommended'];
  if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))
    || !['high','medium','skip'].includes(String(value.fit))
    || !['funny','engaging','thought-provoking'].includes(String(value.recommended))
    || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 240) throw new RadarError('llm_schema_invalid');
  const drafts = [value.funny, value.engaging, value.thoughtProvoking];
  if (!drafts.every(draft => typeof draft === 'string')) throw new RadarError('llm_schema_invalid');
  if (value.fit === 'skip') {
    if (drafts.some(draft => draft !== '') || value.recommended !== 'funny') throw new RadarError('llm_skip_invalid');
  } else {
    for (const draft of drafts as string[]) {
      if (!draft.trim() || draft !== draft.trim() || Array.from(draft).length > 220
        || /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]|#|\b(great point|absolutely|this is so true|couldn't agree more)\b/iu.test(draft)) throw new RadarError('llm_voice_invalid');
      const sentences = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(draft)];
      // ICU may merge a lowercase sentence into its predecessor; enforce this boundary explicitly.
      if (/[.!?]\s+["'“‘([{]*\p{Ll}/u.test(draft) || sentences.length > 2 || sentences.some(sentence => {
        const first = sentence.segment.match(/\p{L}/u)?.[0];
        return !first || !/\p{Lu}/u.test(first);
      })) throw new RadarError('llm_sentence_invalid');
      // The model is instructed not to invent experience; reject common first-person claims too.
      if (/\bI (?:built|made|tried|tested|ran|shipped|earned|sold|launched)|\b(?:my|our) (?:customers|users|revenue|product|startup)\b/i.test(draft)) throw new RadarError('llm_experience_invalid');
    }
    if (new Set((drafts as string[]).map(d => d.toLowerCase())).size !== 3) throw new RadarError('llm_duplicate_drafts');
  }
  return value as unknown as ReplyResult;
}
export function createGenerator(config: Config, apiKey: string, beforeCall: () => Promise<void>) {
  return async function generateReplies(post: Tweet): Promise<ReplyResult> {
    const messages: {role: string; content: string}[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ author: post.username, post: post.text.slice(0, 12000) }) },
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      await beforeCall();
      const response = await externalFetch(`${config.llmBaseUrl}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.llmModel, temperature: 0.6, max_tokens: 600,
          response_format: { type: 'json_object' }, messages }),
      }, 'llm');
      if (!response.ok) throw new RadarError(`llm_http_${response.status}`);
      const body = object(await responseJson(response, 'llm'));
      const choices = body.choices;
      let content: string | undefined;
      if (Array.isArray(choices) && choices.length) {
        const message = object(object(choices[0]).message);
        if (typeof message.content === 'string') content = message.content;
      }
      try {
        if (!content) throw new RadarError('llm_empty_content');
        return validateReplyResult(JSON.parse(content));
      } catch {
        if (attempt === 1) throw new RadarError('llm_invalid_after_repair');
        // Do not feed an arbitrary model response back as trusted instructions.
        messages.push({ role: 'user', content: 'Your previous output was malformed or violated the schema/voice. Repair it: return only JSON, the exact six keys, all three distinct drafts under 220 characters, capitalized sentences, no emoji, hashtags, praise or invented experience. Skip requires empty drafts.' });
      }
    }
    throw new RadarError('llm_invalid_after_repair');
  };
}
