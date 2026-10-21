import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const indexHtml = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf-8');
const appJs = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf-8');
const styleCss = fs.readFileSync(new URL('../src/web/public/style.css', import.meta.url), 'utf-8');

test('Epic 成功庆祝层包含标题、游戏清单与礼花画布', () => {
  assert.match(indexHtml, /id="epic-celebration"/);
  assert.match(indexHtml, /恭喜白嫖成功/);
  assert.match(indexHtml, /id="epic-confetti-canvas"/);
  assert.match(indexHtml, /id="btn-close-epic-celebration"/);
  assert.match(styleCss, /\.celebration-layer/);
  assert.match(styleCss, /\.celebration-panel/);
  assert.match(styleCss, /prefers-reduced-motion/);
});

test('领取成功后自动关闭 VNC 并展示庆祝弹窗', () => {
  const claimBlock = appJs.match(/async function claimEpic\(accountId\)[\s\S]*?async function refreshEpicTab/);
  assert.ok(claimBlock, '应能找到 claimEpic 函数');
  assert.match(claimBlock[0], /collectEpicSuccesses\(resultGroups\)/);
  assert.match(claimBlock[0], /closeNovncModal\(\)/);
  assert.match(claimBlock[0], /showEpicCelebration\(/);
  assert.match(claimBlock[0], /epicChallengeAutoOpened = false/);
});

test('成功结果只认 claimed 与 owned，礼花不依赖外部 CDN', () => {
  const collectBlock = appJs.match(/function collectEpicSuccesses\([\s\S]*?\n}/);
  assert.ok(collectBlock, '应能找到 collectEpicSuccesses 函数');
  assert.match(collectBlock[0], /status === 'claimed'/);
  assert.match(collectBlock[0], /status === 'owned'/);
  assert.match(appJs, /requestAnimationFrame\(tick\)/);
  assert.equal(appJs.includes('cdn.jsdelivr.net'), false);
  assert.equal(appJs.includes('unpkg.com'), false);
});
