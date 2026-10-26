import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 用独立数据目录，避免测试污染真实 data/
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-history-'));
process.env.MSR_DATA_DIR = tmpDir;

const { default: historyManager } = await import('../src/core/history.js');

test('历史明细只记录真实任务分解，不再套用固定模板', () => {
  historyManager.recordAccountDay('acc_test', '2026-10-15', {
    earned: 137,
    balance: 51355,
    breakdown: [{ name: '必应 PC 搜索', icon: '🔍', points: 60 }]
  });
  const history = historyManager.load();
  const rec = history.accounts.acc_test['2026-10-15'];
  assert.equal(rec.earned, 137);
  assert.deepEqual(rec.breakdown, [{ name: '必应 PC 搜索', icon: '🔍', points: 60 }]);
});

test('没有传入分解时保持为空数组，而不是编造条目', () => {
  historyManager.recordAccountDay('acc_test', '2026-10-14', { earned: 100, balance: 100 });
  const rec = historyManager.load().accounts.acc_test['2026-10-14'];
  assert.deepEqual(rec.breakdown, [], '旧实现会返回「签到10/阅读30/...」这种编造明细');
});

test('breakdownFromStats 只汇总真正拿到分的任务', () => {
  const breakdown = historyManager.breakdownFromStats({
    acc_1: {
      tasks: {
        search: { name: '必应 PC 搜索', icon: '🔍', points: 60 },
        read: { name: '新闻资讯自动阅读', icon: '📖', points: 30 },
        promos: { name: '活动卡片与 Quiz 问答', icon: '🧩', points: 0 }
      }
    },
    acc_2: {
      tasks: {
        search: { name: '必应 PC 搜索', icon: '🔍', points: 12 }
      }
    }
  });
  assert.deepEqual(breakdown, [
    { name: '必应 PC 搜索', icon: '🔍', points: 72 },
    { name: '新闻资讯自动阅读', icon: '📖', points: 30 }
  ]);
});

test('写入是延迟合并的，flush 后才落盘', async () => {
  const file = path.join(tmpDir, 'history.json');
  historyManager.recordGlobalDay('2026-10-15', { earned: 200, balance: 999 });
  const before = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.equal(before.global['2026-10-15'], undefined, '未 flush 前不应写盘');

  historyManager.flush();
  const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.equal(after.global['2026-10-15'].earned, 200);
});

test('getHistory 返回的天数与请求一致，缺失日期返回 0 而不是编造趋势', () => {
  // 用一个从未记录过的账号，保证除今天以外都没有历史
  const list = historyManager.getHistory(3, 'acc_empty', { accounts: { acc_empty: { balance: 10, earned: 0, tasks: {} } } });
  assert.equal(list.length, 3);
  const missing = list[1];
  assert.equal(missing.earned, 0);
  assert.deepEqual(missing.breakdown, []);
});

test('历史快照记录待领取、连签与印章，并允许领取后归零', () => {
  historyManager.recordAccountDay('acc_snapshot', '2026-10-12', {
    earned: 20,
    balance: 520,
    claimablePoints: 35,
    streakDays: 4,
    stamps: { progress: 5, max: 12 }
  });
  let rec = historyManager.load().accounts.acc_snapshot['2026-10-12'];
  assert.equal(rec.claimablePoints, 35);
  assert.equal(rec.streakDays, 4);
  assert.deepEqual(rec.stamps, { progress: 5, max: 12 });

  historyManager.recordAccountDay('acc_snapshot', '2026-10-12', {
    earned: 20,
    balance: 520,
    claimablePoints: 0,
    streakDays: 0,
    stamps: { progress: 6, max: 12 }
  });
  rec = historyManager.load().accounts.acc_snapshot['2026-10-12'];
  assert.equal(rec.claimablePoints, 0, '领取后待领取必须归零，不能沿用旧快照');
  assert.equal(rec.streakDays, 0, '断签后连续天数必须归零');
  assert.equal(rec.stamps.progress, 6);
});

test('汇总历史按天返回账号级待领取、连签与印章快照', () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateKey = historyManager.formatDate(yesterday);
  historyManager.recordAccountDay('acc_history_fields', dateKey, {
    earned: 12,
    balance: 800,
    claimablePoints: 9,
    streakDays: 3,
    stamps: { progress: 2, max: 12 }
  });
  const list = historyManager.getHistory(2, 'all', { accounts: {} });
  const accountRow = list[0].accounts.find(item => item.id === 'acc_history_fields');
  assert.ok(accountRow);
  assert.equal(accountRow.claimablePoints, 9);
  assert.equal(accountRow.streakDays, 3);
  assert.deepEqual(accountRow.stamps, { progress: 2, max: 12 });
});
