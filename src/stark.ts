// An honest (if small) STARK, built on the STARK-101 construction.
//
// The lesson this module exists to teach: a STARK verifier catches a cheating
// prover *without ever re-running the computation*. It never sees the full
// trace. It only checks Merkle openings and a low-degree (FRI) test. If the
// prover tampers with even one trace cell, the constraint quotient stops being
// a polynomial, its low-degree extension is no longer low degree, and FRI
// rejects. Nothing here re-derives Fibonacci to find the cheat.
//
// Construction (single-column Fibonacci AIR):
//   trace t[i]: t[0]=t[1]=1, t[i+2]=t[i+1]+t[i]
//   trace polynomial f: interpolated over D = <w>, the N-th roots of unity
//   transition C(x) = f(w^2 x) - f(w x) - f(x), must vanish on D\{last two}
//   quotient   Q(x) = C(x) / Z_T(x)   (a polynomial iff the trace is valid)
//   boundary   B0 = (f(x)-1)/(x-1),  B1 = (f(x)-1)/(x-w)
//   composition CP = a0*B0 + a1*B1 + a2*Q     (Fiat-Shamir a0,a1,a2)
//   commit f and CP over an LDE coset; prove deg(CP) is low with real FRI.

import {
  P,
  GENERATOR,
  add,
  sub,
  mul,
  div,
  pow,
  inv,
  rootOfUnity,
  interpolate,
  polyEval,
  polyDegree,
  polyAdd,
  polyMul,
  polyDivRem,
} from './field';
import {
  buildMerkle,
  openMerkle,
  verifyOpening,
  sha256Hex,
  type MerkleOpening,
} from './merkle';

export const BLOWUP = 8; // LDE rate = 1/8
export const NUM_QUERIES = 8;
export const TOY_LABEL = 'Educational STARK over a real 2-adic field — toy parameters, not production secure.';

export type FriLayerOpening = {
  a: number; // low index inside this layer
  b: number; // sibling index a + (layerSize/2)
  valA: string;
  valB: string;
  pathA: string[];
  pathB: string[];
};

export type StarkQuery = {
  index: number; // query position in the LDE domain
  // trace openings used to recompute the composition value at this point
  fx: MerkleOpening; // f(x)
  fwx: MerkleOpening; // f(w x)
  fw2x: MerkleOpening; // f(w^2 x)
  layers: FriLayerOpening[]; // one per FRI fold
};

export type StarkProof = {
  label: string;
  params: {
    prime: string;
    generator: string;
    traceLength: number; // N
    blowup: number;
    ldeSize: number; // L = N * blowup
    numFolds: number;
    numQueries: number;
    offset: string; // coset offset
    zk: boolean; // whether the trace polynomial was masked for zero-knowledge
  };
  traceRoot: string; // Merkle root of f (or masked f') over the LDE
  alphas: string[]; // composition challenges a0,a1,a2
  compBetas: string[]; // degree-adjustment challenges b0,b1,b2
  friRoots: string[]; // Merkle root of each FRI layer (length numFolds)
  betas: string[]; // FRI folding challenges (length numFolds)
  finalLayer: string[]; // fully revealed final layer (must be constant)
  queries: StarkQuery[];
};

export type CheckResult = { name: string; ok: boolean; detail: string };
export type VerifyResult = { accepted: boolean; checks: CheckResult[] };

export type ProveResult = {
  proof: StarkProof;
  diag: {
    trace: bigint[];
    traceValid: boolean; // whether the (possibly tampered) trace satisfies the AIR
    compositionDegree: number; // actual degree of CP over the LDE (-1 if not computed)
    degreeBound: number; // the bound an honest CP stays under (= ldeSize / blowup)
    transcript: string[]; // human-readable phase log
    tampered: boolean;
    zk: boolean;
  };
};

export function buildFibonacciTrace(n: number, tamperRow = -1): bigint[] {
  const t: bigint[] = [1n, 1n];
  for (let i = 2; i < n; i += 1) t.push(add(t[i - 1], t[i - 2]));
  if (tamperRow >= 0 && tamperRow < n) t[tamperRow] = add(t[tamperRow], 1n);
  return t;
}

function traceSatisfiesAir(t: bigint[]): boolean {
  if (t[0] !== 1n || t[1] !== 1n) return false;
  for (let i = 0; i + 2 < t.length; i += 1) {
    if (sub(t[i + 2], add(t[i + 1], t[i])) !== 0n) return false;
  }
  return true;
}

async function challenge(transcript: string): Promise<bigint> {
  const h = await sha256Hex(transcript);
  const v = BigInt('0x' + h.slice(0, 16));
  return v % P === 0n ? 1n : v % P;
}

// FRI fold of one pair: low = g(x), high = g(-x); returns the next-layer value
// g_next(x^2) = (g(x)+g(-x))/2 + beta * (g(x)-g(-x))/(2x).
function friFold(low: bigint, high: bigint, beta: bigint, x: bigint): bigint {
  const even = div(add(low, high), 2n);
  const odd = div(sub(low, high), mul(2n, x));
  return add(even, mul(beta, odd));
}

// Vanishing polynomial of the transition domain (all of D except the last two
// rows, which have no successor pair): Z_T(x) = (x^N - 1) / ((x-w^{N-2})(x-w^{N-1})).
function transitionVanish(x: bigint, n: number, w: bigint): bigint {
  const numer = sub(pow(x, BigInt(n)), 1n);
  const denom = mul(sub(x, pow(w, BigInt(n - 2))), sub(x, pow(w, BigInt(n - 1))));
  return div(numer, denom);
}

// The composition value at a point, with PER-CONSTRAINT DEGREE ADJUSTMENT.
//
// CP(x) = (a0 + b0·x)·B0 + (a1 + b1·x)·B1 + (a2 + b2·x^{N-2})·Q
//   B0 = (f(x)-1)/(x-1)        boundary t[0]=1
//   B1 = (f(x)-1)/(x-w)        boundary t[1]=1
//   Q  = C(x)/Z_T(x),  C = f(w²x) - f(wx) - f(x)
//
// Each constraint quotient is lifted to a common target degree with a *second*
// random coefficient (the b_i). Without this, components of different degree
// could let a cheater hide a high-degree term in a low-degree slot; the random
// shift makes such cross-degree cancellation fail with overwhelming probability.
// The lift exponents (x¹ for the boundaries, x^{N-2} for the transition) depend
// only on the component degrees, so the SAME formula serves both the standard
// and the zero-knowledge (masked, higher-degree) prover.
function compositionValue(
  fx: bigint,
  fwx: bigint,
  fw2x: bigint,
  x: bigint,
  n: number,
  w: bigint,
  alphas: bigint[],
  compBetas: bigint[],
): bigint {
  const c = sub(sub(fw2x, fwx), fx);
  const q = div(c, transitionVanish(x, n, w));
  const b0 = div(sub(fx, 1n), sub(x, 1n));
  const b1 = div(sub(fx, 1n), sub(x, w));
  const t0 = mul(add(alphas[0], mul(compBetas[0], x)), b0);
  const t1 = mul(add(alphas[1], mul(compBetas[1], x)), b1);
  const t2 = mul(add(alphas[2], mul(compBetas[2], pow(x, BigInt(n - 2)))), q);
  return add(add(t0, t1), t2);
}

// A uniformly random field element (fresh entropy — used only for ZK masking,
// never for Fiat-Shamir). The randomness MUST be independent of the witness;
// that independence is what gives zero-knowledge.
function randomField(): bigint {
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  return ((BigInt(buf[0]) << 32n) | BigInt(buf[1])) % P;
}

export async function prove(n: number, options: { tamper?: boolean; zk?: boolean; tamperRow?: number } = {}): Promise<ProveResult> {
  const tamper = options.tamper ?? false;
  const zk = options.zk ?? false;
  const transcript: string[] = [];
  const N = n;
  // Zero-knowledge masking raises the trace polynomial's degree, so the whole
  // evaluation domain (and the FRI fold count) grows to match. The masking
  // polynomial must carry at least as many random coefficients as the number of
  // distinct trace points the verifier opens (≤ 3 per query), or the *joint*
  // distribution of those openings would not be witness-independent.
  const degreeBound = zk ? nextPow2(N + 3 * NUM_QUERIES) : N; // = L / blowup
  const L = degreeBound * BLOWUP;
  const shift = L / N; // index step on the LDE that corresponds to multiplying x by w
  const numFolds = Math.round(Math.log2(degreeBound));
  const offset = GENERATOR;
  const w = rootOfUnity(N); // trace-domain generator
  const v = rootOfUnity(L); // LDE-domain generator

  // 1. Trace + trace polynomial.
  const tamperRow = tamper ? (options.tamperRow ?? Math.floor(N / 2)) : -1;
  const trace = buildFibonacciTrace(N, tamperRow);
  const traceValid = traceSatisfiesAir(trace);
  const domain: bigint[] = [];
  for (let i = 0; i < N; i += 1) domain.push(pow(w, BigInt(i)));
  const fCoeffs = interpolate(domain, trace);

  // 1b. Zero-knowledge masking. f'(x) = f(x) + Z_D(x)·r(x), with Z_D(x)=x^N−1
  // vanishing on the trace domain and r a fresh random polynomial. On the trace
  // domain f' = f (so every constraint is untouched), but on the LDE coset the
  // opened values are blinded by randomness independent of the witness.
  let ldePoly = fCoeffs;
  if (zk) {
    const zd = new Array<bigint>(N + 1).fill(0n);
    zd[0] = sub(0n, 1n);
    zd[N] = 1n; // x^N − 1
    // r has (degreeBound − N) coefficients, so f′ has degree exactly
    // degreeBound − 1 and enough randomness to blind every opened point.
    const maskCoeffs = degreeBound - N;
    const r = new Array<bigint>(maskCoeffs).fill(0n).map(() => randomField());
    if (r[maskCoeffs - 1] === 0n) r[maskCoeffs - 1] = 1n; // keep the top degree present
    ldePoly = polyAdd(fCoeffs, polyMul(zd, r));
  }
  transcript.push(
    `1. Built length-${N} trace${tamper ? ` (TAMPERED at row ${tamperRow})` : ''}, interpolated f, ` +
      `${zk ? 'masked it as f′ = f + (xᴺ−1)·r for zero-knowledge, ' : ''}then took the low-degree extension.`,
  );

  // 2. Low-degree extension over the coset, then commit it.
  const traceLde: bigint[] = new Array(L);
  for (let j = 0; j < L; j += 1) traceLde[j] = polyEval(ldePoly, mul(offset, pow(v, BigInt(j))));
  const traceTree = await buildMerkle(traceLde);
  transcript.push(`2. Evaluated ${zk ? 'f′' : 'f'} on the ${L}-point LDE coset (blowup ${BLOWUP}) and committed it. trace root = ${traceTree.rootHex.slice(0, 16)}…`);

  // 3. Fiat-Shamir challenges from the trace commitment: composition (a) and
  // degree-adjustment (b).
  const alphas = [
    await challenge(`${traceTree.rootHex}|alpha|0`),
    await challenge(`${traceTree.rootHex}|alpha|1`),
    await challenge(`${traceTree.rootHex}|alpha|2`),
  ];
  const compBetas = [
    await challenge(`${traceTree.rootHex}|beta|0`),
    await challenge(`${traceTree.rootHex}|beta|1`),
    await challenge(`${traceTree.rootHex}|beta|2`),
  ];
  transcript.push('3. Derived composition challenges a0..a2 and degree-adjustment challenges b0..b2 from the trace root.');

  // 4. Composition polynomial CP (degree-adjusted), evaluated on the LDE coset.
  const cpLde: bigint[] = new Array(L);
  for (let j = 0; j < L; j += 1) {
    const x = mul(offset, pow(v, BigInt(j)));
    cpLde[j] = compositionValue(traceLde[j], traceLde[(j + shift) % L], traceLde[(j + 2 * shift) % L], x, N, w, alphas, compBetas);
  }

  // Teaching diagnostic only (the verifier never does this). Skipped in ZK mode
  // because the masked domain is large enough to make interpolation slow.
  let compositionDegree = -1;
  if (!zk) {
    const cosetPoints: bigint[] = [];
    for (let j = 0; j < L; j += 1) cosetPoints.push(mul(offset, pow(v, BigInt(j))));
    compositionDegree = polyDegree(interpolate(cosetPoints, cpLde));
  }
  transcript.push(
    `4. Built the degree-adjusted composition CP and evaluated it on the LDE.` +
      (compositionDegree >= 0 ? ` Actual deg(CP) = ${compositionDegree} (honest proofs keep this < ${degreeBound}).` : ` Honest deg(CP) stays < ${degreeBound}.`),
  );

  // 5. FRI commit phase: fold CP down to a constant.
  const friRoots: string[] = [];
  const betas: bigint[] = [];
  const layers: bigint[][] = [cpLde];
  const layerTrees = [await buildMerkle(cpLde)];
  friRoots.push(layerTrees[0].rootHex);

  for (let r = 0; r < numFolds; r += 1) {
    const cur = layers[r];
    const m = cur.length;
    const half = m >> 1;
    const beta = await challenge(`${friRoots.join('|')}|fold|${r}`);
    betas.push(beta);
    const offR = pow(offset, 1n << BigInt(r));
    const vR = rootOfUnity(m);
    const next: bigint[] = new Array(half);
    let xi = offR; // offR * vR^i
    for (let i = 0; i < half; i += 1) {
      next[i] = friFold(cur[i], cur[i + half], beta, xi);
      xi = mul(xi, vR);
    }
    layers.push(next);
    if (r < numFolds - 1) {
      const tree = await buildMerkle(next);
      layerTrees.push(tree);
      friRoots.push(tree.rootHex);
    }
  }
  const finalLayer = layers[layers.length - 1];
  transcript.push(
    `5. Ran ${numFolds} FRI folds (${L} → ${finalLayer.length} evaluations). Final layer is ${finalLayer.every((x) => x === finalLayer[0]) ? 'constant ✓' : 'NOT constant ✗'} — that constancy is the low-degree test.`,
  );

  // 6. Query phase: sample positions from the full transcript (Fiat-Shamir).
  const seed = `${traceTree.rootHex}|${friRoots.join('|')}|${finalLayer.join(',')}`;
  const queries: StarkQuery[] = [];
  for (let qi = 0; qi < NUM_QUERIES; qi += 1) {
    const g = Number((await challenge(`${seed}|query|${qi}`)) % BigInt(L));
    const fx = openMerkle(traceTree, g);
    const fwx = openMerkle(traceTree, (g + shift) % L);
    const fw2x = openMerkle(traceTree, (g + 2 * shift) % L);

    const layerOpenings: FriLayerOpening[] = [];
    let carry = g;
    for (let r = 0; r < numFolds; r += 1) {
      const m = L >> r;
      const half = m >> 1;
      const a = carry % half;
      const b = a + half;
      const tree = layerTrees[r];
      layerOpenings.push({
        a,
        b,
        valA: tree.values[a].toString(),
        valB: tree.values[b].toString(),
        pathA: openMerkle(tree, a).path,
        pathB: openMerkle(tree, b).path,
      });
      carry = a;
    }
    queries.push({ index: g, fx, fwx, fw2x, layers: layerOpenings });
  }
  transcript.push(`6. Opened ${NUM_QUERIES} random query positions with Merkle proofs for the trace and every FRI layer.`);

  const proof: StarkProof = {
    label: TOY_LABEL,
    params: {
      prime: P.toString(),
      generator: GENERATOR.toString(),
      traceLength: N,
      blowup: BLOWUP,
      ldeSize: L,
      numFolds,
      numQueries: NUM_QUERIES,
      offset: offset.toString(),
      zk,
    },
    traceRoot: traceTree.rootHex,
    alphas: alphas.map((a) => a.toString()),
    compBetas: compBetas.map((b) => b.toString()),
    friRoots,
    betas: betas.map((b) => b.toString()),
    finalLayer: finalLayer.map((x) => x.toString()),
    queries,
  };

  return {
    proof,
    diag: { trace, traceValid, compositionDegree, degreeBound, transcript, tampered: tamper, zk },
  };
}

// The verifier. It receives only the proof — never the trace. Every rejection
// path below is a property of the commitments and the low-degree test, not a
// recomputation of Fibonacci.
export async function verify(proof: StarkProof): Promise<VerifyResult> {
  const checks: CheckResult[] = [];
  const N = proof.params.traceLength;
  const L = proof.params.ldeSize;
  const numFolds = proof.params.numFolds;

  // 0. Proof shape. Every count below is dictated by the public protocol
  // parameters, so the verifier recomputes them instead of trusting the proof.
  // Without this, a prover could *claim* 8 queries but ship an empty query
  // list — the per-query loop would never run and every later check would
  // pass vacuously.
  const isPow2 = (x: number): boolean => Number.isInteger(x) && x > 0 && (x & (x - 1)) === 0;
  const problems: string[] = [];
  if (proof.params.blowup !== BLOWUP) problems.push(`blowup ${proof.params.blowup} ≠ ${BLOWUP}`);
  if (proof.params.numQueries !== NUM_QUERIES) problems.push(`declared queries ${proof.params.numQueries} ≠ ${NUM_QUERIES}`);
  if (!isPow2(N)) problems.push(`trace length ${N} is not a power of two`);
  const expectedBound = proof.params.zk ? nextPow2(N + 3 * NUM_QUERIES) : N;
  if (L !== expectedBound * BLOWUP) problems.push(`LDE size ${L} ≠ ${expectedBound * BLOWUP}`);
  if (numFolds !== Math.log2(expectedBound)) problems.push(`fold count ${numFolds} ≠ log₂(${expectedBound})`);
  if (proof.friRoots.length !== numFolds) problems.push(`${proof.friRoots.length} FRI roots for ${numFolds} folds`);
  if (proof.betas.length !== numFolds) problems.push(`${proof.betas.length} FRI challenges for ${numFolds} folds`);
  if (proof.alphas.length !== 3 || proof.compBetas.length !== 3) problems.push('composition challenge lists have the wrong length');
  if (proof.finalLayer.length !== L >> numFolds) problems.push(`final layer has ${proof.finalLayer.length} values, expected ${L >> numFolds}`);
  if (proof.queries.length !== NUM_QUERIES) problems.push(`proof contains ${proof.queries.length} of the required ${NUM_QUERIES} queries`);
  if (proof.queries.some((q) => q.layers.length !== numFolds)) problems.push('a query is missing FRI layer openings');
  checks.push({
    name: 'Proof shape & parameters',
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? `All counts match the protocol: ${NUM_QUERIES} queries, ${numFolds} folds, ${L >> numFolds} final-layer values.`
        : `Malformed proof: ${problems.join('; ')}. Remaining checks skipped.`,
  });
  if (problems.length > 0) return { accepted: false, checks };

  const offset = BigInt(proof.params.offset);
  const shift = L / N;
  const w = rootOfUnity(N);
  const v = rootOfUnity(L);
  const alphas = proof.alphas.map((a) => BigInt(a));
  const compBetas = proof.compBetas.map((b) => BigInt(b));
  const finalLayer = proof.finalLayer.map((x) => BigInt(x));

  // Recompute every Fiat-Shamir challenge independently.
  const expectedAlphas = [0, 1, 2].map((i) => challenge(`${proof.traceRoot}|alpha|${i}`));
  const expectedBetas = [0, 1, 2].map((i) => challenge(`${proof.traceRoot}|beta|${i}`));
  const ea = await Promise.all(expectedAlphas);
  const eb = await Promise.all(expectedBetas);
  const alphasOk = alphas.every((a, i) => a === ea[i]) && compBetas.every((b, i) => b === eb[i]);
  checks.push({
    name: 'Fiat-Shamir challenges',
    ok: alphasOk,
    detail: alphasOk ? 'Composition and degree-adjustment challenges match the trace commitment.' : 'Challenges were not honestly derived from the transcript.',
  });

  const betas: bigint[] = [];
  for (let r = 0; r < numFolds; r += 1) {
    betas.push(await challenge(`${proof.friRoots.slice(0, r === 0 ? 1 : r + 1).join('|')}|fold|${r}`));
  }

  // Final layer must be a single constant — this IS the low-degree verdict.
  const constant = finalLayer[0];
  const finalConstant = finalLayer.every((x) => x === constant);
  checks.push({
    name: 'FRI low-degree test (final layer constant)',
    ok: finalConstant,
    detail: finalConstant
      ? `Final layer collapsed to the constant ${constant} — CP is low degree.`
      : 'Final FRI layer is NOT constant — the composition polynomial is high degree, so a constraint was violated.',
  });

  // Re-derive query positions and check every opening + fold relation.
  const seed = `${proof.traceRoot}|${proof.friRoots.join('|')}|${proof.finalLayer.join(',')}`;
  let merkleOk = true;
  let cpOk = true;
  let foldOk = true;

  for (let qi = 0; qi < proof.queries.length; qi += 1) {
    const q = proof.queries[qi];
    const g = Number((await challenge(`${seed}|query|${qi}`)) % BigInt(L));
    if (q.index !== g) {
      foldOk = false;
      continue;
    }

    // (a) Trace openings against the trace root, at x, w·x, w²·x.
    const idxOk = q.fx.index === g && q.fwx.index === (g + shift) % L && q.fw2x.index === (g + 2 * shift) % L;
    const traceMerkle =
      idxOk &&
      (await verifyOpening(q.fx, proof.traceRoot)) &&
      (await verifyOpening(q.fwx, proof.traceRoot)) &&
      (await verifyOpening(q.fw2x, proof.traceRoot));
    if (!traceMerkle) merkleOk = false;

    // (b) Recompute the composition value at x from the opened trace values,
    // using exactly the same degree-adjusted formula as the prover.
    const x = mul(offset, pow(v, BigInt(g)));
    const cpVal = compositionValue(BigInt(q.fx.value), BigInt(q.fwx.value), BigInt(q.fw2x.value), x, N, w, alphas, compBetas);

    // (c) FRI layers: openings, CP-consistency, and fold relations.
    let carry = g;
    let carriedVal = cpVal; // value expected at layer 0, position `carry`
    for (let r = 0; r < numFolds; r += 1) {
      const m = L >> r;
      const half = m >> 1;
      const layer = q.layers[r];
      const a = carry % half;
      if (layer.a !== a || layer.b !== a + half) {
        foldOk = false;
        break;
      }
      const rootR = r < proof.friRoots.length ? proof.friRoots[r] : '';
      const openA: MerkleOpening = { index: layer.a, value: layer.valA, path: layer.pathA };
      const openB: MerkleOpening = { index: layer.b, value: layer.valB, path: layer.pathB };
      if (!(await verifyOpening(openA, rootR)) || !(await verifyOpening(openB, rootR))) {
        merkleOk = false;
      }
      // carried value must match this layer's committed value at `carry`.
      const here = carry < half ? BigInt(layer.valA) : BigInt(layer.valB);
      if (carriedVal !== here) cpOk = false;
      // fold to the next layer.
      const offR = pow(offset, 1n << BigInt(r));
      const xPoint = mul(offR, pow(rootOfUnity(m), BigInt(a)));
      carriedVal = friFold(BigInt(layer.valA), BigInt(layer.valB), betas[r], xPoint);
      carry = a;
    }
    // final carried value must equal the revealed final layer at `carry`.
    if (carriedVal !== finalLayer[carry % finalLayer.length]) foldOk = false;
  }

  checks.push({
    name: 'Trace & FRI Merkle openings',
    ok: merkleOk,
    detail: merkleOk ? 'All queried leaves open correctly against their commitments.' : 'A Merkle opening failed — committed data was altered.',
  });
  checks.push({
    name: 'Composition consistency',
    ok: cpOk,
    detail: cpOk
      ? 'Composition value recomputed from the trace matches the committed FRI layer 0 at every query.'
      : 'Composition value does not match the committed evaluations.',
  });
  checks.push({
    name: 'FRI fold relations',
    ok: foldOk,
    detail: foldOk ? 'Every layer folds consistently into the next at every query.' : 'A FRI fold relation failed.',
  });

  const accepted = checks.every((c) => c.ok);
  return { accepted, checks };
}

// ---------------------------------------------------------------------------
// UI helpers for the individual exhibits. These reuse the same field, the same
// real interpolation, and the same real FRI fold as the full protocol above.
// ---------------------------------------------------------------------------

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export type AirAnalysis = {
  trace: bigint[];
  transitions: { i: number; value: bigint }[]; // C(i) = t[i+2]-t[i+1]-t[i]
  boundaryOk: boolean;
  traceDegree: number; // degree of the interpolated trace polynomial
};

// Exhibit 2: expose the AIR (trace, transition residuals, boundary, degree).
export function airAnalysis(n: number, tamperRow = -1): AirAnalysis {
  const trace = buildFibonacciTrace(n, tamperRow);
  const transitions: { i: number; value: bigint }[] = [];
  for (let i = 0; i + 2 < n; i += 1) {
    transitions.push({ i, value: sub(trace[i + 2], add(trace[i + 1], trace[i])) });
  }
  const w = rootOfUnity(n);
  const domain: bigint[] = [];
  for (let i = 0; i < n; i += 1) domain.push(pow(w, BigInt(i)));
  const traceDegree = polyDegree(interpolate(domain, trace));
  return { trace, transitions, boundaryOk: trace[0] === 1n && trace[1] === 1n, traceDegree };
}

export type QuotientAnalysis = {
  n: number;
  tampered: boolean;
  tamperRow: number;
  constraintDegree: number; // deg C(x), C(x)=f(w²x)-f(wx)-f(x)
  vanishDegree: number; // deg Z_T(x) = N-2
  quotientDegree: number; // deg of C/Z_T as an interpolated function over the domain
  cleanDivision: boolean; // does Z_T divide C exactly? (remainder == 0)
  remainderDegree: number; // deg of the polynomial remainder (-1 iff clean)
  cleanQuotientBound: number; // the degree an honest quotient stays at or below (= N-2)
  // A few sample points of the "quotient function" C(x)/Z_T(x) evaluated OFF the
  // transition domain (where Z_T ≠ 0). For an honest trace these agree with the
  // low-degree quotient polynomial; for a tamper they are the values whose
  // interpolation blows the degree up.
  samplePoints: { x: string; c: string; z: string; q: string }[];
};

// Exhibit 2·5 (the missing middle step): take the SAME (possibly tampered)
// Fibonacci trace, form the transition constraint polynomial
//   C(x) = f(w²x) − f(wx) − f(x)
// and divide it by the transition vanishing polynomial Z_T(x). For an honest
// trace C vanishes on the whole transition domain, so Z_T divides C exactly and
// the quotient Q = C/Z_T is a genuine LOW-degree polynomial (deg ≤ N-2). For a
// tampered trace a single constraint is nonzero, Z_T does NOT divide C, the
// remainder is nonzero, and the quotient — as a function you must still commit
// and low-degree-test — interpolates to degree ≈ the domain size. THIS is the
// exact step where "a constraint is violated" becomes "the polynomial is not
// low degree", which is what FRI then rejects. Everything is real field
// arithmetic and real polynomial division; nothing is faked.
export function quotientAnalysis(n: number, tamperRow = -1): QuotientAnalysis {
  const N = n;
  const w = rootOfUnity(N);
  const trace = buildFibonacciTrace(N, tamperRow);
  const domain: bigint[] = [];
  for (let i = 0; i < N; i += 1) domain.push(pow(w, BigInt(i)));
  const f = interpolate(domain, trace);

  // C(x) = f(w²x) − f(wx) − f(x) as an exact coefficient polynomial. Composing
  // f with the scalar maps x↦wx, x↦w²x is just scaling coefficient k by wᵏ.
  const fwx = f.map((c, k) => mul(c, pow(w, BigInt(k))));
  const fw2x = f.map((c, k) => mul(c, pow(w, BigInt(2 * k))));
  const cPoly = polyAdd(polyAdd(fw2x, fwx.map((c) => sub(0n, c))), f.map((c) => sub(0n, c)));

  // Z_T(x) = (xᴺ − 1) / ((x − wᴺ⁻²)(x − wᴺ⁻¹)) — vanishes on every transition
  // row (D minus the last two, which have no successor pair).
  let zNum = new Array<bigint>(N + 1).fill(0n);
  zNum[0] = sub(0n, 1n);
  zNum[N] = 1n; // xᴺ − 1
  const factor1 = [sub(0n, pow(w, BigInt(N - 2))), 1n]; // (x − wᴺ⁻²)
  const factor2 = [sub(0n, pow(w, BigInt(N - 1))), 1n]; // (x − wᴺ⁻¹)
  const zDenom = polyMul(factor1, factor2);
  const zt = polyDivRem(zNum, zDenom).quotient;

  // Exact polynomial division C / Z_T.
  const { quotient, remainder } = polyDivRem(cPoly, zt);
  const remainderDegree = polyDegree(remainder);
  const cleanDivision = remainderDegree < 0;

  // The verifier does not get to divide symbolically; it only ever sees the
  // quotient as EVALUATIONS it must low-degree-test. Reconstruct that function
  // by evaluating C(x)/Z_T(x) at N points OFF the transition domain (an offset
  // coset, where Z_T ≠ 0) and interpolating. Honest ⇒ low degree; tamper ⇒ the
  // interpolant's degree blows up toward N-1, which is what FRI catches.
  const off = GENERATOR;
  const cosetPts: bigint[] = [];
  const cosetVals: bigint[] = [];
  const samplePoints: { x: string; c: string; z: string; q: string }[] = [];
  for (let i = 0; i < N; i += 1) {
    const x = mul(off, pow(w, BigInt(i)));
    const cAt = polyEval(cPoly, x);
    const zAt = polyEval(zt, x);
    const qAt = div(cAt, zAt);
    cosetPts.push(x);
    cosetVals.push(qAt);
    if (i < 4) samplePoints.push({ x: x.toString(), c: cAt.toString(), z: zAt.toString(), q: qAt.toString() });
  }
  const quotientFnDegree = polyDegree(interpolate(cosetPts, cosetVals));

  return {
    n: N,
    tampered: tamperRow >= 0,
    tamperRow,
    constraintDegree: polyDegree(cPoly),
    vanishDegree: polyDegree(zt),
    quotientDegree: cleanDivision ? polyDegree(quotient) : quotientFnDegree,
    cleanDivision,
    remainderDegree,
    cleanQuotientBound: N - 2,
    samplePoints,
  };
}

export type FriLayerInfo = { size: number; rootHex: string; beta?: string; degree: number };
export type FriDemoResult = {
  domainSize: number;
  numFolds: number;
  layers: FriLayerInfo[];
  finalConstant: boolean;
  finalValues: string[];
  proofBytesEstimate: number;
  lowDegree: boolean; // verdict: did FRI accept?
};

// Shared real FRI commit phase: fold `initialLayer` (evaluations of some
// polynomial over an offset coset of size `domainSize`) down toward a constant,
// committing every layer with a real Merkle root and deriving every folding
// challenge with Fiat-Shamir. Used both by the abstract-polynomial demo and by
// the trace-threaded demo so they exercise IDENTICAL folding code.
async function foldLayers(initialLayer: bigint[], off: bigint): Promise<FriDemoResult> {
  const domainSize = initialLayer.length;
  const numFolds = Math.round(Math.log2(domainSize / BLOWUP));
  let layer = initialLayer;
  const layers: FriLayerInfo[] = [];
  const roots: string[] = [];

  const degreeOf = (evals: bigint[], offR: bigint, vR: bigint): number => {
    const pts: bigint[] = [];
    for (let j = 0; j < evals.length; j += 1) pts.push(mul(offR, pow(vR, BigInt(j))));
    return polyDegree(interpolate(pts, evals));
  };

  for (let r = 0; r <= numFolds; r += 1) {
    const tree = await buildMerkle(layer);
    roots.push(tree.rootHex);
    const offR = pow(off, 1n << BigInt(r));
    const vR = rootOfUnity(layer.length);
    layers.push({ size: layer.length, rootHex: tree.rootHex, degree: degreeOf(layer, offR, vR) });
    if (r === numFolds) break;
    const beta = await challenge(`${roots.join('|')}|fold|${r}`);
    layers[r].beta = beta.toString();
    const half = layer.length >> 1;
    const next: bigint[] = new Array(half);
    let xi = offR;
    for (let i = 0; i < half; i += 1) {
      next[i] = friFold(layer[i], layer[i + half], beta, xi);
      xi = mul(xi, vR);
    }
    layer = next;
  }

  const finalConstant = layer.every((x) => x === layer[0]);
  const pathLen = Math.log2(domainSize);
  const proofBytesEstimate = Math.round(NUM_QUERIES * numFolds * 2 * pathLen * 32);

  return {
    domainSize,
    numFolds,
    layers,
    finalConstant,
    finalValues: layer.map((x) => x.toString()),
    proofBytesEstimate,
    lowDegree: finalConstant,
  };
}

// Exhibit 3: run real even/odd FRI folding on a chosen polynomial. With
// `tamper`, inject a high-degree term so the final layer fails to collapse —
// the same mechanism that catches a cheating prover in the full protocol.
export async function friDemo(degree: number, options: { tamper?: boolean } = {}): Promise<FriDemoResult> {
  const tamper = options.tamper ?? false;
  const domainSize = nextPow2(degree + 1) * BLOWUP;
  const off = GENERATOR;
  const v = rootOfUnity(domainSize);

  const coeffs = new Array<bigint>(domainSize).fill(0n);
  for (let i = 0; i <= degree; i += 1) coeffs[i] = BigInt(i + 1);
  if (tamper) coeffs[domainSize / 2] = 7n; // a term FRI cannot fold away

  const layer: bigint[] = new Array(domainSize);
  for (let j = 0; j < domainSize; j += 1) layer[j] = polyEval(coeffs, mul(off, pow(v, BigInt(j))));

  return foldLayers(layer, off);
}

// Exhibit 3 (threaded): fold the SAME object Exhibit 2 tampered with. We take
// the honest-or-tampered Fibonacci trace, form the transition constraint
// quotient function Q(x) = C(x)/Z_T(x) — the exact artifact the quotient panel
// just built — evaluate it on the LDE coset, and run the real FRI fold on it.
// Honest ⇒ Q is low degree ⇒ folds to a constant ⇒ ACCEPT. Tampered ⇒ Z_T does
// not divide C, Q is NOT low degree ⇒ the final layer is not constant ⇒ REJECT.
// This is the whole AIR→FRI causal chain acting on one artifact, end to end.
export async function friFromTrace(n: number, tamperRow = -1): Promise<FriDemoResult & { tampered: boolean }> {
  const N = n;
  const off = GENERATOR;
  const w = rootOfUnity(N);
  const trace = buildFibonacciTrace(N, tamperRow);
  const domain: bigint[] = [];
  for (let i = 0; i < N; i += 1) domain.push(pow(w, BigInt(i)));
  const f = interpolate(domain, trace);

  // Constraint polynomial C(x) = f(w²x) − f(wx) − f(x), exact coefficients.
  const fwx = f.map((c, k) => mul(c, pow(w, BigInt(k))));
  const fw2x = f.map((c, k) => mul(c, pow(w, BigInt(2 * k))));
  const cPoly = polyAdd(polyAdd(fw2x, fwx.map((c) => sub(0n, c))), f.map((c) => sub(0n, c)));

  // Transition vanishing polynomial Z_T(x).
  const zNum = new Array<bigint>(N + 1).fill(0n);
  zNum[0] = sub(0n, 1n);
  zNum[N] = 1n;
  const zt = polyDivRem(zNum, polyMul([sub(0n, pow(w, BigInt(N - 2))), 1n], [sub(0n, pow(w, BigInt(N - 1))), 1n])).quotient;

  // Evaluate Q(x) = C(x)/Z_T(x) on an offset LDE coset (Z_T ≠ 0 there) and fold.
  const domainSize = N * BLOWUP;
  const v = rootOfUnity(domainSize);
  const layer: bigint[] = new Array(domainSize);
  for (let j = 0; j < domainSize; j += 1) {
    const x = mul(off, pow(v, BigInt(j)));
    layer[j] = div(polyEval(cPoly, x), polyEval(zt, x));
  }

  const result = await foldLayers(layer, off);
  return { ...result, tampered: tamperRow >= 0 };
}

export type ProofStats = {
  traceLength: number;
  ldeSize: number;
  uniqueTracePointsOpened: number; // distinct trace leaves the verifier saw
  friOpenings: number; // FRI layer leaves opened across all queries
  proofBytes: number;
  estimatedSecurityBits: number;
};

export type ZkExperiment = {
  position: number;
  trials: number;
  buckets: number;
  trueValue: string; // the unmasked f(x) the verifier must NOT learn
  realHistogram: number[]; // distribution of masked openings f′(x) over fresh randomness
  simHistogram: number[]; // distribution of a simulator that knows no witness (uniform)
  distinctOpenings: number; // how many of the masked openings were unique
  leakedCount: number; // times a masked opening equalled the true value (want ~0)
  maxBucketGap: number; // max |real−sim| as a fraction of trials (small ⇒ indistinguishable)
  pairwiseCorrelation: number; // |corr| between two distinct positions' openings (want ~0)
};

// Empirically demonstrate the zero-knowledge masking. At a fixed coset point we
// draw many masked openings f′(x) = f(x) + (xᴺ−1)·r(x) with FRESH randomness and
// compare their distribution to a witness-free simulator that just outputs
// uniform field elements. Because r(x) is uniform, the masked opening is uniform
// and independent of the true f(x): the two histograms match and the true value
// never leaks. This is the core of the masking ZK argument made measurable.
//
// Honesty note: this checks the (necessary) condition that revealed values are
// distributed independently of the witness. It is strong evidence, not a formal
// zero-knowledge proof — that requires a simulator argument over full transcripts.
export function zkOpeningExperiment(n: number, position: number, trials: number, buckets = 16): ZkExperiment {
  const N = n;
  const degreeBound = nextPow2(N + 3 * NUM_QUERIES);
  const maskCoeffs = degreeBound - N;
  const L = degreeBound * BLOWUP;
  const off = GENERATOR;
  const v = rootOfUnity(L);
  const w = rootOfUnity(N);
  const trace = buildFibonacciTrace(N);
  const domain: bigint[] = [];
  for (let i = 0; i < N; i += 1) domain.push(pow(w, BigInt(i)));
  const fCoeffs = interpolate(domain, trace);

  const x = mul(off, pow(v, BigInt(position % L)));
  const x2 = mul(off, pow(v, BigInt((position + 7) % L))); // a second, distinct point
  const trueValue = polyEval(fCoeffs, x);
  const zdx = sub(pow(x, BigInt(N)), 1n);
  const zdx2 = sub(pow(x2, BigInt(N)), 1n);
  const f2 = polyEval(fCoeffs, x2);

  const evalR = (coeffs: bigint[], at: bigint): bigint => {
    let acc = 0n;
    let xp = 1n;
    for (let k = 0; k < coeffs.length; k += 1) {
      acc = add(acc, mul(coeffs[k], xp));
      xp = mul(xp, at);
    }
    return acc;
  };

  const realHistogram = new Array<number>(buckets).fill(0);
  const simHistogram = new Array<number>(buckets).fill(0);
  const seen = new Set<string>();
  let leakedCount = 0;
  const aVals: number[] = [];
  const bVals: number[] = [];
  const bucketOf = (val: bigint): number => Number((val * BigInt(buckets)) / P);

  for (let t = 0; t < trials; t += 1) {
    const r = new Array<bigint>(maskCoeffs).fill(0n).map(() => randomField());
    const masked = add(trueValue, mul(zdx, evalR(r, x)));
    const masked2 = add(f2, mul(zdx2, evalR(r, x2)));
    realHistogram[bucketOf(masked)] += 1;
    simHistogram[bucketOf(randomField())] += 1;
    seen.add(masked.toString());
    if (masked === trueValue) leakedCount += 1;
    aVals.push(Number((masked * 1000n) / P));
    bVals.push(Number((masked2 * 1000n) / P));
  }

  let maxBucketGap = 0;
  for (let i = 0; i < buckets; i += 1) {
    maxBucketGap = Math.max(maxBucketGap, Math.abs(realHistogram[i] - simHistogram[i]) / trials);
  }

  // Pearson correlation between two positions' openings (independence check).
  const mean = (a: number[]): number => a.reduce((s, z) => s + z, 0) / a.length;
  const ma = mean(aVals);
  const mb = mean(bVals);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < aVals.length; i += 1) {
    cov += (aVals[i] - ma) * (bVals[i] - mb);
    va += (aVals[i] - ma) ** 2;
    vb += (bVals[i] - mb) ** 2;
  }
  const pairwiseCorrelation = va > 0 && vb > 0 ? Math.abs(cov / Math.sqrt(va * vb)) : 0;

  return {
    position,
    trials,
    buckets,
    trueValue: trueValue.toString(),
    realHistogram,
    simHistogram,
    distinctOpenings: seen.size,
    leakedCount,
    maxBucketGap,
    pairwiseCorrelation,
  };
}

// One masked opening of a fixed point, with fresh randomness each call. Returns
// the (unchanging) secret f(x) and the (blinded) value the verifier actually
// receives: f′(x) = f(x) + (xᴺ−1)·r(x). The point of drawing it live is to let a
// learner SEE that the received value moves every click while the secret does
// not — the mechanism the histogram then aggregates. Real field arithmetic.
export function maskedOpeningSample(n: number, position: number): { secret: string; masked: string } {
  const N = n;
  const degreeBound = nextPow2(N + 3 * NUM_QUERIES);
  const maskCoeffs = degreeBound - N;
  const L = degreeBound * BLOWUP;
  const off = GENERATOR;
  const v = rootOfUnity(L);
  const w = rootOfUnity(N);
  const trace = buildFibonacciTrace(N);
  const domain: bigint[] = [];
  for (let i = 0; i < N; i += 1) domain.push(pow(w, BigInt(i)));
  const fCoeffs = interpolate(domain, trace);
  const x = mul(off, pow(v, BigInt(position % L)));
  const secret = polyEval(fCoeffs, x);
  const zdx = sub(pow(x, BigInt(N)), 1n);
  const r = new Array<bigint>(maskCoeffs).fill(0n).map(() => randomField());
  let rx = 0n;
  let xp = 1n;
  for (let k = 0; k < r.length; k += 1) {
    rx = add(rx, mul(r[k], xp));
    xp = mul(xp, x);
  }
  const masked = add(secret, mul(zdx, rx));
  return { secret: secret.toString(), masked: masked.toString() };
}

// Quantify succinctness: how little of the witness the verifier actually sees.
export function proofStats(proof: StarkProof): ProofStats {
  const traceIdx = new Set<number>();
  let friOpenings = 0;
  for (const q of proof.queries) {
    traceIdx.add(q.fx.index);
    traceIdx.add(q.fwx.index);
    traceIdx.add(q.fw2x.index);
    friOpenings += q.layers.length * 2;
  }
  return {
    traceLength: proof.params.traceLength,
    ldeSize: proof.params.ldeSize,
    uniqueTracePointsOpened: traceIdx.size,
    friOpenings,
    proofBytes: JSON.stringify(proof).length,
    estimatedSecurityBits: securityBits(proof.params.blowup, proof.params.numQueries),
  };
}

// Toy soundness estimate. The dominant FRI query term is rate^(-queries), i.e.
// each query contributes log2(blowup) bits. Real analyses add commit-phase and
// proximity-gap terms; this is the headline figure used for teaching.
export function securityBits(blowup: number, queries: number): number {
  return Math.round(queries * Math.log2(blowup));
}

// re-export for convenience
export { rootOfUnity, inv, P };
