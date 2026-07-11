// Crypto correctness self-test. Bundled by esbuild and run under Node.
// Asserts: honest proofs verify; tampered proofs are rejected BY THE PROOF
// SYSTEM (low-degree test), not by recomputing the trace.
import { prove, verify, airAnalysis, friDemo, zkOpeningExperiment } from '../src/stark';
import { P, GENERATOR, rootOfUnity, pow, mul } from '../src/field';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures += 1;
}

async function main() {
  // Field sanity.
  check('prime is 3*2^30+1', P === 3221225473n);
  check('5 is generator order check (5^(p-1)=1)', pow(GENERATOR, P - 1n) === 1n);
  for (const N of [8, 16]) {
    const w = rootOfUnity(N);
    check(`w^N=1 for N=${N}`, pow(w, BigInt(N)) === 1n);
    check(`w is primitive (w^(N/2)!=1) N=${N}`, pow(w, BigInt(N / 2)) !== 1n);
    const v = rootOfUnity(N * 8);
    check(`v^blowup = w for N=${N}`, pow(v, 8n) === w);
  }

  for (const N of [8, 16]) {
    // Honest proof must verify.
    const { proof, diag } = await prove(N);
    check(`honest trace valid N=${N}`, diag.traceValid);
    check(`honest deg(CP) < N N=${N}`, diag.compositionDegree < N, `deg=${diag.compositionDegree}`);
    const res = await verify(proof);
    check(`honest proof ACCEPTED N=${N}`, res.accepted, res.checks.filter((c) => !c.ok).map((c) => c.name).join(', '));

    // Tampered proof must be rejected.
    const t = await prove(N, { tamper: true });
    check(`tampered trace invalid N=${N}`, !t.diag.traceValid);
    check(`tampered deg(CP) high N=${N}`, t.diag.compositionDegree >= N, `deg=${t.diag.compositionDegree}`);
    const tres = await verify(t.proof);
    check(`tampered proof REJECTED N=${N}`, !tres.accepted);
    // The rejection must come from the low-degree test, NOT from recomputation.
    const lowDeg = tres.checks.find((c) => c.name.includes('low-degree'));
    check(`tampered rejection is via low-degree test N=${N}`, !!lowDeg && !lowDeg.ok, lowDeg?.detail);

    // A flipped commitment leaf must break Merkle verification.
    const bad = JSON.parse(JSON.stringify(proof)) as typeof proof;
    bad.queries[0].fx.value = (BigInt(bad.queries[0].fx.value) + 1n).toString();
    const bres = await verify(bad);
    check(`flipped trace leaf REJECTED N=${N}`, !bres.accepted);
  }

  // airAnalysis: honest trace has all-zero transition residuals; tampered does not.
  const airOk = airAnalysis(16);
  check('airAnalysis honest residuals all zero', airOk.transitions.every((t) => t.value === 0n));
  check('airAnalysis honest boundary ok', airOk.boundaryOk);
  const airBad = airAnalysis(16, 8);
  check('airAnalysis tamper produces nonzero residual', airBad.transitions.some((t) => t.value !== 0n));

  // friDemo: low-degree input collapses to a constant; tampered does not.
  const friLow = await friDemo(8);
  check('friDemo low-degree collapses to constant', friLow.finalConstant && friLow.lowDegree);
  const friHigh = await friDemo(8, { tamper: true });
  check('friDemo high-degree fails to collapse', !friHigh.finalConstant && !friHigh.lowDegree);

  // --- Degree adjustment is active: honest deg(CP) is lifted to N-1 (not N-2). ---
  const adj = await prove(16);
  check('degree adjustment lifts honest deg(CP) to N-1', adj.diag.compositionDegree === 15, `deg=${adj.diag.compositionDegree}`);
  check('proof carries 3 degree-adjustment challenges', adj.proof.compBetas.length === 3);

  // --- Zero-knowledge mode: completeness + soundness preserved under masking. ---
  const nextPow2 = (x) => { let p = 1; while (p < x) p <<= 1; return p; };
  for (const N of [8, 16]) {
    const z = await prove(N, { zk: true });
    const expectedLde = nextPow2(N + 3 * 8) * 8;
    check(`zk params: domain enlarged for masking N=${N}`, z.proof.params.zk && z.proof.params.ldeSize === expectedLde, `lde=${z.proof.params.ldeSize}`);
    const zres = await verify(z.proof);
    check(`zk honest proof ACCEPTED N=${N}`, zres.accepted, zres.checks.filter((c) => !c.ok).map((c) => c.name).join(', '));
    const zt = await prove(N, { zk: true, tamper: true });
    const ztres = await verify(zt.proof);
    check(`zk tampered proof REJECTED N=${N}`, !ztres.accepted);
  }

  // --- Zero-knowledge masking actually hides the witness. ---
  // Two independent masked proofs of the SAME statement must have different
  // trace commitments (fresh randomness ⇒ different transcripts).
  const z1 = await prove(16, { zk: true });
  const z2 = await prove(16, { zk: true });
  check('zk: fresh randomness ⇒ different trace roots', z1.proof.traceRoot !== z2.proof.traceRoot);

  // --- Empirical ZK: masked openings are uniform and independent of the witness. ---
  const exp = zkOpeningExperiment(16, 5, 4000, 16);
  check('zk: masked openings essentially all distinct', exp.distinctOpenings >= exp.trials - 2, `${exp.distinctOpenings}/${exp.trials}`);
  check('zk: true value never leaks through an opening', exp.leakedCount === 0);
  check('zk: every histogram bucket populated (no clustering)', exp.realHistogram.every((c) => c > 0));
  check('zk: real distribution ≈ witness-free simulator', exp.maxBucketGap < 0.05, `maxGap=${exp.maxBucketGap.toFixed(4)}`);
  check('zk: two positions are uncorrelated (independent)', exp.pairwiseCorrelation < 0.1, `|corr|=${exp.pairwiseCorrelation.toFixed(4)}`);

  // --- Adversarial: mutate every field of an HONEST proof; each must reject. ---
  const honest = (await prove(16)).proof;
  const baseline = await verify(honest);
  check('adversarial baseline accepts', baseline.accepted);

  const clone = () => JSON.parse(JSON.stringify(honest));
  const rejects = async (label, mutate) => {
    const p = clone();
    mutate(p);
    const res = await verify(p);
    check(`mutation rejected: ${label}`, !res.accepted);
  };
  await rejects('flip alpha challenge', (p) => { p.alphas[0] = (BigInt(p.alphas[0]) + 1n).toString(); });
  await rejects('flip degree-adjust beta', (p) => { p.compBetas[0] = (BigInt(p.compBetas[0]) + 1n).toString(); });
  await rejects('flip a FRI layer root', (p) => { p.friRoots[0] = p.friRoots[0].slice(0, -1) + (p.friRoots[0].endsWith('0') ? '1' : '0'); });
  await rejects('flip final-layer constant', (p) => { p.finalLayer[0] = (BigInt(p.finalLayer[0]) + 1n).toString(); });
  await rejects('flip a query index', (p) => { p.queries[0].index = (p.queries[0].index + 1) % p.params.ldeSize; });
  await rejects('flip a FRI layer opened value', (p) => { p.queries[0].layers[0].valA = (BigInt(p.queries[0].layers[0].valA) + 1n).toString(); });
  await rejects('flip a trace opening f(wx)', (p) => { p.queries[0].fwx.value = (BigInt(p.queries[0].fwx.value) + 1n).toString(); });
  await rejects('swap a Merkle path hash', (p) => { const pa = p.queries[0].fx.path; pa[0] = pa[0].slice(0, -1) + (pa[0].endsWith('0') ? '1' : '0'); });
  await rejects('forge final layer to a fake constant', (p) => { p.finalLayer = p.finalLayer.map(() => '12345'); });

  // --- Structural forgeries: a proof must carry exactly what the protocol
  // demands, or the per-query checks could pass vacuously. ---
  await rejects('strip all queries from the proof', (p) => { p.queries = []; });
  await rejects('drop one query', (p) => { p.queries.pop(); });
  await rejects('truncate the final layer to one value', (p) => { p.finalLayer = p.finalLayer.slice(0, 1); });
  await rejects('claim zero FRI folds', (p) => { p.params.numFolds = 0; p.friRoots = []; p.betas = []; });
  await rejects('claim a smaller LDE than the blowup requires', (p) => { p.params.ldeSize = p.params.ldeSize / 2; });
  const stripped = clone();
  stripped.queries = [];
  const sres = await verify(stripped);
  check(
    'vacuous-pass hole closed: empty query list fails the shape check',
    !sres.accepted && sres.checks.some((c) => c.name.includes('shape') && !c.ok),
    sres.checks.find((c) => !c.ok)?.detail ?? '',
  );

  // Boundary tamper (row 0) must be caught too — B0 = (f-1)/(x-1) stops being a
  // polynomial, so CP is high degree and FRI rejects.
  const bnd = await prove(16, { tamper: true, tamperRow: 0 });
  const bndRes = await verify(bnd.proof);
  check('boundary tamper (row 0) REJECTED', !bndRes.accepted);
  check('boundary tamper caught by low-degree test', !bndRes.checks.find((c) => c.name.includes('low-degree'))?.ok);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
