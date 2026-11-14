import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { codeAt, stepAt } from '../../api/src/admin/totp';
import { signIn } from './helpers';

/**
 * The admin centre: signed in, a new admin team member sets up the authenticator
 * (QR + key), enters the code and lands on the overview; reloading keeps the session.
 */
test('a new admin sets up the authenticator and opens the control centre', async ({ page }) => {
  const email = `admin${Date.now().toString(36)}@example.com`;
  await signIn(page, email);
  const db = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL ?? 'postgres://orbit_admin:orbit_admin_dev@localhost:5432/orbit' });
  await db.connect();
  await db.query(`UPDATE users SET is_platform_admin = true WHERE email = $1`, [email]);
  await db.query(`INSERT INTO admin_users (user_id, role) SELECT id, 'owner' FROM users WHERE email = $1`, [email]);
  await db.end();

  await page.goto('/admin');
  const gate = page.getByTestId('admin-gate');
  await expect(gate).toContainText('scan this with an authenticator app');
  await expect(gate.locator('svg')).toBeVisible();
  const key = (await gate.locator('.mono').first().innerText()).replace(/\s+/g, '');
  await page.getByTestId('admin-code').fill('000000');
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(gate).toContainText('not right');
  await page.getByTestId('admin-code').fill(codeAt(key, stepAt()));
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByTestId('admin-overview')).toBeVisible();
  await expect(page.getByTestId('admin-overview')).toContainText('monthly recurring revenue');

  // Tabs work and the session survives a reload (this tab only).
  await page.getByRole('button', { name: 'Messaging' }).click();
  await expect(page.getByText('Automatic messages')).toBeVisible();
  await expect(page.getByText('Renewal reminder (7 days before)')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('admin-gate')).toHaveCount(0);
  await page.getByRole('button', { name: 'Team' }).click();
  await expect(page.getByText(email)).toBeVisible();
});
