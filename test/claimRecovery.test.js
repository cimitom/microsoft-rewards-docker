import test from 'node:test';
import assert from 'node:assert/strict';

const {
  default: browserManager,
  parseClaimablePoints
} = await import('../src/core/browser.js');

function makeLocator(kind, state) {
  return {
    first() {
      return this;
    },
    filter() {
      return this;
    },
    async count() {
      return kind === 'overlay' ? 1 : 1;
    },
    async waitFor() {
      if (kind === 'overlay') throw new Error('overlay remained visible');
    },
    async isVisible() {
      if (kind === 'overlay') return true;
      if (kind === 'close') return false;
      if (kind === 'confirm') return state.clicked && !state.confirmed;
      if (kind === 'card') return state.remainingPoints > 0;
      return false;
    },
    async innerText() {
      if (kind !== 'card') return '';
      return state.remainingPoints > 0 ? `可领取\n${state.remainingPoints} 点` : '';
    },
    async click() {
      if (kind === 'card') throw new Error('overlay intercepts pointer events');
      if (kind === 'confirm') {
        state.confirmed = true;
        if (state.clearOnConfirm) state.remainingPoints = 0;
      }
    },
    async evaluate() {
      if (kind === 'card') {
        state.clicked = true;
        return true;
      }
      return false;
    }
  };
}

function makeClaimPage(state) {
  return {
    url() {
      return state.url || 'https://rewards.bing.com/dashboard';
    },
    async evaluate() {
      return state.bodyText || 'Microsoft Rewards 可领取 每日积分';
    },
    async goto() {},
    async reload() {
      state.reloads++;
    },
    async waitForLoadState() {},
    async waitForFunction() {},
    keyboard: {
      async press() {}
    },
    locator(selector) {
      if (selector === 'button') return makeLocator('card', state);
      if (selector.includes('fixed') && selector.includes('inset-0')
        && (selector.includes('bg-bgSmoke') || selector.includes('z-40'))) {
        return makeLocator('overlay', state);
      }
      if (selector.includes('aria-label="关闭"') || selector.includes(':has-text("关闭")')
        || selector.includes(':has-text("知道了")') || selector.includes(':has-text("稍后")')) {
        return makeLocator('close', state);
      }
      if (selector.includes('[role="dialog"] button')) {
        return makeLocator('confirm', state);
      }
      return makeLocator('unknown', state);
    }
  };
}

function stubClaimBrowser(t, state) {
  const originals = {
    getExecutablePath: browserManager.getExecutablePath,
    launchBrowser: browserManager.launchBrowser,
    createPage: browserManager.createPage,
    commitBrowserSession: browserManager.commitBrowserSession,
    closeBrowser: browserManager.closeBrowser,
    delay: browserManager.delay
  };
  const page = makeClaimPage(state);
  browserManager.getExecutablePath = () => '/fake/chromium';
  browserManager.launchBrowser = async () => ({ context: {} });
  browserManager.createPage = async () => page;
  browserManager.commitBrowserSession = async () => {
    state.committed = true;
    return true;
  };
  browserManager.closeBrowser = async () => {
    state.closed = true;
  };
  browserManager.delay = async () => {};
  t.after(() => {
    Object.assign(browserManager, originals);
  });
}

test('领取积分数解析兼容换行与千分位', () => {
  assert.equal(parseClaimablePoints('可领取\n21 点'), 21);
  assert.equal(parseClaimablePoints('可领取 1,250 points'), 1250);
  assert.equal(parseClaimablePoints('暂无可领取积分'), 0);
});

test('全屏遮罩拦截点击时改用 DOM 事件并在回读归零后确认领取', async (t) => {
  const state = {
    remainingPoints: 21,
    clicked: false,
    confirmed: false,
    clearOnConfirm: true,
    reloads: 0,
    committed: false,
    closed: false
  };
  stubClaimBrowser(t, state);

  const claimed = await browserManager.claimDashboardPoints({
    id: 'acc_claim_overlay',
    name: '遮罩领取测试'
  });

  assert.equal(claimed, 21);
  assert.equal(state.clicked, true);
  assert.equal(state.confirmed, true);
  assert.equal(state.reloads, 1);
  assert.equal(state.committed, true);
  assert.equal(state.closed, true);
});

test('点击确认但官网待领取数量未变化时不得虚报领取成功', async (t) => {
  const state = {
    remainingPoints: 21,
    clicked: false,
    confirmed: false,
    clearOnConfirm: false,
    reloads: 0,
    committed: false,
    closed: false
  };
  stubClaimBrowser(t, state);

  const claimed = await browserManager.claimDashboardPoints({
    id: 'acc_claim_unverified',
    name: '领取核验失败测试'
  });

  assert.equal(claimed, 0);
  assert.equal(state.reloads, 2);
  assert.equal(state.committed, false);
  assert.equal(state.closed, true);
});

test('领取页跳转登录时直接失败，不把“无卡片”误判为领取成功', async (t) => {
  const state = {
    url: 'https://login.live.com/oauth20_authorize.srf',
    bodyText: '登录以继续',
    remainingPoints: 21,
    clicked: false,
    confirmed: false,
    clearOnConfirm: false,
    reloads: 0,
    committed: false,
    closed: false
  };
  stubClaimBrowser(t, state);

  const claimed = await browserManager.claimDashboardPoints({
    id: 'acc_claim_login_lost',
    name: '登录态丢失测试'
  });

  assert.equal(claimed, 0);
  assert.equal(state.clicked, false);
  assert.equal(state.reloads, 0);
  assert.equal(state.committed, false);
  assert.equal(state.closed, true);
});
