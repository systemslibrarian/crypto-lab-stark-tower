import { defineConfig, devices } from '@playwright/test';

const PORT = 4310;
const BASE = '/crypto-lab-stark-tower/';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}${BASE}`,
    colorScheme: 'dark',
    trace: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Build first: `preview` only serves whatever is already in dist/. Without
    // the build in front, a failing compile leaves the previous good bundle on
    // disk and the suite passes green against source that no longer builds —
    // which silently invalidates mutation checking.
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
