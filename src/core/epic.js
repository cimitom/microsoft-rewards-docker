import { chromium } from 'playwright-core';
import configManager from '../config.js';
import logger from '../logger.js';
import networkClient from '../network.js';
import browserManager from './browser.js';
import { browserSlotLock } from './contextLock.js';

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
    this.checking = false;
    this.runningAccountId = null;
    this.lastRun = null; // { startedAt, finishedAt, results: [] }
    this.lastCheckAt = 0;
    // 无头浏览器实时状态（供前端展示当前跑到哪一步）
    this.state = {
      status: 'idle', // idle | checking | navigating | clicking | ordering | waiting | retrying | done
      accountName: '',
      gameTitle: '',
      attempt: 0,
      maxAttempts: 0,
      lastAction: '空闲中',
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

  getState() {
    return {
      running: this.running,
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
      checkIntervalMin: clamp(e.checkIntervalMin, 5, 1440, 30),
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
    let games = [];
    try {
      games = await this.fetchFreeGamesFromApi();
    } catch (e) {
      if (!this.isDemo()) throw e;
      logger.log('🟡', `Epic 免费游戏接口异常（演示模式继续）: ${e.message}`);
    }
    if (this.isDemo()) {
      const demo = this.demoGames();
      const existing = new Set(games.map(g => g.id));
      games = [...games, ...demo.filter(g => !existing.has(g.id))];
    }
    return games;
  }

  async fetchFreeGamesFromApi() {
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
    const end = new Date(Date.now() + 3 * 86400000).toISOString();
    return [
      { id: 'demo_game_1', title: '星海远征', slug: 'demo-star-voyage', url: 'https://store.epicgames.com/zh-CN/p/demo-star-voyage', endDate: end, image: null },
      { id: 'demo_game_2', title: '像素工坊', slug: 'demo-pixel-workshop', url: 'https://store.epicgames.com/zh-CN/p/demo-pixel-workshop', endDate: end, image: null },
      { id: 'demo_game_3', title: '暗影回廊', slug: 'demo-shadow-corridor', url: 'https://store.epicgames.com/zh-CN/p/demo-shadow-corridor', endDate: end, image: null },
      { id: 'demo_game_4', title: 'Rusty Rally', slug: 'demo-rusty-rally', url: 'https://store.epicgames.com/zh-CN/p/demo-rusty-rally', endDate: end, image: null }
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
  async claimSingle(page, game) {
    const result = { id: game.id, title: game.title, url: game.url, ok: false, status: 'failed', message: '' };
    if (this.isDemo()) return this.simulateClaim(game);
    if (!game.url) {
      result.status = 'skipped';
      result.message = '暂无可领取页面（可能是未揭晓的神秘游戏）';
      return result;
    }

    try {
      this.updateState({ status: 'navigating', gameTitle: game.title, lastAction: `打开「${game.title}」商品页...` });
      await page.goto(game.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await this.delay(3000);
      await this.dismissOverlays(page);

      // 已在库中：本次无需领取
      if (await page.locator('text=已在库中').count() > 0) {
        result.ok = true;
        result.status = 'owned';
        result.message = '已在库中';
        return result;
      }

      this.updateState({ status: 'clicking', lastAction: `点击「获取」...` });
      const exactGet = page.getByRole('button', { name: /^获取$|^Get$/ }).first();
      const getBtn = (await exactGet.count()) > 0
        ? exactGet
        : page.getByRole('button', { name: /获取|Get/ }).first();

      if ((await getBtn.count()) === 0) {
        result.message = `未找到「获取」按钮（当前按钮：${await this.visibleButtonTexts(page)}）`;
        return result;
      }
      await getBtn.click({ timeout: 10000 });
      await this.delay(2000);
      await this.dismissOverlays(page);

      this.updateState({ status: 'ordering', lastAction: `确认订单...` });
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

      const successText = await page.locator('text=/谢谢|感谢|订单已提交|Thanks|Thank you|Order confirmed/').count();
      if (successText > 0) {
        result.ok = true;
        result.status = 'claimed';
        result.message = '领取成功';
      } else if (await page.locator('text=已在库中').count() > 0) {
        result.ok = true;
        result.status = 'owned';
        result.message = '已在库中';
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

    const execPath = browserManager.getExecutablePath();
    if (!execPath) throw new Error('未检测到 Chromium 内核');

    // 与积分任务的搜索流程共用浏览器资源锁，避免两个 Chromium 同时占内存
    const gotSlot = await browserSlotLock.acquire('epic-browser', 180000);
    if (!gotSlot) throw new Error('浏览器资源正被积分任务占用，请稍后再试');
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
      browserSlotLock.release('epic-browser');
    }
  }

  /**
   * 为单个账号领取免费游戏。
   * 只处理「本次促销期内尚未领取成功」的游戏；失败按设置重试，仍失败则留给下一轮检查。
   */
  async claimForAccount(accountId, prefetchedGames = null) {
    const acc = configManager.findEpicAccount(accountId);
    if (!acc) throw new Error('Epic 账号不存在');
    if (!acc.storageState?.cookies?.length) throw new Error('该账号尚未导入会话，请先导入 Cookie');

    const settings = this.getSettings();
    const demo = this.isDemo();
    const execPath = browserManager.getExecutablePath();
    if (!demo && !execPath) throw new Error('未检测到 Chromium 内核，无法执行领取');

    const allGames = prefetchedGames || await this.fetchFreeGames();
    const handled = acc.handledGames || {};
    const pending = allGames.filter(g => !['claimed', 'owned'].includes(handled[g.id]?.status));
    logger.log('🎮', `发现 ${allGames.length} 个免费游戏，其中 ${pending.length} 个待处理`, '', acc.name);

    if (pending.length === 0) {
      this.updateState({ status: 'idle', lastAction: '没有需要领取的游戏' });
      return { games: allGames, results: [], pending: 0 };
    }

    let browser = null;
    let context = null;
    let page = null;
    const results = [];
    let slotHeld = false;

    try {
      if (!demo) {
        // 与积分任务的搜索流程共用浏览器资源锁，避免两个 Chromium 同时占内存
        const gotSlot = await browserSlotLock.acquire('epic-browser', 180000);
        if (!gotSlot) throw new Error('浏览器资源正被积分任务占用，请稍后再试');
        slotHeld = true;
        browser = await chromium.launch({
          executablePath: execPath,
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled']
        });
        context = await browser.newContext({
          storageState: { cookies: acc.storageState.cookies, origins: acc.storageState.origins || [] },
          locale: 'zh-CN',
          timezoneId: 'Asia/Shanghai',
          userAgent: UA,
          viewport: { width: 1366, height: 768 }
        });
        await context.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        page = await context.newPage();
      }

      const maxAttempts = settings.retryCount + 1;
      for (const game of pending) {
        let final = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          this.updateState({ attempt, maxAttempts, gameTitle: game.title });
          const r = await this.claimSingle(page, game);
          final = r;
          if (r.status !== 'failed') break;
          if (attempt < maxAttempts) {
            this.updateState({ status: 'retrying', lastAction: `「${game.title}」第 ${attempt} 次失败，${settings.retryIntervalSec} 秒后重试...` });
            logger.log('🟡', `「${game.title}」第 ${attempt}/${maxAttempts} 次失败：${r.message}`, '', acc.name);
            await this.delay(settings.retryIntervalSec * 1000);
          }
        }
        results.push(final);
        const icon = final.status === 'failed' ? '🔴' : (final.status === 'owned' ? '🟡' : '✅');
        logger.log(icon, `${game.title}：${final.message}`, '', acc.name);
        await this.delay(1500 + Math.floor(Math.random() * 2000));
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
      const patch = {
        handledGames: pruned,
        lastClaimAt: Date.now(),
        lastClaimMessage: `本次领取 ${claimedCount} 个 / 已有 ${ownedCount} 个 / 失败 ${failedCount} 个`
      };
      if (!demo && context) {
        patch.storageState = await context.storageState();
        patch.sessionValid = true;
      }
      configManager.updateEpicAccount(accountId, patch);
    } finally {
      if (browser) await browser.close().catch(() => {});
      if (slotHeld) browserSlotLock.release('epic-browser');
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
    if (this.running || this.checking) throw new Error('Epic 任务正在运行中，请稍后再试');
    return this.runClaimAll();
  }

  /** 实际执行全部账号领取（供定时检查内部调用，不再重复做并发判断） */
  async runClaimAll() {
    this.running = true;
    const startedAt = Date.now();
    const allResults = [];
    const settings = this.getSettings();
    this.updateState({ status: 'checking', startedAt, accountName: '', gameTitle: '', lastAction: '开始检查免费游戏...' });

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
        this.updateState({ accountName: acc.name, status: 'checking', lastAction: `开始处理账号「${acc.name}」` });

        const handled = acc.handledGames || {};
        const pending = allGames.filter(g => !['claimed', 'owned'].includes(handled[g.id]?.status));
        if (pending.length === 0) {
          allResults.push({ accountId: acc.id, accountName: acc.name, results: [] });
          continue;
        }

        try {
          const { results } = await this.claimForAccount(acc.id, allGames);
          allResults.push({ accountId: acc.id, accountName: acc.name, results });
        } catch (e) {
          logger.log('🔴', `Epic 账号 [${acc.name}] 领取失败: ${e.message}`, '', acc.name);
          configManager.updateEpicAccount(acc.id, { sessionValid: false, lastVerifyMessage: e.message });
          allResults.push({ accountId: acc.id, accountName: acc.name, error: e.message, results: [] });
        }
        // 不同账号之间的操作间隔（全局设置）
        if (i < accounts.length - 1) {
          this.updateState({ status: 'waiting', lastAction: `等待 ${settings.accountGapSec} 秒后切换下一个账号...` });
          await this.delay(settings.accountGapSec * 1000);
        }
      }

      this.lastRun = { startedAt, finishedAt: Date.now(), results: allResults };
      this.updateState({ status: 'done', lastAction: '本轮领取完成' });
      return { accounts: accounts.map(a => ({ id: a.id, name: a.name })), results: allResults };
    } finally {
      this.running = false;
      this.runningAccountId = null;
      this.lastCheckAt = Date.now();
    }
  }

  /** 为单个账号领取（带运行状态保护） */
  async claimOne(accountId) {
    if (this.running || this.checking) throw new Error('Epic 任务正在运行中，请稍后再试');
    this.running = true;
    this.runningAccountId = accountId;
    const startedAt = Date.now();
    const acc = configManager.findEpicAccount(accountId);
    this.updateState({ status: 'checking', startedAt, accountName: acc?.name || '', lastAction: '开始检查免费游戏...' });
    try {
      const { games, results } = await this.claimForAccount(accountId);
      this.lastRun = { startedAt, finishedAt: Date.now(), results: [{ accountId, results }] };
      this.updateState({ status: 'done', lastAction: '本轮领取完成' });
      return { games, results };
    } finally {
      this.running = false;
      this.runningAccountId = null;
      this.lastCheckAt = Date.now();
    }
  }

  /**
   * 定时检查：先做一次轻量接口请求，只有发现「某个启用账号还有未处理的免费游戏」才真正触发领取。
   */
  async checkAndClaimIfNeeded() {
    // 防止「定时检查」与「手动领取」互相踩踏
    if (this.running || this.checking) return { skipped: 'busy' };
    const settings = this.getSettings();
    if (!settings.enabled) return { skipped: 'disabled' };

    const accounts = configManager.getEpicAccounts().filter(a => a.enabled !== false && a.storageState?.cookies?.length);
    if (accounts.length === 0) return { skipped: 'no-account' };

    this.checking = true;
    try {
      this.updateState({ status: 'checking', lastAction: '正在检查是否有新的免费游戏...' });
      const games = await this.fetchFreeGames();
      if (games.length === 0) {
        this.lastCheckAt = Date.now();
        this.updateState({ status: 'idle', lastAction: '当前没有免费游戏' });
        return { games: 0, claimed: false };
      }

      const needClaim = accounts.some(acc => {
        const handled = acc.handledGames || {};
        return games.some(g => !['claimed', 'owned'].includes(handled[g.id]?.status));
      });

      if (!needClaim) {
        this.lastCheckAt = Date.now();
        this.updateState({ status: 'idle', lastAction: '所有免费游戏都已处理过' });
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
