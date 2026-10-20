import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { findChromiumExecutable } = await import('../src/core/chromiumExecutable.js');

test('Chromium 路径优先采用显式配置', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-chromium-'));
  const executable = path.join(tmp, 'chromium');
  fs.writeFileSync(executable, '');
  assert.equal(findChromiumExecutable({ CHROMIUM_PATH: executable }), executable);
});

test('显式配置失效时回退到已安装的 Edge/Chrome', () => {
  const installed = [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable'
  ].find(candidate => fs.existsSync(candidate));
  assert.equal(
    findChromiumExecutable({ CHROMIUM_PATH: '/definitely/missing/chromium' }),
    installed || null
  );
});
