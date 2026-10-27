import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-vnc-config-'));
process.env.MSR_DATA_DIR = tmpDir;

const { normalizeVncPassword, resolveVncPassword } = await import('../src/core/vncService.js');

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('VNC 密码会去除首尾空格并限制为 8 位', () => {
  assert.equal(normalizeVncPassword(' 88e6b5b1 '), '88e6b5b1');
  assert.equal(normalizeVncPassword(''), '');
  assert.throws(() => normalizeVncPassword('123456789'), /最多 8 位/);
});

test('配置中的 VNC 密码优先于环境变量', () => {
  const previous = process.env.NOVNC_PASSWORD;
  process.env.NOVNC_PASSWORD = 'envpass1';
  try {
    assert.equal(resolveVncPassword({ server: { vncPassword: 'cfgpass2' } }), 'cfgpass2');
    assert.equal(resolveVncPassword({ server: {} }), 'envpass1');
  } finally {
    if (previous === undefined) delete process.env.NOVNC_PASSWORD;
    else process.env.NOVNC_PASSWORD = previous;
  }
});

