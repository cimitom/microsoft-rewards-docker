import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'src/web/public/app.js'), 'utf-8');
const { default: rewardsApi } = await import('../src/core/api.js');
const { default: configManager } = await import('../src/config.js');
const { TaskManager } = await import('../src/core/taskManager.js');
const { isQuestSubtaskCompleted } = await import('../src/core/questStatus.js');

test('新建 Epic 账号时“打开可见浏览器登录”不会因按钮禁用而无响应', () => {
  assert.match(
    APP_SOURCE,
    /openLoginBtn\.disabled = false/,
    '打开登录按钮必须始终可点击，由处理函数负责先保存草稿账号'
  );
  assert.match(
    APP_SOURCE,
    /async function ensureEpicAccountSaved\(\)/,
    '必须存在自动保存 Epic 草稿账号的辅助函数'
  );
  assert.match(
    APP_SOURCE,
    /accountId = await ensureEpicAccountSaved\(\)/,
    '点击登录后应先自动保存账号，再打开 Firefox 登录窗口'
  );
});

test('Epic 会话导入在新账号场景也会先自动保存账号', () => {
  const importBlock = APP_SOURCE.match(/async function importEpicSession\(\)[\s\S]*?if \(!session\)/);
  assert.ok(importBlock, '应能找到 importEpicSession 函数');
  assert.match(importBlock[0], /await ensureEpicAccountSaved\(\)/);
});

test('Halloween 中英文重复任务合并时保留 5/6 的真实进度，不能被 0/6 覆盖', () => {
  const text = `
    <script>self.__next_f.push([1,"\\"text-globalBody2Strong\\",\\"children\\":\\"50分的万圣节礼遇\\",\\"b\\":{\\"children\\":\\"5/6 个任务\\"}"])</script>
    <script>self.__next_f.push([1,"\\"text-globalBody2Strong\\",\\"children\\":\\"A 50-point Halloween treat\\",\\"b\\":{\\"children\\":\\"0/6 个任务\\"}"])</script>
  `;
  const quests = rewardsApi.extractQuests(text.replace(/\\"/g, '"'));
  const halloween = quests.filter(q => /Halloween|万圣节/.test(q.title));
  assert.equal(halloween.length, 1, '同一活动只能保留一张卡');
  assert.equal(halloween[0].progress, 5);
  assert.equal(halloween[0].max, 6);
  assert.match(halloween[0].title, /万圣节|Halloween/);
});

test('子任务描述中的“(1/5 天已完成)”不能被误判为整个子任务已完成', () => {
  assert.equal(isQuestSubtaskCompleted({
    rawText: '在您的桌面上搜索 10 天中的 5 天。(1/5 天已完成)\n开始搜索',
    hasSuccessIcon: false,
    hasEmptyCircle: true
  }), false);
  assert.equal(isQuestSubtaskCompleted({ hasSuccessIcon: true, hasEmptyCircle: false }), true);
});

test('移动端凭据异常时必须拒绝移动端手动任务', async () => {
  const accountId = 'acc_blocked_175';
  configManager.upsertAccount({
    id: accountId,
    name: '异常账号',
    cookie: 'MOCK_COOKIE',
    refreshToken: 'MOCK_TOKEN'
  });
  configManager.recordAuthDiagnosis(accountId, {
    cookieValid: true,
    tokenValid: false,
    overallValid: false,
    warning: true,
    warningMessage: '移动端 Token 实际绑定到其他账号'
  });
  const tm = new TaskManager();
  const acc = configManager.findAccount(accountId);
  assert.match(tm.getAccountBlockReason(acc), /Token/);
  await assert.rejects(
    () => tm.runTaskAction(accountId, 'read'),
    /账号凭据异常，已拒绝执行/
  );
});
