import fs from 'fs';
import path from 'path';
import { chromium } from 'patchright-core';
import configManager from '../config.js';
import logger from '../logger.js';
import networkClient from '../network.js';
import { firefoxSlotLock } from './contextLock.js';
import { DATA_DIR, withTimeout } from '../fsUtil.js';
import { findChromiumExecutable } from './chromiumExecutable.js';
import { PC_USER_AGENT } from './fingerprint.js';
import { isDemoMode, isDemoEpicAccountId } from './demoMode.js';
import { toBrowserProxy } from './proxy.js';

// Epic 官方商城静态接口：返回当前在售商品及促销信息（含每周免费游戏）
const FREE_GAMES_API = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN';
const STORE_BASE = 'https://store.epicgames.com/zh-CN';
const STORE_HOME = `${STORE_BASE}/`;
const EPIC_PROFILE_DIR = path.join(DATA_DIR, 'epic-firefox-profiles');
const CHALLENGE_TEXT_RE = /verify you are human|确认您是真人|正在验证|checking your browser|cf-mitigated|try again|cloudflare/i;
const LOGIN_TEXT_RE = /sign in|log in|登录|登入/i;
export const EPIC_ORDER_BUTTON_RE = /添加到库|添加至库|加入库|Add to Library|下订单|下单|确认订单|结账|Place Order|Checkout/i;
// “结账 / Checkout” 只是打开结账层，不能当成最终确认按钮。
// 最终动作必须优先命中真正会把游戏写入账号库的按钮。
export const EPIC_FINAL_ORDER_BUTTON_RE = /添加到库|添加至库|加入库|Add to Library|下订单|下单|确认订单|Place Order/i;
export const EPIC_OWNED_BUTTON_RE = /已在库中|已在您的库中|In Library|In your library/i;
export const EPIC_SUCCESS_TEXT_RE = /已添加到库|已添加至库|已加入库|已添加到您的库|已加入您的库|已拥有此游戏|订单已提交|购买成功|领取成功|感谢您的购买|Added to your library|Successfully added to your library|Already in your library|You already own this game|Order confirmed|Purchase complete|Thanks for your order|Thank you for your order/i;
const EPIC_OWNED_TEXT_RE = /^(已在库中|已在您的库中|In Library|In your library)$/i;

function safeProfileId(accountId) {
  return String(accountId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
}

export function epicProfilePath(accountId) {
  return path.join(EPIC_PROFILE_DIR, safeProfileId(accountId));
}

export function isEpicChallengeText(text) {
  return CHALLENGE_TEXT_RE.test(String(text || ''));
}

export function isEpicLoginText(text) {
  return LOGIN_TEXT_RE.test(String(text || ''));
}

export function evaluateEpicBrowserFingerprint(signals = {}) {
  const warnings = [];
  const ua = String(signals.userAgent || '');
  const platform = String(signals.platform || '');
  const gl = `${signals.webglVendor || ''} ${signals.webglRenderer || ''}`.trim();
  if (signals.webdriver !== false) warnings.push('navigator.webdriver 不是 false');
  if (/HeadlessChrome/i.test(ua)) warnings.push('UA 暴露 HeadlessChrome');
  if (ua && !/Chrome\//.test(ua)) warnings.push('UA 中缺少 Chrome 标识');
  if (/Windows NT/.test(ua) && !/Win/.test(platform)) warnings.push('UA 与 navigator.platform 不一致');
  if (/Macintosh/.test(ua) && !/Mac/.test(platform)) warnings.push('UA 与 navigator.platform 不一致');
  if (/(X11|Linux)/.test(ua) && !/Linux/.test(platform)) warnings.push('UA 与 navigator.platform 不一致');
  if (/llvmpipe|swiftshader|softpipe|software/i.test(gl)) warnings.push('WebGL 暴露软件渲染');
  if (!signals.webglRenderer) warnings.push('WebGL 不可用');
  if (!Array.isArray(signals.languages) || signals.languages.length === 0) warnings.push('navigator.languages 为空');
  return warnings;
}

function chromiumWebglPatch() {
  const VENDOR = 'Google Inc. (Intel)';
  const RENDERER = 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)';
  const SOFTWARE_RE = /swiftshader|llvmpipe|softpipe|software/i;
  const patch = (proto) => {
    if (!proto?.getParameter) return;
    const orig = proto.getParameter;
    let spoof = null;
    proto.getParameter = function (parameter) {
      if (parameter === 37445 || parameter === 37446) {
        if (spoof === null) {
          const real = `${orig.call(this, 37445) || ''} ${orig.call(this, 37446) || ''}`;
          spoof = SOFTWARE_RE.test(real);
        }
        if (spoof) return parameter === 37445 ? VENDOR : RENDERER;
      }
      return orig.call(this, parameter);
    };
    proto.getParameter.toString = () => orig.toString();
  };
  try {
    patch(window.WebGLRenderingContext?.prototype);
    patch(window.WebGL2RenderingContext?.prototype);
  } catch {}
}

async function patchChromiumWebglPage(page) {
  if (!page?.evaluate) return;
  await page.evaluate(chromiumWebglPatch).catch(() => {});
}

async function applyChromiumWebglIdentity(context, page) {
  if (!context?.newCDPSession || !page) return;
  const source = `(${chromiumWebglPatch.toString()})()`;
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
    if (!context.__epicCdpSessions) context.__epicCdpSessions = [];
    context.__epicCdpSessions.push(cdp);
  } catch {}
  await patchChromiumWebglPage(page);
}

/**
 * 归一化「每天自动领取时间」。非法输入一律退回 10:00，
 * 避免一个手滑写入的空值让定时任务永远不触发。
 */
export function normalizeAutoClaimTime(value) {
  const m = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '10:00';
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) return '10:00';
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

class EpicStopError extends Error {
  constructor(message = 'Epic 任务已手动停止') {
    super(message);
    this.name = 'EpicStopError';
    this.code = 'EPIC_STOPPED';
  }
}

/**
 * Epic 免费游戏自动领取。
 * 列表走官方静态接口（稳定），领取走 Playwright 驱动网页（用户提供已登录会话）。
 */
export class EpicManager {
  constructor() {
    this.running = false;
    this.checking = false;
    this.verifying = false;
    this.stopRequested = false;
    this.activeContext = null;
    this.activeAccountId = null;
    this.loginContext = null;
    this.loginAccountId = null;
    this.loginEngine = null;
    this.loginSlotOwner = null;
    this.loginTimer = null;
    this.loginClosePromise = null;
    this.closeTimeoutMs = Math.max(10, Number(process.env.BROWSER_CLOSE_TIMEOUT_MS) || 15000);
    this.runningAccountId = null;
    this.lastRun = null; // { startedAt, finishedAt, results: [] }
    this.lastCheckAt = 0;
    // 进程启动时刻。定时器用它做「首次检查」的下限，避免容器一重启就立刻跑一轮。
    this.bootedAt = Date.now();
    // 无头浏览器实时状态（供前端展示当前跑到哪一步）
    this.state = {
      status: 'idle', // idle | checking | navigating | challenge | clicking | ordering | waiting | retrying | verifying | done
      accountName: '',
      gameTitle: '',
      attempt: 0,
      maxAttempts: 0,
      lastAction: '空闲中',
      progress: 0,
      code: '',
      lastUpdate: Date.now(),
      startedAt: null
    };
    if (this.isDemo()) {
      // 演示模式下自动补齐示例账号，方便本地预览
      this.seedDemoData();
    } else {
      // 正式实例启动时清理旧版本可能落盘的演示账号与领取记录。
      this.purgeStaleDemoData();
    }
  }

  delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  updateState(partial) {
    Object.assign(this.state, partial, { lastUpdate: Date.now() });
  }

  throwIfStopped() {
    if (this.stopRequested) throw new EpicStopError();
  }

  async interruptibleDelay(ms) {
    const deadline = Date.now() + Math.max(0, Number(ms) || 0);
    while (Date.now() < deadline) {
      this.throwIfStopped();
      await this.delay(Math.min(250, deadline - Date.now()));
    }
  }

  async stop() {
    const active = this.running || this.checking || this.verifying || !!this.activeContext || !!this.loginContext;
    if (!active) {
      return { stopped: false, message: '当前没有正在运行的 Epic 任务' };
    }
    this.stopRequested = true;
    const hadTask = this.running || this.checking || this.verifying;
    this.updateState({
      status: 'stopping',
      progress: this.state.progress || 0,
      code: 'stopped',
      lastAction: '正在停止 Epic 任务并释放浏览器资源...'
    });
    logger.log('🛑', '收到手动停止指令，正在关闭 Epic 浏览器并释放资源');
    const activeContext = this.activeContext;
    this.activeContext = null;
    this.activeAccountId = null;
    const closeTasks = [];
    if (activeContext) {
      closeTasks.push(
        withTimeout(
          Promise.resolve().then(() => activeContext.close()),
          this.closeTimeoutMs,
          '关闭 Epic 浏览器超时'
        ).catch(() => {})
      );
    }
    if (this.loginContext) {
      closeTasks.push(this.closeLoginWindow().catch(() => {}));
    }
    // 不等待浏览器 close()，否则 Chromium 卡住时前端要等满 15 秒还没有反馈。
    Promise.allSettled(closeTasks).catch(() => {});
    if (!this.running && !this.checking && !this.verifying) {
      if (!hadTask) this.stopRequested = false;
      this.updateState({
        status: 'idle',
        progress: 0,
        code: 'stopped',
        lastAction: 'Epic 任务已停止，浏览器资源已释放'
      });
    }
    return { stopped: true, message: '停止指令已执行，浏览器正在后台关闭' };
  }

  /** 登录窗口是否正在占用某个账号的 Firefox 持久化 profile */
  isLoginWindowOpen() {
    return !!this.loginContext;
  }

  /**
   * 登录窗口会长时间占用该账号的 Firefox profile，期间任何领取/校验都必须让路。
   * 否则两边会打开同一个 profile 目录，Firefox 会报 "profile in use"，
   * 领取流程还可能把旧的 storageState 回写，覆盖用户刚完成的登录。
   */
  assertLoginWindowClosed(action = '执行 Epic 任务') {
    if (this.loginContext) {
      throw new Error(`Epic 登录窗口已打开，请先保存或关闭登录窗口再${action}`);
    }
  }

  async openLoginWindow(accountId) {
    if (this.running || this.checking || this.verifying) {
      throw new Error('Epic 任务正在运行中，请先停止任务再登录');
    }
    if (process.env.EPIC_VISIBLE !== '1') {
      throw new Error('当前未启用可见浏览器，请设置 EPIC_VISIBLE=1 后重启容器');
    }
    const acc = configManager.findEpicAccount(accountId);
    if (!acc) throw new Error('Epic 账号不存在');
    await this.closeLoginWindow().catch(() => {});

    const slotOwner = `epic-login:${accountId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const gotSlot = await firefoxSlotLock.acquire(slotOwner, 180000);
    if (!gotSlot) throw new Error('浏览器资源正被 Epic 任务占用，请稍后再登录');

    let launched;
    try {
      // 登录必须从干净会话开始，并且用独立的临时 profile：
      // 旧凭据（多半已失效）混进来会让登录请求带着互相矛盾的会话，
      // 而登录窗口的使命就是建立一个全新会话。正常领取用的 profile 不受影响。
      const loginProfile = `${epicProfilePath(accountId)}-login-chromium`;
      fs.rmSync(loginProfile, { recursive: true, force: true });
      launched = await this.launchPersistentContext(acc, {
        cleanSession: true,
        profileDir: loginProfile,
        engine: 'chromium'
      });
    } catch (e) {
      firefoxSlotLock.release(slotOwner);
      throw e;
    }
    this.loginContext = launched.context;
    this.loginAccountId = accountId;
    this.loginEngine = launched.engine || 'chromium';
    this.loginSlotOwner = slotOwner;
    this.scheduleLoginWindowTimeout();
    this.updateState({
      status: 'login_window',
      progress: 0,
      accountName: acc.name,
      lastAction: '已打开 Epic Chromium 登录窗口，请在可见浏览器中完成登录'
    });
    const loginUrl = 'https://www.epicgames.com/id/login?lang=zh-CN&noHostRedirect=true&redirectUrl=' + encodeURIComponent(`${STORE_BASE}/free-games`);
    await launched.page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await patchChromiumWebglPage(launched.page);
    return { opened: true, accountId, loginUrl };
  }

  /**
   * 登录窗口是人工操作，用户可能中途关掉页面就再也没回来。
   * 没有超时的话，这个 Firefox 会一直占着 profile，定时领取永远让路。
   * 默认 30 分钟自动关闭；EPIC_LOGIN_TIMEOUT_MIN=0 可关闭该保护。
   */
  scheduleLoginWindowTimeout() {
    const minutes = Number(process.env.EPIC_LOGIN_TIMEOUT_MIN ?? 30);
    this.clearLoginWindowTimeout();
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    this.loginTimer = setTimeout(() => {
      logger.log('⏱️', `Epic 登录窗口已超过 ${minutes} 分钟未保存，自动关闭并释放浏览器资源`);
      this.closeLoginWindow().catch(() => {});
    }, minutes * 60 * 1000);
    this.loginTimer.unref?.();
  }

  clearLoginWindowTimeout() {
    if (this.loginTimer) {
      clearTimeout(this.loginTimer);
      this.loginTimer = null;
    }
  }

  async saveLoginWindow(accountId) {
    if (!this.loginContext || this.loginAccountId !== accountId) {
      throw new Error('当前没有已打开的登录窗口');
    }
    if (!configManager.findEpicAccount(accountId)) {
      throw new Error('Epic 账号不存在或已被删除');
    }
    const context = this.loginContext;
    const page = context.pages()[0] || await context.newPage();
    const detected = await this.detectLoginCompleted(page);
    if (!detected.ok) {
      return { saved: false, reason: detected.reason, message: detected.message };
    }

    const capturedState = await context.storageState();
    const verified = await this.verifyLoginStorageState(capturedState);
    if (!verified.ok) {
      logger.log('🟡', `Epic 登录会话尚未真正生效：${verified.message}`, '', configManager.findEpicAccount(accountId)?.name);
      return {
        saved: false,
        reason: 'storage_state_not_reproducible',
        message: verified.message
      };
    }

    const storageState = verified.storageState;
    configManager.updateEpicAccount(accountId, {
      storageState,
      sessionValid: true,
      lastVerifyAt: Date.now(),
      lastVerifyMessage: '通过可见浏览器登录并保存',
      lastSessionImportAt: Date.now()
    });
    await this.closeLoginWindow();
    return { saved: true, cookieCount: storageState.cookies?.length || 0, message: '登录凭据已保存到内置 Chromium profile' };
  }

  async readStoreLoginFlag(page, timeout = 2000) {
    const nav = page.locator('egs-navigation').first();
    const value = await nav.getAttribute('isloggedin', { timeout }).catch(() => null);
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
  }

  /**
   * Epic 商城页面在慢网络下可能长时间处于骨架屏，`isloggedin` 也会一直为 false。
   * 账号门户的 JSON 接口才是更可靠的登录态来源，并且与页面水合速度无关。
   */
  async checkEpicAccountSession(context) {
    if (!context?.request) {
      return { valid: false, state: 'unknown', message: '浏览器上下文不可用' };
    }
    try {
      const response = await context.request.get('https://www.epicgames.com/id/api/account', {
        headers: {
          accept: 'application/json',
          referer: 'https://www.epicgames.com/account/personal'
        },
        timeout: 15000
      });
      const status = response.status();
      const contentType = String(response.headers()['content-type'] || '');
      if (status === 200 && contentType.includes('json')) {
        const data = await response.json().catch(() => null);
        if (data?.id || data?.displayName) {
          return { valid: true, state: 'logged-in', account: data };
        }
      }
      if (status === 401 || (status === 403 && contentType.includes('json'))) {
        return { valid: false, state: 'invalid', message: 'Epic 登录态已失效' };
      }
      if (status === 403 || status === 429) {
        return { valid: false, state: 'challenge', message: `Epic 账号接口返回 HTTP ${status}` };
      }
      return { valid: false, state: 'unknown', message: `Epic 账号接口返回 HTTP ${status}` };
    } catch (e) {
      return { valid: false, state: 'unknown', message: e.message };
    }
  }

  async waitForStoreLoginState(page, timeout = 30000) {
    const deadline = Date.now() + timeout;
    let lastState = { state: 'unknown', text: '' };
    let lastApiCheckAt = 0;
    while (Date.now() < deadline) {
      if (Date.now() - lastApiCheckAt >= 2500) {
        lastApiCheckAt = Date.now();
        const auth = await this.checkEpicAccountSession(page.context?.());
        if (auth.valid) {
          return { loggedIn: true, state: 'logged-in', account: auth.account };
        }
        if (auth.state === 'challenge') {
          return { loggedIn: false, state: 'challenge' };
        }
      }
      if (await this.readStoreLoginFlag(page, 1200) === true) {
        return { loggedIn: true, state: 'logged-in' };
      }

      lastState = await this.detectPageState(page);
      if (lastState.state === 'challenge') {
        return { loggedIn: false, state: 'challenge', text: lastState.text };
      }
      if (lastState.state === 'login') {
        return { loggedIn: false, state: 'login', text: lastState.text };
      }
      await this.delay(700);
    }
    return {
      loggedIn: false,
      state: lastState.state || 'unknown',
      text: lastState.text || ''
    };
  }

  /**
   * 用刚捕获的 storageState 新建隔离上下文，重新打开商城确认登录态。
   * 防止页面尚未水合完成时把 unknown 状态误判为登录成功。
   */
  async verifyLoginStorageState(storageState) {
    const browser = this.loginContext?.browser?.();
    if (!browser) {
      return { ok: false, message: '登录窗口浏览器不可用，无法验证保存的会话' };
    }

    let context = null;
    try {
      context = await browser.newContext({
        storageState,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        viewport: { width: 1366, height: 768 }
      });
      const auth = await this.checkEpicAccountSession(context);
      if (auth.valid) {
        return { ok: true, storageState: await context.storageState() };
      }
      if (auth.state === 'challenge') {
        return { ok: false, message: 'Epic 账号接口仍有人机验证，请稍后再保存' };
      }
      return {
        ok: false,
        message: `保存的会话无法恢复 Epic 登录态：${auth.message || '账号接口未确认登录'}`
      };
    } catch (e) {
      return { ok: false, message: `验证保存的会话失败：${e.message}` };
    } finally {
      if (context) {
        await withTimeout(
          Promise.resolve().then(() => context.close()),
          this.closeTimeoutMs,
          '关闭 Epic 会话验证上下文超时'
        ).catch(() => {});
      }
    }
  }

  /**
   * 登录完成判定：先读商店导航的登录态属性，读不到再复用页面状态识别。
   * 与人机验证一样，识别不出来时宁可提示用户重试，也不要把未登录状态当成已登录保存。
   */
  async detectLoginCompleted(page) {
    const auth = await this.checkEpicAccountSession(page.context?.());
    if (auth.valid) {
      return { ok: true };
    }
    if (auth.state === 'challenge') {
      return { ok: false, reason: 'challenge', message: 'Epic 账号接口触发人机验证，请稍后重试' };
    }
    if (await this.readStoreLoginFlag(page, 5000) === true) {
      return { ok: true };
    }
    await page.goto(`${STORE_BASE}/free-games`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    const state = await this.waitForStoreLoginState(page, 30000);
    if (state.loggedIn) {
      return { ok: true };
    }

    if (state.state === 'challenge') {
      return { ok: false, reason: 'challenge', message: '商店正在人机验证，暂时无法确认登录状态，请稍后重试' };
    }
    if (state.state === 'login') {
      return { ok: false, reason: 'not-logged-in', message: '尚未检测到 Epic 登录完成，请在可见浏览器中完成登录后再保存' };
    }
    return {
      ok: false,
      reason: 'login-unconfirmed',
      message: 'Epic 商城尚未确认登录态，请等待页面完全加载并显示账号后再保存'
    };
  }

  async closeLoginWindow() {
    this.clearLoginWindowTimeout();
    const previousClose = this.loginClosePromise;
    if (!this.loginContext && previousClose) {
      await previousClose.catch(() => {});
      return { closed: true };
    }
    const context = this.loginContext;
    const slotOwner = this.loginSlotOwner;
    this.loginContext = null;
    this.loginAccountId = null;
    this.loginEngine = null;
    this.loginSlotOwner = null;
    // 先释放锁，再尽力关闭浏览器。否则 Firefox 卡死时锁会永久泄漏。
    if (slotOwner) firefoxSlotLock.release(slotOwner);
    const closePromise = context
      ? withTimeout(Promise.resolve().then(() => context.close()), this.closeTimeoutMs, '关闭 Epic 登录窗口超时').catch(() => {})
      : Promise.resolve();
    this.loginClosePromise = closePromise;
    try {
      await closePromise;
    } finally {
      if (this.loginClosePromise === closePromise) this.loginClosePromise = null;
      if (this.state.status === 'login_window') {
        this.updateState({
          status: 'idle',
          progress: 0,
          accountName: '',
          lastAction: 'Epic 登录窗口已关闭'
        });
      }
    }
    return { closed: true };
  }

  /** 删除账号前只关闭属于该账号的登录窗口，避免误伤其他账号的人工登录。 */
  async closeLoginWindowForAccount(accountId) {
    if (this.loginContext && this.loginAccountId !== accountId) {
      return { closed: false, message: '另一个账号的登录窗口仍处于打开状态' };
    }
    return this.closeLoginWindow();
  }

  /**
   * 指纹自检：用与领取任务完全相同的启动参数开一个临时浏览器，
   * 采集风控最常看的那几项，直接展示给用户。
   *
   * 为什么需要它：Epic 的「安全检查」是服务端判定，黑盒且不给原因。
   * 与其反复猜，不如先把「我们自己的浏览器是否还在露馅」变成可观测的。
   */
  async selfCheckFingerprint() {
    if (this.running || this.checking || this.verifying) {
      throw new Error('Epic 任务正在运行中，请先停止任务再做指纹自检');
    }
    if (this.loginContext) throw new Error('请先关闭 Epic 登录窗口再做指纹自检');

    const slotOwner = `epic-selfcheck:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const gotSlot = await firefoxSlotLock.acquire(slotOwner, 60000);
    if (!gotSlot) throw new Error('浏览器资源正被占用，请稍后再试');

    const tmpProfile = path.join(EPIC_PROFILE_DIR, `selfcheck-${Date.now()}`);
    let context = null;
    try {
      const launched = await this.launchPersistentContext(
        { id: 'selfcheck', storageState: null },
        { cleanSession: true, profileDir: tmpProfile, engine: 'chromium' }
      );
      context = launched.context;
      const page = launched.page;
      // 使用 data URL 强制创建新文档，确保 addInitScript 的 WebGL 伪装已执行；
      // 不访问 Epic，避免触发额外风控计数。
      await page.goto('data:text/html,<title>fingerprint</title>', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await patchChromiumWebglPage(page);
      const signals = await page.evaluate(() => {
        const readGl = () => {
          try {
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
            if (!gl) return { vendor: '', renderer: '' };
            const dbg = gl.getExtension('WEBGL_debug_renderer_info');
            return {
              vendor: dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '') : '',
              renderer: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : ''
            };
          } catch {
            return { vendor: '', renderer: '' };
          }
        };
        const glInfo = readGl();
        return {
          userAgent: navigator.userAgent,
          appVersion: navigator.appVersion,
          platform: navigator.platform,
          oscpu: navigator.oscpu || '',
          languages: Array.from(navigator.languages || []),
          hardwareConcurrency: navigator.hardwareConcurrency,
          webdriver: navigator.webdriver,
          pluginsCount: navigator.plugins.length,
          hasWindowChrome: typeof window.chrome !== 'undefined',
          webglVendor: glInfo.vendor,
          webglRenderer: glInfo.renderer,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          screen: `${screen.width}x${screen.height}`
        };
      });
      return {
        signals,
        warnings: evaluateEpicBrowserFingerprint(signals),
        browserVersion: context.browser()?.version?.() || ''
      };
    } finally {
      try {
        if (context) {
          await withTimeout(Promise.resolve().then(() => context.close()), this.closeTimeoutMs, '关闭指纹自检浏览器超时').catch(() => {});
        }
      } finally {
        try {
          fs.rmSync(tmpProfile, { recursive: true, force: true });
        } finally {
          firefoxSlotLock.release(slotOwner);
        }
      }
    }
  }

  getBrowserProxy() {
    const cfg = configManager.get();
    if (!cfg.network?.useProxy) return null;
    const proxy = configManager.getDefaultProxy();
    return proxy?.url ? toBrowserProxy(proxy.url) : null;
  }

  /**
   * 启动 Chromium 持久化上下文。
   *
   * @param {object} acc 账号
   * @param {object} [opts]
   * @param {boolean} [opts.cleanSession] 不注入账号里已保存的 storageState。
   * @param {string} [opts.profileDir] 覆盖 profile 目录（登录窗口用独立的临时目录）
   */
  async launchPersistentContext(acc, { cleanSession = false, profileDir = null } = {}) {
    const dir = profileDir || `${epicProfilePath(acc.id)}-chromium`;
    fs.mkdirSync(dir, { recursive: true });
    const proxy = this.getBrowserProxy();
    const headless = process.env.EPIC_VISIBLE !== '1';

    const executablePath = findChromiumExecutable();
    if (!executablePath) {
      throw new Error('未检测到 Chromium/Edge 浏览器内核，无法打开 Epic 浏览器');
    }
    const context = await chromium.launchPersistentContext(dir, {
      executablePath,
      headless,
      viewport: null,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      ...(cleanSession ? {} : {
        storageState: {
          cookies: acc.storageState?.cookies || [],
          origins: acc.storageState?.origins || []
        }
      }),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-quic',
        '--ignore-gpu-blocklist',
        '--enable-unsafe-swiftshader',
        '--use-angle=swiftshader',
        '--window-size=1366,768',
        '--window-position=0,0'
      ],
      ...(proxy ? { proxy } : {})
    });
    if (!cleanSession && acc.storageState?.cookies?.length) {
      await context.addCookies(acc.storageState.cookies).catch(() => {});
    }
    const page = context.pages()[0] || await context.newPage();
    await applyChromiumWebglIdentity(context, page);
    context.on?.('page', newPage => {
      applyChromiumWebglIdentity(context, newPage).catch(() => {});
    });
    return { context, page, engine: 'chromium' };
  }

  async readPageText(page) {
    const parts = [];
    for (const frame of this.getEpicFrames(page)) {
      try {
        const text = await frame.locator('body').innerText({ timeout: 800 });
        if (text) parts.push(text);
      } catch {}
    }
    return parts.join('\n');
  }

  getEpicFrames(page) {
    try {
      const frames = page?.frames?.();
      if (Array.isArray(frames) && frames.length > 0) return frames.slice(0, 20);
    } catch {}
    return page ? [page] : [];
  }

  /**
   * Epic 的结账层可能位于 iframe 中。只在主页面上查找按钮会出现
   * “VNC 里明明看得到添加到库，脚本却一直说没找到”的情况。
   */
  async findVisibleEpicButton(page, nameRe, { exact = false, requireEnabled = false } = {}) {
    const frames = this.getEpicFrames(page);
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
      const frame = frames[frameIndex];
      let locator = null;
      try {
        locator = frame.getByRole?.('button', { name: nameRe, exact });
      } catch {}
      if (!locator) continue;

      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 12); i++) {
        const candidate = typeof locator.nth === 'function' ? locator.nth(i) : locator.first();
        const visible = await candidate.isVisible().catch(() => false);
        if (!visible) continue;
        const enabled = await Promise.resolve(candidate.isEnabled?.()).catch(() => true);
        if (requireEnabled && enabled === false) continue;
        const text = await Promise.resolve(candidate.innerText?.({ timeout: 500 }))
          .then(value => String(value || '').trim())
          .catch(() => '');
        return { locator: candidate, frame, frameIndex, text, enabled: enabled !== false };
      }
    }

    // 少数活动页把按钮渲染成链接或自定义 role。getByRole 找不到时再做一次
    // 受限的文本查找，仍然只接受 button / role=button / a，避免误点说明文字。
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
      const frame = frames[frameIndex];
      let locator = null;
      try {
        locator = frame.locator?.('button, [role="button"], a').filter({ hasText: nameRe });
      } catch {}
      if (!locator) continue;

      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 12); i++) {
        const candidate = typeof locator.nth === 'function' ? locator.nth(i) : locator.first();
        if (!await candidate.isVisible().catch(() => false)) continue;
        const enabled = await Promise.resolve(candidate.isEnabled?.()).catch(() => true);
        if (requireEnabled && enabled === false) continue;
        const text = await Promise.resolve(candidate.innerText?.({ timeout: 500 }))
          .then(value => String(value || '').trim())
          .catch(() => '');
        return { locator: candidate, frame, frameIndex, text, enabled: enabled !== false };
      }
    }
    return null;
  }

  async findVisibleOrderButton(page) {
    return this.findVisibleEpicButton(page, EPIC_FINAL_ORDER_BUTTON_RE);
  }

  async findCheckoutPage(context, fallbackPage) {
    const pages = context?.pages?.() || [];
    const candidates = [
      fallbackPage,
      ...pages.filter(candidate => candidate !== fallbackPage).reverse()
    ];
    for (const candidate of candidates) {
      if (!candidate || candidate.isClosed?.()) continue;
      if (await this.findVisibleOrderButton(candidate)) return candidate;
    }
    return fallbackPage;
  }

  async hasVisibleText(page, textRe) {
    for (const frame of this.getEpicFrames(page)) {
      if (typeof frame.getByText !== 'function') continue;
      let locator = null;
      try {
        locator = frame.getByText(textRe);
      } catch {}
      if (!locator) continue;
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 12); i++) {
        const candidate = typeof locator.nth === 'function' ? locator.nth(i) : locator.first();
        if (await this.isLocatorRendered(candidate)) return true;
      }
    }
    return false;
  }

  async isLocatorRendered(locator) {
    if (!await locator.isVisible().catch(() => false)) return false;
    return await Promise.resolve(locator.evaluate?.(el => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) > 0.01
        && rect.width > 0
        && rect.height > 0;
    })).then(value => value !== false).catch(() => true);
  }

  /**
   * “TRY AGAIN” 可能只是验证失败后的残留文案，不能单独说明验证层仍在。
   * 这里只认真正可见的验证控件或验证提示，避免遮罩覆盖结账按钮时
   * 仍然直接去点被挡住的下单按钮。
   */
  async hasActiveChallengeUi(page) {
    const selector = [
      '#challenge-stage',
      '.cf-challenge',
      '[id*="challenge-stage" i]',
      '[class*="challenge-stage" i]'
    ].join(',');
    for (const frame of this.getEpicFrames(page)) {
      let locator = null;
      try {
        locator = frame.locator(selector);
      } catch {}
      if (locator) {
        const count = await locator.count().catch(() => 0);
        for (let i = 0; i < Math.min(count, 8); i++) {
          const candidate = typeof locator.nth === 'function' ? locator.nth(i) : locator.first();
          if (await this.isLocatorRendered(candidate)) return true;
        }
      }
      if (await this.hasVisibleText(frame, /verify you are human|confirm you are human|i am human|确认您是真人|正在验证|checking your browser|我不是机器人/i)) {
        return true;
      }
    }
    return false;
  }

  async clickEpicButton(locator, label = '按钮') {
    const errors = [];
    const enabled = await Promise.resolve(locator.isEnabled?.()).catch(() => true);
    if (enabled === false) {
      const message = `${label}当前处于禁用状态`;
      logger.log('🟡', `Epic ${message}`);
      return { ok: false, mode: '', errors: [message] };
    }
    try {
      await locator.scrollIntoViewIfNeeded?.({ timeout: 2000 });
    } catch {}

    const attempts = [
      ['普通点击', () => locator.click({ timeout: 8000, noWaitAfter: true })],
      ['DOM 点击', () => locator.evaluate(el => el.click())],
      // 强制点击在遮罩覆盖时会“成功返回”但事件落到遮罩上，不能放在 DOM 点击前面。
      ['强制点击', () => locator.click({ timeout: 5000, force: true, noWaitAfter: true })]
    ];
    for (const [mode, run] of attempts) {
      try {
        await run();
        return { ok: true, mode, errors };
      } catch (e) {
        errors.push(`${mode}: ${String(e?.message || e).split('\n')[0]}`);
      }
    }
    logger.log('🟡', `Epic「${label}」点击失败：${errors.join('；')}`);
    return { ok: false, mode: '', errors };
  }

  /**
   * 部分订单要求先勾选 EULA。复选框也可能在 iframe 内，
   * 因此先收集所有可见且未勾选的复选框，再优先勾选带同意/条款文案的那个。
   */
  async acceptCheckoutAgreements(page) {
    const candidates = [];
    for (const frame of this.getEpicFrames(page)) {
      let boxes = null;
      try {
        boxes = frame.locator('input[type="checkbox"]');
      } catch {}
      if (!boxes) continue;
      const count = await boxes.count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 10); i++) {
        const box = typeof boxes.nth === 'function' ? boxes.nth(i) : boxes.first();
        if (!await box.isVisible().catch(() => false)) continue;
        if (await box.isChecked().catch(() => true)) continue;
        if (await Promise.resolve(box.isEnabled?.()).catch(() => true) === false) continue;
        const relatedText = await Promise.resolve(box.evaluate(el => {
          const label = el.closest('label')
            || (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
          return `${label?.innerText || ''} ${el.getAttribute('aria-label') || ''} ${el.closest('div')?.innerText?.slice(0, 240) || ''}`;
        })).then(value => String(value || '')).catch(() => '');
        candidates.push({ box, relatedText });
      }
    }

    const agreementRe = /同意|agree|EULA|条款|terms|privacy|隐私/i;
    const chosen = candidates.filter(item => agreementRe.test(item.relatedText));
    if (chosen.length === 0 && candidates.length === 1) chosen.push(candidates[0]);
    for (const item of chosen) {
      await item.box.check({ timeout: 3000 }).catch(async () => {
        await item.box.click({ timeout: 2000, force: true }).catch(() => {});
      });
    }
    return chosen.length;
  }

  async detectPageState(page) {
    const title = await page.title().catch(() => '');
    const pageUrl = page.url();
    const text = await this.readPageText(page);
    const combined = `${title}\n${text}`;

    if (await this.hasActiveChallengeUi(page)) {
      return { state: 'challenge', text: combined };
    }

    // 验证层真正消失后，页面仍可能保留 “TRY AGAIN” 等旧验证文案。
    // 此时可见的结账按钮是比文本更可靠的状态信号。
    if (await this.findVisibleOrderButton(page)) {
      return { state: 'checkout', text: combined };
    }

    if (isEpicChallengeText(combined)) return { state: 'challenge', text: combined };
    if (
      /\/id\/login(?:[/?#]|$)/i.test(pageUrl)
      || /登录您的 Epic Games 账户|sign in to your epic games account/i.test(title)
    ) {
      return { state: 'login', text: combined };
    }

    if (await this.hasVisibleText(page, EPIC_OWNED_TEXT_RE)) {
      return { state: 'owned', text: combined };
    }
    if (await this.findVisibleEpicButton(page, /^获取$|^Get$/i)) {
      return { state: 'product', text: combined };
    }
    return { state: 'unknown', text: combined };
  }

  async waitForPageState(page, wanted, timeout = 30000) {
    const deadline = Date.now() + timeout;
    let last = { state: 'unknown', text: '' };
    while (Date.now() < deadline) {
      this.throwIfStopped();
      last = await this.detectPageState(page);
      if (wanted.includes(last.state)) return last;
      await this.delay(500);
    }
    return last;
  }

  async navigateEpicPage(page, url, timeout = 45000) {
    this.throwIfStopped();
    let navigationError = null;
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: Math.min(15000, timeout) });
    } catch (e) {
      navigationError = e;
    }
    await page.waitForLoadState('domcontentloaded', { timeout: Math.max(5000, timeout - 15000) }).catch(() => {});
    await patchChromiumWebglPage(page);
    this.throwIfStopped();
    const result = await this.waitForPageState(page, ['product', 'checkout', 'challenge', 'login', 'owned'], timeout);
    return { ...result, navigationError };
  }

  async dismissChallengeOverlay(page) {
    const initial = await this.detectPageState(page);
    if (initial.state !== 'challenge') return initial;

    this.updateState({
      status: 'challenge',
      progress: 45,
      code: 'challenge',
      lastAction: '检测到 Epic 人机验证，等待验证层消失（托管验证可能自动放行）...'
    });

    let state = await this.waitForPageState(page, ['product', 'checkout', 'owned', 'login'], 8000);
    if (state.state !== 'challenge' && state.state !== 'unknown') {
      logger.log('✅', 'Epic 人机验证层已消失，继续检查结账按钮');
      return state;
    }
    if (!await this.hasActiveChallengeUi(page) && await this.findVisibleOrderButton(page)) {
      return { state: 'checkout', text: state.text || '' };
    }

    // Epic 的验证层有时是覆盖在结账界面上的 UI 层。先尝试关闭覆盖层，
    // 再给用户留出在 noVNC 中手动完成验证的时间。
    this.updateState({ lastAction: '验证层仍未消失，尝试关闭覆盖层...' });
    await page.keyboard.press('Escape').catch(() => {});
    await this.delay(1000);

    const retryBtn = await this.findVisibleEpicButton(page, /TRY AGAIN|重试/i);
    if (retryBtn) {
      await this.clickEpicButton(retryBtn.locator, retryBtn.text || '重试');
      await this.delay(1500);
    }

    const waitSec = Math.max(10, Math.min(600, Number(process.env.EPIC_CHALLENGE_WAIT_SEC) || 90));
    this.updateState({
      lastAction: `等待人工完成 Epic 人机验证（最多 ${waitSec} 秒），请打开可见浏览器操作`
    });
    state = await this.waitForPageState(page, ['product', 'checkout', 'owned', 'login'], waitSec * 1000);
    if (state.state !== 'challenge' && state.state !== 'unknown') {
      logger.log('✅', 'Epic 人机验证已完成，继续领取流程');
    } else {
      logger.log('🟡', `Epic 人机验证层在 ${waitSec} 秒内仍未消失`);
    }
    return state;
  }

  getState() {
    return {
      running: this.running,
      checking: this.checking,
      verifying: this.verifying,
      stopRequested: this.stopRequested,
      engine: 'chromium',
      visible: process.env.EPIC_VISIBLE === '1',
      novncPort: Number(process.env.NOVNC_PORT || 6080),
      loginWindow: {
        open: !!this.loginContext,
        accountId: this.loginAccountId,
        engine: this.loginEngine
      },
      runningAccountId: this.runningAccountId,
      lastRun: this.lastRun,
      lastCheckAt: this.lastCheckAt,
      state: this.state
    };
  }

  /** 全局领取设置（带安全默认值与边界） */
  getSettings() {
    const cfg = configManager.get();
    const e = cfg.epic || {};
    const clamp = (v, min, max, dft) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return dft;
      return Math.max(min, Math.min(max, n));
    };
    return {
      enabled: e.enabled !== false,
      autoClaimTime: normalizeAutoClaimTime(e.autoClaimTime),
      checkIntervalMin: clamp(e.checkIntervalMin, 5, 10080, 720),
      retryCount: clamp(e.retryCount, 0, 5, 2),
      retryIntervalSec: clamp(e.retryIntervalSec, 10, 600, 60),
      accountGapSec: clamp(e.accountGapSec, 0, 600, 20)
    };
  }

  // ===== 会话导入 =====

  /** 把 Cookie-Editor / storageState / 原始 Cookie 串统一转成 Playwright storageState */
  parseSessionInput(input) {
    const text = String(input || '').trim();
    if (!text) throw new Error('请粘贴 Cookie 或 storageState JSON');

    // 1) storageState JSON（含 cookies 数组）
    try {
      const obj = JSON.parse(text);
      if (obj && Array.isArray(obj.cookies)) {
        const cookies = obj.cookies.map(c => this.normalizeCookie(c)).filter(Boolean);
        if (cookies.length === 0) throw new Error('cookies 为空');
        return { cookies, origins: Array.isArray(obj.origins) ? obj.origins : [] };
      }
      // 2) Cookie-Editor 导出的数组
      if (Array.isArray(obj)) {
        const cookies = obj.map(c => this.normalizeCookie(c)).filter(Boolean);
        if (cookies.length === 0) throw new Error('未解析到任何 Cookie');
        return { cookies, origins: [] };
      }
      // 3) 单个 Cookie 对象
      if (obj && typeof obj === 'object' && obj.name && obj.value !== undefined) {
        const c = this.normalizeCookie(obj);
        if (c) return { cookies: [c], origins: [] };
      }
    } catch (e) {
      // JSON 解析失败就走原始 Cookie 串分支
      if (e instanceof SyntaxError === false && /cookies 为空|未解析到任何 Cookie/.test(e.message)) throw e;
    }

    // 4) 原始 Cookie 请求头字符串：a=1; b=2
    const cookies = [];
    for (const part of text.split(/[;\r\n]+/)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      let name = '';
      let value = '';
      if (trimmed.includes('\t') && !trimmed.includes('=')) {
        const cols = trimmed.split('\t');
        name = String(cols[0] || '').trim();
        value = String(cols[1] || '').trim();
      } else {
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        name = trimmed.slice(0, eq).trim();
        value = trimmed.slice(eq + 1).trim();
      }
      if (!name) continue;
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        value = value.slice(1, -1);
      }
      cookies.push({
        name,
        value,
        domain: '.epicgames.com',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: 'Lax'
      });
    }
    if (cookies.length === 0) {
      throw new Error('无法识别的格式：请粘贴 Cookie-Editor 导出的 JSON、Playwright storageState，或 "a=1; b=2" 形式的 Cookie 串');
    }
    return { cookies, origins: [] };
  }

  normalizeCookie(c) {
    if (!c || !c.name) return null;
    const rawSameSite = String(c.sameSite || '').toLowerCase();
    let sameSite = 'Lax';
    if (rawSameSite.includes('strict')) sameSite = 'Strict';
    else if (rawSameSite.includes('none') || rawSameSite.includes('no_restriction')) sameSite = 'None';

    let expires = c.expires;
    if (typeof expires !== 'number') expires = Number(c.expirationDate);
    if (!Number.isFinite(expires)) expires = -1;

    return {
      name: c.name,
      value: String(c.value ?? ''),
      domain: c.domain || '.epicgames.com',
      path: c.path || '/',
      expires,
      httpOnly: !!c.httpOnly,
      secure: c.secure !== false,
      sameSite
    };
  }

  /** 会话摘要（用于前端展示，绝不返回 cookie 值） */
  summarizeSession(storageState) {
    const cookies = storageState?.cookies || [];
    const hasEpicSession = cookies.some(c => /EPIC_BEARER|EPIC_SESSION|EPIC_SSO/i.test(c.name));
    return { cookieCount: cookies.length, hasEpicSession };
  }

  // ===== 免费游戏列表 =====

  /** 从 Epic 官方静态接口读取当前可领取的免费游戏（演示模式会追加示例游戏） */
  async fetchFreeGames() {
    if (this.isDemo()) {
      return this.demoGames();
    }
    let games = [];
    try {
      games = await this.fetchFreeGamesFromApi();
    } catch (e) {
      logger.log('🟡', `Epic 免费游戏接口异常（演示模式继续）: ${e.message}`);
    }
    return games;
  }

  async fetchFreeGamesFromApi() {
    const headers = {
      'accept': 'application/json',
      'user-agent': PC_USER_AGENT
    };
    const res = await networkClient.request({
      url: FREE_GAMES_API,
      headers,
      timeout: 20000
    });
    const data = typeof res === 'string' ? JSON.parse(res) : res;
    const elements = data?.data?.Catalog?.searchStore?.elements || [];
    const now = Date.now();
    const games = [];

    for (const el of elements) {
      const offerGroups = el.promotions?.promotionalOffers || [];
      const upcomingGroups = el.promotions?.upcomingPromotionalOffers || [];

      // 1. 当前免费中的游戏
      const current = offerGroups
        .flatMap(g => g?.promotionalOffers || [])
        .find(o => {
          if (!o) return false;
          const pct = o.discountSetting?.discountPercentage;
          const start = Date.parse(o.startDate);
          const end = Date.parse(o.endDate);
          return Number(pct) === 0 && start <= now && now < end;
        });

      // 2. 即将推出的下周预告免费游戏
      const upcoming = upcomingGroups
        .flatMap(g => g?.promotionalOffers || [])
        .find(o => {
          if (!o) return false;
          const pct = o.discountSetting?.discountPercentage;
          const start = Date.parse(o.startDate);
          return Number(pct) === 0 && start > now;
        });

      if (!current && !upcoming) continue;

      // 注意：urlSlug 是十六进制 id，不能直接当页面 slug 用（会 404）。
      // 正确的商城页面地址在 catalogNs.mappings / offerMappings 的 pageSlug 里。
      const rawSlug = el.productSlug
        || el.catalogNs?.mappings?.find(m => m?.pageSlug)?.pageSlug
        || el.offerMappings?.find(m => m?.pageSlug)?.pageSlug
        || el.urlSlug
        || '';
      const slug = String(rawSlug).replace(/\/home$/i, '').replace(/^\//, '');
      const isFreeNow = !!current;
      const activeOffer = current || upcoming;

      games.push({
        id: el.id,
        title: el.title || '未知游戏',
        slug,
        url: slug ? `${STORE_BASE}/p/${slug}` : null,
        isFreeNow,
        isUpcoming: !isFreeNow,
        status: isFreeNow ? 'free_now' : 'upcoming',
        startDate: activeOffer?.startDate || null,
        endDate: activeOffer?.endDate || null,
        image: el.keyImages?.find(i => i.type === 'OfferImageWide' || i.type === 'Thumbnail')?.url || null
      });
    }
    return games.sort((a, b) => {
      if (a.isFreeNow && !b.isFreeNow) return -1;
      if (!a.isFreeNow && b.isFreeNow) return 1;
      return 0;
    });
  }

  // ===== 领取流程 =====

  async dismissOverlays(page) {
    const labels = ['继续', '接受', '我同意', '同意', '关闭', 'Continue', 'Accept', 'I Agree'];
    for (const label of labels) {
      try {
        const btn = page.getByRole('button', { name: label, exact: false }).first();
        if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
          await btn.click({ timeout: 2000 }).catch(() => {});
          await this.delay(500);
        }
      } catch {}
    }
  }

  async visibleButtonTexts(page) {
    try {
      const texts = [];
      const frames = this.getEpicFrames(page);
      for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
        const frame = frames[frameIndex];
        try {
          const buttons = frame.locator('button, [role="button"]');
          const count = await buttons.count().catch(() => 0);
          for (let i = 0; i < Math.min(count, 30); i++) {
            const button = typeof buttons.nth === 'function' ? buttons.nth(i) : buttons.first();
            if (!await button.isVisible().catch(() => false)) continue;
            const text = String(await button.innerText({ timeout: 500 }).catch(() => '') || '').trim();
            if (text) texts.push(frameIndex === 0 ? text : `[iframe ${frameIndex}] ${text}`);
          }
        } catch {}
      }
      return [...new Set(texts)].slice(0, 20).join(' / ');
    } catch {
      return '(读取失败)';
    }
  }

  /** 是否演示模式（不启动浏览器，仅模拟流程，用于本地验证） */
  isDemo() {
    return isDemoMode();
  }

  purgeStaleDemoData() {
    const demoAccounts = configManager.getEpicAccounts().filter(acc => isDemoEpicAccountId(acc.id));
    const cfg = configManager.get();
    const records = Array.isArray(cfg.epic?.claimRecords) ? cfg.epic.claimRecords : [];
    const hasDemoRecords = records.some(record => isDemoEpicAccountId(record.accountId));
    if (demoAccounts.length === 0 && !hasDemoRecords) return;

    demoAccounts.forEach(acc => configManager.deleteEpicAccount(acc.id));
    const current = configManager.get();
    if (Array.isArray(current.epic?.claimRecords)) {
      current.epic.claimRecords = current.epic.claimRecords.filter(record => !isDemoEpicAccountId(record.accountId));
      configManager.save();
    }
    logger.log('🧹', `已清理旧版演示 Epic 数据：${demoAccounts.length} 个账号`);
  }

  /** 演示模式：自动创建几个示例账号（只在没有任何 Epic 账号时） */
  seedDemoData() {
    if (!this.isDemo()) return;
    if (configManager.getEpicAccounts().length > 0) return;

    const demoAccounts = [
      {
        id: 'demo_epic_1',
        name: '演示账号 A',
        handledGames: {
          demo_game_1: { at: Date.now() - 36 * 60 * 1000, status: 'claimed' },
          demo_game_2: { at: Date.now() - 35 * 60 * 1000, status: 'owned' }
        }
      },
      {
        id: 'demo_epic_2',
        name: '演示账号 B',
        handledGames: {
          demo_game_1: { at: Date.now() - 28 * 60 * 1000, status: 'claimed' }
        }
      },
      {
        id: 'demo_epic_3',
        name: '演示账号 C',
        handledGames: {}
      }
    ];

    demoAccounts.forEach((account, i) => {
      configManager.upsertEpicAccount({
        id: account.id,
        name: account.name,
        order: i + 1,
        enabled: true,
        storageState: {
          cookies: [
            { name: 'EPIC_BEARER', value: `demo-bearer-${i + 1}`, domain: '.epicgames.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
            { name: 'EPIC_SESSION', value: 'demo-session', domain: '.epicgames.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }
          ],
          origins: []
        },
        sessionValid: true,
        lastVerifyAt: Date.now(),
        lastVerifyMessage: '演示会话（未真实校验）',
        lastClaimAt: i < 2 ? Date.now() - (30 - i * 5) * 60 * 1000 : 0,
        lastClaimMessage: i < 2 ? '演示数据：已处理部分免费游戏' : '',
        handledGames: account.handledGames
      });
    });

    if (configManager.getEpicClaimRecords(1).length === 0) {
      const demoGames = this.demoGames();
      const byId = Object.fromEntries(demoGames.map(g => [g.id, g]));
      configManager.appendEpicClaimRecords([
        { accountId: 'demo_epic_1', title: byId.demo_game_1.title, url: byId.demo_game_1.url, ok: true, status: 'claimed', message: '领取成功', at: Date.now() - 36 * 60 * 1000 },
        { accountId: 'demo_epic_1', title: byId.demo_game_2.title, url: byId.demo_game_2.url, ok: true, status: 'owned', message: '已在库中', at: Date.now() - 35 * 60 * 1000 },
        { accountId: 'demo_epic_2', title: byId.demo_game_1.title, url: byId.demo_game_1.url, ok: true, status: 'claimed', message: '领取成功', at: Date.now() - 28 * 60 * 1000 }
      ]);
    }
    logger.log('🎮', `演示模式：已自动创建 ${demoAccounts.length} 个示例 Epic 账号`);
  }

  /** 演示模式的示例免费游戏 */
  demoGames() {
    const now = Date.now();
    const currentEnd = new Date(now + 1 * 86400000 + 14 * 3600000).toISOString();
    const upcomingStart = currentEnd;
    const upcomingEnd = new Date(now + 8 * 86400000).toISOString();
    return [
      {
        id: 'demo_game_1',
        title: '虎视眈眈 (Out of Sight)',
        slug: 'out-of-sight-4d9ce6',
        url: 'https://store.epicgames.com/zh-CN/p/out-of-sight-4d9ce6',
        isFreeNow: true,
        isUpcoming: false,
        status: 'free_now',
        startDate: new Date(now - 6 * 86400000).toISOString(),
        endDate: currentEnd,
        image: 'https://cdn1.epicgames.com/spt-assets/6e1bf54cfa6344c89d41e4e7af036ac9/out-of-sight-1l12n.jpg'
      },
      {
        id: 'demo_game_2',
        title: 'TerraScape',
        slug: 'terrascape-fc0b29',
        url: 'https://store.epicgames.com/zh-CN/p/terrascape-fc0b29',
        isFreeNow: true,
        isUpcoming: false,
        status: 'free_now',
        startDate: new Date(now - 6 * 86400000).toISOString(),
        endDate: currentEnd,
        image: 'https://cdn1.epicgames.com/spt-assets/a740a2eed807469f88b9dff17e7cd3a3/terrascape-j7p8d.png'
      },
      {
        id: 'demo_game_3',
        title: 'Bad Cheese',
        slug: 'bad-cheese-d36004',
        url: 'https://store.epicgames.com/zh-CN/p/bad-cheese-d36004',
        isFreeNow: false,
        isUpcoming: true,
        status: 'upcoming',
        startDate: upcomingStart,
        endDate: upcomingEnd,
        image: 'https://cdn1.epicgames.com/spt-assets/6cbb0e3805c4436bafd028cafff48307/bad-cheese-16hj0.png'
      },
      {
        id: 'demo_game_4',
        title: 'Agent A - 伪装游戏',
        slug: 'agent-a-a-puzzle-in-disguise',
        url: 'https://store.epicgames.com/zh-CN/p/agent-a-a-puzzle-in-disguise',
        isFreeNow: false,
        isUpcoming: true,
        status: 'upcoming',
        startDate: upcomingStart,
        endDate: upcomingEnd,
        image: 'https://cdn1.epicgames.com/spt-assets/45db4fbe68fe43f4b025dec2014d42e7/agent-a-a-puzzle-in-disguise-3cppl.png'
      }
    ];
  }

  /** 演示模式：模拟一次领取过程 */
  async simulateClaim(game) {
    const result = { id: game.id, title: game.title, url: game.url, ok: false, status: 'failed', message: '' };
    this.updateState({ status: 'navigating', gameTitle: game.title, lastAction: `[演示] 打开「${game.title}」商品页...` });
    await this.delay(1200);
    this.updateState({ status: 'clicking', lastAction: `[演示] 点击「获取」...` });
    await this.delay(1200);
    this.updateState({ status: 'ordering', lastAction: `[演示] 确认订单...` });
    await this.delay(1200);

    const failMode = process.env.EPIC_DEMO_FAIL || '';
    const attempt = this.state.attempt || 1;
    if (failMode === 'all' || (failMode === 'first' && attempt === 1)) {
      result.message = `[演示] 第 ${attempt} 次尝试失败（模拟）`;
      return result;
    }
    result.ok = true;
    result.status = 'claimed';
    result.message = '[演示] 领取成功';
    return result;
  }

  /** 领取单个游戏；status: claimed(本次领到) / owned(本来就有) / skipped(无页面) / failed */
  async detectOwnedState(page) {
    if (await this.hasVisibleText(page, EPIC_OWNED_TEXT_RE)) return true;
    return !!(await this.findVisibleEpicButton(page, EPIC_OWNED_BUTTON_RE));
  }

  async detectClaimOutcome(page) {
    if (await this.hasVisibleText(page, EPIC_SUCCESS_TEXT_RE)) return { status: 'claimed', message: '领取成功' };
    if (await this.detectOwnedState(page)) return { status: 'owned', message: '已在库中' };
    return null;
  }

  async claimSingle(page, game, context = null) {
    const result = {
      id: game.id,
      title: game.title,
      url: game.url,
      ok: false,
      status: 'failed',
      code: '',
      authValid: null,
      message: ''
    };
    if (this.isDemo()) return this.simulateClaim(game);
    if (!game.url) {
      result.status = 'skipped';
      result.code = 'no_url';
      result.message = '暂无可领取页面（可能是未揭晓的神秘游戏）';
      return result;
    }

    try {
      const auth = context ? await this.checkEpicAccountSession(context) : { valid: true };
      if (!auth.valid) {
        if (auth.state === 'challenge') {
          result.status = 'blocked';
          result.code = 'challenge';
          result.message = `Epic 账号接口触发人机验证（${auth.message || 'HTTP 403'}）`;
        } else {
          result.code = 'auth_expired';
          result.authValid = false;
          result.message = auth.message || 'Epic 登录态已失效，请重新登录';
        }
        return result;
      }

      this.updateState({
        status: 'navigating',
        progress: 20,
        code: '',
        gameTitle: game.title,
        lastAction: `打开「${game.title}」商品页...`
      });
      let pageState = await this.navigateEpicPage(page, game.url, 45000);

      if (pageState.state === 'challenge') {
        pageState = await this.dismissChallengeOverlay(page);
      }

      const outcomeAfterChallenge = await this.detectClaimOutcome(page);
      if (outcomeAfterChallenge) {
        result.ok = true;
        result.status = outcomeAfterChallenge.status;
        result.code = outcomeAfterChallenge.status;
        result.authValid = true;
        result.message = outcomeAfterChallenge.message;
        return result;
      }

      if (pageState.state === 'challenge' || pageState.state === 'unknown') {
        result.status = 'blocked';
        result.code = 'challenge';
        result.message = `商店人机验证未通过（当前按钮：${await this.visibleButtonTexts(page)}）`;
        return result;
      }

      if (pageState.state === 'login') {
        // 商城页面很慢时，登录链接可能在页面水合完成前短暂出现。
        // 账号接口已经确认有效，此时继续等待商品按钮，不能据此直接判定掉登录。
        pageState = await this.waitForPageState(page, ['product', 'checkout', 'owned', 'challenge'], 30000);
        if (pageState.state === 'challenge' || pageState.state === 'login' || pageState.state === 'unknown') {
          result.status = 'blocked';
          result.code = 'page_timeout';
          result.message = `商城商品页加载超时（当前按钮：${await this.visibleButtonTexts(page)}）`;
          return result;
        }
      }

      // 慢网络下“获取”按钮可能先于账号数据水合出现。短暂稳定后再点击，
      // 避免在商城会话尚未就绪时触发 Epic 的验证错误页。
      await this.delay(2500);
      if (context) {
        const authAfterLoad = await this.checkEpicAccountSession(context);
        if (!authAfterLoad.valid && authAfterLoad.state !== 'challenge') {
          result.code = 'auth_expired';
          result.authValid = false;
          result.message = authAfterLoad.message || 'Epic 登录态已失效，请重新登录';
          return result;
        }
      }

      // 已在库中：本次无需领取
      if (pageState.state === 'owned') {
        result.ok = true;
        result.status = 'owned';
        result.code = 'owned';
        result.authValid = true;
        result.message = '已在库中';
        return result;
      }

      this.updateState({ status: 'clicking', progress: 55, lastAction: `点击「获取」...` });
      let getMatch = await this.findVisibleEpicButton(page, /^获取$|^Get$/i, { requireEnabled: true });
      if (!getMatch) {
        getMatch = await this.findVisibleEpicButton(page, /获取|Get/i, { requireEnabled: true });
      }
      if (!getMatch) {
        result.code = 'no_get_button';
        result.message = `未找到「获取」按钮（当前按钮：${await this.visibleButtonTexts(page)}）`;
        return result;
      }
      const pageCountBeforeClick = context ? context.pages().length : 1;
      const getClick = await this.clickEpicButton(getMatch.locator, '获取');
      if (!getClick.ok) {
        result.code = 'get_click_failed';
        result.message = `点击「获取」失败：${getClick.errors.join('；')}`;
        return result;
      }
      await this.delay(2000);

      if (context) {
        const pages = context.pages();
        if (pages.length > pageCountBeforeClick) {
          page = pages[pages.length - 1];
          await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        }
        const checkoutPage = await this.findCheckoutPage(context, page);
        if (checkoutPage !== page) {
          page = checkoutPage;
          this.updateState({ lastAction: '结账窗口位于另一个标签页，已切换过去继续确认...' });
        }
      }

      this.updateState({ status: 'ordering', progress: 70, lastAction: `等待结账窗口...` });
      const checkoutDeadline = Date.now() + 25000;
      const checkoutStartedAt = Date.now();
      let checkoutReady = false;
      let escapeTried = false;
      while (Date.now() < checkoutDeadline) {
        this.throwIfStopped();
        const outcome = await this.detectClaimOutcome(page);
        if (outcome) {
          result.ok = true;
          result.status = outcome.status;
          result.code = outcome.status;
          result.authValid = true;
          result.message = outcome.message;
          return result;
        }

        const current = await this.detectPageState(page);
        if (current.state === 'challenge') {
          const resolved = await this.dismissChallengeOverlay(page);
          const resolvedOutcome = await this.detectClaimOutcome(page);
          if (resolvedOutcome) {
            result.ok = true;
            result.status = resolvedOutcome.status;
            result.code = resolvedOutcome.status;
            result.authValid = true;
            result.message = resolvedOutcome.message;
            return result;
          }
          if (resolved.state === 'challenge' || resolved.state === 'unknown') {
            result.status = 'blocked';
            result.code = 'challenge';
            result.message = `结账前人机验证未通过（当前按钮：${await this.visibleButtonTexts(page)}）`;
            return result;
          }
        }

        // 验证层真正消失后，页面可能仍残留 “TRY AGAIN” 文案，但结账弹窗已经出现。
        if (await this.findVisibleOrderButton(page)) {
          checkoutReady = true;
          break;
        }

        if (!escapeTried && Date.now() - checkoutStartedAt > 2500) {
          escapeTried = true;
          this.updateState({ lastAction: '未发现结账按钮，尝试关闭验证覆盖层后复检...' });
          await page.keyboard.press('Escape').catch(() => {});
          await this.delay(1200);
        }
        await this.delay(500);
      }

      if (!checkoutReady) {
        const outcome = await this.detectClaimOutcome(page);
        if (outcome) {
          result.ok = true;
          result.status = outcome.status;
          result.code = outcome.status;
          result.authValid = true;
          result.message = outcome.message;
          return result;
        }
        result.code = 'no_order_button';
        result.message = `未出现下单按钮（当前按钮：${await this.visibleButtonTexts(page)}）`;
        return result;
      }

      // 部分游戏需要勾选 EULA 才能下单
      const agreementCount = await this.acceptCheckoutAgreements(page);
      if (agreementCount > 0) {
        this.updateState({ lastAction: `已勾选 ${agreementCount} 项结账协议，准备确认订单...` });
      }

      // 勾选协议或验证层消退后 DOM 可能重建，因此点击前重新定位。
      let orderMatch = await this.findVisibleOrderButton(page);
      if (!orderMatch) {
        await this.delay(1500);
        orderMatch = await this.findVisibleOrderButton(page);
      }
      if (!orderMatch) {
        result.code = 'no_order_button';
        result.message = `结账按钮在点击前消失（当前按钮：${await this.visibleButtonTexts(page)}）`;
        return result;
      }

      const orderLabel = orderMatch.text || '添加到库';
      this.updateState({
        status: 'ordering',
        progress: 82,
        lastAction: `点击「${orderLabel}」（${orderMatch.frameIndex === 0 ? '主页面' : `iframe ${orderMatch.frameIndex}`}）...`
      });
      const orderClick = await this.clickEpicButton(orderMatch.locator, orderLabel);
      if (!orderClick.ok) {
        result.code = 'order_click_failed';
        result.message = `点击「${orderLabel}」失败：${orderClick.errors.join('；')}`;
        return result;
      }
      this.updateState({
        status: 'ordering',
        progress: 86,
        lastAction: `已通过${orderClick.mode}点击「${orderLabel}」，等待入库回调...`
      });

      const confirmDeadline = Date.now() + 35000;
      while (Date.now() < confirmDeadline) {
        this.throwIfStopped();
        const outcome = await this.detectClaimOutcome(page);
        if (outcome) {
          result.ok = true;
          result.status = outcome.status;
          result.code = outcome.status;
          result.authValid = true;
          result.message = outcome.message;
          return result;
        }
        await this.delay(1000);
      }
      result.code = 'order_unconfirmed';
      result.message = `已点击「${orderLabel}」，但未识别到入库确认（当前按钮：${await this.visibleButtonTexts(page)}）`;
      return result;
    } catch (e) {
      result.code = 'exception';
      result.message = `领取异常: ${e.message}`;
      return result;
    }
  }

  /**
   * 校验按钮不仅确认登录，还要同步当前免费游戏的入库状态。
   * 只读取页面状态，不点击“获取”，因此不会触发领取或下单。
   */
  async refreshGameOwnership(page, accountId) {
    const acc = configManager.findEpicAccount(accountId);
    const games = await this.fetchFreeGames();
    const currentGames = games.filter(game => game.isFreeNow !== false && game.url);
    const handledPatch = { ...(acc?.handledGames || {}) };
    const statuses = [];

    for (let i = 0; i < currentGames.length; i++) {
      this.throwIfStopped();
      const game = currentGames[i];
      this.updateState({
        status: 'verifying',
        progress: 40 + Math.round(((i + 1) / Math.max(1, currentGames.length)) * 35),
        gameTitle: game.title,
        lastAction: `同步「${game.title}」入库状态...`
      });

      let status = 'unknown';
      try {
        const pageState = await this.navigateEpicPage(page, game.url, 30000);
        if (await this.detectOwnedState(page)) {
          status = 'owned';
          handledPatch[game.id] = { at: Date.now(), status: 'owned', title: game.title };
        } else if (pageState.state === 'product') {
          const getBtn = await this.findVisibleEpicButton(page, /^获取$|^Get$/i);
          if (getBtn) {
            status = 'available';
            delete handledPatch[game.id];
          }
        } else if (pageState.state === 'challenge') {
          status = 'challenge';
        }
      } catch {
        status = 'unknown';
      }
      statuses.push({ id: game.id, title: game.title, status });
    }

    configManager.updateEpicAccount(accountId, { handledGames: this.pruneHandled(handledPatch) });
    return statuses;
  }

  /** 校验会话是否仍然登录（打开商城首页，区分登录失效与人机验证） */
  async verifySession(accountId) {
    if (this.running || this.checking || this.verifying) throw new Error('Epic 任务正在运行中，请等待完成后再校验');
    this.assertLoginWindowClosed('校验会话');
    const acc = configManager.findEpicAccount(accountId);
    if (!acc) throw new Error('Epic 账号不存在');
    if (!acc.storageState?.cookies?.length) return { valid: false, message: '尚未导入会话' };

    if (this.isDemo()) {
      const valid = acc.sessionValid !== false;
      const message = valid ? '演示会话有效（未真实校验）' : '演示会话已失效（模拟）';
      configManager.updateEpicAccount(accountId, {
        sessionValid: valid,
        lastVerifyAt: Date.now(),
        lastVerifyMessage: message
      });
      return { valid, message };
    }

    // 与积分任务的搜索流程共用浏览器资源锁，避免两个 Chromium 同时占内存
    const slotOwner = `epic-verify:${accountId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const gotSlot = await firefoxSlotLock.acquire(slotOwner, 180000);
    if (!gotSlot) throw new Error('浏览器资源正被积分任务占用，请稍后再试');
    this.throwIfStopped();
    let context = null;
    this.verifying = true;
    try {
      this.updateState({
        status: 'verifying',
        progress: 15,
        accountName: acc.name,
        lastAction: `校验 Epic 账号「${acc.name}」...`
      });
      const launched = await this.launchPersistentContext(acc, { engine: 'chromium' });
      context = launched.context;
      const page = launched.page;
      this.activeContext = context;
      this.activeAccountId = accountId;

      let valid = null;
      let blocked = false;
      let message = '';
      const auth = await this.checkEpicAccountSession(context);
      if (auth.state === 'challenge') {
        blocked = true;
        message = 'Epic 账号接口触发人机验证，暂时无法判断会话是否有效';
      } else if (auth.valid) {
        valid = true;
        message = '会话有效（已登录）';
      } else {
        valid = false;
        message = auth.message || 'Epic 登录态已失效，请重新登录';
      }

      let gameStatuses = [];
      if (valid) {
        gameStatuses = await this.refreshGameOwnership(page, accountId);
        const ownedCount = gameStatuses.filter(game => game.status === 'owned').length;
        const availableCount = gameStatuses.filter(game => game.status === 'available').length;
        const unknownCount = gameStatuses.length - ownedCount - availableCount;
        message = `会话有效（已登录）；入库状态：${ownedCount} 个已在库，${availableCount} 个可领取${unknownCount ? `，${unknownCount} 个未确认` : ''}`;
      }

      const patch = {
        lastVerifyAt: Date.now(),
        lastVerifyMessage: message
      };
      if (valid !== false) {
        patch.storageState = await context.storageState();
      }
      if (valid !== null) patch.sessionValid = valid;
      configManager.updateEpicAccount(accountId, patch);
      this.updateState({ status: 'done', progress: 100, lastAction: message });
      return { valid, blocked, message, gameStatuses };
    } finally {
      this.verifying = false;
      if (this.activeContext === context) {
        this.activeContext = null;
        this.activeAccountId = null;
      }
      this.stopRequested = false;
      try {
        if (context) {
          await withTimeout(Promise.resolve().then(() => context.close()), this.closeTimeoutMs, '关闭会话校验浏览器超时').catch(() => {});
        }
      } finally {
        firefoxSlotLock.release(slotOwner);
      }
    }
  }

  /**
   * 为单个账号领取免费游戏。
   * 只处理「本次促销期内尚未领取成功」的游戏；失败按设置重试，仍失败则留给下一轮检查。
   */
  async claimForAccount(accountId, prefetchedGames = null) {
    const runStartedAt = Date.now();
    this.assertLoginWindowClosed('领取免费游戏');
    const acc = configManager.findEpicAccount(accountId);
    if (!acc) throw new Error('Epic 账号不存在');
    if (!acc.storageState?.cookies?.length) throw new Error('该账号尚未导入会话，请先导入 Cookie');

    const settings = this.getSettings();
    const demo = this.isDemo();
    const allGames = prefetchedGames || await this.fetchFreeGames();
    const handled = acc.handledGames || {};
    const pending = allGames.filter(g => g.isFreeNow !== false && !['claimed', 'owned'].includes(handled[g.id]?.status));
    logger.log('🎮', `发现 ${allGames.length} 个免费游戏，其中 ${pending.length} 个待处理`, '', acc.name);

    if (pending.length === 0) {
      this.updateState({ status: 'idle', lastAction: '没有需要领取的游戏' });
      return { games: allGames, results: [], pending: 0 };
    }

    let context = null;
    let page = null;
    const results = [];
    let slotHeld = false;
    let slotOwner = null;

    try {
      if (!demo) {
        // 与积分任务的搜索流程共用浏览器资源锁，避免两个 Chromium 同时占内存
        slotOwner = `epic-claim:${accountId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        const gotSlot = await firefoxSlotLock.acquire(slotOwner, 180000);
        if (!gotSlot) throw new Error('浏览器资源正被积分任务占用，请稍后再试');
        slotHeld = true;
        this.throwIfStopped();
        const launched = await this.launchPersistentContext(acc, { engine: 'chromium' });
        context = launched.context;
        page = launched.page;
        this.activeContext = context;
        this.activeAccountId = accountId;
      }

      const maxAttempts = settings.retryCount + 1;
      for (const game of pending) {
        this.throwIfStopped();
        let final = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          this.throwIfStopped();
          this.updateState({ attempt, maxAttempts, gameTitle: game.title });
          const r = await this.claimSingle(page, game, context);
          final = r;
          if (r.status !== 'failed') break;
          if (r.code === 'auth_expired' || r.code === 'challenge') {
            if (r.code === 'challenge' && attempt === 1 && maxAttempts > 1) {
              this.updateState({ status: 'retrying', progress: 48, lastAction: `「${game.title}」遇到人机验证，${settings.retryIntervalSec} 秒后再试一次...` });
              logger.log('🟡', `「${game.title}」遇到人机验证，将再尝试一次`, '', acc.name);
              await this.interruptibleDelay(settings.retryIntervalSec * 1000);
              continue;
            }
            break;
          }
          if (attempt < maxAttempts) {
            this.updateState({ status: 'retrying', progress: 55, lastAction: `「${game.title}」第 ${attempt} 次失败，${settings.retryIntervalSec} 秒后重试...` });
            logger.log('🟡', `「${game.title}」第 ${attempt}/${maxAttempts} 次失败：${r.message}`, '', acc.name);
            await this.interruptibleDelay(settings.retryIntervalSec * 1000);
          }
        }
        results.push(final);
        const icon = final.status === 'blocked' ? '🛡️' : (final.status === 'failed' ? '🔴' : (final.status === 'owned' ? '🟡' : '✅'));
        logger.log(icon, `${game.title}：${final.message}`, '', acc.name);
        await this.interruptibleDelay(1500 + Math.floor(Math.random() * 2000));
      }

      // 记录已处理游戏（只记成功/已有），失败留给下一轮检查
      const handledPatch = { ...handled };
      for (const r of results) {
        if (r.status === 'claimed' || r.status === 'owned') {
          handledPatch[r.id] = { at: Date.now(), status: r.status };
        }
      }
      const pruned = this.pruneHandled(handledPatch);

      const claimedCount = results.filter(r => r.status === 'claimed').length;
      const ownedCount = results.filter(r => r.status === 'owned').length;
      const failedCount = results.filter(r => r.status === 'failed').length;
      const blockedCount = results.filter(r => r.status === 'blocked').length;
      const patch = {
        handledGames: pruned,
        lastClaimAt: Date.now(),
        lastClaimMessage: `本次领取 ${claimedCount} 个 / 已有 ${ownedCount} 个 / 失败 ${failedCount} 个 / 拦截 ${blockedCount} 个`
      };
      if (!demo && context) {
        this.throwIfStopped();
        const freshAcc = configManager.findEpicAccount(accountId);
        const sessionChangedDuringRun = Number(freshAcc?.lastSessionImportAt || 0) > runStartedAt;
        if (!sessionChangedDuringRun) {
          patch.storageState = await context.storageState();
          const authStates = results.map(r => r.authValid).filter(v => v === true || v === false);
          if (authStates.includes(true)) patch.sessionValid = true;
          else if (authStates.length > 0 && authStates.every(v => v === false)) patch.sessionValid = false;
        } else {
          logger.log('🟡', '领取期间检测到更新的 Epic 会话，本次不写回旧浏览器状态', '', acc.name);
        }
      }
      configManager.updateEpicAccount(accountId, patch);
    } finally {
      try {
        if (context) {
          await withTimeout(Promise.resolve().then(() => context.close()), this.closeTimeoutMs, '关闭 Epic 领取浏览器超时').catch(() => {});
        }
      } finally {
        if (this.activeContext === context) {
          this.activeContext = null;
          this.activeAccountId = null;
        }
        if (slotHeld && slotOwner) firefoxSlotLock.release(slotOwner);
      }
    }

    this.recordResults(accountId, results);
    return { games: allGames, results, pending: pending.length };
  }

  /** handledGames 只保留最近 200 条，避免长期运行无限增长 */
  pruneHandled(map = {}) {
    const entries = Object.entries(map).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0));
    return Object.fromEntries(entries.slice(0, 200));
  }

  recordResults(accountId, results) {
    const records = results.map(r => ({
      accountId,
      title: r.title,
      url: r.url,
      ok: !!r.ok,
      status: r.status || (r.ok ? 'claimed' : 'failed'),
      message: r.message,
      at: Date.now()
    }));
    configManager.appendEpicClaimRecords(records);
  }

  /** 为全部启用的账号领取（对外入口，带并发保护） */
  async claimAll() {
    if (this.running || this.checking || this.verifying) throw new Error('Epic 任务正在运行中，请稍后再试');
    return this.runClaimAll();
  }

  /** 实际执行全部账号领取（供定时检查内部调用，不再重复做并发判断） */
  async runClaimAll() {
    this.assertLoginWindowClosed('执行批量领取');
    this.running = true;
    const startedAt = Date.now();
    const allResults = [];
    const settings = this.getSettings();
    this.updateState({ status: 'checking', progress: 8, startedAt, accountName: '', gameTitle: '', lastAction: '开始检查免费游戏...' });

    try {
      const accounts = configManager.getEpicAccounts().filter(a => a.enabled !== false && a.storageState?.cookies?.length);
      if (accounts.length === 0) {
        logger.log('🟡', 'Epic：没有可执行的账号（未启用或未导入会话）');
        return { accounts: [], results: [] };
      }

      // 免费游戏列表只取一次，避免每个账号都重复请求
      const allGames = await this.fetchFreeGames();

      for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i];
        this.runningAccountId = acc.id;
        this.updateState({ accountName: acc.name, status: 'checking', progress: 12, lastAction: `开始处理账号「${acc.name}」` });

        const handled = acc.handledGames || {};
        const pending = allGames.filter(g => g.isFreeNow !== false && !['claimed', 'owned'].includes(handled[g.id]?.status));
        if (pending.length === 0) {
          allResults.push({ accountId: acc.id, accountName: acc.name, results: [] });
          continue;
        }

        try {
          const { results } = await this.claimForAccount(acc.id, allGames);
          allResults.push({ accountId: acc.id, accountName: acc.name, results });
        } catch (e) {
          if (e?.code === 'EPIC_STOPPED') {
            logger.log('🛑', `Epic 账号 [${acc.name}] 已手动停止`, '', acc.name);
            allResults.push({ accountId: acc.id, accountName: acc.name, stopped: true, error: e.message, results: [] });
            break;
          }
          logger.log('🔴', `Epic 账号 [${acc.name}] 领取失败: ${e.message}`, '', acc.name);
          configManager.updateEpicAccount(acc.id, { sessionValid: false, lastVerifyMessage: e.message });
          allResults.push({ accountId: acc.id, accountName: acc.name, error: e.message, results: [] });
        }
        // 不同账号之间的操作间隔（全局设置）
        if (i < accounts.length - 1) {
          this.updateState({ status: 'waiting', progress: 90, lastAction: `等待 ${settings.accountGapSec} 秒后切换下一个账号...` });
          await this.interruptibleDelay(settings.accountGapSec * 1000);
        }
      }

      if (this.stopRequested) {
        this.updateState({
          status: 'idle',
          progress: 0,
          code: 'stopped',
          lastAction: 'Epic 批量领取已停止，浏览器资源已释放'
        });
        return { accounts: accounts.map(a => ({ id: a.id, name: a.name })), results: allResults, stopped: true };
      }

      this.lastRun = { startedAt, finishedAt: Date.now(), results: allResults };
      this.updateState({ status: 'done', progress: 100, lastAction: '本轮领取完成' });
      return { accounts: accounts.map(a => ({ id: a.id, name: a.name })), results: allResults };
    } finally {
      this.running = false;
      this.stopRequested = false;
      this.activeContext = null;
      this.activeAccountId = null;
      this.runningAccountId = null;
      this.lastCheckAt = Date.now();
    }
  }

  /** 为单个账号领取（带运行状态保护） */
  async claimOne(accountId) {
    if (this.running || this.checking || this.verifying) throw new Error('Epic 任务正在运行中，请稍后再试');
    this.assertLoginWindowClosed('领取免费游戏');
    this.running = true;
    this.runningAccountId = accountId;
    const startedAt = Date.now();
    const acc = configManager.findEpicAccount(accountId);
    this.updateState({ status: 'checking', progress: 8, startedAt, accountName: acc?.name || '', lastAction: '开始检查免费游戏...' });
    try {
      const { games, results } = await this.claimForAccount(accountId);
      this.lastRun = { startedAt, finishedAt: Date.now(), results: [{ accountId, results }] };
      this.updateState({ status: 'done', progress: 100, lastAction: '本轮领取完成' });
      return { games, results };
    } catch (e) {
      if (e?.code === 'EPIC_STOPPED') {
        this.updateState({
          status: 'idle',
          progress: 0,
          code: 'stopped',
          lastAction: 'Epic 任务已停止，浏览器资源已释放'
        });
      }
      throw e;
    } finally {
      this.running = false;
      this.stopRequested = false;
      this.activeContext = null;
      this.activeAccountId = null;
      this.runningAccountId = null;
      this.lastCheckAt = Date.now();
    }
  }

  /**
   * 定时检查：先做一次轻量接口请求，只有发现「某个启用账号还有未处理的免费游戏」才真正触发领取。
   */
  async checkAndClaimIfNeeded() {
    // 防止「定时检查」与「手动领取」互相踩踏
    if (this.running || this.checking || this.verifying) return { skipped: 'busy' };
    if (this.loginContext) return { skipped: 'login-window' };
    const settings = this.getSettings();
    if (!settings.enabled) return { skipped: 'disabled' };

    const accounts = configManager.getEpicAccounts().filter(a => a.enabled !== false && a.storageState?.cookies?.length);
    if (accounts.length === 0) return { skipped: 'no-account' };

    this.checking = true;
    try {
      this.updateState({ status: 'checking', progress: 5, lastAction: '正在检查是否有新的免费游戏...' });
      const games = await this.fetchFreeGames();
      if (games.length === 0) {
        this.lastCheckAt = Date.now();
        this.updateState({ status: 'idle', progress: 0, lastAction: '当前没有免费游戏' });
        return { games: 0, claimed: false };
      }

      const needClaim = accounts.some(acc => {
        const handled = acc.handledGames || {};
        return games.some(g => g.isFreeNow !== false && !['claimed', 'owned'].includes(handled[g.id]?.status));
      });

      if (!needClaim) {
        this.lastCheckAt = Date.now();
        this.updateState({ status: 'idle', progress: 0, lastAction: '所有免费游戏都已处理过' });
        return { games: games.length, claimed: false };
      }

      // 检查期间可能已被手动领取占用，这时直接跳过本轮
      if (this.running) {
        this.lastCheckAt = Date.now();
        return { skipped: 'busy' };
      }

      logger.log('🎮', `发现 ${games.length} 个免费游戏中有待领取项，开始自动领取`);
      const result = await this.runClaimAll();
      return { games: games.length, claimed: true, result };
    } finally {
      this.checking = false;
    }
  }
}

export const epicManager = new EpicManager();
export default epicManager;
