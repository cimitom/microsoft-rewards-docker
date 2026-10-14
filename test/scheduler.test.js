import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-sched-'));
process.env.MSR_DATA_DIR = tmpDir;

const { default: scheduler } = await import('../src/scheduler.js');
const { default: configManager } = await import('../src/config.js');

test('跨零点窗口的分钟偏移计算正确', () => {
  // 21:00 - 01:00 的窗口（start=1260, end=60, wraps=true）
  assert.equal(scheduler.minutesIntoWindow(1260, true, 22 * 60), 60, '22:00 距窗口起点 60 分钟');
  assert.equal(scheduler.minutesIntoWindow(1260, true, 30), 210, '次日 00:30 距窗口起点 210 分钟');
  // 跨零点窗口「还没开始」时返回的是一个 >= windowLength 的正数（而不是负数），
  // 调用方统一用 `0 <= offset < windowLength` 判断是否在窗口内。
  const notStarted = scheduler.minutesIntoWindow(1260, true, 12 * 60);
  assert.ok(notStarted >= 240, `未进入窗口时应 >= windowLength，实际 ${notStarted}`);
});

test('普通窗口的分钟偏移计算正确', () => {
  assert.equal(scheduler.minutesIntoWindow(540, false, 600), 60);
  assert.equal(scheduler.minutesIntoWindow(540, false, 480), -60);
});

test('日期偏移能跨月与跨年', () => {
  assert.equal(scheduler.shiftDateNum(20261031, 1), 20261101);
  assert.equal(scheduler.shiftDateNum(20261231, 1), 20270101);
  assert.equal(scheduler.shiftDateNum(20260101, -1), 20251231);
});

test('跨零点窗口的计划时间戳落在窗口起点当天', () => {
  const plan = { startMin: 1260, wraps: true, offset: 30 };
  const at = scheduler.planTimestamp(20261015, plan, 0);
  const d = new Date(at);
  assert.equal(d.getHours(), 21);
  assert.equal(d.getMinutes(), 30);
  assert.equal(d.getDate(), 15);
});

test('每个启用账号每天只排一次，且偏移落在允许区间内', () => {
  configManager.update({ accounts: [
    { id: 'acc_a', name: 'A', enabled: true, cookie: 'x=1' },
    { id: 'acc_b', name: 'B', enabled: false, cookie: 'x=1' }
  ] });
  scheduler.plannedDailyRuns = {};
  scheduler.ensureDayPlans(20261015, false);
  const plans = scheduler.plannedDailyRuns['20261015'];
  assert.ok(plans.acc_a, '启用账号应有计划');
  assert.equal(plans.acc_b, undefined, '停用账号不排计划');
  assert.ok(plans.acc_a.offset >= 0 && plans.acc_a.offset <= 59, '偏移必须在 0-59 分钟内');
  assert.equal(plans.acc_a.executed, false);

  // 再次调用不应覆盖已生成的计划
  const before = plans.acc_a.offset;
  scheduler.ensureDayPlans(20261015, false);
  assert.equal(scheduler.plannedDailyRuns['20261015'].acc_a.offset, before);
});
