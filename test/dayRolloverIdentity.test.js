import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-day-rollover-'));
process.env.MSR_DATA_DIR = tmpDir;

const { default: configManager } = await import('../src/config.js');
const { DATA_DIR } = await import('../src/fsUtil.js');
const { TaskManager } = await import('../src/core/taskManager.js');

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('跨日只清空每日进度，不会误判网页身份变化并再次清空余额', () => {
  const acc = configManager.upsertAccount({
    id: 'acc_day_rollover',
    name: '跨日身份测试',
    cookie: '_U=DAY_ROLLOVER; MUID=1'
  });
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const oldDate = Number(
    `${yesterday.getFullYear()}${String(yesterday.getMonth() + 1).padStart(2, '0')}${String(yesterday.getDate()).padStart(2, '0')}`
  );

  const seedManager = new TaskManager();
  const oldStats = seedManager.createDefaultAccountStats(acc.id, acc.name);
  oldStats.date = oldDate;
  oldStats.balance = 500;
  oldStats.earned = 23;
  oldStats.webIdentityKey = acc.webIdentityKey;
  oldStats.identityAppliedAt = acc.identityChangedAt;
  oldStats.credentialAppliedAt = acc.credentialUpdatedAt;
  oldStats.tasks.search = {
    ...oldStats.tasks.search,
    progress: 7,
    max: 15,
    points: 7,
    done: false
  };
  fs.writeFileSync(
    path.join(DATA_DIR, 'stats.json'),
    JSON.stringify({ date: oldDate, accounts: { [acc.id]: oldStats } }, null, 2)
  );

  const manager = new TaskManager();
  const current = manager.ensureAccountStats(acc.id);
  assert.equal(current.webIdentityKey, acc.webIdentityKey);
  assert.equal(current.identityAppliedAt, acc.identityChangedAt);
  assert.equal(current.balance, 500);
  assert.equal(current.tasks.search.progress, 0);
  assert.equal(current.tasks.search.max, 0);
});

