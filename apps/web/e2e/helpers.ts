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

export async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  const note = page.getByText(/Test mode: your code is \d{6}/);
  const code = (await note.textContent())!.match(/\d{6}/)![0];
  await page.getByLabel('Code').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Signed in once the app has left the login page (to The Bridge or onboarding).
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}
