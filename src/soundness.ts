/**
 * FRI soundness accounting for the teaching UI.
 *
 * Sources and scope:
 * - CL146, ePrint 2025/1993 v4 (2026-08-25), Theorem 5.2: the query-round
 *   term is (1 - min(theta, delta))^t and the fold-round MCA errors remain.
 * - CL146, Lemma 2.4: the cited Reed-Solomon MCA estimate is useful only for
 *   theta strictly below the Johnson radius 1 - sqrt(rate).
 * - CL042, ePrint 2026/1367, Sections 2.1-2.5, 4.1-4.3 and 5.4-5.5:
 *   rate^queries is the capacity-model query heuristic, not a complete bound.
 *
 * This module deliberately distinguishes arithmetic that can be computed from
 * rate/query sliders from a theorem-backed protocol claim. Missing evidence is
 * represented as NOT ESTABLISHED; it is never silently replaced by zero.
 */

export type BoundStatus = 'established' | 'not-established';

export interface ErrorBound {
  status: BoundStatus;
  error: number | null;
  bits: number | null;
  missing: string[];
}

export interface QueryReference {
  radius: number;
  error: number;
  bits: number;
}

export interface FriSoundnessEvidence {
  /** Actual relative distance delta of the committed initial word from C_0. */
  distance?: number;
  /** CL146 tradeoff parameter theta. */
  theta?: number;
  /** One justified MCA error for every fold, in round order. */
  foldMcaErrors?: readonly number[];
  /** AIR/composition and algebraic linking error for the surrounding STARK. */
  algebraicCompositionError?: number;
  /** Merkle/hash binding error under the stated commitment assumption. */
  merkleHashError?: number;
  /**
   * Justified total Fiat-Shamir/BCS transform error under the stated model,
   * including the adversary's random-oracle-query loss where applicable.
   */
  fiatShamirBcsError?: number;
}

export interface FriSoundnessLedger {
  rate: number;
  queries: number;
  folds: number;
  capacityModel: {
    classification: 'heuristic';
    queryError: number;
    queryBits: number;
  };
  uniqueRadiusQueryOnly: QueryReference & {
    classification: 'conditional-query-only';
  };
  johnsonLimitQueryOnly: QueryReference & {
    classification: 'strict-limit-query-only';
  };
  citedMcaDomain: {
    johnsonRadius: number;
    supported: boolean;
    reason: string;
  };
  theoremQuery: ErrorBound;
  friIop: ErrorBound;
  endToEnd: ErrorBound;
}

function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function requireProbability(name: string, value: number): void {
  requireFinite(name, value);
  if (value < 0 || value > 1) throw new RangeError(`${name} must be in [0, 1]`);
}

export function errorBits(error: number): number {
  requireProbability('error', error);
  if (error === 0) return Number.POSITIVE_INFINITY;
  return -Math.log2(error);
}

/** Union bound for a complete list of justified, additive error-event bounds. */
export function cappedUnionBound(terms: readonly number[]): number {
  if (terms.length === 0) throw new RangeError('a union bound needs at least one error term');
  for (let i = 0; i < terms.length; i += 1) requireProbability(`error term ${i}`, terms[i]);
  return Math.min(1, terms.reduce((sum, term) => sum + term, 0));
}

function established(error: number): ErrorBound {
  return { status: 'established', error, bits: errorBits(error), missing: [] };
}

function notEstablished(missing: string[]): ErrorBound {
  return { status: 'not-established', error: null, bits: null, missing };
}

/**
 * Build a fail-closed ledger. The reference rows are query terms only. A FRI
 * IOP bound additionally needs delta, theta and every fold MCA term; an
 * end-to-end STARK bound also needs all three surrounding protocol terms.
 */
export function buildFriSoundnessLedger(
  rate: number,
  queries: number,
  folds: number,
  evidence: FriSoundnessEvidence = {},
): FriSoundnessLedger {
  requireFinite('rate', rate);
  if (rate <= 0 || rate > 0.5) {
    throw new RangeError('rate must be in (0, 1/2] for CL146 Construction 4.4');
  }
  if (!Number.isInteger(queries) || queries <= 0) throw new RangeError('queries must be a positive integer');
  if (!Number.isInteger(folds) || folds < 0) throw new RangeError('folds must be a non-negative integer');

  if (evidence.distance !== undefined) requireProbability('distance', evidence.distance);
  if (evidence.theta !== undefined) requireProbability('theta', evidence.theta);
  if (evidence.foldMcaErrors !== undefined) {
    if (evidence.foldMcaErrors.length > folds) throw new RangeError('more fold MCA errors were supplied than there are folds');
    evidence.foldMcaErrors.forEach((term, i) => requireProbability(`fold MCA error ${i}`, term));
  }
  const surrounding = [
    ['algebraic/composition error', evidence.algebraicCompositionError],
    ['Merkle/hash error', evidence.merkleHashError],
    ['Fiat-Shamir/BCS error', evidence.fiatShamirBcsError],
  ] as const;
  for (const [name, value] of surrounding) if (value !== undefined) requireProbability(name, value);

  const capacityQueryError = Math.pow(rate, queries);
  const uniqueRadius = (1 - rate) / 2;
  const uniqueQueryError = Math.pow(1 - uniqueRadius, queries);
  const johnsonRadius = 1 - Math.sqrt(rate);
  // This is a limiting query term: Lemma 2.4 requires theta < johnsonRadius.
  const johnsonLimitQueryError = Math.pow(1 - johnsonRadius, queries);

  const hasTheta = evidence.theta !== undefined;
  const citedMcaDomainSupported = hasTheta && evidence.theta! < johnsonRadius;
  const citedMcaDomainReason = !hasTheta
    ? 'theta was not supplied'
    : citedMcaDomainSupported
      ? 'theta is strictly below the Johnson radius'
      : 'theta must be strictly below the Johnson radius for the cited MCA bound';

  const queryMissing: string[] = [];
  if (evidence.distance === undefined) queryMissing.push('initial-word distance delta');
  if (evidence.theta === undefined) queryMissing.push('tradeoff parameter theta');

  const theoremQuery = queryMissing.length === 0
    ? established(Math.pow(1 - Math.min(evidence.theta!, evidence.distance!), queries))
    : notEstablished(queryMissing);

  const friMissing = [...queryMissing];
  // Theorem 5.2's query term exists for every theta in [0,1]. The strict
  // Johnson guard applies only when instantiating its fold terms through the
  // nontrivial Reed-Solomon MCA estimate cited from Lemma 2.4.
  if (hasTheta && !citedMcaDomainSupported) {
    friMissing.push('theta strictly below the Johnson radius for the cited MCA estimate');
  }
  const allFoldTerms = evidence.foldMcaErrors !== undefined && evidence.foldMcaErrors.length === folds;
  if (!allFoldTerms) friMissing.push(`all ${folds} fold MCA error terms`);
  const friIop = friMissing.length === 0
    ? established(cappedUnionBound([theoremQuery.error!, ...evidence.foldMcaErrors!]))
    : notEstablished(friMissing);

  const endMissing = [...friMissing];
  if (evidence.algebraicCompositionError === undefined) endMissing.push('algebraic/composition error');
  if (evidence.merkleHashError === undefined) endMissing.push('Merkle/hash binding error');
  if (evidence.fiatShamirBcsError === undefined) endMissing.push('Fiat-Shamir/BCS transform error');
  const endToEnd = endMissing.length === 0
    ? established(cappedUnionBound([
        friIop.error!,
        evidence.algebraicCompositionError!,
        evidence.merkleHashError!,
        evidence.fiatShamirBcsError!,
      ]))
    : notEstablished(endMissing);

  return {
    rate,
    queries,
    folds,
    capacityModel: {
      classification: 'heuristic',
      queryError: capacityQueryError,
      queryBits: errorBits(capacityQueryError),
    },
    uniqueRadiusQueryOnly: {
      classification: 'conditional-query-only',
      radius: uniqueRadius,
      error: uniqueQueryError,
      bits: errorBits(uniqueQueryError),
    },
    johnsonLimitQueryOnly: {
      classification: 'strict-limit-query-only',
      radius: johnsonRadius,
      error: johnsonLimitQueryError,
      bits: errorBits(johnsonLimitQueryError),
    },
    citedMcaDomain: {
      johnsonRadius,
      supported: citedMcaDomainSupported,
      reason: citedMcaDomainReason,
    },
    theoremQuery,
    friIop,
    endToEnd,
  };
}

/** Approximate information capacity of one field-valued challenge. */
export function fieldChallengeBits(modulus: bigint): number {
  if (modulus <= 1n) throw new RangeError('field modulus must exceed 1');
  return Math.log2(Number(modulus));
}
