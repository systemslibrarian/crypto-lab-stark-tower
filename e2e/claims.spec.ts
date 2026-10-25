import { expect, test, type Page } from '@playwright/test';

/**
 * Functional claims gate for STARK Tower.
 *
 * The a11y suite proves the page is reachable; this suite proves it is TRUE.
 * Every headline verdict, counter and failure path is driven in a real browser
 * and checked against a value re-derived here — the Fibonacci trace and its AIR
 * residuals, the quotient identity Q(x)*Z(x) = C(x) at the sampled points, the
 * FRI domain-halving schedule and query payload, the query index chain through
 * every fold, and the query-model/size arithmetic of the calculator. Nothing is
 * asserted by matching a copied string where a number can be recomputed.
 */

const P = 3n * 2n ** 30n + 1n; // 3*2^30 + 1 = 3221225473, the STARK-101 field

function fmod(a: bigint): bigint {
  return ((a % P) + P) % P;
}

/** The Fibonacci trace the AIR exhibit claims to build. */
function fibTrace(n: number): bigint[] {
  const t: bigint[] = [1n, 1n];
  for (let i = 2; i < n; i += 1) t.push(fmod(t[i - 1] + t[i - 2]));
  return t.slice(0, n);
}

function nums(text: string): number[] {
  return (text.match(/\d[\d,]*/g) ?? []).map((s) => Number(s.replace(/,/g, '')));
}

function numAfter(text: string, label: string | RegExp): number {
  const src = typeof label === 'string' ? label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : label.source;
  const hit = new RegExp(`${src}[^0-9]*(\\d[\\d,]*)`).exec(text);
  expect(hit, `expected a number after ${String(label)} in: ${text}`).not.toBeNull();
  return Number(hit![1].replace(/,/g, ''));
}

/** "1 in 16.8 million" / "1 in 7.9 × 10^28" -> log10 of the odds. */
function oneInLog10(text: string): number {
  const sci = /1 in ([\d.]+) × 10\^(\d+)/.exec(text);
  if (sci) return Math.log10(Number(sci[1])) + Number(sci[2]);
  const scales: Record<string, number> = {
    thousand: 3, million: 6, billion: 9, trillion: 12, quadrillion: 15, quintillion: 18,
  };
  const named = /1 in ([\d.,]+)\s*(thousand|million|billion|trillion|quadrillion|quintillion)?/.exec(text);
  expect(named, `unparseable odds: ${text}`).not.toBeNull();
  return Math.log10(Number(named![1].replace(/,/g, ''))) + (named![2] ? scales[named![2]] : 0);
}

/** Blank a live region so what we wait for must have been written by this run. */
async function blank(page: Page, ...ids: string[]): Promise<void> {
  await page.evaluate((list) => {
    for (const id of list) {
      const el = document.getElementById(id);
      if (el) el.textContent = '';
    }
  }, ids);
}

async function setSelect(page: Page, id: string, value: string): Promise<void> {
  await page.locator(`#${id}`).selectOption(value);
}

async function setRange(page: Page, id: string, value: number): Promise<void> {
  await page.locator(`#${id}`).evaluate((el, v) => {
    const input = el as HTMLInputElement;
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

interface TraceRow { i: number; value: bigint; status: string; }

async function readTrace(page: Page): Promise<TraceRow[]> {
  const raw = await page.locator('#air-trace-table tbody tr').evaluateAll((rows) =>
    rows.map((r) => Array.from(r.querySelectorAll('td')).map((td) => td.textContent ?? '')),
  );
  return raw.map((cells) => ({ i: Number(cells[0]), value: BigInt(cells[1]), status: cells[2].trim() }));
}

interface Residual { i: number; value: bigint; violated: boolean; }

async function readResiduals(page: Page): Promise<Residual[]> {
  const text = await page.locator('#air-constraints').innerText();
  const out: Residual[] = [];
  for (const line of text.split('\n')) {
    const hit = /C\(\s*(\d+)\)\s*=\s*(\d+)/.exec(line);
    if (hit) out.push({ i: Number(hit[1]), value: BigInt(hit[2]), violated: line.includes('VIOLATED') });
  }
  return out;
}

interface FriRow { round: number; size: number; degree: number; }

async function readFriTable(page: Page): Promise<FriRow[]> {
  const raw = await page.locator('#fri-table tbody tr').evaluateAll((rows) =>
    rows.map((r) => Array.from(r.querySelectorAll('td')).map((td) => td.textContent ?? '')),
  );
  return raw.map((c) => ({ round: Number(c[0]), size: Number(c[1]), degree: Number(c[2]) }));
}

/**
 * Re-run FRI for the current control state and wait for a fresh verdict.
 * Changing a control also triggers a run, so first wait for any in-flight fold
 * to land (the status leaves "Folding…" only when it finishes), then blank the
 * verdict so what we read back was written by our own run.
 */
async function runFri(page: Page): Promise<string> {
  await expect(page.locator('#fri-status')).not.toHaveText('Folding…', { timeout: 30_000 });
  await blank(page, 'fri-verdict');
  await page.locator('#fri-run').click();
  await expect(page.locator('#fri-verdict')).toContainText(/FINAL-CODE MEMBERSHIP/, { timeout: 30_000 });
  await expect(page.locator('#fri-status')).not.toHaveText('Folding…');
  return page.locator('#fri-verdict').innerText();
}

test.beforeEach(async ({ page }) => {
  await page.goto('.');
  await expect(page.locator('#air-trace-table tbody tr').first()).toBeVisible();
});

// ════════════ Exhibit 2 — AIR ════════════

test('AIR: the rendered trace is the Fibonacci sequence, and its residuals are recomputed from it', async ({ page }) => {
  for (const n of ['8', '16']) {
    await setSelect(page, 'air-n', n);
    const rows = await readTrace(page);
    expect(rows).toHaveLength(Number(n));
    expect(rows.map((r) => r.value)).toEqual(fibTrace(Number(n)));
    expect(rows[0].status).toBe('boundary');
    expect(rows[1].status).toBe('boundary');
    expect(rows.slice(2).every((r) => r.status === 'derived')).toBe(true);

    // Every printed residual C(i) must equal t[i+2] − t[i+1] − t[i] over F_p,
    // computed from the values the table itself shows.
    const res = await readResiduals(page);
    expect(res).toHaveLength(Number(n) - 2);
    for (const r of res) {
      expect(r.value, `C(${r.i})`).toBe(fmod(rows[r.i + 2].value - rows[r.i + 1].value - rows[r.i].value));
      expect(r.value).toBe(0n);
      expect(r.violated).toBe(false);
    }

    const status = await page.locator('#air-status').innerText();
    expect(status).toContain('Valid trace');
    expect(numAfter(status, 'degree'), 'the interpolant of n points has degree < n').toBeLessThan(Number(n));
    await expect(page.locator('#air-status')).toHaveClass(/status-ok/);
  }
});

test('AIR: tampering one row makes exactly the residuals that touch it nonzero', async ({ page }) => {
  for (const n of ['8', '16']) {
    await setSelect(page, 'air-n', n);
    await page.locator('#air-tamper').click();
    const size = Number(n);
    const row = Math.floor(size / 2);

    const rows = await readTrace(page);
    const honest = fibTrace(size);
    expect(rows.filter((r) => r.status === 'tampered').map((r) => r.i)).toEqual([row]);
    expect(rows[row].value, 'the tampered cell is off by one').toBe(fmod(honest[row] + 1n));
    for (const r of rows) if (r.i !== row) expect(r.value).toBe(honest[r.i]);

    // A single altered cell appears in the three residuals that reference it.
    const res = await readResiduals(page);
    const expectViolated = res
      .filter((r) => r.i === row || r.i + 1 === row || r.i + 2 === row)
      .map((r) => r.i);
    expect(res.filter((r) => r.violated).map((r) => r.i)).toEqual(expectViolated);
    expect(expectViolated.length).toBeGreaterThan(0);
    for (const r of res) {
      expect(r.value, `C(${r.i})`).toBe(fmod(rows[r.i + 2].value - rows[r.i + 1].value - rows[r.i].value));
      expect(r.violated).toBe(r.value !== 0n);
    }

    await expect(page.locator('#air-status')).toHaveClass(/status-bad/);
    await expect(page.locator('#air-status')).toContainText('VIOLATED');

    // Regenerating the trace clears the tamper.
    await page.locator('#air-generate-trace').click();
    await expect(page.locator('#air-status')).toHaveClass(/status-ok/);
    expect((await readResiduals(page)).every((r) => r.value === 0n)).toBe(true);
  }
});

// ════════════ Exhibit 2.5 — the constraint quotient ════════════

interface Samples { c: bigint; z: bigint; q: bigint; }

async function readSamples(page: Page): Promise<Samples[]> {
  const text = await page.locator('#q-detail').innerText();
  const out: Samples[] = [];
  for (const line of text.split('\n')) {
    const hit = /C\(x\)=(\d+)\s+Z\(x\)=(\d+)\s+Q=C\/Z=(\d+)/.exec(line);
    if (hit) out.push({ c: BigInt(hit[1]), z: BigInt(hit[2]), q: BigInt(hit[3]) });
  }
  return out;
}

test('quotient: the honest trace divides cleanly and Q has the degree the flow claims', async ({ page }) => {
  for (const n of ['8', '16']) {
    await setSelect(page, 'q-n', n);
    await page.locator('#q-honest').click();
    const size = Number(n);

    const flow = await page.locator('#q-flow').innerText();
    const detail = await page.locator('#q-detail').innerText();
    const status = await page.locator('#q-status').innerText();

    expect(flow).toContain('remainder = 0 (clean)');
    const degC = numAfter(flow, 'degree');
    const degQ = numAfter(flow, 'deg Q =');
    const degZ = numAfter(detail, 'deg Z =');
    expect(degZ, 'Z vanishes on the n-2 transition rows').toBe(size - 2);
    expect(numAfter(detail, 'vanishing on the')).toBe(size - 2);
    expect(numAfter(detail, 'deg C =')).toBe(degC);
    expect(degQ, 'deg(C/Z) = deg C − deg Z for an exact division').toBe(degC - degZ);
    expect(numAfter(status, 'degree'), 'the status repeats the same quotient degree').toBe(degQ);

    const bound = numAfter(flow, 'honest bound (');
    expect(bound).toBe(size - 2);
    expect(degQ).toBeLessThanOrEqual(bound);
    expect(flow).toContain('LOW DEGREE');
    expect(flow).toContain('The FRI fixture is run below');
    await expect(page.locator('#q-status')).toHaveClass(/status-ok/);
    expect(detail).toContain('remainder is the ZERO polynomial');
  }
});

test('quotient: every sampled point satisfies Q(x)*Z(x) = C(x) in the field', async ({ page }) => {
  for (const mode of ['q-honest', 'q-tamper']) {
    await page.locator(`#${mode}`).click();
    const samples = await readSamples(page);
    expect(samples.length, 'the panel shows sampled points').toBeGreaterThan(0);
    for (const s of samples) {
      expect(s.z, 'sampled off the transition domain, so Z != 0').not.toBe(0n);
      expect(fmod(s.q * s.z), `${s.q} * ${s.z} != ${s.c}`).toBe(fmod(s.c));
      expect(s.c).toBeLessThan(P);
      expect(s.q).toBeLessThan(P);
    }
  }
});

test('quotient: tampering makes the division dirty and the degree explode', async ({ page }) => {
  await page.locator('#q-honest').click();
  const honestDegQ = numAfter(await page.locator('#q-flow').innerText(), 'deg Q =');

  await page.locator('#q-tamper').click();
  const flow = await page.locator('#q-flow').innerText();
  const detail = await page.locator('#q-detail').innerText();
  const status = await page.locator('#q-status').innerText();

  expect(flow).toContain('remainder ≠ 0');
  const remDeg = numAfter(flow, 'remainder ≠ 0 (deg');
  const degQ = numAfter(flow, 'deg Q =');
  expect(remDeg, 'a nonzero remainder has a real degree').toBeGreaterThanOrEqual(0);
  expect(remDeg, 'the remainder is below the divisor degree').toBeLessThan(numAfter(detail, 'deg Z ='));
  expect(numAfter(detail, 'remainder is NONZERO (degree')).toBe(remDeg);
  expect(numAfter(status, 'remainder degree')).toBe(remDeg);

  expect(degQ, 'the quotient degree explodes').toBeGreaterThan(honestDegQ);
  expect(degQ).toBeGreaterThanOrEqual(15); // near the domain size for n = 16
  expect(numAfter(flow, 'Q jumps to')).toBe(degQ);
  expect(numAfter(status, 'explodes to')).toBe(degQ);
  expect(flow).toContain('HIGH DEGREE');
  expect(flow).toContain('FRI fixture is run below');
  await expect(page.locator('#q-status')).toHaveClass(/status-bad/);
  await expect(page.locator('#q-why')).toContainText('nonzero remainder');

  // …and it is recoverable: back to honest restores the clean division.
  await page.locator('#q-honest').click();
  expect(await page.locator('#q-flow').innerText()).toContain('remainder = 0 (clean)');
  await expect(page.locator('#q-status')).toHaveClass(/status-ok/);
});

// ════════════ Exhibit 3 — FRI ════════════

test('FRI: the honest fixture reaches the eight-value final code on the printed schedule', async ({ page }) => {
  for (const n of ['8', '16']) {
    await setSelect(page, 'fri-n', n);
    await page.locator('#fri-trace-tamper').uncheck();
    const verdict = await runFri(page);

    const table = await readFriTable(page);
    const size = Number(n);
    const domain = size * 8; // blowup 8
    expect(table[0].size).toBe(domain);
    for (let r = 1; r < table.length; r += 1) {
      expect(table[r].size, 'each fold halves the domain').toBe(table[r - 1].size / 2);
      expect(table[r].degree, 'folding cannot raise the degree').toBeLessThanOrEqual(table[r - 1].degree);
    }
    expect(table[table.length - 1].size, 'folding stops at the blowup-sized final layer').toBe(8);
    expect(table.map((r) => r.round)).toEqual(table.map((_, i) => i));

    expect(verdict).toContain('✓ FINAL-CODE MEMBERSHIP');
    expect(verdict).toContain('all 8 final evaluations equal');
    const constant = BigInt(numAfter(verdict, 'equal'));
    expect(constant).toBeLessThan(P);
    expect(table[table.length - 1].degree, 'a constant final layer has degree 0').toBe(0);
    await expect(page.locator('#fri-verdict')).toHaveClass(/verdict-ok/);
    await expect(page.locator('#fri-status')).toContainText('honest trace');

    // The displayed byte count is only authentication hashes. Each layer's
    // path shrinks by one; values, roots and final codeword are excluded.
    const sizeLine = await page.locator('#fri-size').innerText();
    const folds = numAfter(sizeLine, 'uncompressed');
    expect(folds).toBe(table.length - 1);
    expect(numAfter(sizeLine, 'folds, ')).toBe(domain);
    expect(numAfter(sizeLine.split('→')[1], '')).toBe(domain >> folds);
    const queries = 8;
    const pathHashesPerQuery = table.slice(0, -1).reduce((sum, row) => sum + 2 * Math.log2(row.size), 0);
    expect(nums(sizeLine)[0]).toBe(queries * pathHashesPerQuery * 32);
    expect(sizeLine).toContain('Values, roots, indices and the final codeword are excluded');

    // The diagram draws one dot per evaluation point in every layer.
    const dots = await page.locator('#fri-viz svg circle').count();
    expect(dots).toBe(table.reduce((acc, r) => acc + r.size, 0));
  }
});

test('FRI: the fixed tampered trace fails final-code membership, and the diagram marks it', async ({ page }) => {
  await setSelect(page, 'fri-n', '16');
  await page.locator('#fri-trace-tamper').check();
  const verdict = await runFri(page);

  expect(verdict).toContain('✗ FINAL-CODE MEMBERSHIP FAILED');
  expect(verdict).toContain('generated fixture is rejected');
  await expect(page.locator('#fri-verdict')).toHaveClass(/verdict-bad/);
  await expect(page.locator('#fri-status')).toContainText('TAMPERED trace');
  await expect(page.locator('#fri-status')).toContainText('Exhibit 02');

  const table = await readFriTable(page);
  const last = table[table.length - 1];
  expect(last.degree, 'the final layer is NOT a constant').toBeGreaterThan(0);
  // Every layer of this generated fixture stays non-constant.
  for (const row of table) expect(row.degree).toBeGreaterThan(0);
  expect(await page.locator('#fri-viz svg .viz-dot-bad').count()).toBe(last.size);

  // Unchecking restores acceptance on the same control.
  await page.locator('#fri-trace-tamper').uncheck();
  expect(await runFri(page)).toContain('✓ FINAL-CODE MEMBERSHIP');
});

test('FRI: the abstract-polynomial source accepts low degree and rejects an injected term', async ({ page }) => {
  await page.locator('#fri-src-abstract').check();
  await expect(page.locator('#fri-abstract-controls')).toBeVisible();
  await expect(page.locator('#fri-trace-controls')).toBeHidden();

  await page.locator('#fri-tamper').uncheck();
  for (const degree of ['4', '8', '16']) {
    await setSelect(page, 'fri-degree', degree);
    const verdict = await runFri(page);
    expect(verdict, `degree ${degree} fixture reaches the final code`).toContain('✓ FINAL-CODE MEMBERSHIP');
    const table = await readFriTable(page);
    expect(table[0].degree, 'the committed layer has the chosen degree').toBe(Number(degree));
    expect(table[table.length - 1].degree).toBe(0);
  }

  await page.locator('#fri-tamper').check();
  const bad = await runFri(page);
  expect(bad).toContain('✗ FINAL-CODE MEMBERSHIP FAILED');
  await expect(page.locator('#fri-status')).toContainText('deliberately high-degree fixture');
  expect((await readFriTable(page))[0].degree).toBeGreaterThan(16);

  // …and back to the threaded-trace source.
  await page.locator('#fri-src-trace').check();
  await expect(page.locator('#fri-trace-controls')).toBeVisible();
  expect(await runFri(page)).toContain('FINAL-CODE MEMBERSHIP');
});

test('FRI: a superseded fold cannot repaint evidence for older controls', async ({ page }) => {
  await expect(page.locator('#fri-status')).not.toHaveText('Folding…', { timeout: 30_000 });
  await page.evaluate(() => {
    (document.getElementById('fri-run') as HTMLButtonElement).click();
    const n = document.getElementById('fri-n') as HTMLSelectElement;
    n.value = '8';
    n.dispatchEvent(new Event('change', { bubbles: true }));
  });

  await expect(page.locator('#fri-status')).toContainText('honest trace', { timeout: 30_000 });
  expect((await readFriTable(page))[0].size).toBe(8 * 8);
  await page.waitForTimeout(500);
  expect((await readFriTable(page))[0].size, 'the older n=16 fold never paints over n=8').toBe(8 * 8);
});

// ════════════ Exhibit 4 — proof size and the query-model calculator ════════════

test('proof size: the benchmark table matches the chart and the size ordering the README claims', async ({ page }) => {
  const rows = await page.locator('#size-table tbody tr').evaluateAll((trs) =>
    trs.map((r) => Array.from(r.querySelectorAll('td')).map((td) => td.textContent ?? '')),
  );
  expect(rows.length).toBeGreaterThan(3);
  const bytes = rows.map((r) => Number(r[2].replace(/[^0-9]/g, '')));
  const bySystem = new Map(rows.map((r, i) => [r[0], bytes[i]]));

  expect(bySystem.get('Groth16 (SNARK)')).toBe(128);
  expect(bySystem.get('PLONK (SNARK)')).toBe(400);
  const starks = rows.filter((r) => !r[0].includes('SNARK')).map((r) => Number(r[2].replace(/[^0-9]/g, '')));
  for (const s of starks) {
    expect(s, 'STARK proofs are 45-200 KB').toBeGreaterThanOrEqual(45 * 1024);
    expect(s).toBeLessThanOrEqual(200 * 1024);
    expect(s, 'orders of magnitude above a SNARK proof').toBeGreaterThan(300 * bySystem.get('Groth16 (SNARK)')!);
  }

  // The log-scaled chart plots exactly the table's numbers.
  const chart = await page.locator('#size-chart .chart-row').evaluateAll((els) =>
    els.map((e) => [e.querySelector('.chart-label')?.textContent ?? '', e.querySelector('.chart-value')?.textContent ?? '']),
  );
  expect(chart.map((c) => c[0])).toEqual(rows.map((r) => r[0]));
  expect(chart.map((c) => Number(c[1].replace(/,/g, '')))).toEqual(bytes);
});

test('proof size: this demo measures its own proof, and JSON transport is bigger than the binary count', async ({ page }) => {
  const measured = page.locator('#size-measured');
  await expect(measured).toContainText('compact binary model', { timeout: 30_000 });
  const text = await measured.innerText();

  expect(numAfter(text, 'N=')).toBe(16);
  expect(numAfter(text, 'blowup')).toBe(8);
  expect(Number(/(\d+) queries/.exec(text)![1])).toBe(8);
  const binary = numAfter(text, 'is about');
  const json = numAfter(text, 'JSON transport encoding is');
  expect(binary).toBeGreaterThan(0);
  expect(json, 'decimal digits and hex paths cost more than 32-byte words').toBeGreaterThan(binary);
  expect(text).toContain('neither establishes production security');
});

test('query-model calculator: arithmetic, classifications and authentication bytes stay consistent', async ({ page }) => {
  for (const [rateLog, queries] of [[3, 8], [1, 40], [6, 80], [4, 17]]) {
    await setRange(page, 'sec-blowup', rateLog);
    await setRange(page, 'sec-queries', queries);
    const blowup = 2 ** rateLog;

    await expect(page.locator('#sec-blowup-val')).toHaveText(String(blowup));
    await expect(page.locator('#sec-queries-val')).toHaveText(String(queries));

    const bits = Number(await page.locator('#sec-bits').innerText());
    expect(bits, 'queries x log2(blowup)').toBe(queries * rateLog);

    // Exact capacity-model arithmetic only: rate^queries = blowup^-queries.
    const odds = await page.locator('#sec-cheat').innerText();
    expect(oneInLog10(odds)).toBeCloseTo(queries * Math.log10(blowup), 1);

    // Reference authentication hashes: 1024-row bound -> 10 folds and a path
    // that shrinks by one hash per layer.
    const kb = Number((await page.locator('#sec-bytes').innerText()).replace(/[^0-9.]/g, ''));
    const initialLog = 10 + rateLog;
    let pathHashesPerQuery = 0;
    for (let r = 0; r < 10; r += 1) pathHashesPerQuery += 2 * (initialLog - r);
    expect(kb).toBe(Number(((queries * pathHashesPerQuery * 32) / 1024).toFixed(1)));

    // The prose and ledger retain the boundaries at every slider setting.
    const note = await page.locator('#sec-note').innerText();
    expect(note).toContain(`${queries} × log₂(${blowup})`);
    expect(nums(note)[0]).toBe(bits);
    expect(note).toContain('heuristic query term, not FRI or STARK soundness');
    expect(note).toContain('strict limit');
    expect(note).toContain('NOT ESTABLISHED');
    const rows = await page.locator('#sec-ledger-body tr').evaluateAll((trs) =>
      trs.map((r) => Array.from(r.querySelectorAll('td')).map((td) => td.textContent ?? '')),
    );
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual(['Capacity model', `${bits} bits`, 'heuristic query arithmetic']);
    expect(rows[1][2]).toContain('requires δ ≥ θ =');
    expect(rows[2][2]).toContain('θ approaches it from below');
    expect(rows[3][1]).toBe('NOT ESTABLISHED');
    expect(rows[4][1]).toBe('NOT ESTABLISHED');
  }
});

test('query-model calculator: toy parameters keep 24 heuristic and all stronger claims unestablished', async ({ page }) => {
  await setRange(page, 'sec-blowup', 3); // blowup 8
  await setRange(page, 'sec-queries', 8);
  await expect(page.locator('#sec-bits')).toHaveText('24');
  expect(oneInLog10(await page.locator('#sec-cheat').innerText())).toBeCloseTo(Math.log10(8 ** 8), 1);

  // The fixed worked example gives exact arithmetic and denies the protocol claim.
  const example = await page.locator('#sec-example').innerText();
  expect(example).toContain('rate 1/8 with 8 independent uniform queries');
  expect(oneInLog10(example)).toBeCloseTo(Math.log10(8 ** 8), 1);
  expect(example).toContain('2^-24');
  expect(example).toContain('not a protocol success probability');

  const rows = await page.locator('#sec-ledger-body tr').evaluateAll((trs) =>
    trs.map((r) => Array.from(r.querySelectorAll('td')).map((td) => td.textContent ?? '')),
  );
  expect(rows[0][1]).toBe('24 bits');
  expect(Number.parseFloat(rows[1][1])).toBeCloseTo(6.64, 2);
  expect(rows[2][1]).toBe('< 12 bits');
  expect(rows[3][2]).toContain('actual δ and all 10 fold MCA terms are absent');
  expect(rows[4][2]).toContain('Fiat-Shamir/BCS');
});

// ════════════ Exhibit 5 — prove and verify ════════════

async function proveE2E(page: Page, mode: 'prove' | 'corrupt'): Promise<string> {
  await blank(page, 'e2e-status', 'e2e-checks');
  await page.locator(`#e2e-${mode}`).click();
  await expect(page.locator('#e2e-status')).toContainText(mode === 'corrupt' ? 'TAMPERED' : 'The proof is', { timeout: 60_000 });
  return page.locator('#e2e-status').innerText();
}

async function verifyE2E(page: Page): Promise<{ status: string; rows: { name: string; ok: boolean }[]; verdict: string }> {
  await blank(page, 'e2e-status', 'e2e-checks');
  await page.locator('#e2e-verify').click();
  await expect(page.locator('#e2e-checks .verdict')).toBeVisible({ timeout: 60_000 });
  const rows = await page.locator('#e2e-checks .check-row').evaluateAll((els) =>
    els.map((e) => ({ name: e.querySelector('.check-name')?.textContent ?? '', ok: e.classList.contains('check-pass') })),
  );
  return {
    status: await page.locator('#e2e-status').innerText(),
    rows,
    verdict: await page.locator('#e2e-checks .verdict').innerText(),
  };
}

interface Succinct { unique: number; lde: number; pct: number; fri: number; traceLen: number; tiles: number[]; }

async function readSuccinct(page: Page): Promise<Succinct> {
  const text = await page.locator('#e2e-succinct').innerText();
  const tiles = await page.locator('#e2e-succinct .sec-stat .sec-num').evaluateAll((els) =>
    els.map((e) => Number((e.textContent ?? '').replace(/[^0-9]/g, ''))),
  );
  return {
    unique: numAfter(text, 'verifier opened'),
    lde: numAfter(text, 'out of an LDE of'),
    pct: numAfter(text, '≈'),
    fri: numAfter(text, 'plus'),
    traceLen: numAfter(text, 'length-'),
    tiles,
  };
}

test('prove: the succinctness counters are internally consistent', async ({ page }) => {
  const status = await proveE2E(page, 'prove');
  const s = await readSuccinct(page);

  expect(s.traceLen).toBe(16);
  expect(s.lde, 'LDE = trace length x blowup 8').toBe(s.traceLen * 8);
  expect(s.unique, 'at most 3 trace openings per query, deduplicated').toBeLessThanOrEqual(3 * 8);
  expect(s.unique).toBeGreaterThan(0);
  expect(s.unique, 'the verifier must not open the whole LDE').toBeLessThan(s.lde);
  expect(s.pct, 'the percentage is the opened fraction').toBe(Math.round((s.unique / s.lde) * 100));
  expect(s.fri, 'two openings per fold per query').toBe(8 * Math.log2(s.traceLen) * 2);

  // Tiles: proof bytes, committed values seen, capacity-model query arithmetic.
  const [proofBytes, seen, bits] = s.tiles;
  expect(seen, 'committed values seen = trace openings + FRI openings').toBe(s.unique + s.fri);
  expect(bits, 'capacity model: queries x log2(blowup) = 8 x 3').toBe(24);
  expect(proofBytes, 'the tile repeats the byte count from the status line').toBe(numAfter(status, 'The proof is'));

  const hint = await page.locator('#e2e-succinct').innerText();
  const jsonBytes = numAfter(hint, 'hex paths — is');
  expect(jsonBytes).toBeGreaterThan(proofBytes);
  expect(Number(/is\s+[\d,]+\s+bytes, about ([\d.]+)/.exec(hint)![1])).toBeCloseTo(jsonBytes / proofBytes, 1);
  expect(hint).toContain('capacity-model query heuristic, not a soundness bound');
  expect(hint).toContain('unique-radius query-only reference is 6.64 bits');
  expect(hint).toContain('Johnson-radius strict limiting query-only value is <12.00 bits');
  expect((hint.match(/NOT ESTABLISHED/g) ?? [])).toHaveLength(2);
});

test('prove: the query inspector index chain is the one the protocol dictates', async ({ page }) => {
  await proveE2E(page, 'prove');
  const s = await readSuccinct(page);
  const text = await page.locator('#e2e-inspector').innerText();

  const L = s.lde;
  const shift = L / s.traceLen;
  const pos = numAfter(text, 'LDE position');
  expect(pos).toBeGreaterThanOrEqual(0);
  expect(pos).toBeLessThan(L);

  const opens = [...text.matchAll(/@(\d+): (\d+)\s+\(Merkle path: (\d+) hashes\)/g)].map((m) => ({
    index: Number(m[1]), value: BigInt(m[2]), path: Number(m[3]),
  }));
  expect(opens).toHaveLength(3);
  expect(opens.map((o) => o.index), 'f(x), f(wx), f(w^2 x)').toEqual([
    pos, (pos + shift) % L, (pos + 2 * shift) % L,
  ]);
  for (const o of opens) {
    expect(o.path, 'a full Merkle path over the L-point commitment').toBe(Math.log2(L));
    expect(o.value).toBeLessThan(P);
  }

  // Each fold opens the pair (a, a + half) and carries a = index % half down.
  const folds = [...text.matchAll(/round (\d+): layer\[(\d+)\]=\d+, layer\[(\d+)\]=\d+/g)].map((m) => ({
    round: Number(m[1]), a: Number(m[2]), b: Number(m[3]),
  }));
  expect(folds).toHaveLength(Math.log2(s.traceLen));
  let carry = pos;
  for (const f of folds) {
    const half = (L >> f.round) >> 1;
    expect(f.a, `round ${f.round} low index`).toBe(carry % half);
    expect(f.b, `round ${f.round} sibling`).toBe((carry % half) + half);
    carry = carry % half;
  }
  expect(text).toContain('commitments, composition consistency, final-code membership and every sampled fold relation');
});

test('verify: an honest proof passes every check and is ACCEPTED', async ({ page }) => {
  await proveE2E(page, 'prove');
  const { status, rows, verdict } = await verifyE2E(page);

  expect(rows.length).toBeGreaterThanOrEqual(6);
  expect(rows.filter((r) => !r.ok), 'no check may fail on an honest proof').toEqual([]);
  expect(verdict).toContain('✓ ACCEPTED');
  expect(verdict).toContain('commitment, composition, final-code and sampled-fold check');
  expect(status).toContain('ACCEPTED');
  await expect(page.locator('#e2e-checks .verdict')).toHaveClass(/verdict-ok/);
  await expect(page.locator('#e2e-checks .check-fail')).toHaveCount(0);
});

test('verify: the fixed corrupted fixture fails final-code membership, with no recomputation', async ({ page }) => {
  const proveStatus = await proveE2E(page, 'corrupt');
  expect(proveStatus).toContain('TAMPERED');
  expect(numAfter(proveStatus, 'row')).toBe(8); // n/2 for the default n = 16
  expect(proveStatus).toContain('final-code membership check fails');
  expect(proveStatus).toContain('authenticated openings remain intact');

  const { status, rows, verdict } = await verifyE2E(page);
  expect(verdict).toContain('✗ REJECTED');
  await expect(page.locator('#e2e-checks .verdict')).toHaveClass(/verdict-bad/);

  // Record the exact observed failure, not a universal rejection claim.
  const failed = rows.filter((r) => !r.ok).map((r) => r.name);
  expect(failed).toEqual(['FRI final-code membership (8 evaluations, degree < 1)']);
  const merkle = rows.find((r) => r.name.includes('Merkle openings'))!;
  expect(merkle.ok, 'the commitments still open correctly — nothing was forged').toBe(true);
  expect(rows.find((r) => r.name.includes('Proof shape'))!.ok).toBe(true);

  const detail = await page.locator('#e2e-checks .check-fail .check-detail').innerText();
  expect(detail).toContain('eight final evaluations are not all equal');
  expect(detail).toContain('generated fixture fails final-code membership');
  expect(status).toContain('without the verifier re-running Fibonacci');
  expect(status).toContain('REJECTED');

  // Re-proving honestly on the same panel goes back to ACCEPTED.
  await proveE2E(page, 'prove');
  expect((await verifyE2E(page)).verdict).toContain('ACCEPTED');
});

test('verify: zero-knowledge mode masks the trace and the masked proof still verifies', async ({ page }) => {
  await proveE2E(page, 'prove');
  const plain = await readSuccinct(page);

  await page.locator('#e2e-zk').check();
  const status = await proveE2E(page, 'prove');
  expect(status).toContain('zero-knowledge: trace masked');
  const masked = await readSuccinct(page);

  expect(masked.traceLen, 'the same computation is proved').toBe(plain.traceLen);
  expect(masked.lde, 'masking pads the domain to hide the extra openings').toBeGreaterThan(plain.lde);
  expect(masked.lde % 8, 'still a blowup-8 LDE').toBe(0);
  expect(masked.tiles[0], 'a masked proof is larger').toBeGreaterThan(plain.tiles[0]);

  const { rows, verdict } = await verifyE2E(page);
  expect(rows.filter((r) => !r.ok)).toEqual([]);
  expect(verdict).toContain('✓ ACCEPTED');
});

test('verify: pressing Verify with no proof says so instead of claiming anything', async ({ page }) => {
  await page.locator('#e2e-verify').click();
  await expect(page.locator('#e2e-status')).toHaveText('Generate a proof first.');
  await expect(page.locator('#e2e-checks .verdict')).toHaveCount(0);
});

test('prove: changed inputs retire completed and in-flight proof evidence', async ({ page }) => {
  await proveE2E(page, 'prove');
  await verifyE2E(page);

  await page.locator('#e2e-n').selectOption('8');
  await expect(page.locator('#e2e-status')).toHaveText('Inputs changed. Generate a new proof for the current settings.');
  await expect(page.locator('#e2e-checks')).toBeEmpty();
  await expect(page.locator('#e2e-inspector')).toBeEmpty();
  await expect(page.locator('#e2e-transcript')).toContainText('No proof generated for the current settings.');
  await page.locator('#e2e-verify').click();
  await expect(page.locator('#e2e-status')).toHaveText('Generate a proof first.');

  await page.locator('#e2e-n').selectOption('16');
  await page.evaluate(() => {
    (document.getElementById('e2e-prove') as HTMLButtonElement).click();
    const n = document.getElementById('e2e-n') as HTMLSelectElement;
    n.value = '8';
    n.dispatchEvent(new Event('change', { bubbles: true }));
    (document.getElementById('e2e-prove') as HTMLButtonElement).click();
  });

  await expect(page.locator('#e2e-status')).toContainText('Proof generated for n=8', { timeout: 60_000 });
  expect((await readSuccinct(page)).traceLen).toBe(8);
  await page.waitForTimeout(500);
  await expect(page.locator('#e2e-status')).toContainText('Proof generated for n=8');
  expect((await readSuccinct(page)).traceLen, 'the older n=16 proof never repaints the panel').toBe(8);
});

// ════════════ Exhibit 5b — the "zk" in zk-STARK ════════════

test('zk: a masked opening changes on every reveal while the secret stays fixed', async ({ page }) => {
  const secretOf = () => page.locator('#zk-one-viz .zk-one-secret .zk-one-num').innerText();
  const latestOf = () => page.locator('#zk-one-viz .zk-one-latest .zk-one-num').innerText();

  const secret = await secretOf();
  expect(BigInt(secret)).toBeLessThan(P);
  const seen = new Set<string>([await latestOf()]);

  for (let i = 0; i < 5; i += 1) {
    await page.locator('#zk-one').click();
    expect(await secretOf(), 'the witness never moves').toBe(secret);
    seen.add(await latestOf());
  }
  expect(seen.size, 'every reveal shows a fresh masked value').toBe(6);
  await expect(page.locator('#zk-one-viz')).toContainText('unchanged');

  const note = await page.locator('#zk-one-note').innerText();
  expect(numAfter(note, '')).toBe(6);
  expect(note).toContain('the secret f(x) never moved');
  // The history is capped, so the panel cannot grow without bound.
  expect(await page.locator('#zk-one-viz .zk-one-row').count()).toBeLessThanOrEqual(6);
});

test('zk: masked openings match the witness-free simulator and never leak the true value', async ({ page }) => {
  await blank(page, 'zk-note');
  await page.locator('#zk-run').click();
  await expect(page.locator('#zk-note')).toContainText('fresh-randomness runs', { timeout: 30_000 });

  const note = await page.locator('#zk-note').innerText();
  const tiles = await page.locator('#zk-stats .sec-stat').evaluateAll((els) =>
    els.map((e) => ({ num: e.querySelector('.sec-num')?.textContent ?? '', cap: e.querySelector('.sec-cap')?.textContent ?? '' })),
  );
  expect(tiles).toHaveLength(4);

  const [distinct, leaks, gap, corr] = tiles;
  const [d, trials] = distinct.num.split('/').map(Number);
  expect(d, 'distinct openings cannot exceed trials').toBeLessThanOrEqual(trials);
  expect(d / trials, 'a fresh mask each time means near-total distinctness').toBeGreaterThan(0.99);
  expect(numAfter(note, 'Across')).toBe(trials);

  expect(Number(leaks.num), 'the true value must not appear among masked openings').toBe(0);
  await expect(page.locator('#zk-stats .sec-num').nth(1)).toHaveClass(/status-ok/);
  expect(note).toContain('never leaked in this run');

  // The gap the tile reports is the gap the prose reports.
  const tileGap = Number(gap.num.replace('%', ''));
  expect(tileGap).toBe(Number(/max gap ([\d.]+)%/.exec(note)![1]));
  expect(tileGap, 'the masked distribution tracks the simulator').toBeLessThan(15);
  expect(Math.abs(Number(corr.num)), 'no correlation between opened points').toBeLessThan(0.2);

  // One bar per histogram bucket, for both series.
  const buckets = await page.locator('#zk-viz .zk-col').count();
  expect(buckets).toBe(16);
  expect(await page.locator('#zk-viz .zk-bar-real').count()).toBe(buckets);
  expect(await page.locator('#zk-viz .zk-bar-sim').count()).toBe(buckets);
});
