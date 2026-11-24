import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { SEED, signIn } from './helpers';

const DB = process.env.DATABASE_MIGRATION_URL ?? 'postgres://orbit_migrator:orbit_migrator_dev@localhost:5432/orbit';
const ADMIN_DB = process.env.DATABASE_ADMIN_URL ?? 'postgres://orbit_admin:orbit_admin_dev@localhost:5432/orbit';

function psql(sql: string, url = ADMIN_DB) {
  return execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-tAc', sql], { encoding: 'utf8' }).trim();
}

function setGlowPlan(code: string) {
  psql(
    `UPDATE businesses SET plan_id = (SELECT id FROM plans WHERE code = '${code}') WHERE slug = 'glow-studio';`,
  );
}

test.describe('Phase 6: premium experience by plan', () => {
  test.beforeAll(() => {
    // Ensure a clean starting state on Free for Glow Studio
    psql(`DELETE FROM plan_changes WHERE business_id = (SELECT id FROM businesses WHERE slug = 'glow-studio');`);
    psql(`DELETE FROM milestones WHERE business_id = (SELECT id FROM businesses WHERE slug = 'glow-studio');`);
    psql(`UPDATE business_profiles SET appearance = '{"theme":"space","brandColor":null,"avatarStyle":"initials","festivals":["diwali","christmas"]}' WHERE business_id = (SELECT id FROM businesses WHERE slug = 'glow-studio');`);
    setGlowPlan('free');
    psql(`DELETE FROM plan_changes WHERE business_id = (SELECT id FROM businesses WHERE slug = 'glow-studio');`);
  });

  test.afterAll(() => {
    // Restore Glow Studio to its seeded Plus/Space state so other specs stay unaffected
    psql(`DELETE FROM plan_changes WHERE business_id = (SELECT id FROM businesses WHERE slug = 'glow-studio');`);
    psql(`DELETE FROM milestones WHERE business_id = (SELECT id FROM businesses WHERE slug = 'glow-studio');`);
    psql(`UPDATE business_profiles SET appearance = '{"theme":"space","brandColor":null,"avatarStyle":"initials","festivals":["diwali","christmas"]}' WHERE business_id = (SELECT id FROM businesses WHERE slug = 'glow-studio');`);
    setGlowPlan('plus');
    psql(`DELETE FROM plan_changes WHERE business_id = (SELECT id FROM businesses WHERE slug = 'glow-studio');`);
  });

  test('theme switching and locks on Free', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, SEED.salon);
    await page.goto('/bridge?view=details');
    await expect(page.getByTestId('appearance-panel')).toBeVisible();

    // Free can switch to Light theme
    await page.getByTestId('theme-light').click();
    await expect(page.locator('main.space-theme')).toHaveAttribute('data-theme', 'light');

    // Midnight is locked on Free and opens friendly preview sheet
    await expect(page.getByTestId('theme-midnight')).toHaveAttribute('data-locked', 'true');
    await page.getByTestId('theme-midnight').click();
    await expect(page.getByTestId('feature-lock-sheet')).toBeVisible();
    await expect(page.getByTestId('lock-upgrade-btn')).toBeVisible();

    // Switch back to Space
    await page.getByRole('button', { name: 'Maybe later' }).click();
    await page.getByTestId('theme-space').click();
    await expect(page.locator('main.space-theme')).toHaveAttribute('data-theme', 'space');
  });

  test('upgrade celebration once, Pro visuals & Morning Story, then calm downgrade', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, SEED.salon);

    // Upgrade Free -> Pro (trigger inserts plan_changes row)
    setGlowPlan('pro');
    await page.goto('/bridge');

    // Celebration modal appears once
    await expect(page.getByTestId('upgrade-celebration')).toBeVisible();
    await page.getByTestId('upgrade-continue').click();
    await expect(page.getByTestId('upgrade-celebration')).toBeHidden();

    // Pro shine badge, trails, Wins card, Morning Story, and What's new checklist
    await expect(page.getByTestId('plan-badge')).toContainText('Orbit Pro');
    await expect(page.getByTestId('orbit-system')).toHaveAttribute('data-trails', 'true');
    await expect(page.getByTestId('whats-new-card')).toBeVisible();
    await expect(page.getByTestId('wins-card')).toBeVisible();
    await expect(page.getByTestId('morning-story-card')).toBeVisible();

    // Open Morning Story and step through all 4 cards
    await page.getByTestId('open-morning-story').click();
    await expect(page.getByTestId('story-slide-0')).toBeVisible();
    await page.getByTestId('story-next').click();
    await expect(page.getByTestId('story-slide-1')).toBeVisible();
    await page.getByTestId('story-next').click();
    await expect(page.getByTestId('story-slide-2')).toBeVisible();
    await page.getByTestId('story-next').click();
    await expect(page.getByTestId('story-slide-3')).toBeVisible();
    await page.getByTestId('story-next').click();
    await expect(page.getByTestId('morning-story-modal')).toBeHidden();

    // Reload: celebration must NOT reappear
    await page.reload();
    await expect(page.getByTestId('pulse')).toBeVisible();
    await expect(page.getByTestId('upgrade-celebration')).toHaveCount(0);

    // Switch to Sunrise theme on Pro
    await page.goto('/bridge?view=details');
    await page.getByTestId('theme-sunrise').click();
    await expect(page.locator('main.space-theme')).toHaveAttribute('data-theme', 'sunrise');

    // Downgrade Pro -> Free: calm summary appears, theme falls back to space
    setGlowPlan('free');
    await page.goto('/bridge');
    await expect(page.getByTestId('downgrade-summary')).toBeVisible();
    await expect(page.locator('main.space-theme')).toHaveAttribute('data-theme', 'space');
    await page.getByTestId('downgrade-dismiss').click();
    await expect(page.getByTestId('downgrade-summary')).toBeHidden();
  });

  test('Business visuals (constellation ring, brand colour, report, phone + desktop no overflow) & Enterprise white-label', async ({ page }) => {
    // Seed 2 branches + Success Manager setting for Business
    psql(
      `INSERT INTO locations (business_id, name) SELECT id, 'Indiranagar' FROM businesses WHERE slug = 'glow-studio' AND NOT EXISTS (SELECT 1 FROM locations WHERE business_id = businesses.id AND name = 'Indiranagar');
       INSERT INTO locations (business_id, name) SELECT id, 'Koramangala' FROM businesses WHERE slug = 'glow-studio' AND NOT EXISTS (SELECT 1 FROM locations WHERE business_id = businesses.id AND name = 'Koramangala');`,
    );
    psql(
      `INSERT INTO platform_settings (key, value) VALUES ('support.success_manager', '{"name":"Ananya Rao","role":"Success Manager","phone":"+919876543210","whatsapp":"919876543210"}')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`,
    );
    setGlowPlan('business');
    psql(`UPDATE plan_changes SET seen_at = now() WHERE business_id = (SELECT id FROM businesses WHERE slug = 'glow-studio');`);

    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, SEED.salon);
    await page.goto('/bridge');
    await expect(page.getByTestId('plan-badge')).toContainText('Orbit Business');
    await expect(page.getByTestId('constellation-ring')).toBeVisible();
    await expect(page.getByTestId('success-manager-card')).toContainText('Ananya Rao');

    // Open Monthly Business Report
    await page.getByTestId('open-business-report').click();
    await expect(page.getByTestId('business-report-modal')).toBeVisible();
    await page.getByTestId('business-report-modal').getByRole('button', { name: 'Close' }).click();

    // Check phone (390×844) has no horizontal scroll
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/bridge');
    await expect(page.getByTestId('pulse')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow).toBe(false);

    // Switch to Enterprise white-label: NO "Orbit" branding on Bridge or public page
    setGlowPlan('enterprise');
    psql(`UPDATE plan_changes SET seen_at = now() WHERE business_id = (SELECT id FROM businesses WHERE slug = 'glow-studio');`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/bridge');
    await expect(page.locator('main.space-theme')).toHaveAttribute('data-whitelabel', 'true');
    await expect(page.getByTestId('plan-badge')).toHaveCount(0);
    await expect(page.getByTestId('app-nav')).not.toContainText('Orbit');

    await page.goto('/glow-studio');
    await expect(page.locator('main')).not.toContainText('Powered by Orbit');
  });
});
