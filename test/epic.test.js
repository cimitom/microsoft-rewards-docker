import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-epic-test-'));
process.env.MSR_DATA_DIR = tmpDir;

const {
  isEpicChallengeText,
  isEpicLoginText,
  EPIC_ORDER_BUTTON_RE,
  EPIC_SUCCESS_TEXT_RE,
  epicProfilePath,
  EpicManager
} = await import('../src/core/epic.js');
const { default: configManager } = await import('../src/config.js');

test('Epic 人机验证与登录标识识别准确', () => {
  assert.equal(isEpicChallengeText('Verify you are human before accessing store'), true);
  assert.equal(isEpicChallengeText('请确认您是真人'), true);
  assert.equal(isEpicChallengeText('Checking your browser before accessing epicgames.com'), true);
  assert.equal(isEpicChallengeText('Error: cf-mitigated challenge encountered'), true);
  assert.equal(isEpicChallengeText('当前按钮：继续 / TRY AGAIN'), true);
  assert.equal(isEpicChallengeText('Bad Cheese - 限时免费'), false);

  assert.equal(isEpicLoginText('登录以获取免费游戏'), true);
  assert.equal(isEpicLoginText('Sign in with Epic Games'), true);
  assert.equal(isEpicLoginText('获取已拥有游戏'), false);
});

test('epicProfilePath 隔离账号并安全清理特殊字符', () => {
  const p1 = epicProfilePath('epic_1791970091529');
  assert.match(p1, /epic-firefox-profiles[/\\]epic_1791970091529$/);

  const p2 = epicProfilePath('user/../evil:1');
  assert.ok(!p2.includes('..'));
  assert.match(p2, /user____evil_1$/);
});

test('deleteEpicAccount 会一并清理账号对应的浏览器持久化 profile 目录', () => {
  const acc = configManager.upsertEpicAccount({
    id: 'epic_test_profile_del',
    name: '待删账号'
  });
  const dir = epicProfilePath(acc.id);
  const chromiumLoginDir = path.join(path.dirname(dir), `${acc.id}-login-chromium`);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(chromiumLoginDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'test-cookie.txt'), 'cf_clearance_dummy');
  assert.equal(fs.existsSync(dir), true);
  assert.equal(fs.existsSync(chromiumLoginDir), true);

  configManager.deleteEpicAccount(acc.id);
  assert.equal(fs.existsSync(dir), false, '删除账号后持久化 profile 目录应被彻底清理');
  assert.equal(fs.existsSync(chromiumLoginDir), false, '删除账号后 Chromium 登录 profile 也应被清理');
});

test('EpicManager 在任务进行中时拒绝校验与并发', async () => {
  const em = new EpicManager();
  em.running = true;
  await assert.rejects(
    async () => em.verifySession('demo_epic_1'),
    /Epic 任务正在运行中/
  );
  em.running = false;
  em.verifying = true;
  await assert.rejects(
    async () => em.claimOne('demo_epic_1'),
    /Epic 任务正在运行中/
  );
});

test('Epic 结账按钮与成功文案覆盖“添加到库”当前文案', () => {
  assert.equal(EPIC_ORDER_BUTTON_RE.test('添加到库'), true);
  assert.equal(EPIC_ORDER_BUTTON_RE.test('Add to Library'), true);
  assert.equal(EPIC_ORDER_BUTTON_RE.test('确认订单'), true);
  assert.equal(EPIC_ORDER_BUTTON_RE.test('愿望清单'), false);

  assert.equal(EPIC_SUCCESS_TEXT_RE.test('已添加到库'), true);
  assert.equal(EPIC_SUCCESS_TEXT_RE.test('Added to your library'), true);
  assert.equal(EPIC_SUCCESS_TEXT_RE.test('获取'), false);
});

test('Epic 停止请求会关闭活动浏览器上下文并标记状态', async () => {
  const em = new EpicManager();
  let closed = false;
  em.running = true;
  em.activeContext = { close: async () => { closed = true; } };
  const result = await em.stop();
  assert.equal(result.stopped, true);
  assert.equal(closed, true);
  assert.equal(em.stopRequested, true);
  assert.equal(em.state.status, 'stopping');
  em.running = false;
  em.activeContext = null;
  em.stopRequested = false;
});
