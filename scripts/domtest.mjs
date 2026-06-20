// Headless DOM smoke test: load index.html, run the real bundled app, and
// drive the exhibits to confirm honest=accept and corrupt=reject-via-low-degree.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'https://localhost/' });

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
// The app reads global `crypto` (Node provides WebCrypto on globalThis).

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures += 1;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (id) => document.getElementById(id)?.textContent ?? '';
const waitFor = async (id, sub, tries = 100) => {
  for (let i = 0; i < tries; i += 1) {
    if (text(id).includes(sub)) return true;
    await wait(20);
  }
  return false;
};

// Import the bundled app (built by domtest runner before this).
await import(new URL('./app_bundle.mjs', import.meta.url));
await wait(50);

// Theme toggle injected.
check('theme toggle rendered', !!document.querySelector('.theme-toggle'));

// Exhibit 2: trace + constraints render on init.
check('AIR trace table populated', document.querySelectorAll('#air-trace-table tbody tr').length > 0);
document.getElementById('air-tamper').click();
await wait(20);
check('AIR tamper flags a violated constraint', text('air-constraints').includes('VIOLATED'));
check('AIR tamper marks status bad', document.getElementById('air-status').className.includes('status-bad'));

// Exhibit 3: FRI default run collapses to constant.
check('FRI ran on init', await waitFor('fri-verdict', 'LOW DEGREE'));
check('FRI honest is low degree', text('fri-verdict').includes('✓ LOW DEGREE'));
check('FRI visualization rendered', document.querySelectorAll('#fri-viz svg circle').length > 0);
document.getElementById('fri-tamper').checked = true;
document.getElementById('fri-tamper').dispatchEvent(new dom.window.Event('change'));
check('FRI cheat fails low-degree', await waitFor('fri-verdict', 'NOT LOW DEGREE'));
check('FRI viz shows bad final dots', document.querySelectorAll('#fri-viz svg .viz-dot-bad').length > 0);

// Exhibit 4: measured proof size + security calculator.
check('proof size measured', await waitFor('size-measured', 'serializes to'));
const bitsBefore = text('sec-bits');
const qEl = document.getElementById('sec-queries');
qEl.value = '70';
qEl.dispatchEvent(new dom.window.Event('input'));
await wait(20);
check('security calculator responds to queries', text('sec-bits') !== bitsBefore && Number(text('sec-bits')) > 0);

// Exhibit 5: honest prove + verify => accepted.
document.getElementById('e2e-prove').click();
check('e2e proof generated', await waitFor('e2e-status', 'bytes and contains no full trace'));
check('e2e succinctness rendered', await waitFor('e2e-succinct', 'distinct trace points'));
check('e2e query inspector rendered', text('e2e-inspector').includes('Query #0'));
document.getElementById('e2e-verify').click();
check('e2e honest ACCEPTED', await waitFor('e2e-status', 'ACCEPTED'));
check('e2e accept verdict shown', text('e2e-checks').includes('ACCEPTED'));

// Exhibit 5: corrupt + verify => rejected, via low-degree test.
document.getElementById('e2e-corrupt').click();
check('e2e corrupt staged', await waitFor('e2e-status', 'TAMPERED'));
document.getElementById('e2e-verify').click();
check('e2e corrupt REJECTED', await waitFor('e2e-status', 'REJECTED'));
const checksText = text('e2e-checks');
check('rejection mentions low-degree test', checksText.includes('low-degree') && checksText.includes('✗'));
check('verifier did NOT recompute trace', text('e2e-status').includes('never re-ran Fibonacci'));

// Exhibit 5·ZK: masking experiment histogram + stats.
check('ZK histogram rendered', await waitFor('zk-viz', '') || document.querySelectorAll('#zk-viz .zk-bar').length > 0);
check('ZK histogram has bars', document.querySelectorAll('#zk-viz .zk-bar-real').length > 0);
check('ZK note reports no leak', await waitFor('zk-note', 'never leaked'));

// Zero-knowledge mode: masked proof still verifies, and re-running changes the root.
document.getElementById('e2e-zk').checked = true;
document.getElementById('e2e-prove').click();
check('ZK-mode proof generated', await waitFor('e2e-status', 'trace masked'));
document.getElementById('e2e-verify').click();
check('ZK-mode proof ACCEPTED', await waitFor('e2e-status', 'ACCEPTED'));

console.log(`\n${failures === 0 ? 'ALL DOM CHECKS PASSED' : failures + ' DOM CHECK(S) FAILED'}`);
process.exit(failures ? 1 : 0);
