import { expect, test } from '@playwright/test';
import {
  boot,
  driveAllStates,
  expectBaselineNotStale,
  NARROW,
  reportCollected,
  watchPageErrors,
} from './gate';

/**
 * WCAG A/AA regression gate for STARK Tower.
 *
 * The lab is driven along everything it teaches: the shipped state, where every
 * exhibit has already rendered itself in its HONEST configuration and only the
 * end-to-end proof is absent; the shared skip link focused; the AIR trace
 * tampered, re-checked, regenerated and driven at both trace lengths; the
 * constraint quotient in both outcomes, so the clean division and the nonzero
 * remainder are each measured; FRI on the tampered quotient and the honest one,
 * then switched to the abstract-polynomial source — a whole sub-panel behind
 * the `hidden` attribute that only that radio reveals — with and without the
 * injected high-degree term; both soundness sliders at their minimum (1 bit)
 * and maximum (480 bits); the end-to-end protocol proved, verified ACCEPTED,
 * corrupted, verified REJECTED, then re-proved under zero-knowledge masking and
 * at the shorter trace; four masked openings and a fresh masking experiment;
 * the single `<details>` opened by clicking its own summary; and an inline term
 * definition opened by KEYBOARD FOCUS. Every one of those states is scanned, in
 * both themes, at desktop and phone width.
 *
 * See `gate.ts` for why nothing is injected into the page, why the disclosure
 * is not force-opened, why the lab's defaults are asserted rather than assumed,
 * and why `violations` is not the whole oracle.
 */

for (const theme of ['dark', 'light'] as const) {
  test(`no WCAG A/AA violations in ${theme} theme`, async ({ page }) => {
    test.setTimeout(1_800_000);
    const errors = watchPageErrors(page);
    await boot(page, theme);
    await driveAllStates(page, theme);
    expect(errors, errors.join('\n')).toEqual([]);
    expectBaselineNotStale();
    reportCollected();
  });

  test(`no WCAG A/AA violations in ${theme} theme at 380px`, async ({ page }) => {
    test.setTimeout(1_800_000);
    const errors = watchPageErrors(page);
    await page.setViewportSize(NARROW);
    await boot(page, theme);
    await driveAllStates(page, `${theme} @380px`);
    expect(errors, errors.join('\n')).toEqual([]);
    expectBaselineNotStale();
    reportCollected();
  });
}
