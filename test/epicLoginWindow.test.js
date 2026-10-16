import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-epic-login-'));
process.env.MSR_DATA_DIR = tmpDir;

const { EpicManager } = await import('../src/core/epic.js');
const { default: configManager } = await import('../src/config.js');
const { firefoxSlotLock } = await import('../src/core/contextLock.js');

const ACCOUNT_ID = 'epic_login_window_test';

function ensureAccount() {
  if (!configManager.findEpicAccount(ACCOUNT_ID)) {
    configManager.upsertEpicAccount({ id: ACCOUNT_ID, name: '登录窗口测试账号' });
  }
}

function makeManager() {
  const em = new EpicManager();
  const closed = { context: 0 };
  em.launchPersistentContext = async () => ({
    context: {
      close: async () => { closed.context += 1; },
      pages: () => [],
      newPage: async () => ({})
    },
    page: { goto: async () => {} }
  });
  return { em, closed };
}

async function withVisibleBrowser(fn) {
  const prev = process.env.EPIC_VISIBLE;
  process.env.EPIC_VISIBLE = '1';
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.EPIC_VISIBLE;
    else process.env.EPIC_VISIBLE = prev;
  }
}

test('未启用可见浏览器或账号不存在时拒绝打开登录窗口', async () => {
  ensureAccount();
  const { em } = makeManager();
  const prev = process.env.EPIC_VISIBLE;
  delete process.env.EPIC_VISIBLE;
  try {
    await assert.rejects(() => em.openLoginWindow(ACCOUNT_ID), /未启用可见浏览器/);
    process.env.EPIC_VISIBLE = '1';
    await assert.rejects(() => em.openLoginWindow('epic_does_not_exist'), /Epic 账号不存在/);
  } finally {
    if (prev === undefined) delete process.env.EPIC_VISIBLE;
    else process.env.EPIC_VISIBLE = prev;
  }
  assert.equal(firefoxSlotLock.isBusy(), false, '被拒绝的登录请求不应残留资源锁');
});

test('登录窗口持有 Firefox 资源锁，关闭后释放', async () => {
  ensureAccount();
  const { em, closed } = makeManager();
  await withVisibleBrowser(async () => {
    const res = await em.openLoginWindow(ACCOUNT_ID);
    assert.equal(res.opened, true);
    assert.equal(em.isLoginWindowOpen(), true);
    assert.equal(firefoxSlotLock.isBusy(), true, '登录窗口打开期间必须占住 Firefox 锁');
    assert.equal(firefoxSlotLock.tryAcquire('other-owner'), false, '其他流程不得与登录窗口抢同一个 profile');

    await em.closeLoginWindow();
    assert.equal(em.isLoginWindowOpen(), false);
    assert.equal(firefoxSlotLock.isBusy(), false, '关闭登录窗口后必须释放 Firefox 锁');
    assert.equal(closed.context, 1);
  });
});

test('登录窗口启动失败时不残留 Firefox 资源锁', async () => {
  ensureAccount();
  const { em } = makeManager();
  em.launchPersistentContext = async () => { throw new Error('firefox launch boom'); };
  await withVisibleBrowser(async () => {
    await assert.rejects(() => em.openLoginWindow(ACCOUNT_ID), /firefox launch boom/);
  });
  assert.equal(em.isLoginWindowOpen(), false);
  assert.equal(firefoxSlotLock.isBusy(), false);
});

test('登录窗口打开时领取与校验快速失败，而不是去抢同一个 profile', async () => {
  ensureAccount();
  const { em } = makeManager();
  await withVisibleBrowser(async () => {
    await em.openLoginWindow(ACCOUNT_ID);
    await assert.rejects(() => em.verifySession(ACCOUNT_ID), /登录窗口已打开/);
    await assert.rejects(() => em.claimForAccount(ACCOUNT_ID), /登录窗口已打开/);
    await assert.rejects(() => em.claimOne(ACCOUNT_ID), /登录窗口已打开/);
    await assert.rejects(() => em.runClaimAll(), /登录窗口已打开/);
    assert.deepEqual(await em.checkAndClaimIfNeeded(), { skipped: 'login-window' });
    await em.closeLoginWindow();
  });
  assert.equal(firefoxSlotLock.isBusy(), false);
});

test('停止 Epic 任务会关闭登录窗口并释放 Firefox 锁', async () => {
  ensureAccount();
  const { em } = makeManager();
  await withVisibleBrowser(async () => {
    await em.openLoginWindow(ACCOUNT_ID);
    const res = await em.stop();
    assert.equal(res.stopped, true);
    assert.equal(em.isLoginWindowOpen(), false);
    assert.equal(firefoxSlotLock.isBusy(), false);
    em.stopRequested = false;
  });
});

test('没有打开登录窗口时保存凭据会报错', async () => {
  const { em } = makeManager();
  await assert.rejects(() => em.saveLoginWindow(ACCOUNT_ID), /没有已打开的登录窗口/);
});

test('登录窗口带自动关闭超时，关闭后定时器被清掉', async () => {
  ensureAccount();
  const { em } = makeManager();
  const prev = process.env.EPIC_LOGIN_TIMEOUT_MIN;
  await withVisibleBrowser(async () => {
    process.env.EPIC_LOGIN_TIMEOUT_MIN = '0';
    await em.openLoginWindow(ACCOUNT_ID);
    assert.equal(em.loginTimer, null, 'EPIC_LOGIN_TIMEOUT_MIN=0 时应禁用超时保护');
    await em.closeLoginWindow();

    process.env.EPIC_LOGIN_TIMEOUT_MIN = '5';
    await em.openLoginWindow(ACCOUNT_ID);
    assert.ok(em.loginTimer, '默认应给登录窗口设置自动关闭超时');
    await em.closeLoginWindow();
    assert.equal(em.loginTimer, null, '关闭登录窗口后必须清掉超时定时器');
  });
  if (prev === undefined) delete process.env.EPIC_LOGIN_TIMEOUT_MIN;
  else process.env.EPIC_LOGIN_TIMEOUT_MIN = prev;
  assert.equal(firefoxSlotLock.isBusy(), false);
});

test('登录完成判定优先信任导航登录态属性', async () => {
  const { em } = makeManager();
  let navigated = false;
  const page = {
    locator: () => ({ first() { return this; }, getAttribute: async () => 'true' }),
    goto: async () => { navigated = true; }
  };
  const r = await em.detectLoginCompleted(page);
  assert.equal(r.ok, true);
  assert.equal(navigated, false, '已能从导航属性确认登录时不必再跳转页面');
});

test('未登录时判定为未完成并提示重试', async () => {
  const { em } = makeManager();
  em.detectPageState = async () => ({ state: 'login' });
  const page = {
    locator: () => ({ first() { return this; }, getAttribute: async () => null }),
    goto: async () => {}
  };
  const r = await em.detectLoginCompleted(page);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-logged-in');
});

test('人机验证未通过时不把未登录状态保存成已登录', async () => {
  const { em } = makeManager();
  em.detectPageState = async () => ({ state: 'challenge' });
  const page = {
    locator: () => ({ first() { return this; }, getAttribute: async () => null }),
    goto: async () => {}
  };
  const r = await em.detectLoginCompleted(page);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'challenge');
});
