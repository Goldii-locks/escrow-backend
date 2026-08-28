const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const commands = [
  {
    name: 'typecheck',
    cmd: 'npx',
    args: ['tsc', '--noEmit'],
  },
  {
    name: 'build',
    cmd: 'npm',
    args: ['run', 'build'],
  },
  {
    name: 'tests',
    cmd: process.execPath,
    args: [path.join(root, 'node_modules', 'jest', 'bin', 'jest.js'), '--runInBand', '--verbose', '__tests__/build-tx-address-validation.test.ts', '__tests__/submit-validation.test.ts', '__tests__/by-wallet-hardening.test.ts'],
  },
];

for (const c of commands) {
  const result = spawnSync(c.cmd, c.args, {
    cwd: root,
    encoding: 'utf8',
    shell: true,
    env: { ...process.env, NODE_OPTIONS: '--experimental-vm-modules' },
  });
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  fs.writeFileSync(path.join(root, `${c.name}.log`), out);
  fs.writeFileSync(path.join(root, `${c.name}.exit`), String(result.status ?? ''));
  console.log(`=== ${c.name} exit=${result.status} ===`);
  console.log(out.trim());
}
