import { chromium } from 'playwright-core';
import configManager from '../config.js';
import logger from '../logger.js';
import networkClient from '../network.js';
import browserManager from './browser.js';

// Epic 官方商城静态接口：返回当前在售商品及促销信息（含每周免费游戏）
const FREE_GAMES_API = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN';
const STORE_BASE = 'https://store.epicgames.com/zh-CN';
const STORE_HOME = `${STORE_BASE}/`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

/**
 * Epic 免费游戏自动领取。
 * 列表走官方静态接口（稳定），领取走 Playwright 驱动网页（用户提供已登录会话）。
 */
export class EpicManager {
  constructor() {
    this.running = false;
    this.runningAccountId = null;
    this.lastRun = null; // { startedAt, finishedAt, results: [] }
  }

  delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  getState() {
    return {
      running: this.running,
      runningAccountId: this.runningAccountId,
      lastRun: this.lastRun
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

  /** 从 Epic 官方静态接口读取当前可领取的免费游戏 */
  async fetchFreeGames() {
    const res = await networkClient.request({
      url: FREE_GAMES_API,
      headers: { 'user-agent': UA, 'accept': 'application/json' },
      timeout: 20000
    });
    const data = typeof res === 'string' ? JSON.parse(res) : res;
    const elements = data?.data?.Catalog?.searchStore?.elements || [];
    const now = Date.now();
    const games = [];

    for (const el of elements) {
      const offerGroups = el.promotions?.promotionalOffers || [];
      const current = offerGroups
        .flatMap(g => g?.promotionalOffers || [])
        .find(o => {
          if (!o) return false;
          const pct = o.discountSetting?.discountPercentage;
          const start = Date.parse(o.startDate);
          const end = Date.parse(o.endDate);
          return Number(pct) === 0 && start <= now && now < end;
        });
      if (!current) continue;

      // 注意：urlSlug 是十六进制 id，不能直接当页面 slug 用（会 404）。
      // 正确的商城页面地址在 catalogNs.mappings / offerMappings 的 pageSlug 里。
      const rawSlug = el.productSlug
        || el.catalogNs?.mappings?.find(m => m?.pageSlug)?.pageSlug
        || el.offerMappings?.find(m => m?.pageSlug)?.pageSlug
        || el.urlSlug
        || '';
      const slug = String(rawSlug).replace(/\/home$/i, '').replace(/^\//, '');
      games.push({
        id: el.id,
        title: el.title || '未知游戏',
        slug,
        url: slug ? `${STORE_BASE}/p/${slug}` : null,
        endDate: current.endDate,
        image: el.keyImages?.find(i => i.type === 'OfferImageWide' || i.type === 'Thumbnail')?.url || null
      });
    }
    return games;
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
      const texts = await page.locator('button').allInnerTexts();
      return [...new Set(texts.map(t => String(t).trim()).filter(Boolean))].slice(0, 12).join(' / ');
    } catch {
      return '(读取失败)';
    }
  }

  /** 领取单个游戏 */
  async claimSingle(page, game) {
    const result = { id: game.id, title: game.title, url: game.url, ok: false, message: '' };
    if (!game.url) {
      result.message = '暂无可领取页面（可能是未揭晓的神秘游戏）';
      return result;
    }

    try {
      await page.goto(game.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await this.delay(3000);
      await this.dismissOverlays(page);

      // 已在库中直接跳过
      if (await page.locator('text=已在库中').count() > 0) {
        result.ok = true;
        result.message = '已在库中，跳过';
        return result;
      }

      const getBtn = page.getByRole('button', { name: /^获取$|^获取$|^Get$|^Get$/ }).first();
      const getBtnLoose = (await getBtn.count()) > 0
        ? getBtn
        : page.getByRole('button', { name: /获取|Get/ }).first();

      if ((await getBtnLoose.count()) === 0) {
        result.message = `未找到「获取」按钮（当前按钮：${await this.visibleButtonTexts(page)}）`;
        return result;
      }
      await getBtnLoose.click({ timeout: 10000 });
      await this.delay(2000);
      await this.dismissOverlays(page);

      const orderBtn = page.getByRole('button', { name: /下订单|下单|确认订单|结账|Place Order|Checkout/ }).first();
      try {
        await orderBtn.waitFor({ timeout: 15000 });
      } catch {
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

      await orderBtn.click({ timeout: 10000 });
      await this.delay(5000);

      const successText = await page.locator('text=/谢谢|感谢|已在库中|订单已提交|Thanks|Thank you|Order confirmed/').count();
      if (successText > 0) {
        result.ok = true;
        result.message = '领取成功';
      } else {
        result.message = `已点击下单，未识别到成功提示（当前按钮：${await this.visibleButtonTexts(page)}）`;
      }
      return result;
    } catch (e) {
      result.message = `领取异常: ${e.message}`;
      return result;
    }
  }

  /** 校验会话是否仍然登录（打开商城首页，看是否出现「登录」入口） */
  async verifySession(accountId) {
    const acc = configManager.findEpicAccount(accountId);
    if (!acc) throw new Error('Epic 账号不存在');
    if (!acc.storageState?.cookies?.length) return { valid: false, message: '尚未导入会话' };

    const execPath = browserManager.getExecutablePath();
    if (!execPath) throw new Error('未检测到 Chromium 内核');

    const browser = await chromium.launch({ executablePath: execPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
      const context = await browser.newContext({
        storageState: { cookies: acc.storageState.cookies, origins: acc.storageState.origins || [] },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        userAgent: UA
      });
      const page = await context.newPage();
      await page.goto(STORE_HOME, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await this.delay(3000);
      await this.dismissOverlays(page);

      const loginEntry = page.getByRole('link', { name: /登录|Sign in|Log in/ }).first();
      const hasLogin = (await loginEntry.count()) > 0 && await loginEntry.isVisible().catch(() => false);
      const valid = !hasLogin;
      const message = valid ? '会话有效（已登录）' : '未登录或会话已失效，请重新导入 Cookie';

      configManager.updateEpicAccount(accountId, {
        sessionValid: valid,
        lastVerifyAt: Date.now(),
        lastVerifyMessage: message
      });
      return { valid, message };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  /** 为单个账号领取当前所有免费游戏 */
  async claimForAccount(accountId) {
    const acc = configManager.findEpicAccount(accountId);
    if (!acc) throw new Error('Epic 账号不存在');
    if (!acc.storageState?.cookies?.length) throw new Error('该账号尚未导入会话，请先导入 Cookie');

    const execPath = browserManager.getExecutablePath();
    if (!execPath) throw new Error('未检测到 Chromium 内核，无法执行领取');

    const games = await this.fetchFreeGames();
    logger.log('🎮', `账号 [${acc.name}] 发现 ${games.length} 个当前可领取的免费游戏`, '', acc.name);

    const browser = await chromium.launch({
      executablePath: execPath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled']
    });

    const results = [];
    try {
      const context = await browser.newContext({
        storageState: { cookies: acc.storageState.cookies, origins: acc.storageState.origins || [] },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        userAgent: UA,
        viewport: { width: 1366, height: 768 }
      });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      const page = await context.newPage();

      for (const game of games) {
        const r = await this.claimSingle(page, game);
        results.push(r);
        logger.log(r.ok ? '✅' : '🟡', `[${acc.name}] ${game.title}：${r.message}`, '', acc.name);
        await this.delay(2000 + Math.floor(Math.random() * 3000));
      }

      // Epic 会刷新部分 cookie，回收最新会话
      const newState = await context.storageState();
      configManager.updateEpicAccount(accountId, {
        storageState: newState,
        sessionValid: true,
        lastClaimAt: Date.now(),
        lastClaimMessage: results.map(r => `${r.title}: ${r.ok ? '成功' : r.message}`).join(' | ')
      });
    } finally {
      await browser.close().catch(() => {});
    }

    this.recordResults(accountId, results);
    return { games, results };
  }

  recordResults(accountId, results) {
    const records = results.map(r => ({
      accountId,
      title: r.title,
      url: r.url,
      ok: !!r.ok,
      message: r.message,
      at: Date.now()
    }));
    configManager.appendEpicClaimRecords(records);
  }

  /** 为全部启用的账号领取 */
  async claimAll() {
    if (this.running) throw new Error('Epic 领取任务正在运行中');
    this.running = true;
    const startedAt = Date.now();
    const allResults = [];

    try {
      const accounts = configManager.getEpicAccounts().filter(a => a.enabled !== false && a.storageState?.cookies?.length);
      if (accounts.length === 0) {
        logger.log('🟡', 'Epic：没有可执行的账号（未启用或未导入会话）');
        return { accounts: [], results: [] };
      }

      for (const acc of accounts) {
        this.runningAccountId = acc.id;
        try {
          const { results } = await this.claimForAccount(acc.id);
          allResults.push({ accountId: acc.id, accountName: acc.name, results });
        } catch (e) {
          logger.log('🔴', `Epic 账号 [${acc.name}] 领取失败: ${e.message}`, '', acc.name);
          configManager.updateEpicAccount(acc.id, { sessionValid: false, lastVerifyMessage: e.message });
          allResults.push({ accountId: acc.id, accountName: acc.name, error: e.message, results: [] });
        }
        await this.delay(3000 + Math.floor(Math.random() * 4000));
      }

      this.lastRun = { startedAt, finishedAt: Date.now(), results: allResults };
      return { accounts: accounts.map(a => ({ id: a.id, name: a.name })), results: allResults };
    } finally {
      this.running = false;
      this.runningAccountId = null;
    }
  }

  /** 为单个账号领取（带运行状态保护） */
  async claimOne(accountId) {
    if (this.running) throw new Error('Epic 领取任务正在运行中');
    this.running = true;
    this.runningAccountId = accountId;
    const startedAt = Date.now();
    try {
      const { games, results } = await this.claimForAccount(accountId);
      this.lastRun = { startedAt, finishedAt: Date.now(), results: [{ accountId, results }] };
      return { games, results };
    } finally {
      this.running = false;
      this.runningAccountId = null;
    }
  }
}

export const epicManager = new EpicManager();
export default epicManager;
