import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { signIn, SEED } from './helpers';

const DB = process.env.DATABASE_MIGRATION_URL ?? 'postgres://orbit_migrator:orbit_migrator_dev@localhost:5432/orbit';

/** Something about to go out for Glow Studio (as Orbit's hold would create it). */
async function holdSomething() {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    const biz = (await c.query(`SELECT id FROM businesses WHERE slug = 'glow-studio'`)).rows[0].id;
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.business_id', $1, true)`, [biz]);
    await c.query(`DELETE FROM held_actions`);
    const r = await c.query(
      `INSERT INTO held_actions (agent_key, action_type, summary, payload, audience, hold_until)
       VALUES ('orbit', 'bulk_message', '{"key":"held.bulk","params":{"agent":"Orbit","count":38}}', '{"kind":"bulk_message","customerIds":[],"text":"Hi {{name}}, open till 10 tonight!"}', 38, now() + interval '90 seconds') RETURNING id`,
    );
    await c.query('COMMIT');
    return { id: r.rows[0].id as string, status: async () => {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.business_id', $1, true)`, [biz]);
      const s = (await c.query(`SELECT status FROM held_actions WHERE id = $1`, [r.rows[0].id])).rows[0].status;
      await c.query('COMMIT');
      return s as string;
    }, end: () => c.end() };
  } catch (e) {
    await c.end();
    throw e;
  }
}

test.use({ viewport: { width: 1440, height: 900 } });

test('Why?: one plain sentence from the real reasons, the facts it used, and “Looks good”', async ({ page }) => {
  await signIn(page, SEED.salon);
  // Found by the customer's name, which stays the same in every language.
  const row = page.getByTestId('feed').locator('li[data-type="handover"]', { hasText: 'Priya' });
  await expect(row).toContainText('Aria passed Priya to you');
  await row.getByTestId('feed-why').click();
  const sheet = page.getByTestId('why-sheet');
  await expect(sheet.getByTestId('why-sentence')).toHaveText('A customer messaged you, the reason noted was “Customer asked for a discount” and discounts always need your OK, so Aria passed Priya’s chat to you.');
  await expect(sheet).toContainText('Based on');
  await expect(sheet).toContainText('No approval needed');
  await sheet.getByRole('button', { name: 'Looks good' }).click();
  await expect(sheet).toContainText('Thanks — noted.');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  // A Needs You card explains itself too.
  // (Whichever decision is on top: another test may already have answered Priya's.)
  await page.locator('.decision').getByTestId('card-why').click();
  await expect(page.getByTestId('why-sentence')).toHaveText(/so (Aria asked you before offering Priya a discount|Nudge drafted a reply to Rahul’s review for you to check)\.$/);
  await page.keyboard.press('Escape');

  // In Hindi, from the same stored reasons.
  await page.getByLabel('Language').first().selectOption('hi');
  await row.getByTestId('feed-why').click();
  await expect(page.getByTestId('why-sentence')).toContainText('Aria ने Priya की चैट आपको सौंपी');
  await page.keyboard.press('Escape');
  await page.getByLabel('भाषा').first().selectOption('en');
});

test('“Don’t do this again for Lakshmi” switches it off for her, and Safety lists it with a way back', async ({ page }) => {
  await signIn(page, SEED.salon);
  const row = page.getByTestId('feed').locator('li', { hasText: 'Lakshmi' });
  await row.getByTestId('feed-why').click();
  await expect(page.getByTestId('why-sentence')).toContainText('so Nudge asked Lakshmi for a review (your “Review requests” rule).');
  await page.getByTestId('why-exception').click();
  await expect(page.getByTestId('why-sheet')).toContainText('Done. Orbit won’t do this for Lakshmi again.');
  await page.keyboard.press('Escape');

  // "Change this rule" lands on the exact switch.
  await row.getByTestId('feed-why').click();
  await expect(page.getByTestId('why-sheet')).toContainText('Switched off for Lakshmi');
  await page.getByRole('button', { name: 'Change this rule' }).click();
  await expect(page).toHaveURL(/view=crew.*highlight=nudge\.review_request/);
  await expect(page.locator('[data-rule="nudge.review_request"]')).toBeVisible();

  const safety = page.getByTestId('safety');
  await expect(safety).toContainText('Lakshmi Iyer');
  await safety.getByRole('button', { name: 'Turn back on' }).click();
  await expect(safety).toContainText('None yet.');
});

test('Undo: the bar counts down above Ask Orbit; Undo cancels it and nothing is sent', async ({ page }) => {
  const held = await holdSomething();
  try {
    await signIn(page, SEED.salon);
    const bar = page.getByTestId('undo-bar');
    await expect(bar).toContainText('Orbit is sending your message to 38 customers');
    // It sits just above Ask Orbit.
    const barBox = (await bar.boundingBox())!;
    const cmdBox = (await page.locator('.cmd').first().boundingBox())!;
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(cmdBox.y + 4);
    await bar.getByTestId('undo').click();
    await expect(bar).toContainText('Cancelled. Nothing was sent.');
    await expect(bar.getByRole('button', { name: 'Edit and send again' })).toBeVisible();
    expect(await held.status()).toBe('cancelled');
    await bar.getByRole('button', { name: 'Edit and send again' }).click();
    await expect(page.locator('.cmd input').first()).toHaveValue('Hi {{name}}, open till 10 tonight!');
  } finally {
    await held.end();
  }
});

test('Crew → Safety: hold times are the owner’s to choose, and changes can be undone for 24 hours', async ({ page }) => {
  await signIn(page, SEED.salon);
  await page.goto('/bridge?view=crew&section=safety');
  const safety = page.getByTestId('safety');
  await safety.locator('[data-hold="message"]').selectOption('60');
  await expect(safety).toContainText('Saved');
  await expect(safety.getByTestId('changes')).toContainText('Safety settings');
  await safety.getByTestId('changes').getByRole('button', { name: 'Undo' }).first().click();
  await expect(safety.getByTestId('changes')).toContainText('Undone');
  await page.reload();
  await expect(page.getByTestId('safety').locator('[data-hold="message"]')).toHaveValue('30');
});
