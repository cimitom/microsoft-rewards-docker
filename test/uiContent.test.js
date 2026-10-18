import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const indexHtml = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf-8');
const appJs = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf-8');
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
const serverJs = fs.readFileSync(new URL('../src/web/server.js', import.meta.url), 'utf-8');

test('v1.7.7 删除顶部重复编辑按钮，只保留任务清单编辑入口', () => {
  assert.equal(indexHtml.includes('id="btn-edit-active-account"'), false);
  assert.equal(appJs.includes("getElementById('btn-edit-active-account')"), false);
  assert.equal(indexHtml.includes('id="btn-edit-current-account-header"'), true);
});

test('Cookie 配置向导统一使用 rewards.bing.com/dashboard', () => {
  assert.equal(indexHtml.includes('https://rewards.bing.com/dashboard'), true);
  assert.equal(indexHtml.includes('登录 <a href="https://cn.bing.com"'), false);
  assert.equal(indexHtml.includes('浏览器 cn.bing.com 的完整 Cookie'), false);
});

test('发布版本号在 package 与 Web 服务端保持一致', () => {
  assert.equal(packageJson.version, '1.7.7');
  assert.match(serverJs, /const CURRENT_VERSION = '1\.7\.7';/);
});
