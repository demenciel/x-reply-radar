import { RadarError } from './log';
export async function externalFetch(url: string | URL, init: RequestInit, stage: string): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(25_000) });
  } catch { throw new RadarError(`${stage}_network_or_timeout`); }
}
export async function responseJson(response: Response, stage: string): Promise<unknown> {
  try { return await response.json(); }
  catch { throw new RadarError(`${stage}_invalid_response`); }
}
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RadarError('invalid_object');
  return value as Record<string, unknown>;
}
