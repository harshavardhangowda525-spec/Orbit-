import { test, expect } from '@playwright/test';
import { midRangePhone, signIn } from './helpers';

test('a new owner sets up Orbit on a phone in under 2 minutes', async ({ page }) => {
  await midRangePhone(page);
  const email = `new${Date.now()}@example.com`;
  const started = Date.now();

  await signIn(page, email);
  await expect(page.getByRole('heading', { name: 'What kind of business do you run?' })).toBeVisible();
  await page.locator('[data-type="salon"]').click();

  await expect(page.getByRole('heading', { name: /Google Maps link, Instagram or website/ })).toBeVisible();
  await page.getByRole('button', { name: 'Skip, I will type it' }).click();

  await expect(page.getByRole('heading', { name: 'What is your business called?' })).toBeVisible();
  await page.getByLabel('Business name').fill('Sunrise Salon');
  await page.getByLabel('Business phone or WhatsApp').fill('98450 12345');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'What do you offer?' })).toBeVisible();
  await page.getByLabel('Price (₹)').first().fill('250');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'When are you open?' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Who works with you?' })).toBeVisible();
  await page.getByRole('button', { name: 'It is just me' }).click();

  await expect(page.getByRole('heading', { name: 'Which calendar should Orbit use?' })).toBeVisible();
  await page.locator('[data-mode="builtin"]').click();

  await expect(page.getByRole('heading', { name: 'Your Orbit is live!' })).toBeVisible();
  const elapsed = (Date.now() - started) / 1000;
  console.log(`Onboarding completed in ${elapsed.toFixed(1)}s (automated, throttled phone)`);
  expect(elapsed).toBeLessThan(120);

  await expect(page.getByTestId('public-link')).toHaveText(/\/sunrise-salon/);
  await expect(page.locator('.qr svg')).toBeVisible();
  await page.screenshot({ path: 'test-results/onboarding-live.png', fullPage: true });

  // Autosave + resume: a reload lands back on the live screen, not the start.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your Orbit is live!' })).toBeVisible();

  await page.getByRole('button', { name: 'Go to The Bridge' }).click();
  await expect(page.getByTestId('pulse')).toBeVisible();
  await expect(page.getByTestId('needs-empty')).toHaveText(/Nothing needs you/);
  await expect(page.getByTestId('feed')).toContainText('Sunrise Salon is live on Orbit');

  // The public page works for customers.
  const href = await page.request.get(`/sunrise-salon`);
  expect(href.ok()).toBeTruthy();
});

test('resume works mid-way through onboarding', async ({ page }) => {
  const email = `resume${Date.now()}@example.com`;
  await signIn(page, email);
  await page.locator('[data-type="gym"]').click();
  await page.getByRole('button', { name: 'Skip, I will type it' }).click();
  await page.getByLabel('Business name').fill('Peak Fitness');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'What do you offer?' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'What do you offer?' })).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByLabel('Business name')).toHaveValue('Peak Fitness');
});
