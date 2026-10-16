import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const {
  detectFirefoxVersion,
  buildFirefoxUserAgent,
  webdriverInitScript
} = await import('../src/core/firefoxStealth.js');

/**
 * 这组断言防的是 v1.7.2 修掉的真实事故：
 * 旧代码把 Chromium 专用 stealth 注入 Firefox，还写死 `rv:127.0`，
 * 结果同一份指纹里 UA 说 Windows Firefox 127、platform/oscpu 说 Mac、
 * navigator.plugins 冒出 Chrome PDF 插件、window.chrome 凭空出现、
 * WebGL 被 webgl.disabled 关掉。Epic 登录页的风控据此判为机器人，
 * 人机验证通过后登录 POST 直接返回「错误回复」。
 */

function writeApplicationIni(dir, version) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'application.ini');
  fs.writeFileSync(file, `[App]\nVendor=Mozilla\nName=Firefox\nVersion=${version}\n`);
  return file;
}

test('从浏览器自身的 application.ini 读取真实版本号，而不是硬编码', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-ffver-'));

  // Linux / Windows 布局：application.ini 与可执行文件同目录
  const flatDir = path.join(tmp, 'flat');
  writeApplicationIni(flatDir, '157.0');
  assert.equal(detectFirefoxVersion(path.join(flatDir, 'firefox')), '157.0');

  // macOS .app 布局：Contents/Resources/application.ini
  const appDir = path.join(tmp, 'Nightly.app', 'Contents', 'Resources');
  writeApplicationIni(appDir, '158.0.1');
  assert.equal(
    detectFirefoxVersion(path.join(tmp, 'Nightly.app', 'Contents', 'MacOS', 'firefox')),
    '158.0.1'
  );

  // 读不到就返回 null，让调用方决定降级，而不是编一个版本号
  assert.equal(detectFirefoxVersion(path.join(tmp, 'nowhere', 'firefox')), null);
  assert.equal(detectFirefoxVersion(null), null);
});

test('UA 的版本号来自真实浏览器，且同一条 UA 里不出现第二个版本号', () => {
  const ua = buildFirefoxUserAgent('157.0', 'linux');
  assert.equal(ua, 'Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0');
  const versions = [...ua.matchAll(/rv:(\d+)|Firefox\/(\d+)/g)].map(m => m[1] || m[2]);
  assert.deepEqual([...new Set(versions)], ['157'], 'UA 内不允许出现多个不同的 Firefox 版本号');
});

test('UA 声明的系统跟随真实运行平台，不做跨系统伪装', () => {
  assert.match(buildFirefoxUserAgent('157.0', 'linux'), /\(X11; Linux x86_64;/);
  assert.match(buildFirefoxUserAgent('157.0', 'darwin'), /\(Macintosh; Intel Mac OS X 10\.15;/);
  assert.match(buildFirefoxUserAgent('157.0', 'win32'), /\(Windows NT 10\.0; Win64; x64;/);
  // 拿不到版本号时不生成 UA：宁可不发，也不要发一个自称 Windows 的假身份
  assert.equal(buildFirefoxUserAgent(null, 'linux'), null);
});

test('stealth 只把 webdriver 置为 false，不再注入 Chrome 专属特征', () => {
  const src = webdriverInitScript.toString();
  assert.match(src, /webdriver/);
  assert.match(src, /false/);

  // Firefox 原生没有 window.chrome，也没有 Chrome PDF 插件。
  // 任何一处重新出现都说明 Chromium 的 evasion 又被搬回来了。
  for (const forbidden of ['window.chrome', 'chrome.runtime', 'PDF Viewer', 'Native Client', 'plugins']) {
    assert.ok(!src.includes(forbidden), `stealth 脚本不应再触碰 ${forbidden}`);
  }
});

test('stealth 不再依赖 Chromium 专用的 puppeteer-extra-plugin-stealth', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/core/firefoxStealth.js'), 'utf-8');
  assert.ok(
    !src.includes('evasions/') && !/import\(\s*[`'"]puppeteer-extra/.test(src),
    'Firefox 不应再动态加载 Chromium 的 evasions 列表（注释里说明历史可以，代码里不能有）'
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  assert.ok(
    !pkg.dependencies?.['puppeteer-extra-plugin-stealth'],
    '该依赖只服务被移除的 Chromium evasion，应从依赖中删掉'
  );
});

test('Epic 启动 Firefox 时不再伪造 UA、也不再关闭 WebGL', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/core/epic.js'), 'utf-8');
  assert.ok(!/rv:127\.0/.test(src), '不允许再写死 Firefox 版本号');
  assert.ok(!/userAgent:\s*UA/.test(src), '不允许只改 UA 字符串而留下 platform/oscpu 矛盾');
  assert.ok(!/webgl\.disabled/.test(src), 'WebGL 是风控采集项，不允许整体关闭');
});
