#!/usr/bin/env node
/**
 * Focused PR-10 mutation checks.
 *
 * Every case runs in a disposable copy so an interruption cannot leave the
 * source tree mutated. A kill counts only when the unmutated suite passed and
 * the owning assertion is visible in the failed run.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'stark-tower-pr10-mutations-'));

const mutations = [
  {
    name: 'heuristic label removed',
    file: 'index.html',
    before: 'capacity-model query bits (heuristic)',
    after: 'soundness bits',
    owningFailure: 'capacity arithmetic is visibly classified as heuristic',
  },
  {
    name: 'CL146 query term replaced by capacity arithmetic',
    file: 'src/soundness.ts',
    before: 'Math.pow(1 - Math.min(evidence.theta!, evidence.distance!), queries)',
    after: 'Math.pow(rate, queries)',
    owningFailure: 'FAIL  soundness: CL146 conditional query formula uses min(theta, delta)',
  },
  {
    name: 'missing fold error silently accepted',
    file: 'src/soundness.ts',
    before: 'evidence.foldMcaErrors.length === folds',
    after: 'evidence.foldMcaErrors.length >= 0',
    owningFailure: 'FAIL  soundness: one of two fold errors is incomplete, not zero',
  },
  {
    name: 'final-code membership becomes the whole verdict',
    file: 'src/stark.ts',
    before: 'const accepted = checks.every((c) => c.ok);',
    after: 'const accepted = finalConstant;',
    owningFailure: 'FAIL  final membership alone cannot accept a proof',
  },
];

function disposableCopy(label) {
  const destination = join(scratch, label);
  cpSync(root, destination, {
    recursive: true,
    filter(source) {
      const path = relative(root, source);
      return !(
        path === '.git' || path.startsWith(`.git${process.platform === 'win32' ? '\\' : '/'}`) ||
        path === 'node_modules' || path.startsWith(`node_modules${process.platform === 'win32' ? '\\' : '/'}`) ||
        path === 'dist' || path.startsWith(`dist${process.platform === 'win32' ? '\\' : '/'}`) ||
        path === 'test-results' || path.startsWith(`test-results${process.platform === 'win32' ? '\\' : '/'}`) ||
        path === 'playwright-report' || path.startsWith(`playwright-report${process.platform === 'win32' ? '\\' : '/'}`) ||
        path === 'scripts/selftest_bundle.mjs' || path === 'scripts/app_bundle.mjs'
      );
    },
  });
  symlinkSync(join(root, 'node_modules'), join(destination, 'node_modules'), 'dir');
  return destination;
}

function runSuite(cwd) {
  return spawnSync(process.execPath, ['scripts/test.mjs'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    maxBuffer: 20 * 1024 * 1024,
    timeout: 120_000,
  });
}

function output(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function replaceExactlyOnce(cwd, mutation) {
  const path = join(cwd, mutation.file);
  const source = readFileSync(path, 'utf8');
  const count = source.split(mutation.before).length - 1;
  if (count !== 1) throw new Error(`${mutation.name}: expected one anchor in ${mutation.file}, found ${count}`);
  writeFileSync(path, source.replace(mutation.before, mutation.after));
}

try {
  const baselineRoot = disposableCopy('baseline');
  const baseline = runSuite(baselineRoot);
  if (baseline.status !== 0 || baseline.signal) {
    throw new Error(`baseline failed or timed out\n${output(baseline)}`);
  }
  console.log('baseline: unmutated copy PASSES');

  for (let i = 0; i < mutations.length; i += 1) {
    const mutation = mutations[i];
    const mutationRoot = disposableCopy(`mutation-${i + 1}`);
    replaceExactlyOnce(mutationRoot, mutation);
    const result = runSuite(mutationRoot);
    const transcript = output(result);
    if (result.status === 0 || result.signal) {
      throw new Error(`${mutation.name}: mutation survived or timed out\n${transcript}`);
    }
    if (!transcript.includes(mutation.owningFailure)) {
      throw new Error(`${mutation.name}: suite failed, but not at its owning assertion\n${transcript}`);
    }
    console.log(`caught ${i + 1}/${mutations.length}: ${mutation.name}`);
  }

  console.log(`all ${mutations.length} mutation(s) caught`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
