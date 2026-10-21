import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf-8');
const epicSource = fs.readFileSync(path.join(ROOT, 'src/core/epic.js'), 'utf-8');

test('镜像不再安装 Playwright Firefox 浏览器', () => {
  assert.equal(packageJson.dependencies?.['playwright-firefox'], undefined);
  assert.ok(!/playwright\s+install[^\n]*firefox/i.test(dockerfile));
  assert.ok(!epicSource.includes('playwright-firefox'));
  assert.ok(!epicSource.includes('firefoxUserPrefs'));
});

test('Epic 登录、体检、领取和指纹自检统一使用 Chromium', () => {
  assert.match(epicSource, /import \{ chromium \} from 'patchright-core'/);
  assert.ok(!epicSource.includes('launchPersistentContext(dir, {\n      headless'));
  assert.match(epicSource, /engine: 'chromium'/);
});

test('Chromium 在 Xvfb 中启用软件 WebGL 并伪装为常见核显', () => {
  assert.match(epicSource, /--enable-unsafe-swiftshader/);
  assert.match(epicSource, /--use-angle=swiftshader/);
  assert.match(epicSource, /applyChromiumWebglIdentity/);
  assert.match(epicSource, /WEBGL_debug_renderer_info|37445|37446/);
});
