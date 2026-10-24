import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-v186-'));
process.env.MSR_DATA_DIR = tmpDir;

const ROOT = path.resolve(import.meta.dirname, '..');
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'src/web/public/app.js'), 'utf-8');
const STYLE_SOURCE = fs.readFileSync(path.join(ROOT, 'src/web/public/style.css'), 'utf-8');

const { default: configManager } = await import('../src/config.js');
const { default: networkClient } = await import('../src/network.js');
const { default: rewardsApi } = await import('../src/core/api.js');
const { default: browserManager } = await import('../src/core/browser.js');
const { EpicManager } = await import('../src/core/epic.js');
const { TaskManager } = await import('../src/core/taskManager.js');

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('Epic 公共接口忽略微软账号残留代理，但仍遵循全局代理策略', () => {
  configManager.setNetworkProxyConfig({
    proxies: [
      { id: 'proxy_global', name: '全局', url: 'http://127.0.0.1:18080' },
      { id: 'proxy_account', name: '账号', url: 'socks5h://127.0.0.1:11080' }
    ],
    defaultProxyId: 'proxy_global',
    useProxy: false,
    lockRegion: true
  });
  networkClient.setActiveProxyContext({
    mode: 'proxy',
    proxyId: 'proxy_account',
    proxyName: '账号',
    proxyUrl: 'socks5h://127.0.0.1:11080',
    missing: false
  });

  assert.equal(networkClient.getEffectiveProxyUrl(), 'socks5h://127.0.0.1:11080');
  assert.equal(networkClient.getEffectiveProxyUrl({ ignoreAccountProxy: true }), '');

  configManager.setNetworkProxyConfig({
    proxies: configManager.get().network.proxies,
    defaultProxyId: 'proxy_global',
    useProxy: true,
    lockRegion: true
  });
  assert.equal(
    networkClient.getEffectiveProxyUrl({ ignoreAccountProxy: true }),
    'http://127.0.0.1:18080'
  );
});

test('Epic 免费游戏请求显式传入忽略账号代理标记', async (t) => {
  const originalRequest = networkClient.request;
  let seenOptions = null;
  networkClient.request = async (options) => {
    seenOptions = options;
    return JSON.stringify({
      data: { Catalog: { searchStore: { elements: [] } } }
    });
  };
  t.after(() => {
    networkClient.request = originalRequest;
  });

  const manager = new EpicManager();
  const games = await manager.fetchFreeGamesFromApi();
  assert.deepEqual(games, []);
  assert.equal(seenOptions?.ignoreAccountProxy, true);
});

test('账号任务收尾会自动检查并领取额外积分', async (t) => {
  const originalCheck = rewardsApi.checkClaimablePoints;
  const originalClaim = browserManager.claimDashboardPoints;
  rewardsApi.checkClaimablePoints = async () => 18;
  browserManager.claimDashboardPoints = async () => 18;
  t.after(() => {
    rewardsApi.checkClaimablePoints = originalCheck;
    browserManager.claimDashboardPoints = originalClaim;
  });

  const manager = new TaskManager();
  const stats = { claimablePoints: 3 };
  const result = await manager.claimExtraPointsAfterTasks(
    { id: 'acc_v186_claim', name: '收尾领取测试' },
    stats
  );

  assert.deepEqual(result, { pending: 18, claimed: 18 });
  assert.equal(stats.claimablePoints, 0);
});

test('额外积分检查失败时保留已知待领取数量，不误清零', async (t) => {
  const originalCheck = rewardsApi.checkClaimablePoints;
  const originalClaim = browserManager.claimDashboardPoints;
  let claimCalled = false;
  rewardsApi.checkClaimablePoints = async () => null;
  browserManager.claimDashboardPoints = async () => {
    claimCalled = true;
    return 0;
  };
  t.after(() => {
    rewardsApi.checkClaimablePoints = originalCheck;
    browserManager.claimDashboardPoints = originalClaim;
  });

  const manager = new TaskManager();
  const stats = { claimablePoints: 7 };
  const result = await manager.claimExtraPointsAfterTasks(
    { id: 'acc_v186_pending', name: '待领取保留测试' },
    stats
  );

  assert.equal(claimCalled, true);
  assert.deepEqual(result, { pending: 7, claimed: 0 });
  assert.equal(stats.claimablePoints, 7);
});

test('多账号栏自动换行，四张汇总卡完整展示且代理卡显示分配账号', () => {
  assert.match(STYLE_SOURCE, /\.account-selector-bar\s*\{[\s\S]*?flex-wrap:\s*wrap/);
  assert.doesNotMatch(STYLE_SOURCE, /\.account-selector-bar\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(STYLE_SOURCE, /\.hero-account-breakdown\s*\{[\s\S]*?max-height:\s*none/);
  assert.match(STYLE_SOURCE, /\.stamps-account-list\s*\{[\s\S]*?max-height:\s*none/);
  assert.match(APP_SOURCE, /function getProxyAssignedAccounts\(proxyId\)/);
  assert.match(APP_SOURCE, /当前分配账号/);
});
