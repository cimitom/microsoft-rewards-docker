import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-v1810-'));
process.env.MSR_DATA_DIR = tmpDir;

const ROOT = path.resolve(import.meta.dirname, '..');
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'src/web/public/app.js'), 'utf-8');
const {
  default: rewardsApi,
  extractJsonObjectsWithKey,
  isServerActionAcknowledged,
  weekdayFromOfferId
} = await import('../src/core/api.js');
const { TaskManager } = await import('../src/core/taskManager.js');
const { default: networkClient } = await import('../src/network.js');

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('打孔卡日志只保留当前进度以内的唯一记录', () => {
  const manager = new TaskManager();
  const task = {
    progress: 3,
    max: 8,
    done: false,
    stepLogs: [
      { step: 1, at: 1 },
      { step: 2, at: 2 },
      { step: 2, at: 3 },
      { step: 3, at: 4 },
      { step: 4, at: 5 },
      { step: 7, at: 6 }
    ]
  };
  const result = manager.normalizePunchCardTask(task);
  assert.equal(result.changed, true);
  assert.equal(task.progress, 3);
  assert.deepEqual(task.stepLogs.map(log => log.step), [1, 2, 3]);
  assert.equal(task.stepLogs[1].at, 3);
});

test('新周期重置旧打孔进度，同周期仍防止瞬时 0 回退', () => {
  const manager = new TaskManager();
  const previous = {
    cycleKey: 'old-week',
    progress: 7,
    max: 8,
    done: false,
    stepLogs: [1, 2, 3, 4, 5, 6, 7].map(step => ({ step, at: step }))
  };
  const nextCycle = manager.mergePunchCardTask(previous, {
    cycleKey: 'new-week',
    progress: 3,
    max: 8,
    done: false,
    stepLogs: [1, 2, 3].map(step => ({ step, at: step + 10 }))
  });
  assert.equal(nextCycle.progress, 3);
  assert.deepEqual(nextCycle.stepLogs.map(log => log.step), [1, 2, 3]);

  const sameCycle = manager.mergePunchCardTask(nextCycle, {
    cycleKey: 'new-week',
    progress: 0,
    max: 8,
    done: false,
    stepLogs: []
  });
  assert.equal(sameCycle.progress, 3);
  assert.deepEqual(sameCycle.stepLogs.map(log => log.step), [1, 2, 3]);
});

test('Flight 对象解析支持嵌套结构并识别桌面任务星期', () => {
  const text = 'prefix {"offerId":"WW_pcchild4_urlreward_Tuesday_RewardsApp_weekly_Exclusive_Octw4_2026_punchcard","hash":"abc","attributes":{"nested":true},"isLocked":true} suffix';
  const objects = extractJsonObjectsWithKey(text);
  assert.equal(objects.length, 1);
  assert.equal(objects[0].attributes.nested, true);
  assert.equal(weekdayFromOfferId(objects[0].offerId), 'tuesday');
});

test('桌面任务 Server Action 使用完整 RSC 请求头并只认真实确认', async () => {
  const originalRequest = networkClient.request;
  let captured = null;
  rewardsApi.cachedNextAction = 'a'.repeat(40);
  rewardsApi.cachedDeploymentId = '20261022-5';
  networkClient.request = async (options) => {
    captured = options;
    return {
      data: '0:{"a":"$@1","q":"","i":false}\n1:true\n',
      status: 200,
      headers: {}
    };
  };
  try {
    const ok = await rewardsApi.claimCard({
      kind: 'desktop_app',
      offerId: 'WW_pcchild4_urlreward_Tuesday_RewardsApp_weekly_Exclusive_Octw4_2026_punchcard',
      parentQuestId: 'WW_pcparent_RewardsApp_weekly_Exclusive_Octw4_2026_punchcard',
      hash: 'b'.repeat(64),
      url: 'https://rewards.bing.com/earn/quest/WW_pcparent_RewardsApp_weekly_Exclusive_Octw4_2026_punchcard'
    });
    assert.equal(ok, true);
    assert.equal(captured.returnResponse, true);
    assert.equal(captured.headers.accept, 'text/x-component');
    assert.equal(captured.headers.origin, 'https://rewards.bing.com');
    assert.match(captured.headers['user-agent'], /MSRewards\/Desktop\/1\.4\.56/);
    assert.equal(captured.headers['X-MSRewards-App'], '1');
    assert.equal(captured.headers['X-Rewards-Source'], 'msrewards-desktop');
    assert.ok(captured.headers['next-router-state-tree']);
    assert.equal(captured.headers['x-deployment-id'], '20261022-5');
    assert.equal(isServerActionAcknowledged(captured.data), false);
  } finally {
    networkClient.request = originalRequest;
  }
});

test('桌面任务 404 重试仍保留 Rewards Desktop 客户端请求头', async () => {
  const originalRequest = networkClient.request;
  rewardsApi.cachedNextAction = 'c'.repeat(40);
  rewardsApi.cachedDeploymentId = '20261022-6';
  let postCount = 0;
  let retryHeaders = null;
  networkClient.request = async (options) => {
    if (options.method === 'POST') {
      postCount++;
      if (postCount === 1) throw new Error('HTTP 404');
      retryHeaders = options.headers;
      return {
        data: '1:true\n',
        status: 200,
        headers: {}
      };
    }
    return '<html></html>';
  };
  try {
    const ok = await rewardsApi.claimCard({
      kind: 'desktop_app',
      offerId: 'WW_pcchild4_urlreward_Tuesday_RewardsApp_weekly_Exclusive_Octw4_2026_punchcard',
      parentQuestId: 'WW_pcparent_RewardsApp_weekly_Exclusive_Octw4_2026_punchcard',
      hash: 'd'.repeat(64),
      url: 'https://rewards.bing.com/earn/quest/WW_pcparent_RewardsApp_weekly_Exclusive_Octw4_2026_punchcard'
    });
    assert.equal(ok, true);
    assert.match(retryHeaders['user-agent'], /MSRewards\/Desktop\/1\.4\.56/);
    assert.equal(retryHeaders['X-MSRewards-App'], '1');
    assert.equal(retryHeaders['X-Rewards-Source'], 'msrewards-desktop');
  } finally {
    networkClient.request = originalRequest;
  }
});

test('悬浮明细不会把超过当前进度的旧日志显示为已完成', () => {
  assert.match(APP_SOURCE, /const log = s <= p \? logs\.find\(l => Number\(l\.step\) === s\) : null/);
  assert.match(APP_SOURCE, /const p = Math\.max\(0, Math\.min\(m, Number\(t\.progress \|\| 0\)\)\)/);
});
