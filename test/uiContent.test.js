import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const indexHtml = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf-8');
const appJs = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf-8');
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
const serverJs = fs.readFileSync(new URL('../src/web/server.js', import.meta.url), 'utf-8');
const styleCss = fs.readFileSync(new URL('../src/web/public/style.css', import.meta.url), 'utf-8');
const webglJs = fs.readFileSync(new URL('../src/web/public/webgl-bg.js', import.meta.url), 'utf-8');

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
  const escaped = packageJson.version.replace(/\./g, '\\.');
  assert.match(serverJs, new RegExp(`const CURRENT_VERSION = '${escaped}';`));
});

test('任务区使用移动端签到与三组 7 日连续进度', () => {
  assert.equal(indexHtml.includes('每日双端签入'), false);
  assert.equal(indexHtml.includes('移动端签到 (双端签入)'), false);
  assert.equal(indexHtml.includes('移动端签到</label>'), true);
  assert.equal(appJs.includes('dual-endpoint-item'), false);
  assert.match(appJs, /必应搜索连续打卡/);
  assert.match(appJs, /每日连续打卡活动/);
  assert.match(appJs, /移动端连续打卡/);
  assert.match(appJs, /TASK_PRIORITY[\s\S]*search: 10[\s\S]*dailySet: 20[\s\S]*sign: 30/);
});

test('液态玻璃视觉包含 WebGL2 背景、统一卡片材质与配置项', () => {
  assert.match(indexHtml, /id="bg-webgl-canvas"/);
  assert.match(indexHtml, /id="tab-appearance"/);
  assert.match(styleCss, /\.glass-surface\.glass-surface/);
  assert.match(styleCss, /--glass-opacity/);
  assert.match(webglJs, /#version 300 es/);
  assert.match(webglJs, /renderSilk/);
  assert.match(webglJs, /renderGrainient/);
  assert.match(webglJs, /renderVeil/);
  assert.match(webglJs, /renderSoftAurora/);
  assert.match(webglJs, /renderPrism/);
});

test('界面固定夜间模式并修复下拉菜单深色可读性', () => {
  assert.equal(indexHtml.includes('data-theme-val="light"'), false);
  assert.equal(indexHtml.includes('id="cfg-ui-theme" value="dark"'), true);
  assert.equal(styleCss.includes('[data-theme="light"]'), false);
  assert.match(styleCss, /\.form-select option[\s\S]*background: #111827/);
  assert.match(styleCss, /\.stamp-grid-item\.collected[\s\S]*#FFD84D/);
});

test('鼠标只驱动边框高光角度，不再生成跟随光斑', () => {
  assert.match(appJs, /--pointer-angle/);
  assert.match(appJs, /Math\.atan2\(normY, normX\) \* 180 \/ Math\.PI \+ 90/);
  assert.equal(appJs.includes('--mouse-x'), false);
  assert.equal(styleCss.includes('--mouse-x'), false);
  assert.match(styleCss, /conic-gradient\([\s\S]*--pointer-angle/);
});

test('账号汇总使用可滚动迷你印章并优化任务卡与统计块排版', () => {
  assert.match(indexHtml, /id="stamps-account-list"/);
  assert.match(appJs, /renderAccountStampsList/);
  assert.match(styleCss, /\.stamps-account-list[\s\S]*overflow-y: auto/);
  assert.match(styleCss, /\.task-card-featured[\s\S]*min-height: 0/);
  assert.match(styleCss, /\.acc-stat-box[\s\S]*border-radius: 10px/);
});

test('首页汇总展示逐账号积分明细，历史图只在汇总视图且位于监控卡片之前', () => {
  assert.match(indexHtml, /id="earned-account-breakdown"/);
  assert.match(indexHtml, /id="balance-account-breakdown"/);
  assert.match(indexHtml, /id="claimable-account-breakdown"/);
  assert.match(appJs, /renderHeroAccountBreakdown/);
  const historyIndex = indexHtml.indexOf('id="history-card-section"');
  const monitorIndex = indexHtml.indexOf('id="browser-monitor-card"');
  assert.ok(historyIndex > 0 && historyIndex < monitorIndex);
  assert.match(appJs, /historyCard\.style\.display = isAllMode \? 'flex' : 'none'/);
});

test('四张 Hero 卡共用标签与明细结构，账号概览避免轮询时重复重建', () => {
  assert.match(indexHtml, /id="stat-streak"/);
  assert.match(styleCss, /\.hero-label-row[\s\S]*min-height: 24px/);
  assert.match(appJs, /accountsOverviewRenderSignature/);
  assert.match(appJs, /signature === accountsOverviewRenderSignature/);
});

test('顶部页签、账号切换和工具栏操作统一使用胶囊圆角', () => {
  assert.match(styleCss, /\.app-tabs[\s\S]*border-radius: 999px/);
  assert.match(styleCss, /\.app-tab[\s\S]*border-radius: 999px/);
  assert.match(styleCss, /\.header-actions \.btn[\s\S]*border-radius: 999px/);
  assert.match(styleCss, /\.account-chip[\s\S]*border-radius: 999px/);
  assert.match(styleCss, /\.chip-add[\s\S]*border-radius: 999px/);
  assert.match(styleCss, /\.ms-toolbar-actions \.btn[\s\S]*border-radius: 999px/);
});
