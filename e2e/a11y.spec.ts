import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Strict WCAG regression gate (axe-core). Scans the full page with every
 * collapsible expanded and every live demo driven so dynamically-injected
 * result regions are covered, in both dark (default) and light themes.
 */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function killMotion(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `*,*::before,*::after{transition:none!important;animation:none!important;
      animation-duration:0s!important;transition-duration:0s!important;
      caret-color:transparent!important;scroll-behavior:auto!important}`,
  });
}

async function expandAll(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('details')) d.open = true;
  });
}

async function clickIfPresent(page: Page, selector: string): Promise<void> {
  const loc = page.locator(selector);
  if ((await loc.count()) > 0) {
    await loc.first().click({ trial: false }).catch(() => {});
  }
}

async function driveDemos(page: Page): Promise<void> {
  // AIR / trace demo
  await clickIfPresent(page, '#air-generate-trace');
  await clickIfPresent(page, '#air-check');
  await clickIfPresent(page, '#air-tamper');
  // FRI low-degree test
  await clickIfPresent(page, '#fri-run');
  // End-to-end prove / verify / corrupt
  await clickIfPresent(page, '#e2e-prove');
  await clickIfPresent(page, '#e2e-verify');
  await clickIfPresent(page, '#e2e-corrupt');
  // Zero-knowledge histogram
  await clickIfPresent(page, '#zk-run');
  // Let async output regions settle
  await page.waitForTimeout(300);
}

async function prep(page: Page): Promise<void> {
  await killMotion(page);
  await driveDemos(page);
  await expandAll(page);
}

async function scan(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const summary = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 5),
  }));
  expect(summary).toEqual([]);
}

test('no WCAG A/AA violations in dark theme', async ({ page }) => {
  await page.goto('.');
  await page.waitForSelector('#cl-theme-toggle');
  await prep(page);
  await scan(page);
});

test('no WCAG A/AA violations in light theme', async ({ page }) => {
  await page.goto('.');
  await page.waitForSelector('#cl-theme-toggle');
  await page.locator('#cl-theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await prep(page);
  await scan(page);
});
