import { RadarError } from './log';
export async function externalFetch(url: string | URL, init: RequestInit, stage: string): Promise<Response> {
  let response: Response;
  try {
    // Workerd supports manual/follow only. Never forward provider credentials through redirects.
    response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(25_000) });
  } catch { throw new RadarError(`${stage}_network_or_timeout`); }
  if (response.status >= 300 && response.status < 400) throw new RadarError(`${stage}_redirect_rejected`);
  return response;
}
export async function responseJson(response: Response, stage: string): Promise<unknown> {
  try { return await response.json(); }
  catch { throw new RadarError(`${stage}_invalid_response`); }
}
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RadarError('invalid_object');
  return value as Record<string, unknown>;
}
