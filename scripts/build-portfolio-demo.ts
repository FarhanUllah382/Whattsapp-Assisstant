import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const runtime = path.join(root, '.portfolio-runtime');
const runtimeSrc = path.join(runtime, 'src');
const demoRoot = path.join(root, 'portfolio-demo');
const demoDb = path.join(demoRoot, 'data', 'portfolio-demo.db');

if (!fs.existsSync(demoDb)) {
  throw new Error('Demo database is missing. Run the seed step first.');
}
if (path.resolve(runtime) === root || !runtime.endsWith('.portfolio-runtime')) {
  throw new Error('Refusing to prepare an unsafe runtime path.');
}

fs.rmSync(runtime, { recursive: true, force: true });
fs.mkdirSync(path.join(runtimeSrc, 'guardrails', 'pacing'), { recursive: true });
fs.mkdirSync(path.join(runtime, 'public'), { recursive: true });

const copies: Array<[string, string]> = [
  ['src/analytics.ts', 'src/analytics.ts'],
  ['src/followups.ts', 'src/followups.ts'],
  ['portfolio-demo/runtime-ledger.ts', 'src/ledger.ts'],
  ['src/guardrails/pacing/engine.ts', 'src/guardrails/pacing/engine.ts'],
  ['src/guardrails/pacing/defaults.ts', 'src/guardrails/pacing/defaults.ts'],
  ['portfolio-demo/runtime-db.ts', 'src/db.ts'],
  ['portfolio-demo/server.ts', 'server.ts'],
  ['portfolio-demo/public/index.html', 'public/index.html'],
  ['portfolio-demo/public/styles.css', 'public/styles.css'],
  ['portfolio-demo/public/app.js', 'public/app.js'],
  ['portfolio-demo/data/portfolio-demo.db', 'portfolio-demo.db'],
];

for (const [source, destination] of copies) {
  fs.copyFileSync(path.join(root, source), path.join(runtime, destination));
}

process.stdout.write('Prepared isolated read-only portfolio runtime.\n');
