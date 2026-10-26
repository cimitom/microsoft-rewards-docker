import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-v189-'));
process.env.MSR_DATA_DIR = tmpDir;

const ROOT = path.resolve(import.meta.dirname, '..');
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'src/web/public/app.js'), 'utf-8');
const INDEX_SOURCE = fs.readFileSync(path.join(ROOT, 'src/web/public/index.html'), 'utf-8');
const { default: configManager } = await import('../src/config.js');
const { default: scheduler } = await import('../src/scheduler.js');
const {
  buildTimeSlot,
  normalizeAccountRunHours,
  reconcileAccountRunHours
} = await import('../src/core/scheduleWindow.js');

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('账号级时间选择只保留一个档位，空数组表示未排期', () => {
  assert.deepEqual(normalizeAccountRunHours([13, 9, 13]), [9]);
  assert.deepEqual(normalizeAccountRunHours([]), []);
  assert.deepEqual(normalizeAccountRunHours('invalid'), []);
  assert.equal(buildTimeSlot([]), null);
  assert.deepEqual(buildTimeSlot([15]), {
    startHour: 15,
    endHour: 16,
    randomDelayMin: 10,
    durationHours: 1
  });
});

test('历史重叠档位按账号顺序保留先占用者并清空冲突账号', () => {
  const accounts = [
    { id: 'a', name: '账号 A', order: 1, runHours: [10] },
    { id: 'b', name: '账号 B', order: 2, runHours: [10] }
  ];
  const result = reconcileAccountRunHours(accounts);

  assert.equal(result.changed, true);
  assert.deepEqual(accounts[0].runHours, [10]);
  assert.deepEqual(accounts[1].runHours, []);
  assert.equal(accounts[1].timeSlot, null);
  assert.deepEqual(result.cleared, [{
    id: 'b',
    name: '账号 B',
    hour: 10,
    occupiedBy: 'a',
    occupiedByName: '账号 A'
  }]);
});

test('配置保存会清理重叠账号，新增账号撞档时清空其时间选择', () => {
  configManager.update({
    accounts: [
      { id: 'v189_a', name: '账号 A', order: 1, enabled: true, cookie: 'x=1', runHours: [11] },
      { id: 'v189_b', name: '账号 B', order: 2, enabled: true, cookie: 'x=2', runHours: [11] }
    ]
  });

  assert.deepEqual(configManager.findAccount('v189_a').runHours, [11]);
  assert.deepEqual(configManager.findAccount('v189_b').runHours, []);
  assert.equal(configManager.getPublicConfig().scheduleConflicts.length, 1);

  const saved = configManager.upsertAccount({
    id: 'v189_c',
    name: '账号 C',
    enabled: true,
    cookie: 'x=3',
    runHours: [11]
  });
  assert.ok(saved.scheduleConflict);
  assert.deepEqual(configManager.findAccount('v189_c').runHours, []);
});

test('无时间档位账号不生成自动计划，改为空选择会移除旧计划', () => {
  configManager.update({
    accounts: [
      { id: 'v189_scheduled', name: '已排期', order: 1, enabled: true, cookie: 'x=1', runHours: [12] },
      { id: 'v189_paused', name: '未排期', order: 2, enabled: true, cookie: 'x=2', runHours: [] }
    ]
  });
  scheduler.plannedDailyRuns = {};
  scheduler.ensureDayPlans(20261026, false);

  const plans = scheduler.plannedDailyRuns['20261026'];
  assert.equal(plans.v189_scheduled.runHour, 12);
  assert.equal(plans.v189_paused, undefined);
  assert.equal(scheduler.getNextRunInfo().v189_paused.status, 'no-schedule');

  configManager.update({
    accounts: [
      { id: 'v189_scheduled', name: '已排期', order: 1, enabled: true, cookie: 'x=1', runHours: [12] },
      { id: 'v189_paused', name: '未排期', order: 2, enabled: true, cookie: 'x=2', runHours: [] }
    ]
  });
  scheduler.ensureDayPlans(20261026, false);
  assert.equal(scheduler.plannedDailyRuns['20261026'].v189_paused, undefined);
});

test('界面只允许单选，已占用档位禁用并提示未选择会暂停', () => {
  assert.match(APP_SOURCE, /function normalizeRunHoursInput/);
  assert.match(APP_SOURCE, /function getAccountRunHours/);
  assert.match(APP_SOURCE, /other\.checked = false/);
  assert.match(APP_SOURCE, /\$\{occupied \? 'disabled' : ''\}/);
  assert.match(APP_SOURCE, /case 'no-schedule'/);
  assert.match(APP_SOURCE, /未选择时间时自动任务不会启动/);
  assert.match(INDEX_SOURCE, /每个账号只能选择一个 1 小时档位/);
  assert.match(INDEX_SOURCE, /未选择时间时账号不会自动执行/);
});
