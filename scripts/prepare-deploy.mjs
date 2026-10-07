import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const PLACEHOLDER = '00000000-0000-0000-0000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function deploymentConfig(source, databaseOverride) {
  const binding = /^database_id\s*=\s*"([^"]+)"[^\r\n]*$/gm;
  const matches = [...source.matchAll(binding)];
  if (matches.length !== 1) throw new Error('Expected exactly one D1 database_id in wrangler.toml.');
  const id = databaseOverride ?? matches[0][1];
  if (!UUID.test(id) || id === PLACEHOLDER) {
    throw new Error('Set CLOUDFLARE_D1_DATABASE_ID under GitHub repository Variables to the real D1 database UUID, or replace the placeholder in wrangler.toml.');
  }
  if (!/^keep_vars\s*=\s*true\s*(?:#[^\r\n]*)?$/m.test(source)) {
    throw new Error('Production deployments require keep_vars = true to preserve Cloudflare runtime variables.');
  }
  const configured = source.replace(binding, `database_id = "${id}"`);
  let inVars = false;
  const lines = configured.split(/\r?\n/).filter(line => {
    if (/^\s*\[vars\]\s*(?:#.*)?$/.test(line)) { inVars = true; return false; }
    if (/^\s*\[/.test(line)) inVars = false;
    return !inVars;
  });
  // Omitting vars is essential: keep_vars alone still permits explicit values to override dashboard edits.
  return lines.join('\n').trimEnd() + '\n';
}

async function main() {
  const root = new URL('../', import.meta.url);
  const source = await readFile(new URL('wrangler.toml', root), 'utf8');
  const config = deploymentConfig(source, process.env.CLOUDFLARE_D1_DATABASE_ID || undefined);
  await writeFile(new URL('.wrangler.deploy.toml', root), config, { mode: 0o600 });
  console.log('Prepared .wrangler.deploy.toml; Cloudflare runtime variables will be preserved.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
