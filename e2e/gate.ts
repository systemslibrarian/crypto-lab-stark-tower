import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { auditContrast, formatContrastFailures } from './contrast';
import { auditNonText } from './nontext';
import { NONTEXT_BASELINE } from './nontext-baseline';

export const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** A phone-width viewport, for the WCAG 1.4.10 reflow half of the gate. */
export const NARROW = { width: 380, height: 800 };

/**
 * Shared machinery for the WCAG gate on STARK Tower.
 *
 * Five rules govern everything here, and each one is a correction of the gate
 * this replaces:
 *
 *  1. NOTHING IS INJECTED INTO THE PAGE BEFORE A SCAN. The old spec's
 *     `killMotion()` pushed `transition:none!important; animation:none!important;
 *     caret-color:transparent!important; scroll-behavior:auto!important` into
 *     the document through `addStyleTag`. That BYPASSED this stylesheet's own
 *     `@media (prefers-reduced-motion: reduce)` block instead of exercising it.
 *     `css/style.css` currently declares no `@keyframes` and no `animation`
 *     property at all, so the block only clamps transition durations — but that
 *     is a fact about today's stylesheet, and `expectNotBlank` re-measures it in
 *     every driven state rather than trusting the reading. The one transition
 *     that matters is `.term-def`'s `opacity 0.12s`, and it is paired with a
 *     `visibility` flip, which is the correct shape.
 *
 *  2. IT FORCE-OPENED THE DISCLOSURE FROM SCRIPT. `expandAll()` set
 *     `d.open = true` on every `<details>`. This page has exactly one — "What a
 *     production STARK still adds on top of this demo" — and it ships shut,
 *     which is a real state a reader meets. This gate scans it shut first and
 *     then opens it by clicking its own `<summary>`, which is also the only way
 *     the `.disclosure summary::before` marker's `▸`→`▾` flip gets exercised.
 *
 *  3. IT SCANNED ONCE, AT ONE VIEWPORT, AFTER A BEST-EFFORT CLICK STORM.
 *     `clickIfPresent()` did `if ((await loc.count()) > 0)` and then
 *     `.click().catch(() => {})` — so a control that was renamed or removed
 *     skipped SILENTLY instead of failing, and every one of the fourteen clicks
 *     could no-op with the run still green. It then waited a fixed `300ms` and
 *     scanned once, at 1280px, with no assertion that anything had happened.
 *     Whole halves of this lab had never been measured: the abstract-polynomial
 *     branch of FRI, both ends of the two soundness sliders, the trace length of
 *     8, zero-knowledge mode, the verifier's REJECTED report, and the entire
 *     380px column. This drive names every control, asserts every completion
 *     signal, and scans after every step in {dark, light} × {1280, 380}.
 *
 *  4. `violations` IS NOT THE WHOLE ORACLE. See `scan`. Two things on this page
 *     are invisible to a violations-only assertion in particular: nearly every
 *     verdict, chip and badge is a `color-mix(in srgb, var(--ok) 14%,
 *     transparent)` over a translucent `--overlay-*` panel, which axe declines
 *     to resolve and files under `incomplete`; and an `aria-label` on a
 *     role-less element is PROHIBITED and lands in `incomplete` too, never in
 *     `violations`.
 *
 *  5. IT HAD NO REFLOW, KEYBOARD-SCROLLER OR NON-TEXT ORACLE, and this page
 *     needs all three. `.commit-table` carries `min-width: 660px` (520px under
 *     860px) inside a `.table-wrap` that is `overflow-x: auto` and nothing
 *     else — no `tabindex`, no role — so at phone width every one of the five
 *     tables is a scrolling region a keyboard cannot reach (WCAG 2.1.1), and
 *     that is a state a drive has to go to a 380px viewport to find.
 */

/**
 * Wait for every running animation and transition to drain.
 *
 * Transitions drain in waves, not in one batch, so a poll for "nothing running
 * right now" can exit through a gap between waves. Require quiescence to hold
 * for several consecutive frames instead.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __quietFrames?: number };
      const running = document.getAnimations().filter((a) => a.playState === 'running');
      w.__quietFrames = running.length === 0 ? (w.__quietFrames ?? 0) + 1 : 0;
      return w.__quietFrames >= 6;
    },
    undefined,
    { timeout: 20_000, polling: 'raf' }
  );
}

/**
 * Assert that reduced motion left the page visible, not merely un-animated.
 *
 * The failure mode this guards against is an element whose only route to its
 * visible state is an animation, in a stylesheet whose reduced-motion block
 * cancels that animation without restoring its end state — the element then
 * renders at `opacity: 0` for every reader with the preference set.
 *
 * This page cannot currently be in that shape, and the assertion is what makes
 * that a measurement rather than a reading: `css/style.css` contains no
 * `@keyframes` and no `animation` property anywhere, and its reduced-motion
 * block only clamps durations. It carries exactly three `opacity` declarations
 * — `.cl-hero-sub` at `.85`, the decorative `.viz-line` at `.28`, and
 * `.term-def` at `0` — and only the last is a hide, which is paired with
 * `visibility: hidden` so the definition leaves the tab order and the
 * accessibility tree together with the pixels. The check runs in every state
 * regardless, because all of that is a property of the current stylesheet and
 * this is the cheapest place to catch the first exception.
 *
 * `aria-hidden` subtrees are excluded, matching axe's own boundary.
 */
async function expectNotBlank(page: Page, label: string): Promise<void> {
  const invisible = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? '')
        .join('')
        .trim();
      if (!own) continue;
      // Deliberately hidden subtrees are not "blank", they are closed.
      if (!(el as HTMLElement).checkVisibility?.({ checkVisibilityCSS: true })) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      let effective = 1;
      let node: Element | null = el;
      while (node) {
        effective *= parseFloat(getComputedStyle(node).opacity);
        node = node.parentElement;
      }
      if (effective === 0) {
        out.push(`${el.tagName.toLowerCase()}#${el.id}.${(el.getAttribute('class') ?? '').trim()}`);
      }
    }
    return Array.from(new Set(out));
  });
  expect(invisible, `no visible text may render at opacity 0 in state: ${label}`).toEqual([]);
}

/**
 * Uncaught page errors and console errors, collected from the moment the page
 * is created. A renderer that throws halfway through leaves an earlier state on
 * screen, and a gate that scans that state reports green for a page that is
 * broken. Attach before `boot`, assert after the drive.
 */
export function watchPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  return errors;
}

/**
 * Exactly one banner landmark: the shared bar.
 *
 * This page has two `<header>` elements — the shared `.cl-topbar` and the lab's
 * own `.cl-hero`. The hero sits inside `<main class="wrap" id="app">`, which
 * scopes it out of the banner role on its own, and `index.html`'s
 * `dedupeBanner()` skips it for that reason (`el.closest('main, …')` returns
 * early). Asserting the OUTCOME rather than either mechanism means a change to
 * the nesting is caught too.
 */
export async function assertSingleBanner(page: Page): Promise<void> {
  const banners = await page.evaluate(() => {
    const scoped = new Set(['MAIN', 'ARTICLE', 'ASIDE', 'NAV', 'SECTION']);
    const isBanner = (el: Element): boolean => {
      if (el.getAttribute('role') === 'banner') return true;
      if (el.tagName !== 'HEADER') return false;
      if (el.getAttribute('role')) return false; // explicit non-banner role wins
      for (let p = el.parentElement; p; p = p.parentElement) if (scoped.has(p.tagName)) return false;
      return true;
    };
    return [...document.querySelectorAll('header,[role="banner"]')].filter(isBanner).length;
  });
  expect(banners, 'exactly one banner landmark').toBe(1);
}

/**
 * `[hidden]` has specificity (0,1,0) — identical to a class — and it lives in
 * the UA stylesheet, so ANY author `display` declaration beats it and the
 * attribute silently does nothing.
 *
 * This is checked at RUNTIME rather than inferred from the CSS, because
 * inferring it is exactly what makes the bug survive. Two elements on this page
 * rely on the attribute: `#fri-abstract-controls`, which `main.ts` flips
 * whenever the FRI source radio changes, and the legacy `.theme-toggle` button
 * `initThemeToggle()` creates already-`hidden` because the shared top bar
 * replaced it. The second one is the interesting case: `css/style.css` gives
 * `.theme-toggle` a `display: inline-flex`, which DOES beat the UA rule — the
 * button is hidden only because `index.html`'s shared header adds a
 * `display:none!important` for it. So the attribute is genuinely a no-op there,
 * and this assertion is what would catch the day the `!important` moves.
 */
export async function expectHiddenMeansHidden(page: Page, label: string): Promise<void> {
  const notHidden = await page.$$eval('[hidden]', (els) =>
    els
      .filter((e) => getComputedStyle(e).display !== 'none')
      .map(
        (e) =>
          `${e.tagName.toLowerCase()}#${e.id}.${(e.getAttribute('class') ?? '').trim()} → display: ${
            getComputedStyle(e).display
          }`
      )
  );
  expect(
    notHidden,
    `the [hidden] attribute must actually hide, in state: ${label}`
  ).toEqual([]);
}

/**
 * An explicit role on a list REPLACES its implicit `list` role, orphaning every
 * `<li>` and firing axe's `listitem` rule once per child. Worth asking the DOM
 * rather than grepping, because roles arrive here inside `innerHTML` template
 * literals where a markup regex only finds them if it guesses the spelling.
 */
export async function expectNoOrphanedLists(page: Page): Promise<void> {
  const broken = await page.$$eval('ul[role], ol[role]', (els) =>
    els
      .filter((e) => e.getAttribute('role') !== 'list')
      .map(
        (e) =>
          `${e.tagName.toLowerCase()}[role=${e.getAttribute('role')}] with ${e.children.length} children`
      )
  );
  expect(broken, 'an explicit role on a list deletes its list semantics').toEqual([]);
}

/**
 * Load the page in a known theme with reduced motion actually in effect, and
 * assert the content every scan relies on is really on the page — including the
 * lab's DEFAULTS, which are never assumed.
 *
 * `test.use({ reducedMotion })` silently does nothing on Playwright 1.61.1, so
 * the emulation is applied imperatively BEFORE the navigation and then
 * *asserted* from inside the page.
 *
 * The theme is seeded through `localStorage` rather than by clicking the
 * toggle, which also pins down a real failure mode: `index.html`'s anti-flash
 * script reads `localStorage.getItem('theme')` and both the shared bar's toggle
 * and `main.ts`'s legacy toggle write `localStorage.setItem('theme', …)`. If
 * those keys drifted apart the theme would silently stop persisting, and this
 * boot fails on `data-theme` rather than quietly scanning dark twice.
 *
 * The defaults are asserted at length because which half of this lab a
 * single-configuration gate sees depends entirely on them. Every exhibit here
 * renders ITSELF on load — `init()` calls `render()`/`run()` at the end of each
 * `bind*`, so the AIR trace, the quotient division, a full FRI fold, the size
 * table, the soundness calculator, one masked opening and the whole 600-trial
 * masking histogram are all already on screen at first paint, all in their
 * HONEST configuration. Only the end-to-end proof is absent. The old gate
 * clicked through fourteen selectors and then scanned; it never recorded which
 * of these was the shipped state and which was the state it had built.
 */
export async function boot(page: Page, theme: 'dark' | 'light'): Promise<void> {
  // A click on a control that never becomes actionable otherwise burns the
  // whole test timeout and reports nothing useful. 20s turns that silent hang
  // into a named failure naming the locator.
  page.setDefaultTimeout(20_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript((t) => localStorage.setItem('theme', t), theme);
  await page.goto('.');
  expect(
    await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
    'reduced-motion emulation must actually be in effect'
  ).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await assertSingleBanner(page);

  // Every in-page link must resolve. axe's skip-link rule is best-practice, not
  // WCAG-tagged, so `withTags(['wcag2a', …])` never runs it and a dangling
  // `href="#…"` is invisible to a green axe pass — which is how a skip link
  // pointing at nothing survived in a sibling lab in this fleet. Here it also
  // covers the seven exhibit links in the `.toc` nav.
  const dangling = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]'))
      .filter((a) => (a.getAttribute('href') ?? '').length > 1)
      .filter((a) => !document.getElementById((a.getAttribute('href') ?? '').slice(1)))
      .map((a) => `${a.className} -> ${a.getAttribute('href')}`)
  );
  expect(dangling, 'in-page links must resolve to an element that exists').toEqual([]);

  // `src/main.ts` builds every result region, so a navigation that resolves
  // proves nothing.
  await expect(page.locator('section.exhibit')).toHaveCount(8);

  // ── The state every exhibit ships in, all of it already rendered ────────
  await expect(page.locator('#air-n')).toHaveValue('16');
  await expect(page.locator('#air-status')).toHaveClass(/status-ok/);
  await expect(page.locator('#air-trace-table tbody tr')).toHaveCount(16);
  await expect(page.locator('#air-trace-table .trace-bad')).toHaveCount(0);
  await expect(page.locator('#air-constraints')).not.toBeEmpty();

  await expect(page.locator('#q-n')).toHaveValue('16');
  await expect(page.locator('#q-status')).toHaveClass(/status-ok/);
  await expect(page.locator('#q-flow .q-chip-ok').first()).toBeVisible();
  await expect(page.locator('#q-detail')).not.toBeEmpty();

  // FRI ships folding the HONEST quotient from the trace, not the abstract
  // polynomial — so the abstract branch is a state the drive has to build.
  await expect(page.locator('#fri-src-trace')).toBeChecked();
  await expect(page.locator('#fri-src-abstract')).not.toBeChecked();
  await expect(page.locator('#fri-trace-tamper')).not.toBeChecked();
  await expect(page.locator('#fri-tamper')).not.toBeChecked();
  await expect(page.locator('#fri-n')).toHaveValue('16');
  await expect(page.locator('#fri-degree')).toHaveValue('8');
  await expect(page.locator('#fri-trace-controls')).toBeVisible();
  await expect(page.locator('#fri-abstract-controls')).toBeHidden();
  await expect(page.locator('#fri-verdict')).toHaveClass(/verdict-ok/);
  await expect(page.locator('#fri-table tbody tr').first()).toBeVisible();
  await expect(page.locator('#fri-viz svg')).toBeVisible();

  await expect(page.locator('#size-table tbody tr')).toHaveCount(6);
  await expect(page.locator('#size-chart .chart-row')).toHaveCount(6);
  await expect(page.locator('#size-measured')).toContainText('toy proof', { timeout: 60_000 });
  await expect(page.locator('#sec-blowup')).toHaveValue('3');
  await expect(page.locator('#sec-queries')).toHaveValue('32');
  await expect(page.locator('#sec-bits')).toHaveText('96');

  // The one exhibit that ships EMPTY, and the two checkboxes that ship off.
  await expect(page.locator('#e2e-n')).toHaveValue('16');
  await expect(page.locator('#e2e-zk')).not.toBeChecked();
  await expect(page.locator('#e2e-checks')).toBeEmpty();
  await expect(page.locator('#e2e-status')).toHaveText('No proof generated yet.');
  await expect(page.locator('#e2e-transcript')).toContainText('No proof generated yet.');
  await expect(page.locator('#e2e-inspector')).toBeEmpty();

  await expect(page.locator('#zk-one-viz .zk-one-row')).toHaveCount(1);
  await expect(page.locator('#zk-viz .zk-hist')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#zk-stats .sec-stat')).toHaveCount(4);

  // The single disclosure ships SHUT, which is a real state and the one the old
  // gate never scanned.
  await expect(page.locator('details.disclosure')).toHaveCount(1);
  await expect(page.locator('details[open]')).toHaveCount(0);

  await expectHiddenMeansHidden(page, `${theme} first paint`);
  await expectNoOrphanedLists(page);
  await settle(page);
  await expectNotBlank(page, `${theme} first paint`);
}

/**
 * Assert the page does not require horizontal scrolling.
 *
 * WCAG 1.4.10 (Reflow, AA). axe has no rule for this at all, and this page is
 * the shape that breaks it: five `.commit-table`s with a hard `min-width` of
 * 660px (520px below 860px), a two-column `.demo-grid`, a `.chart-row` grid
 * with a fixed 180px first track, a 16-bucket flex histogram and an SVG folding
 * diagram. Each wide block is meant to scroll inside its own `.table-wrap`; the
 * assertion here is that none of them scrolls the DOCUMENT.
 */
export async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    if (doc.scrollWidth <= doc.clientWidth) return null;

    // Only elements that actually push the DOCUMENT sideways are culprits. A
    // wide box inside an `overflow-x: auto` wrapper has a huge bounding rect but
    // is clipped by its scroller and contributes nothing to the document's
    // scroll width — naming it sends you off fixing the wrong element. This page
    // has a 660px decoy behind every `.table-wrap`.
    const clipped = (el: Element): boolean => {
      let n = el.parentElement;
      while (n && n !== doc) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true;
        n = n.parentElement;
      }
      return false;
    };

    // A grid or flex ITEM's automatic minimum size is its min-content, so one
    // wide panel can size the whole page's column while the checker names some
    // innocent descendant. Report the min-content width of every direct child of
    // a grid/flex container alongside the widest box, so the CAUSE is visible.
    const tracks = Array.from(document.querySelectorAll('body *'))
      .filter((el) => {
        const p = el.parentElement;
        if (!p) return false;
        const d = getComputedStyle(p).display;
        return d === 'grid' || d === 'flex' || d === 'inline-grid' || d === 'inline-flex';
      })
      .map((el) => {
        const prev = (el as HTMLElement).style.width;
        (el as HTMLElement).style.width = 'min-content';
        const min = el.getBoundingClientRect().width;
        (el as HTMLElement).style.width = prev;
        return { el, min };
      })
      .filter((x) => x.min > doc.clientWidth)
      .sort((a, b) => b.min - a.min)
      .slice(0, 4)
      .map(
        (x) =>
          `${x.el.tagName.toLowerCase()}${x.el.id ? '#' + x.el.id : ''}` +
          `${x.el.getAttribute('class') ? '.' + x.el.getAttribute('class')!.trim().split(/\s+/).join('.') : ''}` +
          ` min-content=${Math.round(x.min)}px`
      );

    const over = Array.from(document.querySelectorAll('body *'))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter((x) => x.r.width > 0 && x.r.right > doc.clientWidth + 1)
      .sort((a, b) => b.r.right - a.r.right);
    const widest = over.filter((x) => !clipped(x.el))[0] ?? over[0];
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      widest: widest
        ? `${clipped(widest.el) ? '[clipped] ' : ''}${widest.el.tagName.toLowerCase()}${widest.el.id ? '#' + widest.el.id : ''}` +
          `${widest.el.getAttribute('class') ? '.' + widest.el.getAttribute('class')!.trim().split(/\s+/).join('.') : ''}` +
          ` @${Math.round(widest.r.width)}px right=${Math.round(widest.r.right)}`
        : '(none identified)',
      gridItemsOverMinContent: tracks,
    };
  });
  expect(overflow, `page must not scroll horizontally in state: ${label}`).toBeNull();
}

/**
 * Every scrolling container must be operable from the keyboard (WCAG 2.1.1). If
 * it holds no focusable content it needs `tabindex="0"`, so it becomes a focus
 * target arrow keys can then scroll.
 *
 * This lab gets it right for its five `<pre>` regions — every one carries
 * `tabindex="0"` alongside its `role="log"`/`role="region"` — and wrong for its
 * tables, which is exactly the asymmetry an oracle is for: `.table-wrap` is
 * `overflow-x: auto` and nothing else, while `.commit-table` inside it forces
 * `min-width: 660px`. Whether that overflows depends on the viewport, so the
 * failure only exists in a state a drive has to go and build.
 */
export async function expectScrollersReachable(page: Page, label: string): Promise<void> {
  const unreachable = await page.evaluate(() => {
    const FOCUSABLE = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';
    return Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
      .filter((el) => {
        const cs = getComputedStyle(el);
        return (
          ['auto', 'scroll'].includes(cs.overflowX) || ['auto', 'scroll'].includes(cs.overflowY)
        );
      })
      .filter((el) => el.tabIndex < 0 && !el.querySelector(FOCUSABLE))
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}#${el.id}.${(el.getAttribute('class') ?? '').trim()}` +
          ` (${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight})`
      );
  });
  expect(
    Array.from(new Set(unreachable)),
    `scrolling regions with no keyboard route in state: ${label}`
  ).toEqual([]);
}

/**
 * Anything given `tabindex="0"` needs a visible focus indicator (WCAG 2.4.7).
 *
 * This is here because the FIX for the 2.1.1 failure above is to make each
 * `.table-wrap` focusable, and a pass that makes several regions focusable and
 * leaves them all without a focus ring has introduced a defect while closing
 * one — which happened elsewhere in this sweep.
 *
 * `:focus-visible` is PRIMED with a real `Tab` press first. Chromium only
 * applies focus-visible styling after keyboard interaction, so an unprimed
 * programmatic `.focus()` reports the unfocused style and invents one phantom
 * failure per region.
 */
export async function expectFocusVisibleIndicator(page: Page, selector: string): Promise<void> {
  // Prime: a real keyboard interaction, then drop focus again.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.keyboard.press('Tab');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());

  const missing = await page.$$eval(selector, (els) =>
    els
      .filter((el) => (el as HTMLElement).checkVisibility?.())
      // Only elements that can actually TAKE focus. An element with no
      // `tabindex` never receives it, so `.focus()` is a no-op and the before /
      // after styles are trivially identical — which reads as "no focus
      // indicator" and is really "not focusable", a different fact belonging to
      // `expectScrollersReachable`.
      .filter((el) => (el as HTMLElement).tabIndex >= 0)
      .map((el) => {
        const before = getComputedStyle(el);
        const idle = `${before.outlineStyle}|${before.outlineWidth}|${before.boxShadow}|${before.borderColor}`;
        (el as HTMLElement).focus();
        const after = getComputedStyle(el);
        const focused = `${after.outlineStyle}|${after.outlineWidth}|${after.boxShadow}|${after.borderColor}`;
        (el as HTMLElement).blur();
        return idle === focused
          ? `${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').trim()} — focus changes nothing (${idle})`
          : '';
      })
      .filter(Boolean)
  );
  expect(
    Array.from(new Set(missing)),
    `every focusable region needs a visible focus indicator (2.4.7): ${selector}`
  ).toEqual([]);
}

/**
 * When `A11Y_COLLECT` is set, `scan` records failures instead of throwing.
 *
 * A strict gate reports the first failing assertion in the first failing state
 * and stops, so a page with defects in several states needs one full run per
 * defect to enumerate them. The collection pass turns that into a single run.
 * It is a debugging aid only: `A11Y_COLLECT` is never set in CI, and a run with
 * it set prints every finding as it happens and then FAILS at the end, so a
 * green collection run cannot be mistaken for a green gate.
 */
const COLLECTING = !!process.env.A11Y_COLLECT;
const collected: string[] = [];

function record(entry: string): void {
  collected.push(entry);
  // Printed as it happens, not only at the end: a hard assertion later in the
  // drive would otherwise abort the test before anything collected so far was
  // ever shown.
  console.log(`\n[A11Y_COLLECT #${collected.length}] ${entry}`);
}

export function softExpect(actual: unknown, message: string, expected: unknown): void {
  if (!COLLECTING) {
    expect(actual, message).toEqual(expected);
    return;
  }
  try {
    expect(actual, message).toEqual(expected);
  } catch {
    record(`${message}\n  ${JSON.stringify(actual, null, 2)}`);
  }
}

/**
 * Fail the test if the collection pass recorded anything. Without this a
 * collection run would end green, and a green collection run is
 * indistinguishable from a green gate — which is the exact confusion the whole
 * exercise exists to remove.
 */
export function reportCollected(): void {
  if (!COLLECTING) return;
  expect(collected, `A11Y_COLLECT recorded ${collected.length} failure(s)`).toEqual([]);
}

async function expectScrollersReachableSoft(page: Page, label: string): Promise<void> {
  if (!COLLECTING) return expectScrollersReachable(page, label);
  try {
    await expectScrollersReachable(page, label);
  } catch (e) {
    record(String(e).slice(0, 6000));
  }
}

/**
 * The 1.4.11 ratchet, soft-wrapped the same way as every other oracle here.
 *
 * It is called from `scan()`. In the fleet reference gate this was copied from
 * it was reachable only from inside `expectScrollersReachableSoft`, AFTER that
 * function's `if (!COLLECTING) return …` guard — so in a strict run, which is
 * every run anyone reads as a pass, the guard returned first and `nontext.ts`
 * never executed at all. Calling it here means it runs in every driven state,
 * in both themes, at both widths.
 */
async function expectNoNewNonTextFailuresSoft(page: Page, label: string): Promise<void> {
  if (!COLLECTING) return expectNoNewNonTextFailures(page, label);
  try {
    await expectNoNewNonTextFailures(page, label);
  } catch (e) {
    record(String(e).slice(0, 6000));
  }
}

async function expectNoHorizontalOverflowSoft(page: Page, label: string): Promise<void> {
  if (!COLLECTING) return expectNoHorizontalOverflow(page, label);
  try {
    await expectNoHorizontalOverflow(page, label);
  } catch (e) {
    record(String(e).slice(0, 6000));
  }
}

/**
 * WCAG 1.4.11 and generated content, ratcheted against a per-repo baseline.
 *
 * Neither class has ANY other oracle: axe has no rule for non-text contrast,
 * and the arithmetic text walk cannot reach a control's boundary or a
 * `::before` glyph, because a pseudo-element is not an element and owns no text
 * node. This page has both kinds live — every `.bs`/`.num-input` boundary, and
 * `.disclosure summary::before`, the `▸`/`▾` marker that is the ONLY affordance
 * on the one disclosure, because the same rule sets `list-style: none` and
 * hides `::-webkit-details-marker`.
 *
 * The backlog is real, so this does not block on it — but a check that merely
 * logs is not a gate. So it ratchets instead: anything NOT in the baseline
 * fails, anything in the baseline that got WORSE fails, and anything in the
 * baseline that has been FIXED fails until its entry is deleted. That last rule
 * is what stops the allowlist becoming a permanent exemption.
 */
const nonTextSeen = new Set<string>();

export async function expectNoNewNonTextFailures(page: Page, label: string): Promise<void> {
  const found = await auditNonText(page);
  // Capture mode: emit every finding and assert nothing, so a baseline can be
  // generated by the SAME path that checks it.
  if (process.env.NT_BASELINE_CAPTURE) {
    for (const f of found) {
      console.log(
        `NTCAP|${f.kind}|${f.selector}|${f.ratio}|${f.required}|${/POSITIONED/.test(f.detail)}`
      );
    }
    return;
  }
  const problems: string[] = [];
  for (const f of found) {
    const key = `${f.kind}|${f.selector}`;
    nonTextSeen.add(key);
    const base = NONTEXT_BASELINE[key];
    if (!base) {
      problems.push(
        `NEW ${f.ratio}:1 (needs ${f.required}:1) [${f.kind}] ${f.selector} — ${f.detail}`
      );
    } else if (f.ratio < base.ratio - 0.01) {
      problems.push(`WORSE ${f.selector}: ${f.ratio}:1, baseline recorded ${base.ratio}:1`);
    }
  }
  expect(problems, `new or worsened non-text contrast in state: ${label}`).toEqual([]);
}

/**
 * Fail if a baselined finding never appeared during the whole drive.
 *
 * It has either been fixed — in which case delete the entry, which is the point
 * — or the drive stopped reaching the state that shows it, which is a coverage
 * regression worth knowing about. Call once, after `driveAllStates`.
 */
export function expectBaselineNotStale(): void {
  const unseen = Object.keys(NONTEXT_BASELINE).filter((k) => !nonTextSeen.has(k));
  expect(
    unseen,
    'baselined non-text findings that no longer appear — delete them from nontext-baseline.ts (or restore the drive state that showed them)'
  ).toEqual([]);
}

/**
 * Scan the page as it currently stands.
 *
 * Seven assertions, because axe's `violations` array alone is not a complete
 * oracle:
 *
 *  - reduced-motion end state — see `expectNotBlank`.
 *  - `violations` — the usual WCAG A/AA rule failures, plus four landmark
 *    best-practice rules `withTags` does not run on its own.
 *  - `incomplete` — axe's "could not decide" bucket, which never reaches the
 *    violations array. The one rule id allowed to remain incomplete is
 *    `color-contrast`, and only because the next assertion computes those
 *    ratios arithmetically — which matters more here than in most labs, since
 *    every verdict, chip, badge and callout surface on this page is a
 *    `color-mix(in srgb, …)` over a translucent `--overlay-*` panel that axe
 *    declines to resolve. Everything else in that bucket is a real result axe
 *    simply could not finish — including `aria-prohibited-attr`, which is where
 *    an `aria-label` on a role-less element hides, a defect that never reaches
 *    the violations array at all.
 *  - arithmetic contrast — composite-aware WCAG 1.4.3 over every text node.
 *  - non-text contrast and generated content — SC 1.4.11, which axe has no rule
 *    for; see `nontext.ts`.
 *  - keyboard reachability of scrolling regions — WCAG 2.1.1.
 *  - reflow — WCAG 1.4.10, which axe has no rule for at all.
 */
export async function scan(page: Page, label: string): Promise<void> {
  await settle(page);
  await expectNotBlank(page, label);
  await expectHiddenMeansHidden(page, label);
  // TWO axe runs, deliberately, and this is not a style choice.
  //
  // `AxeBuilder.withTags()` and `AxeBuilder.withRules()` both write the same
  // `options.runOnly` field, so the second call SILENTLY REPLACES the first —
  // the axe-core/playwright source says so in as many words on `withRules`
  // ("Cannot be used with AxeBuilder#withTags"). Chained as
  // `.withTags(TAGS).withRules([...4 landmark rules])`, axe therefore runs
  // those FOUR best-practice rules and NOT ONE WCAG RULE, while a green result
  // reads exactly like a full A/AA pass. For scale, `withTags(TAGS)` selects 69
  // of axe-core 4.12's 105 rule definitions.
  //
  // Running the two sets separately and merging is the only way to have both.
  // The landmark four are still wanted because they are best-practice rather
  // than WCAG-tagged, so `withTags` alone does not reach them, and this page
  // has the shape they catch: a shared sticky <header role="banner"> above a
  // <main> that contains a second <header> with an <aside role="complementary">
  // inside it.
  const wcag = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const landmarks = await new AxeBuilder({ page })
    .withRules([
      'landmark-no-duplicate-banner',
      'landmark-unique',
      'landmark-one-main',
      'landmark-complementary-is-top-level',
    ])
    .analyze();
  const results = {
    violations: [...wcag.violations, ...landmarks.violations],
    incomplete: [...wcag.incomplete, ...landmarks.incomplete],
  };

  const violations = results.violations.map((v) => ({
    state: label,
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 8),
  }));
  softExpect(violations, `axe violations in state: ${label}`, []);

  const unexplainedIncomplete = results.incomplete
    .filter((v) => v.id !== 'color-contrast')
    .map((v) => ({
      state: label,
      id: v.id,
      nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 8),
    }));
  softExpect(unexplainedIncomplete, `axe incomplete results in state: ${label}`, []);

  const contrast = Array.from(new Set(formatContrastFailures(await auditContrast(page))));
  softExpect(contrast, `measured contrast failures in state: ${label}`, []);

  await expectNoNewNonTextFailuresSoft(page, label);
  await expectScrollersReachableSoft(page, label);
  await expectNoHorizontalOverflowSoft(page, label);
}

// ── The drive ───────────────────────────────────────────────────────────────

/**
 * Drive the lab through the states that render content, scanning each.
 *
 * Six things shape this drive:
 *
 *  - THE SHIPPED STATE IS SCANNED FIRST, AND IT IS ASSERTED, NOT ASSUMED. Every
 *    exhibit renders itself on load in its HONEST configuration, so first paint
 *    is a page of passing verdicts. Which half a one-shot gate measures depends
 *    entirely on that, and the old gate never wrote it down.
 *
 *  - BOTH OUTCOMES OF EVERY VERDICT. The AIR residuals, the quotient division,
 *    the FRI fold and the end-to-end verifier each render an ACCEPT and a
 *    REJECT rendering, in different inks on different tinted surfaces
 *    (`--ok`/`--err` at 12–18% over a translucent panel), and only the honest
 *    one exists until something is tampered. Each is driven both ways.
 *
 *  - THE BRANCH ONLY ONE CONTROL REACHES. `#fri-src-abstract` is the only route
 *    to `#fri-abstract-controls`, which ships behind the `hidden` attribute —
 *    a whole sub-panel, two controls and a distinct FRI result that the old
 *    gate clicked past. `#e2e-zk` is the only route to the masked proof.
 *
 *  - BOTH ENDS OF EVERY RANGE. The two soundness sliders are driven to their
 *    minimum and maximum, because the numbers they print change length by an
 *    order of magnitude (`1 in 2` versus `1 in 1.5 × 10^72`) and because the
 *    minimum is the only state where the calculator's prose reads "1 bit".
 *    Every `<select>` is driven to its other option too.
 *
 *  - THE DISCLOSURE IS OPENED BY CLICKING ITS SUMMARY, never by setting
 *    `.open`. That is the only way the `::before` marker flip is exercised, and
 *    the marker is the sole affordance because the same rule removes the UA
 *    triangle.
 *
 *  - NO FIXED TIMEOUTS. Every exhibit has a DOM completion signal: a verdict
 *    class changing, a status line's text, a table's row count, a histogram
 *    appearing. The drive waits on those. The old gate waited 300ms and hoped.
 */
export async function driveAllStates(page: Page, theme: string): Promise<void> {
  const scanAt = (s: string): Promise<void> => scan(page, `${theme} / ${s}`);

  await scanAt('first paint, every exhibit rendered honest and no proof yet');

  // The skip link is the first focusable element on the page, and the only
  // state in which it paints at all.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.keyboard.press('Tab');
  await expect(page.locator('a.cl-skip-link')).toBeFocused();
  await scanAt('shared skip link focused');

  // ── Exhibit 02: AIR, both outcomes and both trace lengths ───────────────
  await page.click('#air-tamper');
  await expect(page.locator('#air-status')).toHaveClass(/status-bad/);
  await expect(page.locator('#air-trace-table .trace-bad')).toHaveCount(1);
  await expect(page.locator('#air-constraints')).toContainText('VIOLATED');
  await scanAt('AIR trace tampered, a residual violated');

  await page.click('#air-check');
  await expect(page.locator('#air-status')).toHaveClass(/status-bad/);
  await scanAt('AIR constraints re-checked on the tampered trace');

  await page.click('#air-generate-trace');
  await expect(page.locator('#air-status')).toHaveClass(/status-ok/);
  await expect(page.locator('#air-trace-table .trace-bad')).toHaveCount(0);
  await scanAt('AIR trace regenerated honest');

  await page.selectOption('#air-n', '8');
  await expect(page.locator('#air-trace-table tbody tr')).toHaveCount(8);
  await scanAt('AIR at the shorter 8-row trace');
  await page.selectOption('#air-n', '16');
  await expect(page.locator('#air-trace-table tbody tr')).toHaveCount(16);

  // ── Exhibit 02·5: the quotient, both outcomes ───────────────────────────
  await page.click('#q-tamper');
  await expect(page.locator('#q-status')).toHaveClass(/status-bad/);
  await expect(page.locator('#q-flow .q-chip-bad').first()).toBeVisible();
  await expect(page.locator('#q-detail')).not.toBeEmpty();
  await scanAt('quotient division on the tampered trace, nonzero remainder');

  await page.selectOption('#q-n', '8');
  await expect(page.locator('#q-detail')).not.toBeEmpty();
  await scanAt('quotient at the shorter trace, still rejecting');
  await page.selectOption('#q-n', '16');

  await page.click('#q-honest');
  await expect(page.locator('#q-status')).toHaveClass(/status-ok/);
  await expect(page.locator('#q-flow .q-chip-ok').first()).toBeVisible();
  await scanAt('quotient division clean on the honest trace');

  // ── Exhibit 03: FRI, both sources and both outcomes ─────────────────────
  await page.check('#fri-trace-tamper');
  await expect(page.locator('#fri-verdict')).toHaveClass(/verdict-bad/);
  await expect(page.locator('#fri-verdict')).toContainText('NOT LOW DEGREE');
  await expect(page.locator('#fri-viz .viz-dot-bad').first()).toBeVisible();
  await scanAt('FRI folding the tampered quotient, final layer not constant');

  await page.uncheck('#fri-trace-tamper');
  await expect(page.locator('#fri-verdict')).toHaveClass(/verdict-ok/);
  await expect(page.locator('#fri-viz .viz-dot-ok').first()).toBeVisible();
  await scanAt('FRI back on the honest quotient, collapsed to a constant');

  // The abstract branch: a whole sub-panel behind the `hidden` attribute that
  // only this radio reveals.
  await page.check('#fri-src-abstract');
  await expect(page.locator('#fri-abstract-controls')).toBeVisible();
  await expect(page.locator('#fri-trace-controls')).toBeHidden();
  await expect(page.locator('#fri-status')).toContainText('abstract polynomial');
  await scanAt('FRI switched to the abstract polynomial source');

  await page.check('#fri-tamper');
  await expect(page.locator('#fri-verdict')).toHaveClass(/verdict-bad/);
  await scanAt('FRI on an abstract polynomial with an injected high-degree term');

  await page.uncheck('#fri-tamper');
  await page.selectOption('#fri-degree', '16');
  await expect(page.locator('#fri-verdict')).toHaveClass(/verdict-ok/);
  await scanAt('FRI on the highest abstract degree, still low degree');

  await page.check('#fri-src-trace');
  await expect(page.locator('#fri-trace-controls')).toBeVisible();
  await expect(page.locator('#fri-abstract-controls')).toBeHidden();
  await page.selectOption('#fri-n', '8');
  await expect(page.locator('#fri-verdict')).toHaveClass(/verdict-ok/);
  await scanAt('FRI back on the trace at the shorter length');
  await page.selectOption('#fri-n', '16');
  await page.click('#fri-run');
  await expect(page.locator('#fri-verdict')).toHaveClass(/verdict-ok/);

  // ── Exhibit 04: both ends of both soundness sliders ─────────────────────
  await page.locator('#sec-blowup').fill('1');
  await page.locator('#sec-queries').fill('1');
  await expect(page.locator('#sec-blowup-val')).toHaveText('2');
  await expect(page.locator('#sec-queries-val')).toHaveText('1');
  await expect(page.locator('#sec-bits')).toHaveText('1');
  await expect(page.locator('#sec-cheat')).toContainText('1 in');
  await scanAt('soundness calculator at its weakest, 1 bit');

  await page.locator('#sec-blowup').fill('6');
  await page.locator('#sec-queries').fill('80');
  await expect(page.locator('#sec-blowup-val')).toHaveText('64');
  await expect(page.locator('#sec-queries-val')).toHaveText('80');
  await expect(page.locator('#sec-bits')).toHaveText('480');
  await scanAt('soundness calculator at its strongest, 480 bits');

  await page.locator('#sec-blowup').fill('3');
  await page.locator('#sec-queries').fill('32');
  await expect(page.locator('#sec-bits')).toHaveText('96');

  // ── Exhibit 05: prove, verify, corrupt, and zero-knowledge mode ─────────
  await page.click('#e2e-prove');
  await expect(page.locator('#e2e-status')).toContainText('Proof generated for n=16', {
    timeout: 120_000,
  });
  await expect(page.locator('#e2e-transcript')).not.toBeEmpty();
  await expect(page.locator('#e2e-succinct .sec-stat')).toHaveCount(3);
  await expect(page.locator('#e2e-inspector')).toContainText('Query #0');
  await scanAt('proof generated, transcript and succinctness panels populated');

  await page.click('#e2e-verify');
  await expect(page.locator('#e2e-checks .verdict-ok')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('#e2e-checks .check-pass').first()).toBeVisible();
  await expect(page.locator('#e2e-status')).toHaveText('Verification ACCEPTED.');
  await scanAt('verifier ACCEPTED, every check passing');

  await page.click('#e2e-corrupt');
  await expect(page.locator('#e2e-status')).toContainText('TAMPERED trace', { timeout: 120_000 });
  await scanAt('proof rebuilt for a corrupted trace, not yet verified');

  await page.click('#e2e-verify');
  await expect(page.locator('#e2e-checks .verdict-bad')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('#e2e-checks .check-fail').first()).toBeVisible();
  await expect(page.locator('#e2e-status')).toContainText('REJECTED');
  await scanAt('verifier REJECTED, the failing check rendered beside the passing ones');

  await page.check('#e2e-zk');
  await page.click('#e2e-prove');
  await expect(page.locator('#e2e-status')).toContainText('zero-knowledge: trace masked', {
    timeout: 120_000,
  });
  await page.click('#e2e-verify');
  await expect(page.locator('#e2e-checks .verdict-ok')).toBeVisible({ timeout: 120_000 });
  await scanAt('zero-knowledge mode: the masked proof still verifies');

  await page.selectOption('#e2e-n', '8');
  await page.click('#e2e-prove');
  await expect(page.locator('#e2e-status')).toContainText('n=8', { timeout: 120_000 });
  await page.click('#e2e-verify');
  await expect(page.locator('#e2e-checks .verdict-ok')).toBeVisible({ timeout: 120_000 });
  await scanAt('the shorter trace proved and verified under masking');
  await page.uncheck('#e2e-zk');

  // ── Exhibit 05·ZK: the masking experiment ───────────────────────────────
  for (let i = 2; i <= 4; i++) {
    await page.click('#zk-one');
    await expect(page.locator('#zk-one-viz .zk-one-row')).toHaveCount(i);
  }
  await expect(page.locator('#zk-one-note')).toContainText('openings so far');
  await scanAt('four masked openings of the same point, the secret unmoved');

  await page.click('#zk-run');
  await expect(page.locator('#zk-note')).toContainText('fresh-randomness runs', {
    timeout: 120_000,
  });
  await expect(page.locator('#zk-viz .zk-hist')).toBeVisible();
  await scanAt('masking experiment re-run against the witness-free simulator');

  // ── The one disclosure, opened through its own summary ──────────────────
  const disclosure = page.locator('details.disclosure');
  await disclosure.locator('summary').click();
  await expect(disclosure).toHaveAttribute('open', '');
  await expect(page.locator('.disclosure-body')).toBeVisible();
  await scanAt('the production-STARK disclosure open');

  // ── A glossary term, reached the way a keyboard reader reaches it ───────
  const term = page.locator('.term').first();
  await term.focus();
  await expect(term.locator('.term-def')).toBeVisible();
  await scanAt('an inline term definition open on keyboard focus');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());

  // Every region this repo makes focusable must show that it is focused.
  await expectFocusVisibleIndicator(page, '.table-wrap, pre.log');

  await scanAt('the finished page, every exhibit driven');
}
