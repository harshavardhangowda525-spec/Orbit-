import { test, expect } from '@playwright/test';
import { midRangePhone, signIn } from './helpers';

test('The Bridge renders seeded data on a mid-range phone in under 2 seconds', async ({ page }) => {
  await signIn(page, '+919800000001');
  await expect(page.getByTestId('pulse')).toBeVisible();

  // Measure a cold load of The Bridge as a returning owner would see it.
  await midRangePhone(page);
  const started = Date.now();
  await page.goto('/bridge');
  await expect(page.getByTestId('needs-you')).toBeVisible();
  await expect(page.getByTestId('feed')).toContainText('Aria booked 3 appointments');
  const elapsed = Date.now() - started;
  console.log(`The Bridge rendered with data in ${elapsed} ms (4x CPU slowdown, 4G)`);
  expect(elapsed).toBeLessThan(2000);

  await expect(page.getByTestId('pulse')).toContainText('bookings today');
  await expect(page.locator('[data-card-type="discount"]')).toContainText('Priya asked for a discount. Offer 10%?');
  await expect(page.locator('[data-card-type="review_reply"]')).toContainText('Bad review from Rahul');
  await expect(page.getByTestId('earnings')).toContainText('₹');
  await page.screenshot({ path: 'test-results/bridge-en.png', fullPage: true });

  // Expand a grouped feed line.
  await page.getByRole('button', { name: '▼ 3' }).click();
  await expect(page.getByTestId('feed')).toContainText('Aria booked Anil for a haircut');

  // Switch language: everything re-renders in Kannada.
  await page.getByLabel('Language').first().selectOption('kn');
  await expect(page.getByText('ನಿಮ್ಮ ಅಗತ್ಯವಿದೆ')).toBeVisible();
  await expect(page.locator('[data-card-type="discount"]')).toContainText('Priya ರಿಯಾಯಿತಿ ಕೇಳಿದ್ದಾರೆ');
  await page.screenshot({ path: 'test-results/bridge-kn.png', fullPage: true });
  await page.getByLabel('ಭಾಷೆ').first().selectOption('hi');
  await expect(page.getByText('आपकी ज़रूरत है')).toBeVisible();
  await page.getByLabel('भाषा').first().selectOption('en');

  // Swipe to the Crew view.
  await page.getByRole('button', { name: 'Crew', exact: true }).click();
  await expect(page.locator('[data-agent="aria"]')).toContainText('Working');
  await expect(page.locator('[data-agent="vox"]')).toContainText('Not on your plan');
});
