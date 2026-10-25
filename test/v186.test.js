import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-v186-'));
process.env.MSR_DATA_DIR = tmpDir;

const ROOT = path.resolve(import.meta.dirname, '..');
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'src/web/public/app.js'), 'utf-8');
const INDEX_SOURCE = fs.readFileSync(path.join(ROOT, 'src/web/public/index.html'), 'utf-8');
const STYLE_SOURCE = fs.readFileSync(path.join(ROOT, 'src/web/public/style.css'), 'utf-8');

const { default: configManager } = await import('../src/config.js');
const { default: networkClient } = await import('../src/network.js');
const { default: rewardsApi } = await import('../src/core/api.js');
const { default: authManager } = await import('../src/core/auth.js');
const { default: browserManager } = await import('../src/core/browser.js');
const { EpicManager } = await import('../src/core/epic.js');
const { TaskManager } = await import('../src/core/taskManager.js');
const { createServer } = await import('../src/web/server.js');

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
  assert.ok(stats.lastClaimAt > 0);
  assert.equal(stats.lastClaimedPoints, 18);
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

test('Cookie 或 Token 任意一端失效时账号体检整体状态必须为失效', async (t) => {
  const accountId = 'acc_v186_half_valid';
  configManager.upsertAccount({
    id: accountId,
    name: '单端失效测试',
    cookie: '_U=VALID_COOKIE',
    refreshToken: 'EXPIRED_TOKEN'
  });
  const originalCookie = authManager.checkCookieStatus;
  const originalToken = authManager.checkTokenStatus;
  authManager.checkCookieStatus = async () => ({
    valid: true,
    searchReady: true,
    warning: false,
    balance: 100,
    userName: '网页用户'
  });
  authManager.checkTokenStatus = async () => ({
    valid: false,
    message: 'Refresh Token 已过期或失效，请重新授权'
  });
  t.after(() => {
    authManager.checkCookieStatus = originalCookie;
    authManager.checkTokenStatus = originalToken;
  });

  const result = await authManager.testAccount(accountId);
  assert.equal(result.cookie.valid, true);
  assert.equal(result.token.valid, false);
  assert.equal(result.overallValid, false);
  assert.equal(result.allValid, false);
});

test('Token 测试接口使用当前账号代理，并支持候选授权码临时换取', async (t) => {
  configManager.setNetworkProxyConfig({
    proxies: [
      { id: 'proxy_token_test', name: 'Token 测试节点', url: 'http://127.0.0.1:18081' }
    ],
    defaultProxyId: 'proxy_token_test',
    useProxy: true,
    lockRegion: true
  });
  const originalExchange = authManager.exchangeCodeForToken;
  const originalCheckToken = authManager.checkTokenStatus;
  let proxyDuringExchange = null;
  let proxyDuringTest = null;
  authManager.exchangeCodeForToken = async () => {
    proxyDuringExchange = networkClient.getActiveProxyContext();
    return { accessToken: 'draft_access', refreshToken: 'draft_refresh' };
  };
  authManager.checkTokenStatus = async () => {
    proxyDuringTest = networkClient.getActiveProxyContext();
    return { valid: true, message: 'Token 测试通过' };
  };

  const app = createServer();
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    authManager.exchangeCodeForToken = originalExchange;
    authManager.checkTokenStatus = originalCheckToken;
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  });

  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/test-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '候选 Token 账号',
      urlOrCode: 'https://login.live.com/oauth20_desktop.srf?code=M.TEST',
      proxy: { mode: 'proxy', proxyId: 'proxy_token_test' }
    })
  }).then(res => res.json());

  assert.equal(response.success, true);
  assert.equal(response.data.tokens.accessToken, 'draft_access');
  assert.equal(proxyDuringExchange?.proxyId, 'proxy_token_test');
  assert.equal(proxyDuringTest?.proxyId, 'proxy_token_test');
});

test('多账号栏自动换行，四张汇总卡完整展示且代理卡显示分配账号', () => {
  assert.match(STYLE_SOURCE, /\.account-selector-bar\s*\{[\s\S]*?flex-wrap:\s*wrap/);
  assert.doesNotMatch(STYLE_SOURCE, /\.account-selector-bar\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(STYLE_SOURCE, /\.hero-account-breakdown\s*\{[\s\S]*?max-height:\s*none/);
  assert.match(STYLE_SOURCE, /\.stamps-account-list\s*\{[\s\S]*?max-height:\s*none/);
  assert.match(APP_SOURCE, /function getProxyAssignedAccounts\(proxyId\)/);
  assert.match(APP_SOURCE, /当前分配账号/);
});

test('账号编辑与配置中心提供授权页、Cookie/Token 测试和代理提示', () => {
  assert.match(INDEX_SOURCE, /id="btn-quick-test-cookie"/);
  assert.match(INDEX_SOURCE, /id="btn-quick-test-token"/);
  assert.match(INDEX_SOURCE, /id="btn-test-modal-token"/);
  assert.match(INDEX_SOURCE, /id="btn-exchange-token"/);
  assert.match(INDEX_SOURCE, /oauth20_authorize\.srf[\s\S]*target="_blank"/);
  assert.match(INDEX_SOURCE, /测试会使用上方当前账号的代理/);
  assert.match(APP_SOURCE, /\/api\/auth\/test-token/);
  assert.match(APP_SOURCE, /readProxySelection\('quick-add-proxy-mode', 'quick-add-proxy-id'\)/);
  assert.match(APP_SOURCE, /const effectiveOverallValid = d\.cookieValid !== false[\s\S]*d\.tokenValid !== false/);
});
