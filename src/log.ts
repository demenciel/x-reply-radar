import { ConfigError } from './config';
// Only controlled error codes go into logs. Provider bodies and caught messages may contain secrets.
export class RadarError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export function errorCode(error: unknown): string {
  return error instanceof RadarError ? error.code : error instanceof ConfigError ? `configuration_${error.field}` : 'internal_error';
}
export function log(event: string, fields: Record<string, string | number | boolean | undefined> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}
