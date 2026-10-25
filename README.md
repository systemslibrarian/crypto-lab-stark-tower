# crypto-lab-stark-tower

## What It Is

STARK Tower is an **honest, working** browser demonstration of zk-STARKs (Scalable Transparent ARguments of Knowledge; Ben-Sasson et al., 2018) — the post-quantum alternative to pairing-based SNARKs. STARKs require no trusted setup and scale quasi-linearly. Their commitments rely on hash security, FRI contributes information-theoretic proximity errors, and the non-interactive Fiat-Shamir/BCS step is analyzed in a random-oracle model; their post-quantum security is therefore conjectured, not proved. They express computation as an Arithmetic Intermediate Representation (AIR) of polynomial constraints and use FRI (Fast Reed–Solomon IOP) as a transparent low-degree test. The cost is larger proofs (~45–200 KB vs 128 bytes for Groth16).

What makes this demo different from a hand-wave: **the verifier rejects the supplied tampered fixtures without re-running the computation.** It checks authenticated openings, composition consistency, membership in the final degree-`<1` code and sampled FRI fold relations. Tampering one trace cell makes the generated constraint quotient fail polynomial division; for the transcript-derived challenges in this run, its eight final evaluations do not agree and verification rejects. A dedicated **quotient exhibit** makes that causal path visible with exact field arithmetic. This is empirical evidence for the generated fixtures, not a universal soundness experiment.

## When to Use It

- ✅ When a trusted setup ceremony is not feasible or acceptable
- ✅ When post-quantum security is required for long-term proof validity
- ✅ For large-scale computations where STARK proving time beats SNARKs
- ✅ When proving general RISC-V or VM execution (Risc Zero, Miden VM)
- ✅ Off-chain integrity proofs where proof size is not a constraint
- ❌ On-chain verification under tight gas limits — STARK verification is far more expensive than Groth16 (~50 ms vs ~1 ms)
- ❌ When proof size is critical — 45–200 KB vs 128 bytes for Groth16
- ❌ For small circuits where SNARK setup cost is acceptable — Groth16 is faster and smaller
- ❌ As a production proving system — this is a toy-parameter teaching demo with short traces and Lagrange interpolation instead of an NTT; it does not establish a numeric end-to-end soundness bound

## Live Demo

**[systemslibrarian.github.io/crypto-lab-stark-tower](https://systemslibrarian.github.io/crypto-lab-stark-tower/)**

The demo presents an orientation comparing STARKs and SNARKs; an interactive AIR exhibit with a single-column Fibonacci trace where tampering a row makes a residual nonzero; a **quotient exhibit** that divides `C(x)` by `Z(x)` on that same trace; a FRI exhibit with even/odd coset folding and per-layer SHA-256 Merkle roots; a proof-size benchmark with a query-model/error ledger; a full prove-and-verify exhibit with independently visible checks; a zero-knowledge masking mode; and a production survey. Generate an honest proof, inspect all eight final evaluations, verify it, then build the fixed tampered fixture and observe its actual rejection without a trace recomputation.

## What Can Go Wrong

- **Large proofs** — STARK proofs run ~45–200 KB versus 128 bytes for Groth16, a real cost wherever bandwidth or storage is tight.
- **Expensive on-chain verification** — STARK verification is far costlier than Groth16 (~50 ms vs ~1 ms), so tight gas budgets can make it impractical.
- **Query arithmetic is not protocol soundness** — at rate `ρ=1/8` and eight queries, `−log₂(ρ⁸)=24` is exact arithmetic for a capacity-level sampling model. It is displayed as a **heuristic query term**, never as FRI or STARK security. The unique-decoding-radius query-only reference is about 6.64 bits only when both the actual distance and `θ` reach `(1−ρ)/2`. If the actual distance is at least the Johnson radius and `θ` approaches `1−√ρ` from below, the query-only value approaches 12 bits as a strict limit. Neither includes fold-round MCA errors or surrounding protocol terms.
- **The complete bounds are not established here** — applying CL146 requires the actual initial-word distance `δ`, a tradeoff `θ`, and every fold's MCA error. An end-to-end non-interactive STARK analysis must additionally justify AIR/composition algebraic errors, Merkle/hash binding and Fiat-Shamir/BCS loss. The executable ledger leaves both results `NOT ESTABLISHED` rather than treating missing terms as zero.
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

## The Exhibits

1. **Orientation** — STARK vs SNARK comparison table (setup, assumptions, post-quantum posture, size).
2. **AIR** — interactive single-column Fibonacci trace; check constraints; tamper a row and watch a residual become nonzero.
2·5. **Quotient (the missing middle step)** — takes the same trace, forms the constraint polynomial `C(x) = f(w²x) − f(wx) − f(x)`, and divides it by the vanishing polynomial `Z(x)` with exact field arithmetic. Honest ⇒ zero remainder and a low-degree quotient `Q`; the fixed tampered fixture ⇒ nonzero remainder and `Q`'s degree explodes toward the domain size. This is the interactive converter from "constraint violated" to "not low degree"; Exhibit 3 then computes that fixture's actual FRI outcome.
3. **FRI** — real even/odd coset folding (`f(x), f(−x) → f′(x²)`) with SHA-256 Merkle roots per layer, plus an **SVG visualization** of the domain halving. The final code has degree below one and eight evaluations; agreement of all eight is one acceptance condition. The fixed honest and tampered fixtures show their actual outcomes without generalizing one run into a probability claim.
4. **Proof size and query models** — benchmark table, the demo's own toy proof size measured live, and an interactive ledger. It classifies capacity arithmetic as heuristic, unique-radius and Johnson values as conditional query-only references, and leaves incomplete FRI/end-to-end bounds not established. Its separate byte estimate counts only FRI authentication hashes along the actual shrinking paths.
5. **Prove & verify** — the implemented toy protocol end to end. Generate a proof, inspect a query's decommitment and all verifier checks, then **Corrupt trace** and observe this generated fixture fail final-code membership without trace recomputation. Includes a **zero-knowledge mode** toggle and masking experiments. A disclosure panel states what a production STARK still adds.
6. **In production** — StarkNet, StarkEx, Risc Zero, Polygon Miden.

## Architecture

| File | Responsibility |
| --- | --- |
| `src/field.ts` | `F_p` arithmetic, roots of unity, Lagrange interpolation, polynomial eval/degree, exact polynomial division |
| `src/merkle.ts` | SHA-256 Merkle commitments, openings, verification |
| `src/stark.ts` | AIR, prover, verifier, real FRI; plus `airAnalysis` / `quotientAnalysis` / `friDemo` / `friFromTrace` for the exhibits |
| `src/soundness.ts` | Pure, fail-closed FRI query references and error ledger |
| `src/main.ts` | DOM wiring only (no cryptography) |

### What is real vs simplified

- **Real:** the field, polynomial interpolation, SHA-256 Merkle commitments, even/odd FRI folding, Fiat-Shamir challenges, query decommitments, final-code membership, sampled fold checks, **per-constraint degree adjustment** (`αᵢ + βᵢ·x^(D−dᵢ)`), and an **optional zero-knowledge masking** mode (`f′ = f + (xᴺ−1)·r`) whose witness-hiding is demonstrated empirically.
- **Simplified for clarity (clearly labeled in-app):** toy parameters (short traces, blowup 8, 8 queries), Lagrange interpolation instead of NTT, and no claimed numeric FRI or end-to-end soundness bound. The ZK property is shown empirically, not via a full-transcript simulator proof.

## Soundness Sources and Limits

- **CL042:** *SoK: Hash-Based Polynomial Commitments and Low-Degree Tests: From FRI to Basefold, STIR, and WHIR*, [ePrint 2026/1367](https://eprint.iacr.org/2026/1367), current 27-page ePrint version retrieved 2026-10-25. Sections 2.1–2.5 define rate, distance and decoding radii; Sections 4.1–4.3 cover FRI, DEEP-FRI and proximity gaps; Sections 5.4–5.5 distinguish conjectures, IOP soundness and non-interactive security; Section 7 records remaining small-field questions.
- **CL145:** *Small-field hash-based SNARGs are less sound than conjectured*, [ePrint 2025/2197](https://eprint.iacr.org/2025/2197), revision 2 dated 2026-04-09. Sections 3–4 explain the list-size-dependent attack. Its concrete example uses a sextic extension over a 31-bit base field, rate 1/2 and much larger parameters. This lab uses one prime field directly at rate 1/8, so the paper is context for cautious labels—not a demonstrated attack on this implementation.
- **CL146:** *A Simplified Round-by-round Soundness Proof of FRI*, [ePrint 2025/1993](https://eprint.iacr.org/2025/1993), v4 dated 2026-08-25 (current ePrint revision posted 2026-09-25). Lemma 2.4 bounds the cited Reed–Solomon MCA term only for `θ < 1−√ρ`; Sections 3.1–3.2 distinguish IOP, round-by-round and BCS requirements; Construction 4.4 fixes the FRI model; Theorem 5.2 gives every fold error plus query error `(1−min{θ,δ})^t`; Section 5.4 discusses the resulting parameters and limits.

## Testing

```bash
npm test           # crypto self-test + jsdom UI smoke test
npm run typecheck  # tsc --noEmit
```

`npm test` asserts that honest proofs are accepted, the fixed tampered fixtures are rejected through their observed final-code failure (not recomputation), flipped Merkle leaves are rejected, public protocol parameters and malformed scalar encodings fail closed, structurally malformed proofs fail closed, the soundness ledger validates inputs and refuses incomplete bounds, stale interactive evidence is retired, and every exhibit behaves correctly in a headless DOM. `npm run test:mutations` verifies that the gates catch removed heuristic labels, the wrong query formula, omitted fold-error completeness and final-membership-only acceptance.

---

*Part of the [Crypto Lab](https://crypto-lab.systemslibrarian.dev/) suite.*

*"So whether you eat or drink or whatever you do, do it all for the glory of God." — 1 Corinthians 10:31*
