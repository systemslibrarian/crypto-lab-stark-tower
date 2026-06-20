// Test runner: bundles the crypto self-test and the app, then runs both the
// node-level cryptographic checks and the jsdom UI smoke test.
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';

await esbuild.build({
  entryPoints: ['scripts/selftest.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: 'scripts/selftest_bundle.mjs',
});
await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: 'scripts/app_bundle.mjs',
});

let ok = true;
for (const file of ['scripts/selftest_bundle.mjs', 'scripts/domtest.mjs']) {
  console.log(`\n=== ${file} ===`);
  const res = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (res.status !== 0) ok = false;
}
process.exit(ok ? 0 : 1);
