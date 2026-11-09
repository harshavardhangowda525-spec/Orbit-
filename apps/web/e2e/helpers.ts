import type { Page, CDPSession } from '@playwright/test';

/** Simulate a mid-range Android phone on 4G: 4x CPU slowdown, ~9 Mbps down, 85 ms latency. */
export async function midRangePhone(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 85, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (3 * 1024 * 1024) / 8 });
  return cdp;
}

/** Demo accounts created by the seed. */
export const SEED = { salon: 'meera@glowstudio.example', gym: 'suresh@ironcore.example' };

/** SEED_PASSWORD from the seed; new test accounts use TEST_PASSWORD. */
export const SEED_PASSWORD = 'orbit-demo-1234';
export const TEST_PASSWORD = 'test-password-123';

/** Logs in a seeded owner, or signs up a new email (the "Sign up" tab), through the real login screen. */
export async function signIn(page: Page, email: string) {
  const known = Object.values(SEED).includes(email);
  await page.goto('/login');
  if (!known) await page.getByRole('tab', { name: 'Sign up' }).click();
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(known ? SEED_PASSWORD : TEST_PASSWORD);
  await page.getByRole('button', { name: known ? 'Log in' : 'Create account', exact: true }).click();
  // Signed in once the app has left the login page (to The Bridge or onboarding).
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}
