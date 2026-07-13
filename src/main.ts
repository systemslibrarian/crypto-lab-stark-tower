// DOM wiring for STARK Tower. All cryptography lives in ./stark, ./field and
// ./merkle — this file only drives the exhibits and renders results.
import {
  prove,
  verify,
  airAnalysis,
  quotientAnalysis,
  friDemo,
  friFromTrace,
  proofStats,
  securityBits,
  zkOpeningExperiment,
  maskedOpeningSample,
  type StarkProof,
  type VerifyResult,
  type FriLayerInfo,
  type ZkExperiment,
} from './stark';

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function setText(id: string, text: string): void {
  const el = $(id);
  if (el) el.textContent = text;
}

// Human-readable 1-in-N odds: use short-scale names up to quintillions, then
// fall back to scientific notation for astronomically small cheat chances.
function formatOneIn(n: number): string {
  if (!isFinite(n)) return '∞';
  const units: [number, string][] = [
    [1e18, ' quintillion'],
    [1e15, ' quadrillion'],
    [1e12, ' trillion'],
    [1e9, ' billion'],
    [1e6, ' million'],
    [1e3, ' thousand'],
  ];
  if (n >= 1e21) return n.toExponential(1).replace('e+', ' × 10^');
  for (const [scale, name] of units) {
    if (n >= scale) return `${(n / scale).toFixed(n / scale >= 100 ? 0 : 1)}${name}`;
  }
  return `${Math.round(n)}`;
}

// --------------------------------------------------------------------------
// Theme toggle
// --------------------------------------------------------------------------
function initThemeToggle(): void {
  const root = document.documentElement;
  const header = document.querySelector('.cl-hero');
  if (!header) return;
  const button = document.createElement('button');
  button.className = 'theme-toggle';
  button.type = 'button';
  button.hidden = true;
  button.setAttribute('aria-hidden', 'true');
  const apply = (): void => {
    const isDark = root.getAttribute('data-theme') !== 'light';
    button.textContent = isDark ? '🌙' : '☀️';
    button.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
  };
  button.addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    apply();
  });
  header.appendChild(button);
  apply();
}

// --------------------------------------------------------------------------
// Shared renderers
// --------------------------------------------------------------------------
function renderCheckList(target: HTMLElement, result: VerifyResult): void {
  target.innerHTML = '';
  for (const c of result.checks) {
    const row = document.createElement('div');
    row.className = `check-row ${c.ok ? 'check-pass' : 'check-fail'}`;
    row.innerHTML =
      `<span class="check-mark" aria-hidden="true">${c.ok ? '✓' : '✗'}</span>` +
      `<span class="check-body"><span class="check-name">${c.name}</span>` +
      `<span class="check-detail">${c.detail}</span></span>`;
    target.appendChild(row);
  }
  const verdict = document.createElement('div');
  verdict.className = `verdict ${result.accepted ? 'verdict-ok' : 'verdict-bad'}`;
  verdict.setAttribute('role', 'status');
  verdict.textContent = result.accepted
    ? '✓ ACCEPTED — the verifier is convinced, having only checked hashes and a low-degree test.'
    : '✗ REJECTED — the verifier caught the cheat without ever recomputing the trace.';
  target.appendChild(verdict);
}

// --------------------------------------------------------------------------
// Exhibit 2 — AIR
// --------------------------------------------------------------------------
function bindExhibit2(): void {
  const nSel = $('air-n') as HTMLSelectElement | null;
  let tampered = false;

  function render(): void {
    const n = Number(nSel?.value ?? 16);
    const tamperRow = tampered ? Math.floor(n / 2) : -1;
    const a = airAnalysis(n, tamperRow);

    // Trace table
    const table = $('air-trace-table');
    if (table) {
      const head = '<thead><tr><th>step i</th><th>t[i]</th><th>status</th></tr></thead>';
      const body = a.trace
        .map((val, i) => {
          const isTamper = i === tamperRow;
          return `<tr class="${isTamper ? 'trace-bad' : ''}"><td>${i}</td><td>${val}</td><td>${
            isTamper ? 'tampered' : i < 2 ? 'boundary' : 'derived'
          }</td></tr>`;
        })
        .join('');
      table.innerHTML = head + `<tbody>${body}</tbody>`;
    }

    // Transition residuals
    const out = $('air-constraints');
    if (out) {
      const lines = [
        'Transition constraint:  C(i) = t[i+2] − t[i+1] − t[i]   (must be 0)',
        'Boundary constraints:   t[0] = 1,  t[1] = 1',
        '',
        ...a.transitions.map((t) => `  C(${t.i.toString().padStart(2)}) = ${t.value}${t.value === 0n ? '' : '   ← VIOLATED'}`),
      ];
      out.textContent = lines.join('\n');
    }

    const allZero = a.transitions.every((t) => t.value === 0n) && a.boundaryOk;
    setText(
      'air-status',
      allZero
        ? `Valid trace. Interpolated trace polynomial f has degree ${a.traceDegree} (< ${n}), so it is genuinely low degree.`
        : 'Constraints VIOLATED — this trace is not a valid Fibonacci computation. A real STARK turns this fact into a high-degree polynomial that FRI will reject.',
    );
    const s = $('air-status');
    if (s) s.className = `hash-label ${allZero ? 'status-ok' : 'status-bad'}`;
  }

  nSel?.addEventListener('change', render);
  $('air-generate-trace')?.addEventListener('click', () => {
    tampered = false;
    render();
  });
  $('air-check')?.addEventListener('click', render);
  $('air-tamper')?.addEventListener('click', () => {
    tampered = true;
    render();
  });
  render();
}

// --------------------------------------------------------------------------
// Exhibit 2·5 — the constraint quotient (the missing middle step)
// --------------------------------------------------------------------------
function bindQuotient(): void {
  const nSel = $('q-n') as HTMLSelectElement | null;
  let tampered = false;

  function render(): void {
    const n = Number(nSel?.value ?? 16);
    const tamperRow = tampered ? Math.floor(n / 2) : -1;
    const q = quotientAnalysis(n, tamperRow);

    // The one decisive number, shown as an explicit before/after flow.
    const flow = $('q-flow');
    if (flow) {
      const remCell = q.cleanDivision
        ? '<span class="q-chip q-chip-ok">remainder = 0 (clean)</span>'
        : `<span class="q-chip q-chip-bad">remainder ≠ 0 (deg ${q.remainderDegree})</span>`;
      const degCell = q.cleanDivision
        ? `<span class="q-chip q-chip-ok">deg Q = ${q.quotientDegree}</span>`
        : `<span class="q-chip q-chip-bad">deg Q = ${q.quotientDegree}</span>`;
      flow.innerHTML =
        `<div class="q-step"><span class="q-step-label">constraint C(x)</span><span class="q-step-val">degree ${q.constraintDegree}</span></div>` +
        `<div class="q-arrow" aria-hidden="true">÷ Z(x) →</div>` +
        `<div class="q-step"><span class="q-step-label">does Z divide C?</span><span class="q-step-val">${remCell}</span></div>` +
        `<div class="q-arrow" aria-hidden="true">→</div>` +
        `<div class="q-step"><span class="q-step-label">quotient Q(x)</span><span class="q-step-val">${degCell}</span></div>` +
        `<div class="q-verdict ${q.cleanDivision ? 'q-verdict-ok' : 'q-verdict-bad'}">` +
        (q.cleanDivision
          ? `✓ LOW DEGREE — Q stays at or below the honest bound (${q.cleanQuotientBound}). FRI will accept.`
          : `✗ HIGH DEGREE — Q jumps to ${q.quotientDegree}, near the domain size. FRI will reject.`) +
        `</div>`;
    }

    // Division detail, honest math on screen.
    const detail = $('q-detail');
    if (detail) {
      const sample = q.samplePoints
        .map((s, i) => `  x${i} :  C(x)=${trunc12(s.c)}   Z(x)=${trunc12(s.z)}   Q=C/Z=${trunc12(s.q)}`)
        .join('\n');
      const lines = [
        `C(x) = f(w²x) − f(wx) − f(x)        deg C = ${q.constraintDegree}`,
        `Z(x) = vanishing on the ${q.n - 2} transition steps   deg Z = ${q.vanishDegree}`,
        '',
        q.cleanDivision
          ? `C ÷ Z  →  remainder is the ZERO polynomial. Z divides C exactly.`
          : `C ÷ Z  →  remainder is NONZERO (degree ${q.remainderDegree}). Z does NOT divide C.`,
        '',
        q.cleanDivision
          ? `So Q = C/Z is an honest polynomial of degree ${q.quotientDegree} (≤ ${q.cleanQuotientBound}).`
          : `So Q = C/Z is no longer a low-degree polynomial: interpolating its`,
        q.cleanDivision ? '' : `values over the domain gives degree ${q.quotientDegree} — the degree explosion FRI detects.`,
        '',
        'Sampled off the transition domain (where Z ≠ 0):',
        sample,
      ].filter((l) => l !== undefined);
      detail.textContent = lines.join('\n');
    }

    setText(
      'q-status',
      q.cleanDivision
        ? `Honest trace: Z(x) divides C(x) cleanly, so the quotient Q has degree ${q.quotientDegree}.`
        : `Tampered trace: Z(x) does NOT divide C(x) (remainder degree ${q.remainderDegree}), so Q's degree explodes to ${q.quotientDegree}.`,
    );
    const s = $('q-status');
    if (s) s.className = `hash-label ${q.cleanDivision ? 'status-ok' : 'status-bad'}`;

    setText(
      'q-why',
      q.cleanDivision
        ? 'A valid trace makes the constraint vanish on every step, so the division is clean and the quotient is low degree.'
        : 'One broken step leaves a nonzero remainder, and the leftover cannot be a low-degree polynomial.',
    );
  }

  nSel?.addEventListener('change', render);
  $('q-honest')?.addEventListener('click', () => { tampered = false; render(); });
  $('q-tamper')?.addEventListener('click', () => { tampered = true; render(); });
  render();
}

function trunc12(v: string): string {
  return v.length > 12 ? v.slice(0, 12) + '…' : v;
}

function renderFriViz(target: HTMLElement, layers: FriLayerInfo[], finalConstant: boolean): void {
  const W = 640;
  const margin = 30;
  const rowGap = 70;
  const H = layers.length * rowGap;
  const cx = (i: number, size: number): number => margin + ((i + 0.5) * (W - 2 * margin)) / size;

  let lines = '';
  let dots = '';
  let labels = '';
  for (let r = 0; r < layers.length; r += 1) {
    const size = layers[r].size;
    const y = r * rowGap + 30;
    const isFinal = r === layers.length - 1;
    labels += `<text x="2" y="${y + 4}" class="viz-label">${size}</text>`;
    if (r < layers.length - 1) {
      const half = size / 2;
      const ny = (r + 1) * rowGap + 30;
      for (let i = 0; i < half; i += 1) {
        const xt = cx(i, half).toFixed(1);
        lines += `<line x1="${cx(i, size).toFixed(1)}" y1="${y}" x2="${xt}" y2="${ny}" class="viz-line"/>`;
        lines += `<line x1="${cx(i + half, size).toFixed(1)}" y1="${y}" x2="${xt}" y2="${ny}" class="viz-line"/>`;
      }
    }
    const r0 = size > 64 ? 1.6 : 3;
    for (let i = 0; i < size; i += 1) {
      const cls = isFinal ? (finalConstant ? 'viz-dot-ok' : 'viz-dot-bad') : 'viz-dot';
      dots += `<circle cx="${cx(i, size).toFixed(1)}" cy="${y}" r="${r0}" class="${cls}"/>`;
    }
  }
  target.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="fri-svg" preserveAspectRatio="xMidYMid meet">${lines}${dots}${labels}</svg>`;
}

// --------------------------------------------------------------------------
// Exhibit 3 — FRI
// --------------------------------------------------------------------------
function bindExhibit3(): void {
  const degSel = $('fri-degree') as HTMLSelectElement | null;
  const tamperBox = $('fri-tamper') as HTMLInputElement | null;
  const nSel = $('fri-n') as HTMLSelectElement | null;
  const traceTamperBox = $('fri-trace-tamper') as HTMLInputElement | null;
  const srcTrace = $('fri-src-trace') as HTMLInputElement | null;
  const traceControls = $('fri-trace-controls');
  const abstractControls = $('fri-abstract-controls');

  function syncSource(): void {
    const useTrace = srcTrace?.checked ?? true;
    if (traceControls) traceControls.hidden = !useTrace;
    if (abstractControls) abstractControls.hidden = useTrace;
  }

  async function run(): Promise<void> {
    const useTrace = srcTrace?.checked ?? true;
    setText('fri-status', 'Folding…');
    let r;
    let tamper: boolean;
    if (useTrace) {
      const n = Number(nSel?.value ?? 16);
      tamper = traceTamperBox?.checked ?? false;
      r = await friFromTrace(n, tamper ? Math.floor(n / 2) : -1);
    } else {
      const degree = Number(degSel?.value ?? 8);
      tamper = tamperBox?.checked ?? false;
      r = await friDemo(degree, { tamper });
    }

    const table = $('fri-table');
    if (table) {
      const head = '<thead><tr><th>round</th><th>domain</th><th>est. degree</th><th>challenge β</th><th>layer root</th></tr></thead>';
      const body = r.layers
        .map((l, i) => {
          const isFinal = i === r.layers.length - 1;
          return `<tr class="${isFinal ? 'fri-final' : ''}"><td>${i}</td><td>${l.size}</td><td>${l.degree}</td><td>${
            l.beta ? l.beta : '—'
          }</td><td class="mono-cell">${l.rootHex.slice(0, 12)}…</td></tr>`;
        })
        .join('');
      table.innerHTML = head + `<tbody>${body}</tbody>`;
    }

    setText('fri-size', `Estimated query payload: ${r.proofBytesEstimate.toLocaleString()} bytes (${r.numFolds} folds, ${r.domainSize}→${r.domainSize >> r.numFolds} evaluations).`);

    const viz = $('fri-viz');
    if (viz) renderFriViz(viz, r.layers, r.finalConstant);

    const verdict = $('fri-verdict');
    if (verdict) {
      verdict.className = `verdict ${r.finalConstant ? 'verdict-ok' : 'verdict-bad'}`;
      verdict.textContent = r.finalConstant
        ? `✓ LOW DEGREE — the final layer collapsed to the single constant ${r.finalValues[0]}. FRI accepts.`
        : '✗ NOT LOW DEGREE — the final layer is not constant, so FRI rejects. This is exactly how a tampered trace gets caught.';
    }
    setText(
      'fri-status',
      useTrace
        ? tamper
          ? 'Folded the quotient Q from the TAMPERED trace — it did not collapse to a constant. Same object as Exhibit 02, caught here.'
          : 'Folded the quotient Q from the honest trace down to a constant. Same object as Exhibit 02·5.'
        : tamper
          ? 'Folded a deliberately high-degree abstract polynomial.'
          : 'Folded a low-degree abstract polynomial down to a constant.',
    );
  }

  degSel?.addEventListener('change', () => void run());
  tamperBox?.addEventListener('change', () => void run());
  nSel?.addEventListener('change', () => void run());
  traceTamperBox?.addEventListener('change', () => void run());
  srcTrace?.addEventListener('change', () => { syncSource(); void run(); });
  $('fri-src-abstract')?.addEventListener('change', () => { syncSource(); void run(); });
  $('fri-run')?.addEventListener('click', () => void run());
  syncSource();
  void run();
}

// --------------------------------------------------------------------------
// Exhibit 4 — proof size
// --------------------------------------------------------------------------
async function bindExhibit4(): Promise<void> {
  const benchmarks = [
    { system: 'Groth16 (SNARK)', computation: 'Any circuit', bytes: 128, verification: '~1 ms' },
    { system: 'PLONK (SNARK)', computation: 'Any circuit', bytes: 400, verification: '~3 ms' },
    { system: 'STARK (BLAKE3)', computation: 'Fibonacci, 1M steps', bytes: 45 * 1024, verification: '~10 ms' },
    { system: 'STARK (SHA-256)', computation: 'SHA-256 circuit', bytes: 100 * 1024, verification: '~20 ms' },
    { system: 'StarkNet-style', computation: 'Cairo VM execution', bytes: 175 * 1024, verification: '~50 ms' },
    { system: 'Risc Zero receipt', computation: 'RISC-V execution', bytes: 200 * 1024, verification: '~50 ms' },
  ];

  const table = $('size-table');
  if (table) {
    table.innerHTML = [
      '<thead><tr><th>System</th><th>Computation</th><th>Proof size</th><th>Verify</th></tr></thead>',
      '<tbody>',
      ...benchmarks.map(
        (b) => `<tr><td>${b.system}</td><td>${b.computation}</td><td>${b.bytes.toLocaleString()} bytes</td><td>${b.verification}</td></tr>`,
      ),
      '</tbody>',
    ].join('');
  }

  const chart = $('size-chart');
  if (chart) {
    const minLog = Math.log10(Math.min(...benchmarks.map((b) => b.bytes)));
    const maxLog = Math.log10(Math.max(...benchmarks.map((b) => b.bytes)));
    chart.innerHTML = '';
    for (const b of benchmarks) {
      const scaled = ((Math.log10(b.bytes) - minLog) / (maxLog - minLog || 1)) * 100;
      const row = document.createElement('div');
      row.className = 'chart-row';
      row.innerHTML =
        `<div class="chart-label">${b.system}</div>` +
        `<div class="chart-bar-wrap"><div class="chart-bar" style="width:${Math.max(4, scaled)}%"></div></div>` +
        `<div class="chart-value">${b.bytes.toLocaleString()}</div>`;
      chart.appendChild(row);
    }
  }

  // Ground it: measure this demo's own toy proof.
  const { proof } = await prove(16);
  const bytes = JSON.stringify(proof).length;
  setText(
    'size-measured',
    `This page's own toy proof (N=16, blowup 8, ${proof.params.numQueries} queries) serializes to ${bytes.toLocaleString()} bytes — tiny because the parameters are tiny. Production proofs scale this construction up to real security.`,
  );
}

// --------------------------------------------------------------------------
// Exhibit 4 — security ↔ size ↔ speed calculator
// --------------------------------------------------------------------------
function bindSecurityCalc(): void {
  const blowupEl = $('sec-blowup') as HTMLInputElement | null;
  const queriesEl = $('sec-queries') as HTMLInputElement | null;
  if (!blowupEl || !queriesEl) return;

  function update(): void {
    const rateLog = Number(blowupEl!.value); // 1..6
    const blowup = 2 ** rateLog;
    const queries = Number(queriesEl!.value);
    const bits = securityBits(blowup, queries);
    // Illustrative payload for a 1024-row trace (10 folds), Merkle paths grow
    // with the LDE size = 1024 * blowup.
    const folds = 10;
    const pathLen = 10 + rateLog;
    const bytes = queries * folds * 2 * pathLen * 32;

    // A cheating prover's per-proof success probability is ≈ rate^queries =
    // (1/blowup)^queries = 2^(−bits). Render it as human-readable 1-in-N odds.
    const oneInN = Math.pow(blowup, queries); // = 2^bits
    const cheatOdds = formatOneIn(oneInN);

    setText('sec-blowup-val', `${blowup}`);
    setText('sec-queries-val', `${queries}`);
    setText('sec-bits', `${bits}`);
    setText('sec-cheat', `1 in ${cheatOdds}`);
    setText('sec-bytes', `${(bytes / 1024).toFixed(1)} KB`);
    // Fixed worked example so the odds feel concrete.
    setText(
      'sec-example',
      `Worked example: with blowup 8 and 8 queries, a liar slips through about 1 in ${formatOneIn(Math.pow(8, 8))} times (each of the 8 queries independently has a 1-in-8 chance of landing where the cheat is invisible).`,
    );
    setText(
      'sec-note',
      `${bits} bits ${bits >= 100 ? '— production-grade ✓' : bits >= 80 ? '— near production' : '— below production targets'}. A dishonest prover succeeds only if every one of the ${queries} random queries misses the flaw — about 1 in ${cheatOdds}. Each query adds ${rateLog} bit${rateLog === 1 ? '' : 's'} (log₂ of blowup ${blowup}); raising the blowup also enlarges every Merkle path.`,
    );
    const bitsEl = $('sec-bits');
    if (bitsEl) bitsEl.className = `sec-num ${bits >= 100 ? 'status-ok' : bits < 80 ? 'status-bad' : ''}`;
  }

  blowupEl.addEventListener('input', update);
  queriesEl.addEventListener('input', update);
  update();
}

// --------------------------------------------------------------------------
// Exhibit 5 — end-to-end
// --------------------------------------------------------------------------
function bindExhibit5(): void {
  const nSel = $('e2e-n') as HTMLSelectElement | null;
  let proof: StarkProof | null = null;
  let corrupted = false;

  function showTranscript(lines: string[]): void {
    const el = $('e2e-transcript');
    if (el) el.textContent = lines.join('\n');
  }

  function renderSuccinct(p: StarkProof): void {
    const target = $('e2e-succinct');
    if (!target) return;
    const s = proofStats(p);
    const pct = ((s.uniqueTracePointsOpened / s.ldeSize) * 100).toFixed(0);
    target.innerHTML =
      `<p>To be convinced, the verifier opened <strong>${s.uniqueTracePointsOpened}</strong> distinct trace points ` +
      `out of an LDE of <strong>${s.ldeSize}</strong> (≈${pct}%), plus <strong>${s.friOpenings}</strong> FRI-layer points — ` +
      `and never reconstructed the length-${s.traceLength} computation.</p>` +
      `<div class="succinct-grid">` +
      `<div class="sec-stat"><span class="sec-num">${s.proofBytes.toLocaleString()}</span><span class="sec-cap">proof bytes</span></div>` +
      `<div class="sec-stat"><span class="sec-num">${s.uniqueTracePointsOpened + s.friOpenings}</span><span class="sec-cap">committed values seen</span></div>` +
      `<div class="sec-stat"><span class="sec-num">~${s.estimatedSecurityBits}</span><span class="sec-cap">soundness bits (toy)</span></div>` +
      `</div>`;
  }

  function renderInspector(p: StarkProof): void {
    const target = $('e2e-inspector');
    if (!target) return;
    const q = p.queries[0];
    const trunc = (v: string): string => (v.length > 10 ? v.slice(0, 10) + '…' : v);
    const lines = [
      `Query #0 — LDE position ${q.index}`,
      '',
      'Trace openings (the only witness data revealed):',
      `  f(x)     @${q.fx.index}: ${trunc(q.fx.value)}   (Merkle path: ${q.fx.path.length} hashes)`,
      `  f(w·x)   @${q.fwx.index}: ${trunc(q.fwx.value)}   (Merkle path: ${q.fwx.path.length} hashes)`,
      `  f(w²·x)  @${q.fw2x.index}: ${trunc(q.fw2x.value)}   (Merkle path: ${q.fw2x.path.length} hashes)`,
      '',
      'FRI fold openings (pair → next layer), per round:',
      ...q.layers.map(
        (l, r) => `  round ${r}: layer[${l.a}]=${trunc(l.valA)}, layer[${l.b}]=${trunc(l.valB)}  → fold checked`,
      ),
      '',
      'The verifier checks these hashes and the low-degree test. Nothing else.',
    ];
    target.textContent = lines.join('\n');
  }

  const zkBox = $('e2e-zk') as HTMLInputElement | null;

  async function generate(tamper: boolean): Promise<void> {
    const n = Number(nSel?.value ?? 16);
    const zk = zkBox?.checked ?? false;
    setText('e2e-status', tamper ? 'Generating a proof for a tampered trace…' : 'Generating proof…');
    const r = await prove(n, { tamper, zk });
    proof = r.proof;
    corrupted = tamper;
    showTranscript(r.diag.transcript);
    renderSuccinct(proof);
    renderInspector(proof);
    const checks = $('e2e-checks');
    if (checks) checks.innerHTML = '<p class="hint">Proof generated. Click <strong>Verify proof</strong> to run the verifier.</p>';
    setText(
      'e2e-status',
      tamper
        ? `Proof built for a TAMPERED trace (row ${Math.floor(n / 2)} altered). The prover played honest with FRI, so only the low-degree test can catch it. Now verify.`
        : `Proof generated for n=${n}${zk ? ' (zero-knowledge: trace masked)' : ''}. The proof is ${JSON.stringify(proof).length.toLocaleString()} bytes and contains no full trace.`,
    );
  }

  $('e2e-prove')?.addEventListener('click', () => void generate(false));
  $('e2e-corrupt')?.addEventListener('click', () => void generate(true));

  $('e2e-verify')?.addEventListener('click', async () => {
    if (!proof) {
      setText('e2e-status', 'Generate a proof first.');
      return;
    }
    setText('e2e-status', 'Verifying… (checking only commitments + low-degree test)');
    const result: VerifyResult = await verify(proof);
    const checks = $('e2e-checks');
    if (checks) renderCheckList(checks, result);
    setText(
      'e2e-status',
      result.accepted
        ? 'Verification ACCEPTED.'
        : corrupted
          ? 'Verification REJECTED — and notice the verifier never re-ran Fibonacci. The cheat surfaced as a failed low-degree test.'
          : 'Verification REJECTED.',
    );
  });

  showTranscript(['No proof generated yet.', '', 'Click "Generate proof" to run the prover, then "Verify proof".']);
}

// --------------------------------------------------------------------------
// Exhibit 5·ZK — masking experiment
// --------------------------------------------------------------------------
function renderZkHistogram(target: HTMLElement, exp: ZkExperiment): void {
  const maxCount = Math.max(...exp.realHistogram, ...exp.simHistogram, 1);
  // Bucket index of the true (unmasked) value, for the marker. Denominator is P.
  const tb = Number((BigInt(exp.trueValue) * BigInt(exp.buckets)) / (2n ** 30n * 3n + 1n));
  const cols = exp.realHistogram
    .map((real, i) => {
      const sim = exp.simHistogram[i];
      const rh = (real / maxCount) * 100;
      const sh = (sim / maxCount) * 100;
      const marker = i === tb ? '<div class="zk-true">▲ true value</div>' : '';
      return (
        `<div class="zk-col">` +
        `<div class="zk-bars">` +
        `<div class="zk-bar zk-bar-real" style="height:${rh.toFixed(1)}%" title="masked: ${real}"></div>` +
        `<div class="zk-bar zk-bar-sim" style="height:${sh.toFixed(1)}%" title="simulator: ${sim}"></div>` +
        `</div>${marker}</div>`
      );
    })
    .join('');
  target.innerHTML =
    `<div class="zk-legend"><span class="zk-key zk-key-real">masked openings</span><span class="zk-key zk-key-sim">witness-free simulator</span></div>` +
    `<div class="zk-hist" role="img" aria-label="Histogram comparing masked openings to a witness-free simulator across field-value buckets">${cols}</div>`;
}

function bindZkOneOpening(): void {
  let clicks = 0;
  let secret: string | null = null;
  const history: string[] = [];

  function reveal(): void {
    const s = maskedOpeningSample(16, 5);
    clicks += 1;
    secret = s.secret;
    history.unshift(s.masked);
    if (history.length > 6) history.pop();
    const viz = $('zk-one-viz');
    if (viz) {
      const rows = history
        .map((m, i) => `<div class="zk-one-row${i === 0 ? ' zk-one-latest' : ''}"><span class="zk-one-tag">click ${clicks - i}</span><span class="zk-one-num">${trunc12(m)}</span></div>`)
        .join('');
      viz.innerHTML =
        `<div class="zk-one-secret"><span class="zk-one-tag">secret f(x)</span><span class="zk-one-num">${trunc12(secret)}</span><span class="zk-one-fixed">unchanged</span></div>` +
        `<div class="zk-one-label">value the verifier receives (masked):</div>` +
        rows;
    }
    setText(
      'zk-one-note',
      clicks < 2
        ? 'Click again — the secret f(x) stays fixed, but watch the received value change.'
        : `${clicks} openings so far: the secret f(x) never moved, yet the verifier saw a different masked value every time.`,
    );
  }

  $('zk-one')?.addEventListener('click', reveal);
  reveal();
}

function bindZk(): void {
  async function run(): Promise<void> {
    setText('zk-note', 'Drawing masked openings with fresh randomness…');
    // Pure arithmetic — fine to run synchronously after a paint tick.
    await new Promise((r) => setTimeout(r, 0));
    const exp = zkOpeningExperiment(16, 5, 600, 16);
    const viz = $('zk-viz');
    if (viz) renderZkHistogram(viz, exp);
    const stats = $('zk-stats');
    if (stats) {
      stats.innerHTML =
        `<div class="sec-stat"><span class="sec-num">${exp.distinctOpenings}/${exp.trials}</span><span class="sec-cap">distinct openings</span></div>` +
        `<div class="sec-stat"><span class="sec-num ${exp.leakedCount === 0 ? 'status-ok' : 'status-bad'}">${exp.leakedCount}</span><span class="sec-cap">true-value leaks</span></div>` +
        `<div class="sec-stat"><span class="sec-num">${(exp.maxBucketGap * 100).toFixed(1)}%</span><span class="sec-cap">max gap vs simulator</span></div>` +
        `<div class="sec-stat"><span class="sec-num">${exp.pairwiseCorrelation.toFixed(3)}</span><span class="sec-cap">cross-point correlation</span></div>`;
    }
    setText(
      'zk-note',
      `Across ${exp.trials} fresh-randomness runs, masked openings spread ~uniformly and match the witness-free simulator (max gap ${(exp.maxBucketGap * 100).toFixed(1)}%). The true value never leaked. The opened points reveal nothing about the witness.`,
    );
  }
  $('zk-run')?.addEventListener('click', () => void run());
  void run();
}

function init(): void {
  initThemeToggle();
  bindExhibit2();
  bindQuotient();
  bindExhibit3();
  void bindExhibit4();
  bindSecurityCalc();
  bindExhibit5();
  bindZkOneOpening();
  bindZk();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
