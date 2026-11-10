import { test, expect } from '@playwright/test';
import { signIn, SEED } from './helpers';

test('the owner sets GST, writes an invoice with a live GST preview, and the customer opens it', async ({ page, context }) => {
  await signIn(page, SEED.salon);
  await page.goto('/bridge?view=money');
  const money = page.getByTestId('money');
  await expect(money).toContainText('received today');

  await money.getByRole('button', { name: 'GST and invoice settings' }).first().click();
  const gst = page.getByTestId('gst-settings');
  await gst.getByPlaceholder('29ABCDE1234F1Z5').fill('29ABCDE1234F1Z5');
  await gst.getByRole('button', { name: 'Save' }).click();
  await expect(money.getByText('Add your GSTIN')).toHaveCount(0);

  await money.getByRole('button', { name: 'New invoice' }).click();
  const form = page.getByTestId('invoice-form');
  await form.getByLabel('Customer name').fill('Priya Nair');
  await form.getByLabel('Mobile number').fill('9845000111');
  await form.getByLabel('Item or service').fill('Hair spa');
  await form.getByLabel('Price').fill('1180');
  // Prices include GST: 1,000 taxable + 90 CGST + 90 SGST.
  await expect(form).toContainText('₹1,000');
  await expect(form).toContainText('₹90');
  await form.getByRole('button', { name: 'Save and send' }).click();

  const row = money.locator('.rowbtn', { hasText: 'Priya Nair' }).first();
  await expect(row).toContainText(/INV\/\d{2}-\d{2}\/\d{4}/);
  await expect(row).toContainText('₹1,180');

  // Send again shows the customer's link (no messaging channel is connected locally).
  await money.getByRole('button', { name: 'Send again' }).click();
  const link = await money.locator('input[readonly]').first().inputValue();
  expect(link).toMatch(/\/i\/[0-9a-f-]{36}\./);
  const customer = await context.newPage();
  await customer.goto(link);
  const inv = customer.getByTestId('invoice');
  await expect(inv).toContainText('Tax invoice');
  await expect(inv).toContainText('GSTIN: 29ABCDE1234F1Z5');
  await expect(inv).toContainText('Priya Nair');
  await expect(inv).toContainText('Karnataka');
  await expect(inv).toContainText('₹1,180');
});
