import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests',
  testMatch: /.*\.spec\.mjs/,
  timeout: 120000,
  workers: 1, // The 60 fps check needs the CPU to itself
  reporter: [['list']],
  use: { viewport: { width: 1280, height: 720 } },
});
