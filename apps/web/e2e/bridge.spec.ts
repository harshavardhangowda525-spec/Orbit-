import { test, expect } from '@playwright/test';
import { midRangePhone, signIn, SEED } from './helpers';

const API = process.env.API_URL ?? 'http://localhost:4000';

test('The Bridge renders seeded data on a mid-range phone in under 2 seconds', async ({ page }) => {
  await signIn(page, SEED.salon);
  await expect(page.getByTestId('pulse')).toBeVisible();

  await midRangePhone(page);
  const started = Date.now();
  await page.goto('/bridge');
  await expect(page.getByTestId('needs-you')).toBeVisible();
  await expect(page.getByTestId('feed')).toContainText('Aria booked 3 appointments');
  const elapsed = Date.now() - started;
  console.log(`The Bridge rendered with data in ${elapsed} ms (4x CPU slowdown, 4G)`);
  expect(elapsed).toBeLessThan(2000);

  await expect(page.getByTestId('greeting')).toContainText('Meera');
  await expect(page.getByTestId('pulse-score')).toContainText(/\d+/);
  await expect(page.getByTestId('needs-count')).toHaveText('2 decisions');
  await expect(page.locator('[data-card-type="discount"]')).toContainText('Priya asked for a discount. Offer 10%?');
  await expect(page.getByTestId('earnings')).toContainText('₹');
  // Live Crew activity drives the ticker.
  await expect(page.getByTestId('ticker')).toContainText(/Aria is replying to Pooja|Nudge is sending reminders/);

  // Expand a grouped feed line.
  await page.getByRole('button', { name: /Aria booked 3 appointments/ }).click();
  await expect(page.getByTestId('feed')).toContainText('Aria booked Anil for a haircut');

  // One-tap decision: the next card pops in and the counts update.
  await page.locator('[data-card-type="discount"]').getByRole('button', { name: 'Yes' }).click();
  await expect(page.getByTestId('needs-count')).toHaveText('1 decision');
  await expect(page.locator('[data-card-type="review_reply"]')).toContainText('Bad review from Rahul');
  await expect(page.locator('.tiles.phone [data-testid="tile-need-you"]')).toContainText('1');

  // Language switch re-renders everything.
  await page.getByLabel('Language').first().selectOption('kn');
  await expect(page.getByText('ನಿಮ್ಮ ಅಗತ್ಯವಿದೆ')).toBeVisible();
  await page.getByLabel('ಭಾಷೆ').first().selectOption('hi');
  await expect(page.getByText('आपकी ज़रूरत है')).toBeVisible();
  await page.getByLabel('भाषा').first().selectOption('en');

  // Tapping an agent in the orbit opens it in the Crew view.
  // Agents keep orbiting (never "stable" for Playwright), so tap without waiting for stillness.
  await page.getByRole('button', { name: /^Vox:/ }).click({ force: true });
  await expect(page.locator('[data-agent="vox"]')).toContainText('Not on your plan');
  await expect(page.locator('[data-agent="aria"]')).toBeVisible();
});

test('new activity arrives live over WebSocket without reloading', async ({ page, request }) => {
  await signIn(page, SEED.salon);
  await expect(page.getByTestId('feed')).toBeVisible();
  const r = await page.evaluate(() => ({ token: localStorage.getItem('orbit.token'), business: localStorage.getItem('orbit.business') }));
  const cal = await request.get(`${API}/calendar`, { headers: { authorization: `Bearer ${r.token}`, 'x-business-id': r.business! } });
  const svc = (await cal.json()).services.find((s: any) => s.name === 'Haircut');
  const slots = await request.get(`${API}/slots?serviceId=${svc.id}&days=7`, { headers: { authorization: `Bearer ${r.token}`, 'x-business-id': r.business! } });
  const slot = (await slots.json()).at(-1);
  const created = await request.post(`${API}/bookings`, {
    headers: { authorization: `Bearer ${r.token}`, 'x-business-id': r.business! },
    data: { serviceId: svc.id, staffId: slot.staffId, start: slot.start, name: 'Live Test', phone: '9811144401' },
  });
  expect(created.ok()).toBeTruthy();
  await expect(page.getByTestId('feed')).toContainText('Live was booked for Haircut', { timeout: 5000 });
});

test('desktop: key numbers on top, three columns, Ask Orbit docked at the bottom, only the Crew feed scrolls', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
  const page = await ctx.newPage();
  await signIn(page, SEED.salon);
  await expect(page.getByTestId('pulse')).toBeVisible();
  const hero = await page.getByTestId('pulse').boundingBox();
  const needs = await page.getByTestId('needs-you').boundingBox();
  const feed = await page.getByTestId('feed').boundingBox();
  expect(hero!.x).toBeLessThan(needs!.x);
  expect(needs!.x).toBeLessThan(feed!.x);
  // The day's key numbers sit in one row above the columns.
  const kpi = page.getByTestId('kpi-strip');
  await expect(kpi.getByTestId('tile-need-you')).toBeVisible();
  await expect(kpi.getByTestId('kpi-earned')).toBeVisible();
  expect((await kpi.boundingBox())!.y).toBeLessThan(hero!.y);
  await expect(page.locator('.tiles.phone')).toBeHidden();
  // Ask Orbit is docked at the bottom of the screen.
  const bar = (await page.getByTestId('command-bar').boundingBox())!;
  expect(bar.y + bar.height).toBeGreaterThan(900 - 40);
  // The page itself does not scroll; the Crew feed does.
  const sizes = await page.evaluate(() => {
    const feed = document.querySelector('.feed-col') as HTMLElement;
    return { page: document.documentElement.scrollHeight, feedScroll: feed.scrollHeight > feed.clientHeight, feedOverflow: getComputedStyle(feed).overflowY, mid: getComputedStyle(document.querySelector('.mid-col')!).overflowY };
  });
  expect(sizes.page).toBeLessThanOrEqual(900);
  expect(sizes.feedOverflow).toBe('auto');
  expect(sizes.feedScroll).toBe(true);
  expect(sizes.mid).toBe('hidden');
  // "/" jumps to the bar.
  await page.keyboard.press('/');
  await expect(page.getByTestId('command-bar').locator('input')).toBeFocused();
  await ctx.close();
});

test('asking Orbit shows each step, opens the screen, and answers', async ({ page }) => {
  await signIn(page, SEED.salon);
  const bar = page.locator('[data-testid="command-bar"]:visible');
  await bar.getByRole('textbox').fill('show my customers');
  await bar.getByRole('button', { name: 'Send' }).click();
  const reply = page.locator('[data-testid="orbit-reply"]:visible');
  await expect(reply).toContainText('Opening People');
  await expect(reply).toContainText('Looking up customers');
  await expect(reply).toContainText('Here are your customers');
  // Orbit switched the screen in front of the owner, and the answer stayed on screen.
  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible();
});
