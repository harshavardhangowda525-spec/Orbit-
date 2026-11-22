import { test, expect } from '@playwright/test';
import { signIn, SEED } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });

test('Teach Orbit in Details: preview with the exact date, nothing saved until Save, then Undo', async ({ page }) => {
  await signIn(page, SEED.salon);
  await page.goto('/bridge?view=details');
  const panel = page.getByTestId('teach-panel');
  await panel.getByTestId('teach-input').fill('Closed on Tuesdays from next week');
  await panel.getByTestId('teach-go').click();
  const card = panel.getByTestId('teach-card');
  await expect(card).toContainText('This will change');
  const line = card.getByTestId('teach-line').first();
  await expect(line).toContainText(/From .+/);
  await expect(line).toContainText('Tuesday: closed');
  await card.getByTestId('teach-save').click();
  await expect(card.getByTestId('teach-saved')).toContainText(/Saved/);
  await card.getByTestId('teach-undo').click();
  await expect(card.getByTestId('teach-saved')).toContainText('Undone. Everything is back as it was.');
});

test('Ask Orbit: "we are closed on 25 Dec" shows the Teach card right in the Command Bar', async ({ page }) => {
  await signIn(page, SEED.salon);
  const bar = page.locator('[data-testid="command-bar"]:visible');
  await bar.getByRole('textbox').fill('We are closed on 25 Dec');
  await bar.getByRole('button', { name: 'Send' }).click();
  const reply = page.locator('[data-testid="orbit-reply"]:visible');
  await expect(reply).toContainText('Working out what changes');
  await expect(reply.getByTestId('teach-card')).toContainText(/On .*25 Dec/);
  await expect(reply).toContainText('Check it and press Save');
  await reply.getByTestId('teach-card').getByRole('button', { name: 'Cancel' }).click();
});

test('phone: Teach is at the top of Details and fits the screen', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await signIn(page, SEED.salon);
  await page.goto('/bridge?view=details');
  await page.getByTestId('teach-input').fill('Haircut is now 350');
  await page.getByTestId('teach-go').click();
  await expect(page.getByTestId('teach-card')).toContainText('Haircut');
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w).toBeLessThanOrEqual(390);
  await page.getByTestId('teach-card').getByRole('button', { name: 'Cancel' }).click();
});
