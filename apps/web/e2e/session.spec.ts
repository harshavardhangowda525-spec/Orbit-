import { test, expect } from '@playwright/test';

/**
 * A sign-in the server no longer accepts (expired or revoked) must end cleanly:
 * one renewal attempt, then the login page with a short note. The tab must not
 * keep calling the API (or reconnecting live updates) with the dead token.
 */
test('an expired sign-in goes to the login page once, without retrying forever', async ({ page }) => {
  let rejected = 0;
  page.on('response', (r) => {
    if (r.status() === 401 && /localhost:4000/.test(r.url())) rejected++;
  });
  let socketRejects = 0;
  page.on('websocket', (ws) => ws.on('close', () => /\/ws\?/.test(ws.url()) && socketRejects++));

  await page.goto('/login');
  await page.evaluate(() => {
    localStorage.setItem('orbit.token', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4IiwiZXhwIjoxfQ.expired');
    localStorage.setItem('orbit.business', '00000000-0000-0000-0000-000000000000');
  });
  await page.goto('/bridge');
  await expect(page).toHaveURL(/\/login\?expired=1/, { timeout: 15_000 });
  await expect(page.getByText(/session ended/i)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('orbit.token'))).toBeNull();

  // Stay a while: nothing keeps hammering the server with the dead token.
  const before = rejected;
  await page.waitForTimeout(5_000);
  expect(rejected - before).toBe(0);
  expect(rejected).toBeLessThanOrEqual(3);
  expect(socketRejects).toBeLessThanOrEqual(2);
});
