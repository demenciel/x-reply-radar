import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: './wrangler.toml' },
    miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations('./migrations') } },
  }))],
  test: { setupFiles: ['./test/setup.ts'] },
});
