# crypto-lab-stark-tower

## What It Is

STARK Tower is an **honest, working** browser demonstration of zk-STARKs (Scalable Transparent ARguments of Knowledge; Ben-Sasson et al., 2018) — the post-quantum alternative to pairing-based SNARKs. STARKs require no trusted setup (the only cryptographic assumption is a collision-resistant hash), scale quasi-linearly, and are conjectured secure against quantum adversaries. They express computation as an Arithmetic Intermediate Representation (AIR) of polynomial constraints and use FRI (Fast Reed–Solomon IOP) as a transparent low-degree test. The cost is larger proofs (~45–200 KB vs 128 bytes for Groth16).

What makes this demo different from a hand-wave: **the verifier really catches a cheating prover, and it does so without re-running the computation.** It only checks Merkle openings and a FRI low-degree test. Tamper with one trace cell and the constraint quotient stops being a polynomial, its low-degree extension is no longer low degree, and FRI rejects.

## When to Use It

- ✅ When a trusted setup ceremony is not feasible or acceptable
- ✅ When post-quantum security is required for long-term proof validity
- ✅ For large-scale computations where STARK proving time beats SNARKs
- ✅ When proving general RISC-V or VM execution (Risc Zero, Miden VM)
- ✅ Off-chain integrity proofs where proof size is not a constraint
- ❌ On-chain verification under tight gas limits — STARK verification is far more expensive than Groth16 (~50 ms vs ~1 ms)
- ❌ When proof size is critical — 45–200 KB vs 128 bytes for Groth16
- ❌ For small circuits where SNARK setup cost is acceptable — Groth16 is faster and smaller
- ❌ As a production proving system — this is an honest but toy-parameter teaching demo (short traces, ~20-bit soundness, Lagrange instead of NTT), not an audited STARK library

## Live Demo

**[systemslibrarian.github.io/crypto-lab-stark-tower](https://systemslibrarian.github.io/crypto-lab-stark-tower/)**

The demo presents six exhibits: an orientation comparing STARKs and SNARKs; an interactive AIR exhibit with a single-column Fibonacci trace where tampering a row makes a residual nonzero; a real FRI exhibit with even/odd coset folding and per-layer SHA-256 Merkle roots plus an SVG of the domain halving; a proof-size benchmark with a live security ↔ size ↔ speed calculator; a full prove-and-verify exhibit where corrupting the trace is caught by the FRI low-degree test with no recomputation (plus a zero-knowledge masking mode); and a production survey. Generate a proof, verify it, then corrupt the trace and watch the verifier reject it without ever re-running the computation.

## What Can Go Wrong

- **Large proofs** — STARK proofs run ~45–200 KB versus 128 bytes for Groth16, a real cost wherever bandwidth or storage is tight.
- **Expensive on-chain verification** — STARK verification is far costlier than Groth16 (~50 ms vs ~1 ms), so tight gas budgets can make it impractical.
- **Soundness depends on parameters** — blowup factor and query count set the soundness bits; the demo's toy settings (blowup 8, 8 queries ≈ 20-bit) are far below production targets.
- **Field choice matters** — FRI needs a field with high 2-adicity (here `3·2³⁰+1`); a field like `2³¹−1` with 2-adicity 1 cannot support honest power-of-two evaluation domains or real folding.
- **Toy simplifications** — short traces and Lagrange interpolation (instead of NTT) keep the demo legible but are not how a production STARK scales; the ZK property here is shown empirically, not via a full simulator proof.

## Real-World Usage

- **StarkNet and StarkEx** — StarkWare's L2s use STARK proofs to scale Ethereum with validity proofs.
- **Risc Zero** — a general-purpose zkVM proving RISC-V execution with STARKs.
- **Polygon Miden** — a STARK-based zk-rollup and virtual machine.
- **Transparent, post-quantum proof systems** — STARKs are chosen where a trusted setup is unacceptable and long-term quantum resistance matters.

## How to Run Locally

```bash
git clone https://github.com/systemslibrarian/crypto-lab-stark-tower
cd crypto-lab-stark-tower
npm install
npm run dev
```

## Related Demos

- [crypto-lab-snark-arena](https://systemslibrarian.github.io/crypto-lab-snark-arena/) — Groth16 and PLONK, the pairing-based SNARKs STARKs are contrasted against.
- [crypto-lab-zk-arena](https://systemslibrarian.github.io/crypto-lab-zk-arena/) — side-by-side comparison of zk-SNARK and zk-STARK proof systems.
- [crypto-lab-bulletproofs](https://systemslibrarian.github.io/crypto-lab-bulletproofs/) — transparent-setup range proofs via inner-product arguments.
- [crypto-lab-mpcith-sign](https://systemslibrarian.github.io/crypto-lab-mpcith-sign/) — MPC-in-the-Head, a post-quantum signature built from zero-knowledge proofs.
- [crypto-lab-zk-proof-lab](https://systemslibrarian.github.io/crypto-lab-zk-proof-lab/) — Schnorr commitments and Fiat-Shamir, the foundations of non-interactive proofs.

## Why the STARK-101 Field

Arithmetic is over `p = 3·2^30 + 1 = 3221225473`, the field from StarkWare's STARK-101 tutorial. This is deliberate: a Mersenne prime like `2^31 − 1` has 2-adicity 1 (no power-of-two subgroup), so you *cannot* build honest NTT-style evaluation domains or real FRI folding in it. `3·2^30 + 1` has `2^30 | (p − 1)`, giving the 2-adic structure a faithful STARK needs.

## The Six Exhibits

1. **Orientation** — STARK vs SNARK comparison table (setup, assumptions, post-quantum posture, size).
2. **AIR** — interactive single-column Fibonacci trace; check constraints; tamper a row and watch a residual become nonzero.
3. **FRI** — real even/odd coset folding (`f(x), f(−x) → f′(x²)`) with SHA-256 Merkle roots per layer, plus an **SVG visualization** of the domain halving to a constant; a low-degree polynomial collapses, a high-degree one does not.
4. **Proof size** — benchmark table, the demo's own toy proof size measured live, and an interactive **security ↔ size ↔ speed calculator** (blowup and query count → soundness bits).
5. **Prove & verify** — the full protocol end-to-end. Generate a proof, verify it (per-check report), inspect a single query's decommitment, see a **succinctness summary** (how few values the verifier touched), then **Corrupt trace** and watch the *FRI low-degree test* reject it with no trace recomputation. Includes a **zero-knowledge mode** toggle plus a **masking experiment** that histograms masked openings against a witness-free simulator to show the witness stays hidden. A disclosure panel honestly states what a production STARK still adds.
6. **In production** — StarkNet, StarkEx, Risc Zero, Polygon Miden.

## Architecture

| File | Responsibility |
| --- | --- |
| `src/field.ts` | `F_p` arithmetic, roots of unity, Lagrange interpolation, polynomial eval/degree |
| `src/merkle.ts` | SHA-256 Merkle commitments, openings, verification |
| `src/stark.ts` | AIR, prover, verifier, real FRI; plus `airAnalysis` / `friDemo` for the exhibits |
| `src/main.ts` | DOM wiring only (no cryptography) |

### What is real vs simplified

- **Real:** the field, polynomial interpolation, SHA-256 Merkle commitments, even/odd FRI folding, Fiat-Shamir challenges, query decommitments, the low-degree test that catches tampering, **per-constraint degree adjustment** (`αᵢ + βᵢ·x^(D−dᵢ)`), and an **optional zero-knowledge masking** mode (`f′ = f + (xᴺ−1)·r`) whose witness-hiding is demonstrated empirically.
- **Simplified for clarity (clearly labeled in-app):** toy parameters (short traces, blowup 8, 8 queries ≈ 20-bit soundness) and Lagrange interpolation instead of NTT. The ZK property is shown empirically (revealed values independent of the witness), not via a full-transcript simulator proof. None of these change *how* a cheat is caught.

## Testing

```bash
npm test           # crypto self-test + jsdom UI smoke test
npm run typecheck  # tsc --noEmit
```

`npm test` asserts that honest proofs are accepted, tampered proofs are rejected **via the low-degree test** (not recomputation), flipped Merkle leaves are rejected, structurally malformed proofs (stripped queries, truncated FRI layers, forged parameters) are rejected, and every exhibit behaves correctly in a headless DOM.

---

*One of 120+ browser demos in the [Crypto Lab](https://crypto-lab.systemslibrarian.dev/) suite.*

*"So whether you eat or drink or whatever you do, do it all for the glory of God." — 1 Corinthians 10:31*
