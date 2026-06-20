// Finite field F_p for the STARK-101 prime.
//
// p = 3 * 2^30 + 1 = 3221225473 is the field used by StarkWare's STARK-101
// tutorial. Unlike a Mersenne prime such as 2^31 - 1 (whose multiplicative
// group has 2-adicity 1), this prime has 2^30 dividing p - 1, so it contains
// power-of-two subgroups large enough to host honest NTT-style evaluation
// domains and real FRI folding. That 2-adic structure is exactly what a
// faithful STARK needs and is why we use this field instead of 2^31 - 1.

export const P = 3221225473n; // 3 * 2^30 + 1
export const GENERATOR = 5n; // a primitive root of the full multiplicative group
export const TWO_ADICITY = 30; // 2^30 | (P - 1)

export function mod(n: bigint): bigint {
  const v = n % P;
  return v >= 0n ? v : v + P;
}

export function add(a: bigint, b: bigint): bigint {
  return mod(a + b);
}

export function sub(a: bigint, b: bigint): bigint {
  return mod(a - b);
}

export function mul(a: bigint, b: bigint): bigint {
  return mod(a * b);
}

export function pow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = mul(result, b);
    b = mul(b, b);
    e >>= 1n;
  }
  return result;
}

// Multiplicative inverse via Fermat's little theorem (p is prime).
export function inv(a: bigint): bigint {
  if (mod(a) === 0n) throw new Error('Division by zero in field');
  return pow(a, P - 2n);
}

export function div(a: bigint, b: bigint): bigint {
  return mul(a, inv(b));
}

// A primitive `order`-th root of unity, where `order` is a power of two
// dividing 2^30. omega = g^((p-1)/order) has multiplicative order exactly
// `order`, so {omega^0, ..., omega^(order-1)} is a cyclic evaluation domain.
export function rootOfUnity(order: number): bigint {
  if (order <= 0 || (order & (order - 1)) !== 0) {
    throw new Error('rootOfUnity expects a power-of-two order');
  }
  if (BigInt(order) > 1n << BigInt(TWO_ADICITY)) {
    throw new Error('order exceeds the 2-adicity of the field');
  }
  const exponent = (P - 1n) / BigInt(order);
  return pow(GENERATOR, exponent);
}

// ---------------------------------------------------------------------------
// Polynomials are represented as coefficient arrays, low degree first:
// coeffs[0] + coeffs[1] x + coeffs[2] x^2 + ...
// ---------------------------------------------------------------------------

export function polyAdd(a: bigint[], b: bigint[]): bigint[] {
  const len = Math.max(a.length, b.length);
  const out = new Array<bigint>(len);
  for (let i = 0; i < len; i += 1) out[i] = add(a[i] ?? 0n, b[i] ?? 0n);
  return out;
}

export function polyScale(a: bigint[], s: bigint): bigint[] {
  return a.map((c) => mul(c, s));
}

export function polyMul(a: bigint[], b: bigint[]): bigint[] {
  if (a.length === 0 || b.length === 0) return [0n];
  const out = new Array<bigint>(a.length + b.length - 1).fill(0n);
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      out[i + j] = add(out[i + j], mul(a[i], b[j]));
    }
  }
  return out;
}

// Lagrange interpolation through (xs[i], ys[i]). Returns the unique polynomial
// of degree < xs.length. O(n^2) — fine for the small domains used here.
export function interpolate(xs: bigint[], ys: bigint[]): bigint[] {
  const n = xs.length;
  let poly: bigint[] = [0n];
  for (let i = 0; i < n; i += 1) {
    let basis: bigint[] = [1n];
    let denom = 1n;
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      basis = polyMul(basis, [sub(0n, xs[j]), 1n]); // (x - xs[j])
      denom = mul(denom, sub(xs[i], xs[j]));
    }
    poly = polyAdd(poly, polyScale(basis, div(ys[i], denom)));
  }
  return poly.map(mod);
}

// Horner evaluation.
export function polyEval(coeffs: bigint[], x: bigint): bigint {
  let acc = 0n;
  for (let i = coeffs.length - 1; i >= 0; i -= 1) acc = add(mul(acc, x), coeffs[i]);
  return acc;
}

export function polyDegree(coeffs: bigint[]): number {
  for (let i = coeffs.length - 1; i >= 0; i -= 1) {
    if (mod(coeffs[i]) !== 0n) return i;
  }
  return -1; // zero polynomial
}
