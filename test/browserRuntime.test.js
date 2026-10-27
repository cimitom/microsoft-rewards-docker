import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildChromiumArgs,
  buildChromiumEnv,
  classifyWebglRenderer,
  inspectDriEnvironment
} from '../src/core/chromiumRuntime.js';

test('软件渲染模式继续关闭 GPU 并设置 Mesa 软件环境', () => {
  const args = buildChromiumArgs({ useGpu: false });
  const env = buildChromiumEnv({ useGpu: false, baseEnv: {} });
  assert.ok(args.includes('--disable-gpu'));
  assert.ok(!args.includes('--ignore-gpu-blocklist'));
  assert.equal(env.LIBGL_ALWAYS_SOFTWARE, '1');
});

test('核显模式移除软件渲染限制并启用 GPU 参数', () => {
  const args = buildChromiumArgs({ useGpu: true, visible: true });
  const env = buildChromiumEnv({ useGpu: true, baseEnv: { LIBGL_ALWAYS_SOFTWARE: '1' } });
  assert.ok(!args.includes('--disable-gpu'));
  assert.ok(args.includes('--ignore-gpu-blocklist'));
  assert.ok(args.includes('--disable-quic'));
  assert.equal(env.LIBGL_ALWAYS_SOFTWARE, undefined);
});

test('WebGL 渲染器可以区分软件与硬件', () => {
  assert.equal(classifyWebglRenderer('Google', 'ANGLE (Intel, Mesa Intel(R) UHD Graphics (ADL-N), OpenGL)').software, false);
  assert.equal(classifyWebglRenderer('Google', 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)').software, true);
  assert.equal(classifyWebglRenderer('Mesa', 'llvmpipe (LLVM 17.0, 256 bits)').software, true);
});

test('/dev/dri 检测能识别 render node 与普通 card', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-dri-'));
  try {
    fs.writeFileSync(path.join(dir, 'card0'), '');
    fs.writeFileSync(path.join(dir, 'renderD128'), '');
    fs.writeFileSync(path.join(dir, 'not-a-device'), '');
    const info = inspectDriEnvironment(dir);
    assert.equal(info.available, true);
    assert.equal(info.hasRenderNode, true);
    assert.deepEqual(info.devices, [
      path.join(dir, 'card0'),
      path.join(dir, 'renderD128')
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

