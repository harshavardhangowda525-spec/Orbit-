import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests on a mid-range Android phone profile with a slowed CPU.
 * Expects the API on :4000 (seeded with `npm run db:seed`) and the web app on :3000.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  retries: 0,
  use: {
    baseURL: process.env.WEB_URL ?? 'http://localhost:3000',
    ...devices['Pixel 5'],
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  },
  reporter: [['list']],
});
