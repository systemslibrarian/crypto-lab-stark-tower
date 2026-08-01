// SHA-256 Merkle commitments over field elements.
//
// STARKs are *transparent*: their only cryptographic assumption is a
// collision-resistant hash. There is no trusted setup and no pairing. Every
// polynomial the prover commits to is hashed into one of these trees, and the
// verifier checks short Merkle paths instead of seeing the full evaluations.

import { mod, P } from './field';

export type MerkleTree = {
  values: bigint[];
  levels: Uint8Array[][]; // levels[0] = leaf hashes, last level = [root]
  rootHex: string;
};

export type MerkleOpening = {
  index: number;
  value: string; // decimal string of the field element
  path: string[]; // sibling hashes from leaf to root, hex
};

export function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hexString: string): Uint8Array {
  const clean = hexString.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
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

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return new Uint8Array(digest);
}

const LEAF_TAG = new TextEncoder().encode('leaf:');

async function hashLeaf(value: bigint): Promise<Uint8Array> {
  return sha256(concat(LEAF_TAG, bigintToBytes32(value)));
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(await sha256(new TextEncoder().encode(text)));
}

export async function buildMerkle(values: bigint[]): Promise<MerkleTree> {
  if (values.length === 0 || (values.length & (values.length - 1)) !== 0) {
    throw new Error('Merkle inputs must be a non-empty power-of-two length');
  }
  const leaves = await Promise.all(values.map(hashLeaf));
  const levels: Uint8Array[][] = [leaves];
  let current = leaves;
  while (current.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(await sha256(concat(current[i], current[i + 1])));
    }
    levels.push(next);
    current = next;
  }
  return { values, levels, rootHex: hex(levels[levels.length - 1][0]) };
}

export function openMerkle(tree: MerkleTree, index: number): MerkleOpening {
  const path: string[] = [];
  let idx = index;
  for (let level = 0; level < tree.levels.length - 1; level += 1) {
    path.push(hex(tree.levels[level][idx ^ 1]));
    idx >>= 1;
  }
  return { index, value: tree.values[index].toString(), path };
}

// Verify a Merkle opening against a root.
//
// `expectedLeaves` is REQUIRED and is what makes the commitment bind a
// *position in a vector of known length* rather than just "some leaf somewhere".
// Without it the check is much weaker than it looks:
//
//   * The path length is attacker-chosen. Walking a k-hash path only ever
//     consumes the low k bits of the index, so a prover who commits a tiny
//     depth-k tree can answer EVERY position of a claimed 2^d-leaf domain
//     (d > k) out of just 2^k committed values — index 4, 12, 100 … all
//     re-derive the same root. Verified empirically before this check existed.
//   * The index is never range-checked, so a proof can name a position that
//     does not exist in the committed vector at all.
//
// So we pin both: the path must have exactly log2(expectedLeaves) hashes, and
// the index must be a real position inside that vector. We also reject
// non-canonical field encodings (value >= P), because `bigintToBytes32`
// reduces mod P — without this, "5" and "5 + P" would open to the same leaf,
// which would mean the commitment does not uniquely bind the value.
export async function verifyOpening(
  opening: MerkleOpening,
  expectedRootHex: string,
  expectedLeaves: number,
): Promise<boolean> {
  if (!Number.isInteger(expectedLeaves) || expectedLeaves < 1 || (expectedLeaves & (expectedLeaves - 1)) !== 0) {
    return false;
  }
  const depth = Math.log2(expectedLeaves);
  if (opening.path.length !== depth) return false;
  if (!Number.isInteger(opening.index) || opening.index < 0 || opening.index >= expectedLeaves) return false;
  if (opening.path.some((s) => !/^[0-9a-f]{64}$/.test(s))) return false;

  let value: bigint;
  try {
    value = BigInt(opening.value);
  } catch {
    return false;
  }
  if (value < 0n || value >= P) return false;

  let h = await hashLeaf(value);
  let idx = opening.index;
  for (const siblingHex of opening.path) {
    const sibling = fromHex(siblingHex);
    h = idx % 2 === 0 ? await sha256(concat(h, sibling)) : await sha256(concat(sibling, h));
    idx >>= 1;
  }
  return hex(h) === expectedRootHex;
}
