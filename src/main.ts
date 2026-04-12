type TraceRow = { a: bigint; b: bigint };

type MerkleTree = {
  leaves: Uint8Array[];
  levels: Uint8Array[][];
  root: Uint8Array;
  rootHex: string;
};

type MerkleOpening = {
  index: number;
  value: bigint;
  leafHashHex: string;
  path: string[];
};

type FriQueryRound = {
  round: number;
  leftIndex: number;
  rightIndex: number;
  leftValue: string;
  rightValue: string;
  leftPath: string[];
  rightPath: string[];
  nextValue?: string;
  nextPath?: string[];
};

type FriQuery = {
  basePairIndex: number;
  rounds: FriQueryRound[];
};

type ToyProof = {
  label: string;
  fieldPrime: string;
  traceLength: number;
  traceRoot: string;
  compositionRoots: string[];
  friChallenges: string[];
  finalConstant: string;
  queries: FriQuery[];
  packedTrace: string[];
  ldeLength: number;
  queryCount: number;
};

const P = 2147483647n;
const TOY_LABEL = 'Educational STARK over small field - not production parameters.';

function mod(n: bigint): bigint {
  const v = n % P;
  return v >= 0n ? v : v + P;
}

function add(a: bigint, b: bigint): bigint {
  return mod(a + b);
}

function sub(a: bigint, b: bigint): bigint {
  return mod(a - b);
}

function mul(a: bigint, b: bigint): bigint {
  return mod(a * b);
}

function powMod(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) {
      result = mul(result, b);
    }
    b = mul(b, b);
    e >>= 1n;
  }
  return result;
}

function inv(a: bigint): bigint {
  if (a === 0n) {
    throw new Error('Division by zero in field');
  }
  return powMod(a, P - 2n);
}

function div(a: bigint, b: bigint): bigint {
  return mul(a, inv(b));
}

function bigintToBytes32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = mod(v);
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hexString: string): Uint8Array {
  const clean = hexString.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return new Uint8Array(digest);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

async function hashLeaf(value: bigint): Promise<Uint8Array> {
  const preimage = concatBytes(new TextEncoder().encode('leaf:'), bigintToBytes32(value));
  return sha256(preimage);
}

async function buildMerkle(values: bigint[]): Promise<MerkleTree> {
  if (values.length === 0 || (values.length & (values.length - 1)) !== 0) {
    throw new Error('Merkle inputs must be non-empty and power-of-two length');
  }

  const leaves = await Promise.all(values.map((v) => hashLeaf(v)));
  const levels: Uint8Array[][] = [leaves];
  let current = leaves;

  while (current.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(await sha256(concatBytes(current[i], current[i + 1])));
    }
    levels.push(next);
    current = next;
  }

  return {
    leaves,
    levels,
    root: levels[levels.length - 1][0],
    rootHex: hex(levels[levels.length - 1][0]),
  };
}

function openMerkle(tree: MerkleTree, values: bigint[], index: number): MerkleOpening {
  const path: string[] = [];
  let idx = index;
  for (let level = 0; level < tree.levels.length - 1; level += 1) {
    const sibling = idx ^ 1;
    path.push(hex(tree.levels[level][sibling]));
    idx = Math.floor(idx / 2);
  }
  return {
    index,
    value: values[index],
    leafHashHex: hex(tree.leaves[index]),
    path,
  };
}

async function verifyMerkleOpening(opening: MerkleOpening, expectedRootHex: string): Promise<boolean> {
  let h = await hashLeaf(opening.value);
  let idx = opening.index;
  for (const siblingHex of opening.path) {
    const sibling = fromHex(siblingHex);
    if (idx % 2 === 0) {
      h = await sha256(concatBytes(h, sibling));
    } else {
      h = await sha256(concatBytes(sibling, h));
    }
    idx = Math.floor(idx / 2);
  }
  return hex(h) === expectedRootHex;
}

function packRow(row: TraceRow): bigint {
  return add(row.a, mul(row.b, 65537n));
}

function buildFibonacciTrace(n: number): TraceRow[] {
  const rows: TraceRow[] = [];
  let a = 1n;
  let b = 1n;
  rows.push({ a, b });
  for (let i = 1; i < n; i += 1) {
    const nextA = b;
    const nextB = add(a, b);
    rows.push({ a: nextA, b: nextB });
    a = nextA;
    b = nextB;
  }
  return rows;
}

function evaluateConstraints(trace: TraceRow[]): bigint[] {
  const out: bigint[] = [];
  for (let i = 0; i < trace.length - 1; i += 1) {
    const row = trace[i];
    const next = trace[i + 1];
    const c1 = sub(next.a, row.b);
    const c2 = sub(next.b, add(row.a, row.b));
    out.push(add(c1, c2));
  }
  return out;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function padToPow2(values: bigint[]): bigint[] {
  const size = nextPow2(values.length);
  const out = [...values];
  while (out.length < size) {
    out.push(0n);
  }
  return out;
}

function interpolate(xs: bigint[], ys: bigint[]): bigint[] {
  const n = xs.length;
  let poly: bigint[] = [0n];

  for (let i = 0; i < n; i += 1) {
    let basis: bigint[] = [1n];
    let denom = 1n;

    for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      basis = polyMul(basis, [sub(0n, xs[j]), 1n]);
      denom = mul(denom, sub(xs[i], xs[j]));
    }

    const scale = div(ys[i], denom);
    basis = basis.map((c) => mul(c, scale));
    poly = polyAdd(poly, basis);
  }

  return poly.map(mod);
}

function polyAdd(a: bigint[], b: bigint[]): bigint[] {
  const len = Math.max(a.length, b.length);
  const out = new Array<bigint>(len).fill(0n);
  for (let i = 0; i < len; i += 1) {
    out[i] = add(a[i] ?? 0n, b[i] ?? 0n);
  }
  return out;
}

function polyMul(a: bigint[], b: bigint[]): bigint[] {
  const out = new Array<bigint>(a.length + b.length - 1).fill(0n);
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      out[i + j] = add(out[i + j], mul(a[i], b[j]));
    }
  }
  return out;
}

function polyEval(coeffs: bigint[], x: bigint): bigint {
  let acc = 0n;
  for (let i = coeffs.length - 1; i >= 0; i -= 1) {
    acc = add(mul(acc, x), coeffs[i]);
  }
  return acc;
}

async function challengeFromTranscript(transcript: string): Promise<bigint> {
  const h = await sha256(new TextEncoder().encode(transcript));
  let v = 0n;
  for (let i = 0; i < 8; i += 1) {
    v = (v << 8n) + BigInt(h[i]);
  }
  return mod(v || 1n);
}

async function buildToyProof(n: number, tamper = false): Promise<{ proof: ToyProof; trace: TraceRow[]; queryRows: number[] }> {
  const trace = buildFibonacciTrace(n);
  if (tamper && trace.length > 4) {
    trace[4] = { a: add(trace[4].a, 3n), b: trace[4].b };
  }

  const packedTrace = padToPow2(trace.map(packRow));
  const traceTree = await buildMerkle(packedTrace);

  const constraints = evaluateConstraints(trace);
  const constraintPoints = constraints.map((_, i) => BigInt(i + 1));
  const coeffs = interpolate(constraintPoints, constraints);
  const ldeLength = 16;
  const compositionValues = new Array<bigint>(ldeLength)
    .fill(0n)
    .map((_, i) => polyEval(coeffs, BigInt(i + 1)));

  const roundsValues: bigint[][] = [compositionValues];
  const roundTrees: MerkleTree[] = [await buildMerkle(compositionValues)];
  const challenges: bigint[] = [];

  const maxRounds = 3;
  for (let r = 0; r < maxRounds; r += 1) {
    const current = roundsValues[r];
    const challenge = await challengeFromTranscript(`${roundTrees.map((t) => t.rootHex).join('|')}|r${r}`);
    challenges.push(challenge);

    const next: bigint[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(add(current[i], mul(challenge, current[i + 1])));
    }

    roundsValues.push(next);
    roundTrees.push(await buildMerkle(next));
    if (next.length <= 2) {
      break;
    }
  }

  const finalConstant = roundsValues[roundsValues.length - 1][0];
  const queryCount = 4;
  const queries: FriQuery[] = [];

  const baseLen = roundsValues[0].length / 2;
  for (let q = 0; q < queryCount; q += 1) {
    const seed = await challengeFromTranscript(`${roundTrees[0].rootHex}|q${q}|${n}`);
    const basePairIndex = Number(seed % BigInt(baseLen));
    const rounds: FriQueryRound[] = [];
    let pairIndex = basePairIndex;

    for (let r = 0; r < roundsValues.length - 1; r += 1) {
      const currentVals = roundsValues[r];
      const nextVals = roundsValues[r + 1];
      const leftIndex = pairIndex * 2;
      const rightIndex = leftIndex + 1;

      const leftOpen = openMerkle(roundTrees[r], currentVals, leftIndex);
      const rightOpen = openMerkle(roundTrees[r], currentVals, rightIndex);
      const nextOpen = openMerkle(roundTrees[r + 1], nextVals, pairIndex);

      rounds.push({
        round: r,
        leftIndex,
        rightIndex,
        leftValue: leftOpen.value.toString(),
        rightValue: rightOpen.value.toString(),
        leftPath: leftOpen.path,
        rightPath: rightOpen.path,
        nextValue: nextOpen.value.toString(),
        nextPath: nextOpen.path,
      });

      pairIndex = Math.floor(pairIndex / 2);
    }

    queries.push({ basePairIndex, rounds });
  }

  const queryRows = [...new Set(queries.map((q) => q.basePairIndex % Math.max(1, trace.length - 1)))];

  return {
    proof: {
      label: TOY_LABEL,
      fieldPrime: P.toString(),
      traceLength: trace.length,
      traceRoot: traceTree.rootHex,
      compositionRoots: roundTrees.map((t) => t.rootHex),
      friChallenges: challenges.map((c) => c.toString()),
      finalConstant: finalConstant.toString(),
      queries,
      packedTrace: packedTrace.map((v) => v.toString()),
      ldeLength,
      queryCount,
    },
    trace,
    queryRows,
  };
}

async function verifyToyProof(proof: ToyProof): Promise<{ ok: boolean; details: string[] }> {
  const details: string[] = [];
  const challenges = proof.friChallenges.map((c) => BigInt(c));

  for (const q of proof.queries) {
    for (let r = 0; r < q.rounds.length; r += 1) {
      const round = q.rounds[r];
      const leftOpen: MerkleOpening = {
        index: round.leftIndex,
        value: BigInt(round.leftValue),
        leafHashHex: '',
        path: round.leftPath,
      };
      const rightOpen: MerkleOpening = {
        index: round.rightIndex,
        value: BigInt(round.rightValue),
        leafHashHex: '',
        path: round.rightPath,
      };
      const leftOk = await verifyMerkleOpening(leftOpen, proof.compositionRoots[r]);
      const rightOk = await verifyMerkleOpening(rightOpen, proof.compositionRoots[r]);
      if (!leftOk || !rightOk) {
        return { ok: false, details: [...details, `Merkle opening failed at round ${r}`] };
      }

      const expectedNext = add(BigInt(round.leftValue), mul(challenges[r], BigInt(round.rightValue)));
      if (round.nextValue === undefined || round.nextPath === undefined) {
        return { ok: false, details: [...details, `Missing next-round opening at round ${r}`] };
      }

      const nextOpen: MerkleOpening = {
        index: Math.floor(round.leftIndex / 2),
        value: BigInt(round.nextValue),
        leafHashHex: '',
        path: round.nextPath,
      };
      const nextOk = await verifyMerkleOpening(nextOpen, proof.compositionRoots[r + 1]);
      if (!nextOk) {
        return { ok: false, details: [...details, `Next-round Merkle opening failed at round ${r}`] };
      }

      if (expectedNext !== BigInt(round.nextValue)) {
        return { ok: false, details: [...details, `FRI fold mismatch at round ${r}`] };
      }
    }
  }

  details.push('All Merkle openings and fold relations validated.');
  return { ok: true, details };
}

function initThemeToggle(): void {
  const root = document.documentElement;
  const header = document.querySelector('.site-header');
  if (!header) return;

  const button = document.createElement('button');
  button.className = 'theme-toggle';
  button.type = 'button';

  function applyButtonState(): void {
    const current = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const isDark = current === 'dark';
    button.textContent = isDark ? '🌙' : '☀️';
    button.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
  }

  button.addEventListener('click', () => {
    const current = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    applyButtonState();
  });

  header.appendChild(button);
  applyButtonState();
}

function renderTraceTable(trace: TraceRow[], queriedRows: number[] = []): void {
  const table = document.getElementById('air-trace-table');
  if (!table) return;
  table.innerHTML = '';

  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>step</th><th>a</th><th>b</th><th>queried</th></tr>';
  const tbody = document.createElement('tbody');

  trace.forEach((row, i) => {
    const tr = document.createElement('tr');
    if (queriedRows.includes(i)) {
      tr.className = 'trace-queried';
    }
    tr.innerHTML = `<td>${i}</td><td>${row.a}</td><td>${row.b}</td><td>${queriedRows.includes(i) ? 'yes' : 'no'}</td>`;
    tbody.appendChild(tr);
  });

  table.appendChild(thead);
  table.appendChild(tbody);
}

function bindExhibit4(): void {
  const benchmarks = [
    { system: 'Groth16 (SNARK)', computation: 'Any circuit', bytes: 128, verification: '~1ms' },
    { system: 'PLONK (SNARK)', computation: 'Any circuit', bytes: 400, verification: '~3ms' },
    { system: 'STARK (BLAKE3 hash)', computation: 'Fibonacci (1M steps)', bytes: 45 * 1024, verification: '~10ms' },
    { system: 'STARK (SHA-256)', computation: 'SHA-256 circuit', bytes: 100 * 1024, verification: '~20ms' },
    { system: 'StarkNet-style STARK', computation: 'Cairo VM execution', bytes: 175 * 1024, verification: '~50ms' },
    { system: 'Risc Zero receipt', computation: 'RISC-V execution', bytes: 200 * 1024, verification: '~50ms' },
  ];

  const table = document.getElementById('size-table');
  if (table) {
    table.innerHTML = [
      '<thead><tr><th>System</th><th>Computation</th><th>Proof Size</th><th>Verification</th></tr></thead>',
      '<tbody>',
      ...benchmarks.map((b) => `<tr><td>${b.system}</td><td>${b.computation}</td><td>${b.bytes.toLocaleString()} bytes</td><td>${b.verification}</td></tr>`),
      '</tbody>',
    ].join('');
  }

  const chart = document.getElementById('size-chart');
  if (!chart) return;

  const minLog = Math.log10(Math.min(...benchmarks.map((b) => b.bytes)));
  const maxLog = Math.log10(Math.max(...benchmarks.map((b) => b.bytes)));

  chart.innerHTML = '';
  for (const b of benchmarks) {
    const scaled = ((Math.log10(b.bytes) - minLog) / (maxLog - minLog || 1)) * 100;
    const row = document.createElement('div');
    row.className = 'chart-row';
    row.innerHTML = `
      <div class="chart-label">${b.system}</div>
      <div class="chart-bar-wrap"><div class="chart-bar" style="width:${Math.max(4, scaled)}%"></div></div>
      <div class="chart-value">${b.bytes.toLocaleString()}</div>
    `;
    chart.appendChild(row);
  }
}

let airTrace: TraceRow[] = [];
let airProof: ToyProof | null = null;
let airQueryRows: number[] = [];

function bindExhibit2(): void {
  const nInput = document.getElementById('air-n') as HTMLInputElement | null;
  const status = document.getElementById('air-status');
  const constraintsOut = document.getElementById('air-constraints');
  const proofOut = document.getElementById('air-proof');

  document.getElementById('air-generate-trace')?.addEventListener('click', () => {
    const n = Math.min(16, Math.max(8, Number(nInput?.value ?? 16)));
    airTrace = buildFibonacciTrace(n);
    renderTraceTable(airTrace);
    if (status) status.textContent = `Trace generated with ${n} rows.`;
  });

  document.getElementById('air-generate-constraints')?.addEventListener('click', () => {
    if (airTrace.length === 0) {
      airTrace = buildFibonacciTrace(Math.min(16, Math.max(8, Number(nInput?.value ?? 16))));
      renderTraceTable(airTrace);
    }

    const lines = [
      'Transition constraints:',
      'C1(i) = next_a(i) - b(i) = 0',
      'C2(i) = next_b(i) - (a(i) + b(i)) = 0',
      'Boundary: a(0)=1, b(0)=1',
      '',
      ...evaluateConstraints(airTrace).map((v, i) => `row ${i}: C1 + C2 = ${v}`),
    ];
    if (constraintsOut) constraintsOut.textContent = lines.join('\n');
    if (status) status.textContent = 'AIR constraints displayed.';
  });

  document.getElementById('air-prove')?.addEventListener('click', async () => {
    const n = Math.min(16, Math.max(8, Number(nInput?.value ?? 16)));
    const { proof, trace, queryRows } = await buildToyProof(n);
    airTrace = trace;
    airProof = proof;
    airQueryRows = queryRows;
    renderTraceTable(airTrace, airQueryRows);

    if (proofOut) {
      proofOut.textContent = [
        `${proof.label}`,
        `Trace commitment root: ${proof.traceRoot}`,
        ...proof.compositionRoots.map((r, i) => `FRI round ${i} root: ${r}`),
        `Final constant: ${proof.finalConstant}`,
        `Queries: ${proof.queryCount} (rows: ${airQueryRows.join(', ')})`,
      ].join('\n');
    }

    if (status) status.textContent = 'Proof generated. Verifier can now sample queried rows.';
  });

  document.getElementById('air-verify')?.addEventListener('click', async () => {
    if (!airProof) {
      if (status) status.textContent = 'Generate a proof first.';
      return;
    }

    const constraintsHold = airQueryRows.every((i) => {
      if (i >= airTrace.length - 1) return true;
      const row = airTrace[i];
      const next = airTrace[i + 1];
      return next.a === row.b && next.b === add(row.a, row.b);
    });

    const friResult = await verifyToyProof(airProof);
    const valid = constraintsHold && friResult.ok;

    if (proofOut) {
      proofOut.textContent = `${proofOut.textContent ?? ''}\n\nVerifier checks:\n- Queried transition checks: ${constraintsHold ? 'pass' : 'fail'}\n- FRI consistency: ${friResult.ok ? 'pass' : 'fail'}\n- Result: ${valid ? '✓ valid proof' : '✗ invalid proof'}`;
    }

    if (status) status.textContent = valid ? 'Verification succeeded.' : 'Verification failed.';
  });
}

let friState: {
  values: bigint[];
  roots: string[];
  rounds: bigint[][];
  trees: MerkleTree[];
  challenges: bigint[];
} | null = null;

function bindExhibit3(): void {
  const degreeInput = document.getElementById('fri-degree') as HTMLSelectElement | null;
  const status = document.getElementById('fri-status');
  const log = document.getElementById('fri-log');
  const size = document.getElementById('fri-size');

  function logLine(text: string): void {
    if (!log) return;
    log.textContent = `${log.textContent ?? ''}${text}\n`;
  }

  document.getElementById('fri-commit')?.addEventListener('click', async () => {
    const degree = Number(degreeInput?.value ?? 8);
    const coeffs = new Array<bigint>(degree + 1).fill(0n).map((_, i) => BigInt(i + 3));
    const domainSize = nextPow2((degree + 1) * 2);
    const values = new Array<bigint>(domainSize).fill(0n).map((_, i) => polyEval(coeffs, BigInt(i + 1)));
    const tree = await buildMerkle(values);

    friState = {
      values,
      roots: [tree.rootHex],
      rounds: [values],
      trees: [tree],
      challenges: [],
    };

    if (log) log.textContent = '';
    logLine(`Round 0 commit root: ${tree.rootHex}`);
    if (status) status.textContent = `Committed degree-${degree} polynomial evaluations.`;
    if (size) size.textContent = `Current proof payload estimate: ${(4 * Math.log2(domainSize) * 32).toFixed(0)} bytes.`;
  });

  document.getElementById('fri-fold')?.addEventListener('click', async () => {
    if (!friState) {
      if (status) status.textContent = 'Run commit first.';
      return;
    }

    const current = friState.rounds[friState.rounds.length - 1];
    if (current.length <= 2) {
      if (status) status.textContent = 'Already at final round.';
      return;
    }

    const challenge = await challengeFromTranscript(`${friState.roots.join('|')}|fold${friState.rounds.length}`);
    friState.challenges.push(challenge);
    const next: bigint[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(add(current[i], mul(challenge, current[i + 1])));
    }
    const tree = await buildMerkle(next);
    friState.rounds.push(next);
    friState.trees.push(tree);
    friState.roots.push(tree.rootHex);

    logLine(`Fold round ${friState.rounds.length - 1}: challenge=${challenge}, new root=${tree.rootHex}, degree halved.`);
    if (status) status.textContent = `Folded to ${next.length} evaluations.`;
    if (size) {
      const pathLen = Math.log2(friState.rounds[0].length);
      const est = friState.rounds.length * 4 * pathLen * 32;
      size.textContent = `Current proof payload estimate: ${Math.round(est).toLocaleString()} bytes.`;
    }
  });

  document.getElementById('fri-query')?.addEventListener('click', async () => {
    if (!friState || friState.rounds.length < 2) {
      if (status) status.textContent = 'Commit and fold at least once first.';
      return;
    }

    const firstLen = friState.rounds[0].length / 2;
    const seed = await challengeFromTranscript(`${friState.roots[0]}|query`);
    const pair = Number(seed % BigInt(firstLen));
    logLine(`Query phase pair index chosen: ${pair}`);

    let idx = pair;
    for (let r = 0; r < friState.rounds.length - 1; r += 1) {
      const left = idx * 2;
      const right = left + 1;
      const next = idx;
      const leftOpen = openMerkle(friState.trees[r], friState.rounds[r], left);
      const rightOpen = openMerkle(friState.trees[r], friState.rounds[r], right);
      const nextOpen = openMerkle(friState.trees[r + 1], friState.rounds[r + 1], next);
      logLine(`Round ${r} openings:`);
      logLine(`  left=${leftOpen.value} right=${rightOpen.value} next=${nextOpen.value}`);
      logLine(`  Merkle path length=${leftOpen.path.length}`);
      idx = Math.floor(idx / 2);
    }

    if (status) status.textContent = 'Query phase complete; see transcript.';
  });
}

let e2eProof: ToyProof | null = null;
let e2eTrace: TraceRow[] = [];

function bindExhibit5(): void {
  const nInput = document.getElementById('e2e-n') as HTMLInputElement | null;
  const status = document.getElementById('e2e-status');
  const log = document.getElementById('e2e-log');

  function write(text: string): void {
    if (log) log.textContent = text;
  }

  document.getElementById('e2e-prove')?.addEventListener('click', async () => {
    const n = Math.min(16, Math.max(8, Number(nInput?.value ?? 16)));
    const { proof, trace } = await buildToyProof(n, false);
    e2eProof = proof;
    e2eTrace = trace;
    write(JSON.stringify(proof, null, 2));
    if (status) status.textContent = `Proof generated (${proof.queryCount} queries per protocol).`;
  });

  document.getElementById('e2e-verify')?.addEventListener('click', async () => {
    if (!e2eProof) {
      if (status) status.textContent = 'Generate proof first.';
      return;
    }

    const fri = await verifyToyProof(e2eProof);
    const boundary = e2eTrace[0]?.a === 1n && e2eTrace[0]?.b === 1n;
    const transitions = e2eTrace.slice(0, -1).every((row, i) => {
      const next = e2eTrace[i + 1];
      return next.a === row.b && next.b === add(row.a, row.b);
    });

    const ok = fri.ok && boundary && transitions;
    const report = [
      `Verification outcome: ${ok ? '✓ valid' : '✗ invalid'}`,
      `Boundary check: ${boundary ? 'pass' : 'fail'}`,
      `Transition checks: ${transitions ? 'pass' : 'fail'}`,
      `FRI checks: ${fri.ok ? 'pass' : 'fail'}`,
      ...fri.details,
    ];

    write(`${log?.textContent ?? ''}\n\n${report.join('\n')}`);
    if (status) status.textContent = ok ? 'Verification accepted.' : 'Verification rejected.';
  });

  document.getElementById('e2e-corrupt')?.addEventListener('click', async () => {
    const n = Math.min(16, Math.max(8, Number(nInput?.value ?? 16)));
    const { proof, trace } = await buildToyProof(n, true);
    e2eProof = proof;
    e2eTrace = trace;
    if (status) status.textContent = 'Trace corrupted intentionally. Run verify to observe rejection.';
    write(`${JSON.stringify(proof, null, 2)}\n\nTamper marker: row 4 altered before commitment.`);
  });
}

function init(): void {
  initThemeToggle();
  bindExhibit2();
  bindExhibit3();
  bindExhibit4();
  bindExhibit5();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
