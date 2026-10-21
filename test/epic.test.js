import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-epic-test-'));
process.env.MSR_DATA_DIR = tmpDir;

const {
  isEpicChallengeText,
  isEpicLoginText,
  EPIC_ORDER_BUTTON_RE,
  EPIC_FINAL_ORDER_BUTTON_RE,
  EPIC_SUCCESS_TEXT_RE,
  epicProfilePath,
  EpicManager
} = await import('../src/core/epic.js');
const { default: configManager } = await import('../src/config.js');

test('Epic 人机验证与登录标识识别准确', () => {
  assert.equal(isEpicChallengeText('Verify you are human before accessing store'), true);
  assert.equal(isEpicChallengeText('请确认您是真人'), true);
  assert.equal(isEpicChallengeText('Checking your browser before accessing epicgames.com'), true);
  assert.equal(isEpicChallengeText('Error: cf-mitigated challenge encountered'), true);
  assert.equal(isEpicChallengeText('当前按钮：继续 / TRY AGAIN'), true);
  assert.equal(isEpicChallengeText('Bad Cheese - 限时免费'), false);

  assert.equal(isEpicLoginText('登录以获取免费游戏'), true);
  assert.equal(isEpicLoginText('Sign in with Epic Games'), true);
  assert.equal(isEpicLoginText('获取已拥有游戏'), false);
});

test('epicProfilePath 隔离账号并安全清理特殊字符', () => {
  const p1 = epicProfilePath('epic_1791970091529');
  assert.match(p1, /epic-firefox-profiles[/\\]epic_1791970091529$/);

  const p2 = epicProfilePath('user/../evil:1');
  assert.ok(!p2.includes('..'));
  assert.match(p2, /user____evil_1$/);
});

test('deleteEpicAccount 会一并清理账号对应的浏览器持久化 profile 目录', () => {
  const acc = configManager.upsertEpicAccount({
    id: 'epic_test_profile_del',
    name: '待删账号'
  });
  const dir = epicProfilePath(acc.id);
  const chromiumDir = `${dir}-chromium`;
  const chromiumLoginDir = path.join(path.dirname(dir), `${acc.id}-login-chromium`);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(chromiumDir, { recursive: true });
  fs.mkdirSync(chromiumLoginDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'test-cookie.txt'), 'cf_clearance_dummy');
  assert.equal(fs.existsSync(dir), true);
  assert.equal(fs.existsSync(chromiumDir), true);
  assert.equal(fs.existsSync(chromiumLoginDir), true);

  configManager.deleteEpicAccount(acc.id);
  assert.equal(fs.existsSync(dir), false, '删除账号后持久化 profile 目录应被彻底清理');
  assert.equal(fs.existsSync(chromiumDir), false, '删除账号后 Chromium 领取 profile 也应被清理');
  assert.equal(fs.existsSync(chromiumLoginDir), false, '删除账号后 Chromium 登录 profile 也应被清理');
});

test('EpicManager 在任务进行中时拒绝校验与并发', async () => {
  const em = new EpicManager();
  em.running = true;
  await assert.rejects(
    async () => em.verifySession('demo_epic_1'),
    /Epic 任务正在运行中/
  );
  em.running = false;
  em.verifying = true;
  await assert.rejects(
    async () => em.claimOne('demo_epic_1'),
    /Epic 任务正在运行中/
  );
});

test('Epic 结账按钮与成功文案覆盖“添加到库”当前文案', () => {
  assert.equal(EPIC_ORDER_BUTTON_RE.test('添加到库'), true);
  assert.equal(EPIC_ORDER_BUTTON_RE.test('Add to Library'), true);
  assert.equal(EPIC_ORDER_BUTTON_RE.test('确认订单'), true);
  assert.equal(EPIC_ORDER_BUTTON_RE.test('愿望清单'), false);
  assert.equal(EPIC_FINAL_ORDER_BUTTON_RE.test('添加到库'), true);
  assert.equal(EPIC_FINAL_ORDER_BUTTON_RE.test('Checkout'), false, '打开结账层不能当成最终确认按钮');

  assert.equal(EPIC_SUCCESS_TEXT_RE.test('已添加到库'), true);
  assert.equal(EPIC_SUCCESS_TEXT_RE.test('Added to your library'), true);
  assert.equal(EPIC_SUCCESS_TEXT_RE.test('获取'), false);
});

test('Epic 停止请求会关闭活动浏览器上下文并标记状态', async () => {
  const em = new EpicManager();
  let closed = false;
  em.running = true;
  em.activeContext = { close: async () => { closed = true; } };
  const result = await em.stop();
  assert.equal(result.stopped, true);
  assert.equal(closed, true);
  assert.equal(em.stopRequested, true);
  assert.equal(em.state.status, 'stopping');
  em.running = false;
  em.activeContext = null;
  em.stopRequested = false;
});

test('手动完成验证后出现“已在库中”即可确认领取完成', async () => {
  const em = new EpicManager();
  const makeLocator = () => ({
    first() { return this; },
    nth() { return this; },
    count: async () => 1,
    isVisible: async () => true,
    isEnabled: async () => true
  });
  const page = {
    getByText: text => ({ ...makeLocator(), count: async () => /已在库中/.test(String(text)) ? 1 : 0 }),
    getByRole: () => ({ ...makeLocator(), count: async () => 0 }),
    locator: () => ({ ...makeLocator(), count: async () => 0 })
  };
  const outcome = await em.detectClaimOutcome(page);
  assert.deepEqual(outcome, { status: 'owned', message: '已在库中' });
});

test('停止后 claimOne 会把状态从 retrying 收尾为 idle', async () => {
  const id = `epic_stop_state_${Date.now()}`;
  configManager.upsertEpicAccount({ id, name: '停止状态测试' });
  const em = new EpicManager();
  em.claimForAccount = async () => {
    const e = new Error('Epic 任务已手动停止');
    e.code = 'EPIC_STOPPED';
    throw e;
  };
  em.updateState({ status: 'retrying', progress: 55, lastAction: '等待重试...' });
  await assert.rejects(() => em.claimOne(id), /已手动停止/);
  assert.equal(em.running, false);
  assert.equal(em.stopRequested, false);
  assert.equal(em.state.status, 'idle');
  assert.equal(em.state.code, 'stopped');
});

test('校验按钮会同步免费游戏的已在库与可领取状态', async () => {
  const id = `epic_ownership_${Date.now()}`;
  configManager.upsertEpicAccount({
    id,
    name: '入库状态测试',
    handledGames: {
      g2: { at: Date.now(), status: 'owned', title: '游戏二' }
    }
  });
  const em = new EpicManager();
  em.fetchFreeGames = async () => [
    { id: 'g1', title: '游戏一', url: 'https://example.test/g1', isFreeNow: true },
    { id: 'g2', title: '游戏二', url: 'https://example.test/g2', isFreeNow: true }
  ];
  const page = {
    currentGameId: '',
    getByRole: () => ({
      first() { return this; },
      count: async () => page.currentGameId === 'g2' ? 1 : 0,
      isVisible: async () => true
    })
  };
  em.navigateEpicPage = async (_page, url) => {
    page.currentGameId = url.endsWith('/g1') ? 'g1' : 'g2';
    return { state: page.currentGameId === 'g1' ? 'owned' : 'product' };
  };
  em.detectOwnedState = async () => page.currentGameId === 'g1';

  const statuses = await em.refreshGameOwnership(page, id);
  assert.deepEqual(statuses.map(x => x.status), ['owned', 'available']);
  const saved = configManager.findEpicAccount(id);
  assert.equal(saved.handledGames.g1.status, 'owned');
  assert.equal(saved.handledGames.g2, undefined, '仍可领取的游戏必须从已入库记录中移除');
});

test('验证码残留 TRY AGAIN 时，可见的“添加到库”按钮优先执行', async () => {
  const em = new EpicManager();
  let orderClicked = false;
  em.delay = async () => {};
  em.checkEpicAccountSession = async () => ({ valid: true, state: 'logged-in' });
  em.navigateEpicPage = async () => ({ state: 'product' });
  em.detectPageState = async () => ({ state: 'checkout' });
  em.detectClaimOutcome = async () => orderClicked ? { status: 'owned', message: '已在库中' } : null;

  const makeLocator = (kind) => ({
    first() { return this; },
    count: async () => 1,
    isVisible: async () => true,
    click: async () => {
      if (kind === 'order') orderClicked = true;
    }
  });
  const page = {
    getByRole: (_role, options) => {
      const source = String(options?.name || '');
      return makeLocator(source.includes('添加到库') ? 'order' : 'get');
    },
    locator: () => ({ count: async () => 0 })
  };
  const context = { pages: () => [page] };
  const result = await em.claimSingle(page, {
    id: 'order-priority',
    title: '按钮优先级测试',
    url: 'https://example.test/product'
  }, context);

  assert.equal(orderClicked, true);
  assert.equal(result.status, 'owned');
  assert.equal(result.message, '已在库中');
});

test('结账按钮存在时页面状态优先判为 checkout，而不是残留的挑战文本', async () => {
  const em = new EpicManager();
  em.readPageText = async () => 'TRY AGAIN';
  const page = {
    title: async () => 'Agent A',
    url: () => 'https://store.epicgames.com/p/agent-a',
    getByRole: () => ({
      first() { return this; },
      count: async () => 1,
      isVisible: async () => true
    })
  };
  const state = await em.detectPageState(page);
  assert.equal(state.state, 'checkout');
});

test('验证层仍可见时不能越过遮罩直接点结账按钮', async () => {
  const em = new EpicManager();
  em.readPageText = async () => '确认您是真人';
  const makeLocator = (count, visible = true) => ({
    first() { return this; },
    nth() { return this; },
    count: async () => count,
    isVisible: async () => visible,
    isEnabled: async () => true,
    innerText: async () => count > 0 ? '添加到库' : ''
  });
  const page = {
    title: async () => 'Agent A',
    url: () => 'https://store.epicgames.com/p/agent-a',
    getByText: () => makeLocator(1),
    getByRole: () => makeLocator(1),
    locator: () => makeLocator(0)
  };

  const state = await em.detectPageState(page);
  assert.equal(state.state, 'challenge');
});

test('结账按钮位于 iframe 时仍能识别为 checkout', async () => {
  const em = new EpicManager();
  em.readPageText = async () => 'TRY AGAIN';
  const makeLocator = (count) => ({
    first() { return this; },
    nth() { return this; },
    count: async () => count,
    isVisible: async () => count > 0,
    isEnabled: async () => true,
    innerText: async () => count > 0 ? '添加到库' : ''
  });
  const emptyFrame = {
    getByRole: () => makeLocator(0),
    locator: () => makeLocator(0)
  };
  const checkoutFrame = {
    getByRole: (_role, options) => makeLocator(/添加到库/.test(String(options?.name)) ? 1 : 0),
    locator: () => makeLocator(0)
  };
  const page = {
    title: async () => 'Agent A',
    url: () => 'https://store.epicgames.com/p/agent-a',
    frames: () => [emptyFrame, checkoutFrame],
    getByRole: () => makeLocator(0)
  };

  const state = await em.detectPageState(page);
  assert.equal(state.state, 'checkout');
});

test('结账窗口位于新标签页时会切换到实际结账页', async () => {
  const em = new EpicManager();
  const productPage = { name: 'product', isClosed: () => false };
  const checkoutPage = { name: 'checkout', isClosed: () => false };
  em.findVisibleOrderButton = async candidate => candidate === checkoutPage;

  const found = await em.findCheckoutPage(
    { pages: () => [productPage, checkoutPage] },
    productPage
  );
  assert.equal(found, checkoutPage);
});

test('隐藏的成功文案不能被当成领取完成', async () => {
  const em = new EpicManager();
  const makeLocator = (visible) => ({
    first() { return this; },
    nth() { return this; },
    count: async () => 1,
    isVisible: async () => visible,
    isEnabled: async () => true
  });
  const page = {
    getByText: () => makeLocator(false),
    getByRole: () => ({ ...makeLocator(false), count: async () => 0 }),
    locator: () => ({ ...makeLocator(false), count: async () => 0 })
  };
  assert.equal(await em.detectClaimOutcome(page), null);
});

test('普通点击被遮挡时，结账按钮会降级为 DOM 点击而不是假成功的强制点击', async () => {
  const em = new EpicManager();
  let clicks = 0;
  let domClicks = 0;
  let forceClicks = 0;
  const locator = {
    scrollIntoViewIfNeeded: async () => {},
    click: async options => {
      clicks += 1;
      if (clicks === 1) throw new Error('element is covered by another element');
      if (options?.force) forceClicks += 1;
    },
    evaluate: async () => {
      domClicks += 1;
    }
  };

  const result = await em.clickEpicButton(locator, '添加到库');
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'DOM 点击');
  assert.equal(clicks, 1);
  assert.equal(domClicks, 1);
  assert.equal(forceClicks, 0, 'DOM 点击成功后不能再触发假成功的强制点击');
});
