import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-v187-'));
process.env.MSR_DATA_DIR = tmpDir;

const ROOT = path.resolve(import.meta.dirname, '..');
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'src/web/public/app.js'), 'utf-8');
const TASK_SOURCE = fs.readFileSync(path.join(ROOT, 'src/core/taskManager.js'), 'utf-8');

const { default: configManager } = await import('../src/config.js');
const { TaskManager } = await import('../src/core/taskManager.js');

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('局部官网同步不能把同一天已确认的任务进度覆盖为 0', () => {
  const manager = new TaskManager();
  const merged = manager.mergeMonotonicTask(
    {
      name: '必应 PC 搜索任务',
      progress: 60,
      max: 60,
      points: 60,
      done: true,
      searchTier: { code: 'gold', label: '金牌', max: 60 }
    },
    {
      name: '必应 PC 搜索任务',
      progress: 0,
      max: 0,
      points: 0,
      done: false,
      statusMessage: '官网未返回搜索等级配额'
    }
  );

  assert.equal(merged.progress, 60);
  assert.equal(merged.max, 60);
  assert.equal(merged.points, 60);
  assert.equal(merged.done, true);
  assert.equal(merged.searchTier.code, 'gold');
});

test('账号汇总暴露并持久化上一次运行时间', () => {
  configManager.upsertAccount({
    id: 'acc_v187_last_run',
    name: '运行时间测试',
    cookie: '_U=LAST_RUN'
  });
  const manager = new TaskManager();
  const stats = manager.ensureAccountStats('acc_v187_last_run');
  const lastRunAt = 1793000000000;
  stats.lastRunAt = lastRunAt;
  manager.saveStats();

  const summary = manager.computeSummary();
  const account = summary.accountsList.find(item => item.id === 'acc_v187_last_run');
  assert.equal(account.lastRunAt, lastRunAt);
});

test('重新绑定 Cookie 清空当日进度时仍保留上次运行时间', () => {
  configManager.upsertAccount({
    id: 'acc_v187_identity',
    name: '身份变化测试',
    cookie: '_U=IDENTITY_A; MUID=A'
  });
  const manager = new TaskManager();
  const before = manager.ensureAccountStats('acc_v187_identity');
  before.lastRunAt = 1793001111111;
  before.webIdentityKey = 'old-identity';
  before.identityAppliedAt = 0;

  const changed = manager.ensureAccountStats('acc_v187_identity');
  assert.equal(changed.lastRunAt, 1793001111111);
});

test('任务收尾使用正确账号变量，并防止详情请求竞态覆盖', () => {
  assert.match(TASK_SOURCE, /claimExtraPointsAfterTasks\(accCfg, accStats\)/);
  assert.doesNotMatch(TASK_SOURCE, /\n\s*await this\.claimExtraPointsAfterTasks\(acc, accStats\)/);
  assert.match(TASK_SOURCE, /extraClaim\.claimed > 0/);
  assert.match(TASK_SOURCE, /claimedRecently/);
  assert.match(APP_SOURCE, /let statusFetchSeq = 0/);
  assert.match(APP_SOURCE, /requestSeq !== statusFetchSeq \|\| requestedAccountId !== selectedAccountId/);
});

test('刷新倒计时按微软积分商城 00:00 计算，账号悬浮包含上次运行时间', () => {
  assert.match(
    APP_SOURCE,
    /const target = new Date\(now\.getFullYear\(\), now\.getMonth\(\), now\.getDate\(\), 0, 0, 0\)/
  );
  assert.match(APP_SOURCE, /function formatLastRunTime\(ts\)/);
  assert.match(APP_SOURCE, /上次运行：\$\{lastRunText\}/);
  assert.match(APP_SOURCE, /formatLastRunTime\(acc\.lastRunAt\)/);
});
