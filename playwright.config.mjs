import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests',
  testMatch: /.*\.spec\.mjs/,
  timeout: 120000,
  workers: 1, // The 60 fps check needs the CPU to itself
  reporter: [['list']],
  use: {
    viewport: { width: 1280, height: 720 },
    // WebGL2 on SwiftShader, for the GPU renderer's tests. Headless needs no
    // display, and a forwarded one that fails takes the GPU process down.
    launchOptions: {
      args: ['--enable-unsafe-swiftshader'],
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'DISPLAY')),
    },
  },
});
