import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-epic-sched-'));
process.env.MSR_DATA_DIR = tmpDir;

const ROOT = path.resolve(import.meta.dirname, '..');
const { normalizeAutoClaimTime } = await import('../src/core/epic.js');
const { default: epicManager } = await import('../src/core/epic.js');
const { default: scheduler } = await import('../src/scheduler.js');

/**
 * 这组断言防的是 v1.7.3 修掉的真实事故：
 * 容器重启后 Epic 会在 1 分钟内自动跑一轮 —— 因为 lastCheckAt 是内存值、
 * 重启即归零，`if (lastCheckAt && ...)` 于是恒为假，间隔限制完全失效。
 * 现在改为「到设定时间才启动」+「首次检查以进程启动时刻为下限」。
 */

test('normalizeAutoClaimTime 归一化合法时间、拒绝非法值', () => {
  assert.equal(normalizeAutoClaimTime('10:00'), '10:00');
  assert.equal(normalizeAutoClaimTime('9:05'), '09:05');
  assert.equal(normalizeAutoClaimTime(' 23:59 '), '23:59');
  assert.equal(normalizeAutoClaimTime('00:00'), '00:00');
  // 非法输入一律回落到默认值，避免空值让定时任务永不触发
  assert.equal(normalizeAutoClaimTime(''), '10:00');
  assert.equal(normalizeAutoClaimTime(undefined), '10:00');
  assert.equal(normalizeAutoClaimTime('24:00'), '10:00');
  assert.equal(normalizeAutoClaimTime('10:60'), '10:00');
  assert.equal(normalizeAutoClaimTime('abc'), '10:00');
});

test('Epic 设置暴露 autoClaimTime，默认 10:00', () => {
  const s = epicManager.getSettings();
  assert.match(s.autoClaimTime, /^\d{2}:\d{2}$/);
  assert.equal(s.autoClaimTime, '10:00');
});

test('到点前不触发，到点后才触发', () => {
  const at = (h, m) => new Date(2026, 0, 5, h, m, 0).getTime();
  const settings = { enabled: true, autoClaimTime: '10:00', checkIntervalMin: 30 };

  // 用很久以前的时间做「上次检查」，隔离掉间隔因素，只看时间闸门
  const savedLast = epicManager.lastCheckAt;
  const savedBoot = epicManager.bootedAt;
  try {
    epicManager.lastCheckAt = at(0, 0);
    epicManager.bootedAt = at(0, 0);
    assert.equal(scheduler.shouldRunEpicCheck(settings, at(9, 59)), false, '09:59 应保持暂停');
    assert.equal(scheduler.shouldRunEpicCheck(settings, at(10, 0)), true, '10:00 应放行');
    assert.equal(scheduler.shouldRunEpicCheck(settings, at(10, 1)), true);
  } finally {
    epicManager.lastCheckAt = savedLast;
    epicManager.bootedAt = savedBoot;
  }
});

test('重启后不会立刻跑：首次检查以进程启动时刻为下限', () => {
  const boot = new Date(2026, 0, 5, 10, 0, 0).getTime();
  const settings = { enabled: true, autoClaimTime: '10:00', checkIntervalMin: 30 };

  const savedLast = epicManager.lastCheckAt;
  const savedBoot = epicManager.bootedAt;
  try {
    // 模拟刚重启：lastCheckAt 归零（内存值丢失），bootedAt 是启动时刻
    epicManager.lastCheckAt = 0;
    epicManager.bootedAt = boot;

    assert.equal(scheduler.shouldRunEpicCheck(settings, boot + 60 * 1000), false, '重启 1 分钟后不应执行');
    assert.equal(scheduler.shouldRunEpicCheck(settings, boot + 29 * 60 * 1000), false, '未满间隔不应执行');
    assert.equal(scheduler.shouldRunEpicCheck(settings, boot + 30 * 60 * 1000), true, '满间隔后放行');
  } finally {
    epicManager.lastCheckAt = savedLast;
    epicManager.bootedAt = savedBoot;
  }
});

test('关闭自动领取后任何时刻都不触发', () => {
  const at = (h, m) => new Date(2026, 0, 5, h, m, 0).getTime();
  const settings = { enabled: false, autoClaimTime: '00:00', checkIntervalMin: 5 };
  const savedLast = epicManager.lastCheckAt;
  try {
    epicManager.lastCheckAt = 0;
    assert.equal(scheduler.shouldRunEpicCheck(settings, at(23, 59)), false);
  } finally {
    epicManager.lastCheckAt = savedLast;
  }
});

test('更新检查读 tags 而不是 releases/latest', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/web/server.js'), 'utf-8');
  assert.ok(
    !/api\.github\.com\/repos\/[^'"`\s]*\/releases\/latest/.test(src),
    'releases/latest 只反映「最近一次发布的 Release」，历史上只到 v1.6.2，' +
    '会让 v1.6.3~v1.7.2 之间的用户永远看不到更新，必须改为读 tags（注释里提及可以）'
  );
  assert.match(src, /\/tags\?per_page=/, '应从 tags 列表取语义化版本最大值');
  assert.match(src, /checkFailed/, '检查失败必须如实上报，不能伪装成「已是最新」');
});
