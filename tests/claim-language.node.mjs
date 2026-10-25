import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const files = ['README.md', 'index.html', 'src/main.ts', 'src/stark.ts', 'src/merkle.ts'];
const sources = new Map(files.map((file) => [file, readFileSync(new URL(file, root), 'utf8')]));
const combined = [...sources.entries()].map(([file, text]) => `\nFILE ${file}\n${text}`).join('');

test('retired FRI overclaims cannot return', () => {
  const retired = [
    /24[- ]bit soundness/i,
    /24 conjectured soundness bits/i,
    /7\s*[–-]\s*12[^\n.]*provab/i,
    /whole verdict/i,
    /bottom row[^\n.]*one dot/i,
    /verifier['’]s work is independent/i,
    /only cryptographic assumption/i,
    /a high-degree one does not/i,
    /a liar slips through/i,
    /rate\^\(-queries\)/i,
    /soundness bits \(toy\)/i,
  ];
  for (const phrase of retired) assert.doesNotMatch(combined, phrase, `retired claim returned: ${phrase}`);
});

test('capacity arithmetic is visibly classified as heuristic', () => {
  assert.match(sources.get('index.html'), /capacity-model query bits \(heuristic\)/);
  assert.match(sources.get('src/main.ts'), /capacity-model query heuristic<\/em>, not a soundness bound/);
  assert.match(sources.get('README.md'), /heuristic query term[^\n]*never as FRI or STARK security/);
});

test('missing theorem and protocol terms remain visibly unestablished', () => {
  const html = sources.get('index.html');
  assert.match(html, /NOT ESTABLISHED/);
  const main = sources.get('src/main.ts');
  assert.match(main, /CL146 FRI IOP bound/);
  assert.match(main, /End-to-end STARK bound/);
  assert.match(main, /actual δ and all \$\{folds\} fold MCA terms are absent/);
  assert.match(main, /algebraic\/composition, Merkle\/hash and Fiat-Shamir\/BCS terms/);
});

test('the eight-value final code is one acceptance condition, not the verdict', () => {
  const html = sources.get('index.html');
  assert.match(html, /eight evaluations/);
  assert.match(html, /only one part of acceptance/);
  const stark = sources.get('src/stark.ts');
  assert.match(stark, /eight evaluations must agree/);
  assert.match(stark, /authenticated sampled fold checks below/);
});

test('all three reviewed papers are cited with the audited scope', () => {
  const readme = sources.get('README.md');
  assert.match(readme, /eprint\.iacr\.org\/2026\/1367/);
  assert.match(readme, /Sections 2\.1–2\.5[^\n]*Sections 4\.1–4\.3[^\n]*Sections 5\.4–5\.5[^\n]*Section 7/);
  assert.match(readme, /eprint\.iacr\.org\/2025\/2197[^\n]*revision 2 dated 2026-04-09/);
  assert.match(readme, /not a demonstrated attack on this implementation/);
  assert.match(readme, /eprint\.iacr\.org\/2025\/1993[^\n]*v4 dated 2026-08-25/);
  assert.match(readme, /Theorem 5\.2 gives every fold error plus query error/);
});
