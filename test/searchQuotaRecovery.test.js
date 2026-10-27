import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-search-quota-'));
process.env.MSR_DATA_DIR = tmpDir;

const { default: configManager } = await import('../src/config.js');
const { default: networkClient } = await import('../src/network.js');
const { default: rewardsApi } = await import('../src/core/api.js');
const { TaskManager } = await import('../src/core/taskManager.js');

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('搜索配额读取会从骨架页自动重试到有效页面', async (t) => {
  const originalRequest = networkClient.request;
  let requestIndex = 0;
  const retryEvents = [];
  networkClient.request = async ({ url }) => {
    const pairIndex = Math.floor(requestIndex++ / 2);
    if (pairIndex === 0) return '<html><body>loading</body></html>';
    if (url.includes('/dashboard')) {
      return '<script>{"pointsCounters":{"pc":{"max":30,"progress":3},"totalPoints":675}}</script>';
    }
    return '<html><body>loading</body></html>';
  };
  t.after(() => {
    networkClient.request = originalRequest;
  });

  const quota = await rewardsApi.getSearchQuota({
    attempts: 2,
    retryDelaysMs: [0],
    onRetry: event => retryEvents.push(event)
  });

  assert.deepEqual(
    { progress: quota.progress, max: quota.max, source: quota.source, attemptsUsed: quota.attemptsUsed },
    { progress: 3, max: 30, source: 'dashboard', attemptsUsed: 2 }
  );
  assert.equal(retryEvents.length, 1);
  assert.equal(retryEvents[0].attempt, 1);
});

test('搜索配额重试耗尽后返回空，不伪造默认 60 分', async (t) => {
  const originalRequest = networkClient.request;
  networkClient.request = async () => '<html><body>loading</body></html>';
  t.after(() => {
    networkClient.request = originalRequest;
  });

  const quota = await rewardsApi.getSearchQuota({
    attempts: 2,
    retryDelaysMs: [0]
  });
  assert.equal(quota, null);
});

test('任务执行在官网暂时不可读时只使用当天已确认的官方配额', async (t) => {
  const accountId = 'acc_quota_cache';
  configManager.upsertAccount({
    id: accountId,
    name: '配额缓存测试',
    cookie: '_U=QUOTA_CACHE; MUID=1'
  });
  const manager = new TaskManager();
  const stats = manager.ensureAccountStats(accountId);
  stats.searchQuotaVerifiedAt = Date.now();
  stats.searchQuotaMax = 30;
  stats.searchQuotaProgress = 3;
  stats.searchQuotaSource = 'sync';
  manager.saveStats();

  const originalGetSearchQuota = rewardsApi.getSearchQuota;
  let probeCount = 0;
  rewardsApi.getSearchQuota = async () => {
    probeCount++;
    return null;
  };
  t.after(() => {
    rewardsApi.getSearchQuota = originalGetSearchQuota;
  });

  const account = configManager.findAccount(accountId);
  const cached = await manager.resolveSearchQuota(account, { pc: null }, {
    attempts: 1,
    retryDelaysMs: [],
    useCache: true,
    persist: false
  });
  assert.equal(probeCount, 1);
  assert.equal(cached.ok, true);
  assert.equal(cached.cached, true);
  assert.equal(cached.source, 'cache');
  assert.deepEqual(cached.pc, { progress: 3, max: 30 });

  const unknown = await manager.resolveSearchQuota(account, {
    pc: { progress: 0, max: 45 }
  }, {
    probeMissing: false,
    useCache: true,
    persist: false
  });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /未知搜索配额 45/);
});

test('未知配额会先重试，恢复为标准等级后才继续搜索', async (t) => {
  const accountId = 'acc_quota_unknown_retry';
  configManager.upsertAccount({
    id: accountId,
    name: '未知配额重试测试',
    cookie: '_U=QUOTA_UNKNOWN_RETRY; MUID=1'
  });
  const manager = new TaskManager();
  const originalGetSearchQuota = rewardsApi.getSearchQuota;
  rewardsApi.getSearchQuota = async () => ({
    progress: 4,
    max: 30,
    source: 'dashboard',
    attemptsUsed: 2
  });
  t.after(() => {
    rewardsApi.getSearchQuota = originalGetSearchQuota;
  });

  const account = configManager.findAccount(accountId);
  const result = await manager.resolveSearchQuota(account, {
    pc: { progress: 3, max: 45 }
  }, {
    attempts: 2,
    retryDelaysMs: [0],
    persist: false
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'retry');
  assert.deepEqual(result.pc, { progress: 4, max: 30 });
});

test('缺少配额时更新状态不能清空当天已验证的搜索额度', () => {
  const accountId = 'acc_quota_preserve';
  configManager.upsertAccount({
    id: accountId,
    name: '配额保留测试',
    cookie: '_U=QUOTA_PRESERVE; MUID=1'
  });
  const manager = new TaskManager();
  const stats = manager.ensureAccountStats(accountId);
  stats.searchQuotaVerifiedAt = Date.now();
  stats.searchQuotaMax = 30;
  stats.searchQuotaProgress = 3;
  stats.tasks.search = {
    ...stats.tasks.search,
    progress: 3,
    max: 30,
    points: 3,
    searchTier: { code: 'silver', label: '银牌', max: 30 }
  };
  manager.saveStats();

  manager.updateTask('search', {
    statusMessage: '官网暂时未返回搜索等级配额，已暂停搜索',
    searchQuotaErrorAt: Date.now()
  }, accountId);

  const preserved = manager.ensureAccountStats(accountId);
  assert.equal(preserved.tasks.search.progress, 3);
  assert.equal(preserved.tasks.search.max, 30);
  assert.equal(preserved.searchQuotaMax, 30);
});

test('搜索配额重试收到停止指令后立即取消，不再等待退避时间', async () => {
  const startedAt = Date.now();
  const quota = await rewardsApi.getSearchQuota({
    attempts: 4,
    retryDelaysMs: [5000, 10000, 30000],
    shouldStop: () => true
  });
  assert.equal(quota.aborted, true);
  assert.ok(Date.now() - startedAt < 250, '停止指令不能继续等待配额退避');
});

test('任务停止后 resolveSearchQuota 返回 stopped，不继续搜索', async () => {
  const accountId = 'acc_quota_stopped';
  configManager.upsertAccount({
    id: accountId,
    name: '配额停止测试',
    cookie: '_U=QUOTA_STOPPED; MUID=1'
  });
  const manager = new TaskManager();
  const account = configManager.findAccount(accountId);
  const result = await manager.resolveSearchQuota(account, null, {
    attempts: 4,
    retryDelaysMs: [5000, 10000, 30000],
    shouldStop: () => true,
    persist: false
  });
  assert.equal(result.ok, false);
  assert.equal(result.stopped, true);
  assert.match(result.reason, /任务已停止/);
});
