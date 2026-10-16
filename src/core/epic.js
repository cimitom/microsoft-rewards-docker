import fs from 'fs';
import path from 'path';
import { firefox } from 'playwright-firefox';
import configManager from '../config.js';
import logger from '../logger.js';
import networkClient from '../network.js';
import { firefoxSlotLock } from './contextLock.js';
import { DATA_DIR } from '../fsUtil.js';
import {
  applyFirefoxStealth,
  detectFirefoxVersion,
  buildFirefoxUserAgent,
  evaluateFirefoxFingerprint
} from './firefoxStealth.js';

// Epic 官方商城静态接口：返回当前在售商品及促销信息（含每周免费游戏）
const FREE_GAMES_API = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN';
const STORE_BASE = 'https://store.epicgames.com/zh-CN';
const STORE_HOME = `${STORE_BASE}/`;
const EPIC_PROFILE_DIR = path.join(DATA_DIR, 'epic-firefox-profiles');
const CHALLENGE_TEXT_RE = /verify you are human|确认您是真人|正在验证|checking your browser|cf-mitigated|try again|cloudflare/i;
const LOGIN_TEXT_RE = /sign in|log in|登录|登入/i;
export const EPIC_ORDER_BUTTON_RE = /添加到库|添加至库|加入库|Add to Library|下订单|下单|确认订单|结账|Place Order|Checkout/i;
export const EPIC_SUCCESS_TEXT_RE = /已添加到库|已加入库|已拥有|谢谢|感谢|订单已提交|Added to your library|In Library|Thanks|Thank you|Order confirmed/i;

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

// Epic 使用 Firefox，不能复用 Chromium 的 UA 与 Sec-CH-UA。
// 版本号从浏览器自身的 application.ini 读取，避免写死后与镜像里的 Firefox 版本脱节。
export const FIREFOX_VERSION = detectFirefoxVersion(firefox.executablePath());
const UA = buildFirefoxUserAgent(FIREFOX_VERSION);
if (!UA) {
  logger.log('🟡', '未能读取内置 Firefox 版本号，Epic 接口请求将不附带自定义 User-Agent');
}
const FIREFOX_HEADERS = {
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
};

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
    this.loginSlotOwner = null;
    this.loginTimer = null;
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
    // 演示模式下自动补齐示例账号，方便本地预览
    this.seedDemoData();
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
    this.updateState({
      status: 'stopping',
      progress: this.state.progress || 0,
      code: 'stopped',
      lastAction: '正在停止 Epic 任务并释放浏览器资源...'
    });
    logger.log('🛑', '收到手动停止指令，正在关闭 Epic 浏览器并释放资源');
    if (this.activeContext) {
      await this.activeContext.close().catch(() => {});
    }
    await this.closeLoginWindow().catch(() => {});
    return { stopped: true, message: '停止指令已发送，浏览器资源即将释放' };
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
      const loginProfile = `${epicProfilePath(accountId)}-login`;
      fs.rmSync(loginProfile, { recursive: true, force: true });
      launched = await this.launchPersistentContext(acc, {
        cleanSession: true,
        profileDir: loginProfile
      });
    } catch (e) {
      firefoxSlotLock.release(slotOwner);
      throw e;
    }
    this.loginContext = launched.context;
    this.loginAccountId = accountId;
    this.loginSlotOwner = slotOwner;
    this.scheduleLoginWindowTimeout();
    this.updateState({
      status: 'login_window',
      progress: 0,
      accountName: acc.name,
      lastAction: `已打开 Epic 登录窗口，请在可见浏览器中完成登录`
    });
    const loginUrl = 'https://www.epicgames.com/id/login?lang=zh-CN&noHostRedirect=true&redirectUrl=' + encodeURIComponent(`${STORE_BASE}/free-games`);
    await launched.page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
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
    const context = this.loginContext;
    const page = context.pages()[0] || await context.newPage();
    const detected = await this.detectLoginCompleted(page);
    if (!detected.ok) {
      return { saved: false, reason: detected.reason, message: detected.message };
    }

    const storageState = await context.storageState();
    configManager.updateEpicAccount(accountId, {
      storageState,
      sessionValid: true,
      lastVerifyAt: Date.now(),
      lastVerifyMessage: '通过可见浏览器登录并保存',
      lastSessionImportAt: Date.now()
    });
    await this.closeLoginWindow();
    return { saved: true, cookieCount: storageState.cookies?.length || 0, message: '登录凭据已保存到内置 Firefox profile' };
  }

  /**
   * 登录完成判定：先读商店导航的登录态属性，读不到再复用页面状态识别。
   * 与人机验证一样，识别不出来时宁可提示用户重试，也不要把未登录状态当成已登录保存。
   */
  async detectLoginCompleted(page) {
    const nav = page.locator('egs-navigation').first();
    if (await nav.getAttribute('isloggedin', { timeout: 5000 }).catch(() => null) === 'true') {
      return { ok: true };
    }
    await page.goto(`${STORE_BASE}/free-games`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    if (await nav.getAttribute('isloggedin', { timeout: 8000 }).catch(() => null) === 'true') {
      return { ok: true };
    }

    const state = await this.detectPageState(page);
    if (state.state === 'login') {
      return { ok: false, reason: 'not-logged-in', message: '尚未检测到 Epic 登录完成，请在可见浏览器中完成登录后再保存' };
    }
    if (state.state === 'challenge') {
      return { ok: false, reason: 'challenge', message: '商店正在人机验证，暂时无法确认登录状态，请稍后重试' };
    }
    return { ok: true };
  }

  async closeLoginWindow() {
    this.clearLoginWindowTimeout();
    if (this.loginContext) {
      await this.loginContext.close().catch(() => {});
    }
    this.loginContext = null;
    this.loginAccountId = null;
    if (this.loginSlotOwner) {
      firefoxSlotLock.release(this.loginSlotOwner);
      this.loginSlotOwner = null;
    }
    return { closed: true };
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
        { cleanSession: true, profileDir: tmpProfile }
      );
      context = launched.context;
      const page = launched.page;
      // 用 about:blank 即可：这些信号与页面无关，不打扰 Epic，也避免触发风控计数
      await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
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
        warnings: evaluateFirefoxFingerprint(signals),
        firefoxVersion: FIREFOX_VERSION
      };
    } finally {
      if (context) await context.close().catch(() => {});
      fs.rmSync(tmpProfile, { recursive: true, force: true });
      firefoxSlotLock.release(slotOwner);
    }
  }

  getBrowserProxy() {
    const cfg = configManager.get();
    if (!cfg.network?.useProxy || !cfg.network?.proxyUrl) return null;
    return { server: String(cfg.network.proxyUrl).trim() };
  }

  /**
   * 启动 Firefox 持久化上下文。
   *
   * @param {object} acc 账号
   * @param {object} [opts]
   * @param {boolean} [opts.cleanSession] 不注入账号里已保存的 storageState。
   *   登录流程必须用干净会话：拿一个多半已失效的旧凭据去登录，
   *   会让登录请求带着互相矛盾的会话，Epic 官方排障也是建议清空站点数据后重登。
   * @param {string} [opts.profileDir] 覆盖 profile 目录（登录窗口用独立的临时目录）
   */
  async launchPersistentContext(acc, { cleanSession = false, profileDir = null } = {}) {
    const dir = profileDir || epicProfilePath(acc.id);
    fs.mkdirSync(dir, { recursive: true });
    const proxy = this.getBrowserProxy();
    const headless = process.env.EPIC_VISIBLE !== '1';
    const context = await firefox.launchPersistentContext(dir, {
      headless,
      viewport: { width: 1366, height: 768 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      extraHTTPHeaders: FIREFOX_HEADERS,
      ...(cleanSession ? {} : {
        storageState: {
          cookies: acc.storageState?.cookies || [],
          origins: acc.storageState?.origins || []
        }
      }),
      ...(proxy ? { proxy } : {})
    });

    // 配置里的会话是登录凭据的唯一来源；持久化 profile 负责保留 CF 信任 Cookie。
    if (!cleanSession) {
      const cookies = acc.storageState?.cookies || [];
      if (cookies.length > 0) {
        await context.addCookies(cookies).catch(() => {});
      }
    }
    await applyFirefoxStealth(context);

    const page = context.pages()[0] || await context.newPage();
    await page.setViewportSize({ width: 1366, height: 768 }).catch(() => {});
    return { context, page };
  }

  async readPageText(page) {
    const parts = [];
    const frames = page.frames();
    for (const frame of frames.slice(0, 20)) {
      try {
        const text = await frame.locator('body').innerText({ timeout: 800 });
        if (text) parts.push(text);
      } catch {}
    }
    return parts.join('\n');
  }

  async detectPageState(page) {
    const title = await page.title().catch(() => '');
    const text = await this.readPageText(page);
    const combined = `${title}\n${text}`;

    if (isEpicChallengeText(combined)) return { state: 'challenge', text: combined };

    for (const frame of page.frames().slice(0, 20)) {
      const owned = await frame.locator('text=已在库中').count().catch(() => 0);
      if (owned > 0) return { state: 'owned', text: combined };

      const getBtn = frame.getByRole('button', { name: /^获取$|^Get$/ }).first();
      if (await getBtn.count().catch(() => 0) > 0 && await getBtn.isVisible().catch(() => false)) {
        return { state: 'product', text: combined };
      }

      const loginEntry = frame.getByRole('link', { name: /登录|Sign in|Log in/ }).first();
      if (await loginEntry.count().catch(() => 0) > 0 && await loginEntry.isVisible().catch(() => false)) {
        return { state: 'login', text: combined };
      }
    }

    if (isEpicLoginText(combined)) return { state: 'login', text: combined };
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
    this.throwIfStopped();
    const result = await this.waitForPageState(page, ['product', 'challenge', 'login', 'owned'], timeout);
    return { ...result, navigationError };
  }

  async dismissChallengeOverlay(page) {
    const initial = await this.detectPageState(page);
    if (initial.state !== 'challenge') return initial;

    this.updateState({
      status: 'challenge',
      progress: 45,
      code: 'challenge',
      lastAction: '检测到 Epic 人机验证，等待验证层自动通过...'
    });

    let state = await this.waitForPageState(page, ['product', 'owned', 'login'], 8000);
    if (state.state !== 'challenge' && state.state !== 'unknown') return state;

    // Epic 的验证层有时是覆盖在结账界面上的 UI 层。ESC 是用户实测有效的兜底路径，
    // 但只在仍处于挑战状态时尝试一次，避免影响正常页面。
    this.updateState({ lastAction: '验证层仍未消失，尝试关闭覆盖层后继续...' });
    await page.keyboard.press('Escape').catch(() => {});
    state = await this.waitForPageState(page, ['product', 'owned', 'login'], 12000);
    return state;
  }

  getState() {
    return {
      running: this.running,
      verifying: this.verifying,
      stopRequested: this.stopRequested,
      engine: 'firefox',
      visible: process.env.EPIC_VISIBLE === '1',
      novncPort: Number(process.env.NOVNC_PORT || 6080),
      loginWindow: {
        open: !!this.loginContext,
        accountId: this.loginAccountId
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
    for (const part of text.split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const name = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!name) continue;
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
    // 与浏览器保持同一个身份：UA 由内置 Firefox 的真实版本拼出，读不到就不发。
    const headers = { 'accept': 'application/json' };
    if (UA) headers['user-agent'] = UA;
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
      for (const frame of page.frames().slice(0, 20)) {
        try {
          texts.push(...await frame.locator('button').allInnerTexts());
        } catch {}
      }
      return [...new Set(texts.map(t => String(t).trim()).filter(Boolean))].slice(0, 16).join(' / ');
    } catch {
      return '(读取失败)';
    }
  }

  /** 是否演示模式（不启动浏览器，仅模拟流程，用于本地验证） */
  isDemo() {
    return process.env.EPIC_DEMO === '1';
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

      if (pageState.state === 'challenge' || pageState.state === 'unknown') {
        result.status = 'blocked';
        result.code = 'challenge';
        result.message = `商店人机验证未通过（当前按钮：${await this.visibleButtonTexts(page)}）`;
        return result;
      }

      if (pageState.state === 'login') {
        result.code = 'auth_expired';
        result.authValid = false;
        result.message = 'Epic 登录态已失效，请重新导入会话';
        return result;
      }

      // 已在库中：本次无需领取
      if (pageState.state === 'owned' || await page.locator('text=已在库中').count() > 0) {
        result.ok = true;
        result.status = 'owned';
        result.code = 'owned';
        result.authValid = true;
        result.message = '已在库中';
        return result;
      }

      this.updateState({ status: 'clicking', progress: 55, lastAction: `点击「获取」...` });
      const exactGet = page.getByRole('button', { name: /^获取$|^Get$/ }).first();
      const getBtn = (await exactGet.count()) > 0
        ? exactGet
        : page.getByRole('button', { name: /获取|Get/ }).first();

      if ((await getBtn.count()) === 0) {
        result.code = 'no_get_button';
        result.message = `未找到「获取」按钮（当前按钮：${await this.visibleButtonTexts(page)}）`;
        return result;
      }
      const pageCountBeforeClick = context ? context.pages().length : 1;
      await getBtn.click({ timeout: 10000, noWaitAfter: true });
      await this.delay(2000);

      if (context) {
        const pages = context.pages();
        if (pages.length > pageCountBeforeClick) {
          page = pages[pages.length - 1];
          await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        }
      }

      this.updateState({ status: 'ordering', progress: 70, lastAction: `等待结账窗口...` });
      const orderBtn = page.getByRole('button', { name: EPIC_ORDER_BUTTON_RE }).first();
      const checkoutDeadline = Date.now() + 25000;
      const checkoutStartedAt = Date.now();
      let checkoutReady = false;
      let escapeTried = false;
      while (Date.now() < checkoutDeadline) {
        this.throwIfStopped();
        const successCount = await page.getByText(EPIC_SUCCESS_TEXT_RE).count().catch(() => 0);
        if (successCount > 0) {
          result.ok = true;
          result.status = 'claimed';
          result.code = 'claimed';
          result.authValid = true;
          result.message = '领取成功';
          return result;
        }
        if (await page.locator('text=已在库中').count().catch(() => 0) > 0) {
          result.ok = true;
          result.status = 'owned';
          result.code = 'owned';
          result.authValid = true;
          result.message = '已在库中';
          return result;
        }

        const current = await this.detectPageState(page);
        if (current.state === 'challenge') {
          const resolved = await this.dismissChallengeOverlay(page);
          if (resolved.state === 'challenge' || resolved.state === 'unknown') {
            result.status = 'blocked';
            result.code = 'challenge';
            result.message = `结账前人机验证未通过（当前按钮：${await this.visibleButtonTexts(page)}）`;
            return result;
          }
        }

        if (await orderBtn.count().catch(() => 0) > 0 && await orderBtn.isVisible().catch(() => false)) {
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
        result.code = 'no_order_button';
        result.message = `未出现下单按钮（当前按钮：${await this.visibleButtonTexts(page)}）`;
        return result;
      }

      // 部分游戏需要勾选 EULA 才能下单
      try {
        const checkbox = page.locator('input[type="checkbox"]').first();
        if (await checkbox.count() > 0) {
          const checked = await checkbox.isChecked().catch(() => true);
          if (!checked) await checkbox.check({ timeout: 3000 }).catch(() => {});
        }
      } catch {}

      this.updateState({ status: 'ordering', progress: 82, lastAction: `确认订单...` });
      await orderBtn.click({ timeout: 10000, noWaitAfter: true });
      await this.delay(5000);

      const successText = await page.getByText(EPIC_SUCCESS_TEXT_RE).count();
      if (successText > 0) {
        result.ok = true;
        result.status = 'claimed';
        result.code = 'claimed';
        result.authValid = true;
        result.message = '领取成功';
      } else if (await page.locator('text=已在库中').count() > 0) {
        result.ok = true;
        result.status = 'owned';
        result.code = 'owned';
        result.authValid = true;
        result.message = '已在库中';
      } else {
        result.code = 'order_unconfirmed';
        result.message = `已点击下单，未识别到成功提示（当前按钮：${await this.visibleButtonTexts(page)}）`;
      }
      return result;
    } catch (e) {
      result.code = 'exception';
      result.message = `领取异常: ${e.message}`;
      return result;
    }
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
      const launched = await this.launchPersistentContext(acc);
      context = launched.context;
      this.activeContext = context;
      this.activeAccountId = accountId;
      const page = launched.page;
      let pageState = await this.navigateEpicPage(page, STORE_HOME, 20000);
      if (pageState.state === 'challenge') {
        pageState = await this.dismissChallengeOverlay(page);
      }

      let valid = null;
      let blocked = false;
      let message = '';
      if (pageState.state === 'challenge') {
        blocked = true;
        message = '商店人机验证未通过，暂时无法判断会话是否有效';
      } else if (pageState.state === 'login') {
        valid = false;
        message = '未登录或会话已失效，请重新导入 Cookie';
      } else {
        valid = true;
        message = '会话有效（已登录）';
      }

      const patch = {
        lastVerifyAt: Date.now(),
        lastVerifyMessage: message,
        storageState: await context.storageState()
      };
      if (valid !== null) patch.sessionValid = valid;
      configManager.updateEpicAccount(accountId, patch);
      this.updateState({ status: 'done', progress: 100, lastAction: message });
      return { valid, blocked, message };
    } finally {
      this.verifying = false;
      if (this.activeContext === context) {
        this.activeContext = null;
        this.activeAccountId = null;
      }
      this.stopRequested = false;
      if (context) await context.close().catch(() => {});
      firefoxSlotLock.release(slotOwner);
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
        const launched = await this.launchPersistentContext(acc);
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
      if (context) await context.close().catch(() => {});
      if (this.activeContext === context) {
        this.activeContext = null;
        this.activeAccountId = null;
      }
      if (slotHeld && slotOwner) firefoxSlotLock.release(slotOwner);
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
