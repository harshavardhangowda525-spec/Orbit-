import { test, expect } from '@playwright/test';
import { signIn, SEED } from './helpers';

/** A tiny real PNG (the offline demo reader returns a fixed sample, so any photo works). */
const PHOTO = { name: 'board.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') };

test.use({ viewport: { width: 1440, height: 900 } });

test('Snap your price list: review shows what was read, nothing is saved until Add, then the services appear', async ({ page }) => {
  await signIn(page, SEED.salon);
  await page.goto('/bridge?view=details');
  await page.getByTestId('details-snap').click();
  await page.getByTestId('snap-input-file').setInputFiles(PHOTO);
  await expect(page.getByTestId('snap-row')).toHaveCount(4);
  await expect(page.getByTestId('snap-price-list')).toContainText('Found 4 services');
  // "Facial" was read with low confidence: amber, "Please check".
  await expect(page.getByTestId('snap-row').filter({ has: page.locator('input[value="Facial"]') })).toContainText('Please check');
  // Haircut is already a service at a different price: Update / Keep both / Skip.
  await expect(page.getByTestId('snap-price-list')).toContainText('You already have Haircut');
  await expect(page.getByTestId('services-card')).not.toContainText('Hair spa');
  await page.getByTestId('snap-add-all').click();
  await expect(page.getByTestId('snap-done')).toContainText(/services? added/);
  await page.getByTestId('snap-done').getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('services-card')).toContainText('Hair spa');
  await expect(page.getByTestId('services-card')).toContainText('from ₹ ₹800');
});

test('Scan a bill from The Bridge: one review card, Save, Undo; then it is in the books', async ({ page }) => {
  await signIn(page, SEED.salon);
  await page.getByTestId('scan-fab').click();
  await page.getByTestId('snap-input-file').setInputFiles(PHOTO);
  await expect(page.getByTestId('bill-vendor')).toHaveValue('BESCOM');
  await expect(page.getByTestId('bill-total')).toHaveValue('3450');
  // Khata learned BESCOM from the owner's earlier bills.
  await expect(page.getByTestId('bill-category')).toHaveValue('electricity');
  await expect(page.getByTestId('scan-bill')).toContainText('Same category as your last bill from BESCOM');
  await page.getByTestId('bill-save').click();
  await expect(page.getByTestId('bill-saved')).toContainText('Saved the ₹3,450 bill.');
  // Kept with this month's bills (whatever date is printed on it).
  await expect(page.getByTestId('bill-saved-month')).toContainText(/Added to .+’s bills\./);
  // Undo: gone again.
  await page.getByTestId('bill-saved').getByRole('button', { name: 'Undo' }).click();
  await page.goto('/bridge?view=money');
  await expect(page.getByTestId('books')).not.toContainText('₹3,450');

  // Save it for real, then it is listed with Why?
  await page.getByTestId('books-scan').click();
  await page.getByTestId('snap-input-file').setInputFiles(PHOTO);
  await page.getByTestId('bill-save').click();
  await page.getByTestId('bill-saved').getByRole('button', { name: 'Continue' }).click();
  const row = page.locator('.bill-item', { hasText: '₹3,450' });
  await expect(row).toContainText('BESCOM');
  await row.getByRole('button', { name: 'Why?' }).click();
  await expect(page.getByTestId('why-sentence')).toContainText('Khata saved the ₹3,450 bill from BESCOM');
});

test('Add sale: the cash line goes up by exactly the sale', async ({ page }) => {
  await signIn(page, SEED.salon);
  await page.goto('/bridge?view=money');
  // Only this test logs sales, so the cash line is safe to compare while other tests add bills.
  const cash = page.locator('.books-bars li', { hasText: 'Cash and other sales' }).locator('b');
  await expect(cash).toContainText('₹');
  const amount = async () => Number((await cash.innerText()).replace(/[^\d]/g, ''));
  const before = await amount();
  await page.getByTestId('books-sale').click();
  await page.getByTestId('sale-amount').fill('1,250');
  await page.getByTestId('add-sale').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('sale-saved')).toContainText('Saved ₹1,250.');
  await page.getByTestId('sale-saved').getByRole('button', { name: 'Continue' }).click();
  await expect.poll(amount).toBe(before + 1250);
});

test('phone: Money opens on the books with earned, spent and kept', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await signIn(page, SEED.salon);
  await page.getByTestId('tab-bar').locator('[data-nav="money"]').click();
  await expect(page.getByTestId('books-revenue')).toContainText('₹');
  await expect(page.getByTestId('books-expenses')).toContainText('₹');
  await expect(page.getByTestId('books-profit')).toContainText('₹');
  await expect(page.getByTestId('books')).toContainText('Based on bills and sales added to Orbit.');
  await page.getByTestId('tab-invoices').click();
  await expect(page.getByTestId('money')).toBeVisible();
});
