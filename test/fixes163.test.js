import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-fixes-'));
process.env.MSR_DATA_DIR = tmpDir;

const { default: configManager, SECRET_PLACEHOLDER, SECRET_CLEAR } = await import('../src/config.js');
const { default: rewardsApi } = await import('../src/core/api.js');
const { default: scheduler } = await import('../src/scheduler.js');

test('SECRET_CLEAR 和 null 可以彻底清空凭据，而不是被旧值复原', () => {
  configManager.upsertAccount({
    id: 'acc_clear_test',
    name: '清空测试账号',
    cookie: 'ORIGINAL_COOKIE',
    refreshToken: 'ORIGINAL_REFRESH_TOKEN',
    accessToken: 'ORIGINAL_ACCESS_TOKEN'
  });

  let acc = configManager.findAccount('acc_clear_test');
  assert.equal(acc.cookie, 'ORIGINAL_COOKIE');
  assert.equal(acc.refreshToken, 'ORIGINAL_REFRESH_TOKEN');

  // 1. 用 null 清空 Token
  configManager.upsertAccount({
    id: 'acc_clear_test',
    accessToken: null,
    refreshToken: null
  });
  acc = configManager.findAccount('acc_clear_test');
  assert.equal(acc.accessToken, '', 'accessToken 应被清空为字符串');
  assert.equal(acc.refreshToken, '', 'refreshToken 应被清空为字符串');
  assert.equal(acc.cookie, 'ORIGINAL_COOKIE', '未声明清空的 cookie 仍保留');

  // 2. 用 SECRET_CLEAR 清空 Cookie
  configManager.upsertAccount({
    id: 'acc_clear_test',
    cookie: SECRET_CLEAR
  });
  acc = configManager.findAccount('acc_clear_test');
  assert.equal(acc.cookie, '', 'cookie 应被清空');
});

test('getHotSearchWord 在热词耗尽且网络失败时不抛异常且绝不返回 undefined', async () => {
  rewardsApi.hotWordList = ['词1', '词2'];
  rewardsApi.hotWordIndex = 2; // 模拟已取完

  // 模拟网络请求失败
  const origFetch = rewardsApi.fetchSearchWordList;
  rewardsApi.fetchSearchWordList = async () => ({ success: false, sample: [] });

  try {
    const word = await rewardsApi.getHotSearchWord();
    assert.ok(typeof word === 'string' && word.length > 0, '必须返回非空字符串兜底词');
    assert.notEqual(word, 'undefined', '不能返回字符串 undefined');
    assert.notEqual(word, undefined, '不能返回 undefined');
  } finally {
    rewardsApi.fetchSearchWordList = origFetch;
  }
});

test('scheduler 计划落盘与跨实例恢复：已执行状态不丢失', () => {
  const today = scheduler.getTodayNum();
  scheduler.ensureDayPlans(today, false);
  const plan = scheduler.plannedDailyRuns[String(today)]?.acc_1;
  if (plan) {
    plan.executed = true;
    scheduler.savePlans();

    // 重新从磁盘加载
    scheduler.plannedDailyRuns = {};
    scheduler.loadPlans();
    assert.equal(scheduler.plannedDailyRuns[String(today)]?.acc_1?.executed, true, '重启后已执行状态必须保持 true');
  }
});
