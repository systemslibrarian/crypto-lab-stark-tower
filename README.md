# crypto-lab-stark-tower

## 1. What It Is

STARK Tower demonstrates zk-STARKs (Scalable Transparent ARguments of Knowledge, Ben-Sasson et al., 2018) - the post-quantum alternative to pairing-based SNARKs. STARKs require no trusted setup ceremony (the only cryptographic assumption is a collision-resistant hash function), scale quasi-linearly with computation size, and are conjectured secure against quantum adversaries. The construction uses Arithmetic Intermediate Representation (AIR) to express computations as polynomial constraints, and FRI (Fast Reed-Solomon IOP) as the polynomial commitment scheme. The cost is larger proofs (~45-200KB vs 128 bytes for Groth16).

## 2. When to Use It

- ✅ When a trusted setup ceremony is not feasible or acceptable
- ✅ When post-quantum security is required for long-term proof validity
- ✅ For large-scale computations where STARK proving time beats SNARKs
- ✅ When proving general RISC-V or VM execution (Risc Zero, Miden VM)
- ✅ Off-chain integrity proofs where proof size is not a constraint
- ❌ On-chain verification with tight gas limits - STARK verification is significantly more expensive than Groth16 (~50ms vs ~1ms)
- ❌ When proof size is critical - 45-200KB vs 128 bytes for Groth16
- ❌ For small circuits where SNARK setup cost is acceptable - Groth16 will be faster and smaller

## 3. Live Demo

Link: https://systemslibrarian.github.io/crypto-lab-stark-tower/

Six exhibits: STARKs vs SNARKs orientation with key property comparison, Arithmetic Intermediate Representation with interactive Fibonacci trace, FRI protocol visualizer with folding rounds and Merkle commitments, proof size tradeoffs with real benchmark comparison table, end-to-end STARK proof generation and verification with tamper detection, and real production deployments in StarkNet, StarkEx, Risc Zero, and Miden.

## 4. How to Run Locally

```bash
git clone https://github.com/systemslibrarian/crypto-lab-stark-tower
cd crypto-lab-stark-tower
npm install
npm run dev
```

## 5. Part of the Crypto-Lab Suite

Part of [crypto-lab](https://systemslibrarian.github.io/crypto-lab/) - browser-based cryptography demos spanning 2,500 years of cryptographic history to NIST FIPS 2024 post-quantum standards.

Whether you eat or drink or whatever you do, do it all for the glory of God. - 1 Corinthians 10:31