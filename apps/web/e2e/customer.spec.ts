import { test, expect } from '@playwright/test';
import { signIn, SEED } from './helpers';

/**
 * Customer side. Requires the API started with AI_PROVIDER=fake (the demo brain:
 * it answers from the knowledge base and offers real slots), so no API key is needed.
 */
test('a customer asks a question in the chat and gets the answer from the knowledge base', async ({ page }) => {
  await page.goto('/glow-studio?chat=1');
  const chat = page.getByTestId('chat');
  await expect(chat).toContainText('Glow Studio');
  await chat.getByRole('button', { name: 'Timings' }).click();
  await expect(chat).toContainText('Our opening hours are shown on our page', { timeout: 10_000 });
});

test('a customer books a real free slot from the public page', async ({ page }) => {
  await page.goto('/glow-studio');
  await page.getByRole('button', { name: /Book now/ }).click();
  const flow = page.getByTestId('booking');
  await flow.getByRole('button', { name: /^Haircut/ }).click();
  await flow.getByRole('button', { name: 'Anyone available' }).click();
  await flow.locator('.slot-grid .btn').last().click();
  await flow.getByLabel('Your name').fill('Rekha');
  await flow.getByLabel('Mobile number').fill(`98${String(Date.now()).slice(-8)}`);
  await flow.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(flow).toContainText('You are booked!');
  // The manage link lets the customer cancel.
  await flow.getByRole('link', { name: 'Change or cancel' }).click();
  await expect(page.getByTestId('manage')).toContainText('Haircut');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Cancel booking' }).click();
  await expect(page.getByText('Your booking is cancelled.')).toBeVisible();
});

test('the owner takes over a chat from the inbox and the customer sees the reply live', async ({ browser }) => {
  const customer = await (await browser.newContext()).newPage();
  await customer.goto('/glow-studio?chat=1');
  const chat = customer.getByTestId('chat');
  await chat.getByPlaceholder('Type your message').fill('I want to talk to a person');
  await chat.getByRole('button', { name: 'Send' }).click();
  await expect(chat).toContainText('A person from the team is now chatting with you');

  const owner = await (await browser.newContext()).newPage();
  await signIn(owner, SEED.salon);
  await owner.goto('/inbox');
  await owner.getByTestId('inbox-list').getByRole('link').first().click();
  await expect(owner.getByTestId('conversation')).toContainText('I want to talk to a person');
  await owner.getByLabel('Write a reply').fill('Hi! Meera here, how can I help?');
  await owner.getByRole('button', { name: 'Send' }).click();
  await expect(chat).toContainText('Meera here, how can I help?', { timeout: 5000 });
  await owner.getByRole('button', { name: 'Hand back to Aria' }).click();
  await expect(owner.getByRole('button', { name: 'Take over' })).toBeVisible();
});
