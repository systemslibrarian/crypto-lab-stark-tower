# crypto-lab-stark-tower

## 1. What It Is

STARK Tower is an **honest, working** browser demonstration of zk-STARKs (Scalable Transparent ARguments of Knowledge; Ben-Sasson et al., 2018) — the post-quantum alternative to pairing-based SNARKs. STARKs require no trusted setup (the only cryptographic assumption is a collision-resistant hash), scale quasi-linearly, and are conjectured secure against quantum adversaries. They express computation as an Arithmetic Intermediate Representation (AIR) of polynomial constraints and use FRI (Fast Reed–Solomon IOP) as a transparent low-degree test. The cost is larger proofs (~45–200 KB vs 128 bytes for Groth16).

What makes this demo different from a hand-wave: **the verifier really catches a cheating prover, and it does so without re-running the computation.** It only checks Merkle openings and a FRI low-degree test. Tamper with one trace cell and the constraint quotient stops being a polynomial, its low-degree extension is no longer low degree, and FRI rejects.

## 2. Why the STARK-101 Field

Arithmetic is over `p = 3·2^30 + 1 = 3221225473`, the field from StarkWare's STARK-101 tutorial. This is deliberate: a Mersenne prime like `2^31 − 1` has 2-adicity 1 (no power-of-two subgroup), so you *cannot* build honest NTT-style evaluation domains or real FRI folding in it. `3·2^30 + 1` has `2^30 | (p − 1)`, giving the 2-adic structure a faithful STARK needs.

## 3. When to Use STARKs

- ✅ When a trusted setup ceremony is not feasible or acceptable
- ✅ When post-quantum security is required for long-term proof validity
- ✅ For large-scale computations where STARK proving time beats SNARKs
- ✅ When proving general RISC-V or VM execution (Risc Zero, Miden VM)
- ✅ Off-chain integrity proofs where proof size is not a constraint
- ❌ On-chain verification under tight gas limits — STARK verification is far more expensive than Groth16 (~50 ms vs ~1 ms)
- ❌ When proof size is critical — 45–200 KB vs 128 bytes for Groth16
- ❌ For small circuits where SNARK setup cost is acceptable — Groth16 is faster and smaller

## 4. The Six Exhibits

1. **Orientation** — STARK vs SNARK comparison table (setup, assumptions, post-quantum posture, size).
2. **AIR** — interactive single-column Fibonacci trace; check constraints; tamper a row and watch a residual become nonzero.
3. **FRI** — real even/odd coset folding (`f(x), f(−x) → f′(x²)`) with SHA-256 Merkle roots per layer, plus an **SVG visualization** of the domain halving to a constant; a low-degree polynomial collapses, a high-degree one does not.
4. **Proof size** — benchmark table, the demo's own toy proof size measured live, and an interactive **security ↔ size ↔ speed calculator** (blowup and query count → soundness bits).
5. **Prove & verify** — the full protocol end-to-end. Generate a proof, verify it (per-check report), inspect a single query's decommitment, see a **succinctness summary** (how few values the verifier touched), then **Corrupt trace** and watch the *FRI low-degree test* reject it with no trace recomputation. Includes a **zero-knowledge mode** toggle plus a **masking experiment** that histograms masked openings against a witness-free simulator to show the witness stays hidden. A disclosure panel honestly states what a production STARK still adds.
6. **In production** — StarkNet, StarkEx, Risc Zero, Polygon Miden.

## 5. Architecture

| File | Responsibility |
| --- | --- |
| `src/field.ts` | `F_p` arithmetic, roots of unity, Lagrange interpolation, polynomial eval/degree |
| `src/merkle.ts` | SHA-256 Merkle commitments, openings, verification |
| `src/stark.ts` | AIR, prover, verifier, real FRI; plus `airAnalysis` / `friDemo` for the exhibits |
| `src/main.ts` | DOM wiring only (no cryptography) |

### What is real vs simplified

- **Real:** the field, polynomial interpolation, SHA-256 Merkle commitments, even/odd FRI folding, Fiat-Shamir challenges, query decommitments, the low-degree test that catches tampering, **per-constraint degree adjustment** (`αᵢ + βᵢ·x^(D−dᵢ)`), and an **optional zero-knowledge masking** mode (`f′ = f + (xᴺ−1)·r`) whose witness-hiding is demonstrated empirically.
- **Simplified for clarity (clearly labeled in-app):** toy parameters (short traces, blowup 8, 8 queries ≈ 20-bit soundness) and Lagrange interpolation instead of NTT. The ZK property is shown empirically (revealed values independent of the witness), not via a full-transcript simulator proof. None of these change *how* a cheat is caught.

## 6. Run and Test Locally

```bash
git clone https://github.com/systemslibrarian/crypto-lab-stark-tower
cd crypto-lab-stark-tower
npm install
npm run dev        # serve the demo
npm test           # crypto self-test + jsdom UI smoke test
npm run typecheck  # tsc --noEmit
```

`npm test` asserts that honest proofs are accepted, tampered proofs are rejected **via the low-degree test** (not recomputation), flipped Merkle leaves are rejected, and every exhibit behaves correctly in a headless DOM.

## 7. Live Demo

https://systemslibrarian.github.io/crypto-lab-stark-tower/

## 8. Part of the Crypto-Lab Suite

Part of [crypto-lab](https://systemslibrarian.github.io/crypto-lab/) — browser-based cryptography demos spanning 2,500 years of cryptographic history to NIST FIPS 2024 post-quantum standards.

Whether you eat or drink or whatever you do, do it all for the glory of God. — 1 Corinthians 10:31
