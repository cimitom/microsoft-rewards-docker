import fs from 'fs';
import { EventEmitter } from 'events';
// patchright-core 是 playwright-core 的补丁分支（API 完全一致），
// 它从协议层修掉了 Playwright 最容易被识别的自动化特征：
// CDP 的 Runtime.enable / Console.enable 泄漏、--enable-automation 启动参数、
// navigator.webdriver 等。--disable-blink-features=AutomationControlled 由它自动加上，
// 所以下面不再重复传这个参数。
import { chromium } from 'patchright-core';
import logger from '../logger.js';
import rewardsApi from './api.js';
import configManager from '../config.js';
import { browserSlotLock } from './contextLock.js';
import { readBrowserSession, writeBrowserSession } from './browserSession.js';
import { SearchStagnationGuard } from './searchStagnation.js';
import {
  PC_USER_AGENT,
  SEC_CH_UA,
  PLATFORM,
  CHROME_MAJOR,
  buildUserAgentMetadata
} from './fingerprint.js';

class BrowserManager extends EventEmitter {
  constructor() {
    super();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.shouldStop = false;
    // 是否持有浏览器资源锁（由 launchBrowser/closeBrowser 维护）
    this.slotHeld = false;
    // 当前绑定的账号（会话持久化需要它来定位文件与校验凭据指纹）
    this.sessionAccount = null;
    this.state = {
      status: 'idle', // 'idle' | 'starting' | 'navigating' | 'typing' | 'dwelling' | 'waiting' | 'stopped'
      activeAccountId: null,
      activeAccountName: '未启动',
      currentQuery: '',
      searchCount: 0,
      totalTarget: 0,
      nextSearchIn: 0,
      memoryMB: 0,
      lastAction: '浏览器当前处于空闲休眠状态 (0 内存占用)',
      lastUpdate: Date.now()
    };
  }

  getExecutablePath() {
    if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) {
      return process.env.CHROMIUM_PATH;
    }

    const candidatePaths = [
      // Linux (Debian/Ubuntu/Alpine)
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      // macOS
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      // Windows
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  updateState(partial) {
    Object.assign(this.state, partial);
    this.state.lastUpdate = Date.now();
    this.emit('status', this.state);
  }

  getStatus() {
    return this.state;
  }

  parseCookies(cookieStr, defaultDomain = '.bing.com') {
    if (!cookieStr || typeof cookieStr !== 'string') return [];
    const list = [];
    const parts = cookieStr.split(';');
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const name = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (name !== '_EDGE_S') {
          list.push({
            name,
            value,
            domain: defaultDomain,
            path: '/'
          });
        }
      }
    }
    return list;
  }

  async launchBrowser(acc) {
    const execPath = this.getExecutablePath();
    if (!execPath) {
      throw new Error('未检测到 Chromium 或 Edge 浏览器内核，请确保安装了 Chromium');
    }

    // 抢浏览器资源锁：Epic 领取也走同一把锁，避免两个 Chromium 同时跑把 NAS 内存打满
    const gotSlot = await browserSlotLock.acquire('rewards-browser', 180000);
    if (!gotSlot) {
      throw new Error('浏览器资源正被其它任务占用（Epic 领取或另一个搜索流程），请稍后重试');
    }
    this.slotHeld = true;

    this.updateState({
      status: 'starting',
      activeAccountId: acc?.id || 'acc_1',
      activeAccountName: acc?.name || '当前账号',
      memoryMB: 180,
      lastAction: '正在初始化无头浏览器 Chromium 引擎...'
    });

    let browser = null;
    try {
      browser = await chromium.launch({
        executablePath: execPath,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check'
        ]
      });

      // 镜像里的 Chromium 主版本如果和指纹常量脱节，这里提醒维护者同步，
      // 否则会重新出现「UA 版本 ≠ 真实引擎版本」的矛盾。
      const realMajor = String(browser.version() || '').split('.')[0];
      if (realMajor && realMajor !== CHROME_MAJOR) {
        logger.log('🟡', `镜像内 Chromium 主版本为 ${realMajor}，但指纹常量 CHROME_MAJOR=${CHROME_MAJOR}，建议同步更新 src/core/fingerprint.js`);
      }

      // 复用该账号上一轮的浏览器会话（Cookie + localStorage）。
      // 凭据换过账号时 readBrowserSession 会判定为过期并返回 null，自动回退到全新会话。
      const stored = readBrowserSession(acc);
      const storageState = stored?.storageState || null;
      if (stored?.stale) {
        logger.log('🟡', `已丢弃该账号的旧浏览器会话（${stored.reason}），本次使用全新会话`, '', acc?.name);
      } else if (storageState) {
        const savedDays = stored.savedAt
          ? ((Date.now() - stored.savedAt) / 86400000).toFixed(1)
          : '?';
        logger.log('🔐', `已复用该账号的浏览器会话（${storageState.cookies.length} 个 Cookie，保存于 ${savedDays} 天前）`, '', acc?.name);
      }

      const context = await browser.newContext({
        userAgent: PC_USER_AGENT,
        viewport: { width: 1366, height: 768 },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        // 浏览器一定会带的客户端提示；Playwright 的 userAgent 选项不会设置它们，
        // 不补的话 UA 说 Chrome/150 而 Sec-CH-UA 说真实版本，等于自相矛盾。
        extraHTTPHeaders: {
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'sec-ch-ua': SEC_CH_UA,
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': PLATFORM.clientHint
        },
        ...(storageState ? { storageState } : {})
      });

      // 说明：这里刻意不再用 Object.defineProperty(navigator, 'webdriver', ...) 去「抹平」webdriver。
      // 配合 --disable-blink-features=AutomationControlled，Chromium 原生就返回 false，
      // 而那段 init script 会在 navigator 实例上凭空造出一个自有属性 getter ——
      // 真实浏览器上没有这个自有属性，反而成了更明显的自动化特征。

      // 无 GPU 的无头环境里 WebGL 会暴露 SwiftShader（软件渲染），
      // 与「Windows 桌面 Chrome」的身份矛盾，这里改成常见的核显标识。
      await context.addInitScript(() => {
        const VENDOR = 'Google Inc. (Intel)';
        const RENDERER = 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)';
        const patch = (proto) => {
          if (!proto || !proto.getParameter) return;
          const orig = proto.getParameter;
          proto.getParameter = function (p) {
            if (p === 37445) return VENDOR;  // UNMASKED_VENDOR_WEBGL
            if (p === 37446) return RENDERER; // UNMASKED_RENDERER_WEBGL
            return orig.call(this, p);
          };
          proto.getParameter.toString = () => orig.toString();
        };
        try {
          patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
          patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
        } catch {}
      });

      // 注入当前账号的完整 Cookie
      if (acc?.cookie) {
        const cookies = this.parseCookies(acc.cookie, '.bing.com');
        const cnCookies = this.parseCookies(acc.cookie, 'cn.bing.com');
        await context.addCookies([...cookies, ...cnCookies]);
      }

      this.browser = browser;
      this.context = context;
      this.sessionAccount = acc || null;
      return { browser, context };
    } catch (e) {
      // 启动过程中失败也必须把锁还回去，否则后续所有浏览器任务都会被卡住
      if (browser) await browser.close().catch(() => {});
      this.releaseBrowserSlot();
      throw e;
    }
  }

  releaseBrowserSlot() {
    if (!this.slotHeld) return;
    this.slotHeld = false;
    browserSlotLock.release('rewards-browser');
  }

  /**
   * 新建页面并立即对齐指纹。
   *
   * Playwright 的 `newContext({ userAgent })` 只改 UA 头，不会改 Sec-CH-UA
   * 与 navigator.platform。这里用 CDP 的 setUserAgentOverride 把
   * UA / 客户端提示 / 平台一次性设成同一套身份（比在 JS 里覆写原型链更不易被识别，
   * 因为它保持原生实现，不留下 JS getter 特征）。
   */
  async createPage(context) {
    const page = await context.newPage();
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: PC_USER_AGENT,
        // 注意：CDP 的 acceptLanguage 是「语言列表」，不能带 q 权重，
        // 否则 navigator.languages 会变成 ["zh-CN","zh;q=0.9"] 这种畸形值。
        acceptLanguage: 'zh-CN,zh',
        platform: PLATFORM.navigator,
        userAgentMetadata: buildUserAgentMetadata()
      });
      // 保持会话引用，避免被回收后覆盖失效
      if (!this.cdpSessions) this.cdpSessions = [];
      this.cdpSessions.push(cdp);
    } catch (e) {
      // 指纹对齐失败不应该让整个任务挂掉，降级继续（只是可能留下版本不一致）
      logger.log('🟡', `浏览器指纹对齐失败，本次以默认指纹继续: ${e.message}`);
    }
    return page;
  }

  /**
   * 把当前浏览器状态（Cookie + localStorage）写回磁盘，供下次执行复用。
   *
   * 只在任务确实跑成功的路径上调用：失败路径写回会把半残的会话固化下来，
   * 反而让下一轮从一开始就处于坏状态。
   */
  async commitBrowserSession() {
    if (!this.context || !this.sessionAccount) return false;
    try {
      const state = await this.context.storageState();
      const cookieCount = Array.isArray(state?.cookies) ? state.cookies.length : 0;
      const ok = writeBrowserSession(this.sessionAccount, state);
      if (ok) {
        logger.log('💾', `浏览器会话已保存（${cookieCount} 个 Cookie），下次执行将复用`, '', this.sessionAccount.name);
      }
      return ok;
    } catch (e) {
      logger.log('🟡', `浏览器会话保存失败: ${e.message}`, '', this.sessionAccount?.name);
      return false;
    }
  }

  async closeBrowser() {
    try {
      if (this.context) await this.context.close().catch(() => {});
      if (this.browser) await this.browser.close().catch(() => {});
    } catch {}
    this.browser = null;
    this.context = null;
    this.page = null;
    this.cdpSessions = [];
    this.sessionAccount = null;
    this.releaseBrowserSlot();
    this.updateState({
      status: 'idle',
      activeAccountId: null,
      activeAccountName: '未启动',
      currentQuery: '',
      nextSearchIn: 0,
      memoryMB: 0,
      lastAction: '浏览器已彻底关闭，内存完全释放 (0 内存占用)'
    });
  }

  delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * 单次测试搜索 (仅搜 1 次，检验按键输入流与积分变化，完全安全无冷冻风险)
   */
  async singleTestSearch(acc) {
    const accName = acc?.name || '当前账号';
    logger.log('🔍', `启动无头浏览器执行「单次安全验证搜索」...`, '', accName);

    if (acc?.cookie && !acc.cookie.includes('_U=')) {
      logger.log('⚠️', `当前账号 [${accName}] 的 Cookie 中缺少关键标识 _U，必应搜索无法关联用户计分！请前往 cn.bing.com 登录后重新抓取完整 Cookie`, '', accName);
    }

    try {
      this.shouldStop = false;
      const { browser, context } = await this.launchBrowser(acc);
      const page = await this.createPage(context);
      this.page = page;

      this.updateState({
        status: 'navigating',
        lastAction: '正在访问微软必应首页 (cn.bing.com)...'
      });

      await page.goto('https://cn.bing.com', { waitUntil: 'domcontentloaded', timeout: 25000 });
      await this.delay(1500);

      const query = await rewardsApi.getHotSearchWord();
      this.updateState({
        status: 'typing',
        currentQuery: query,
        searchCount: 1,
        totalTarget: 1,
        lastAction: `正在模拟真人键盘打字键入: "${query}"...`
      });

      logger.log('⌨️', `拟人键盘打字检索: "${query}"`, '', accName);

      const searchInputSelector = '#sb_form_q';
      await page.waitForSelector(searchInputSelector, { timeout: 10000 });
      await page.click(searchInputSelector);
      await this.delay(300);

      // 模拟人类真实打字延迟 (每个字符 60~120ms)
      for (const char of query) {
        await page.type(searchInputSelector, char, { delay: rewardsApi.randomRange(60, 120) });
      }
      await this.delay(500);

      // 模拟回车提交搜索
      this.updateState({
        status: 'dwelling',
        lastAction: `按下 Enter 提交搜索，等待搜索结果渲染...`
      });
      await page.keyboard.press('Enter');

      // 等待搜索结果页面渲染
      await page.waitForTimeout(3500);

      // 模拟鼠标滚轮向下浏览
      this.updateState({
        lastAction: `模拟鼠标滚轮向下浏览搜索结果...`
      });
      await page.mouse.wheel(0, rewardsApi.randomRange(300, 700));
      await this.delay(3000);

      logger.log('✅', `单次搜索完成，正在验证积分与配额...`, '', accName);
      await this.commitBrowserSession();
      await this.closeBrowser();

      return {
        success: true,
        query,
        message: `单次搜索已成功完成！检索词: "${query}"`
      };
    } catch (e) {
      logger.log('🔴', `单次测试搜索失败: ${e.message}`, '', accName);
      await this.closeBrowser();
      throw e;
    }
  }

  /**
   * 平缓拉长模式：按全局「搜索节奏」设置（基础间隔 ± 随机浮动）完成 PC 搜索。
   * 执行窗口硬性限制为 3 小时（对应 4 小时时段抛去首小时随机启动）。
   */
  async runPacedSearch(acc, neededPoints, options = {}) {
    const accName = acc?.name || '当前账号';
    const { onProgress = null, probeProgress = null, stagnantLimit = 10 } = options;
    const totalSearches = Math.max(1, Math.min(Math.ceil(neededPoints / 3), 20));

    // 停滞保护：连续 N 次搜索官网进度都不涨，说明搜索额度已到顶或账号正在被限流，
    // 继续搜只会白白增加风控暴露面。达到阈值就主动停手，把本轮当部分完成收尾。
    const stagnation = new SearchStagnationGuard(stagnantLimit);

    // 全局搜索节奏（配置中心「任务与防风控」→ 搜索节奏设置）
    const cfg = configManager.get();
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    // 安全下限：基础间隔 ≥ 60 秒、随机浮动 ≥ 30 秒，避免过于密集触发风控
    const wantedIntervalSec = clamp(Number(cfg.tasks?.searchIntervalSec ?? 180) || 180, 60, 900);
    const jitterSec = clamp(Number(cfg.tasks?.searchJitterSec ?? 30) || 30, 30, 300);
    // 3 小时硬上限：任何情况下 次数 × (间隔 + 浮动) 不得超过 10800 秒
    const MAX_WINDOW_SEC = 3 * 3600;
    const perSearchBudget = Math.floor(MAX_WINDOW_SEC / totalSearches);
    const intervalSec = Math.max(60, Math.min(wantedIntervalSec, perSearchBudget - jitterSec));
    // 随机浮动为「只延后」的叠加模型：单次实际等待 = 基础间隔 + 0~浮动 秒
    const estimatedSec = totalSearches * (intervalSec + Math.floor(jitterSec / 2));
    const worstSec = totalSearches * (intervalSec + jitterSec);
    if (intervalSec < wantedIntervalSec) {
      logger.log('⚠️', `为保证 ${totalSearches} 次搜索在 3 小时内完成，本次间隔已自动压缩为 ${intervalSec} 秒 + 0~${jitterSec} 秒浮动`, '', accName);
    }

    if (acc?.cookie && !acc.cookie.includes('_U=')) {
      logger.log('⚠️', `当前账号 [${accName}] 的 Cookie 中缺少关键标识 _U，必应搜索无法关联用户计分！请在配置中心更新包含 _U 的完整 Cookie`, '', accName);
    }

    logger.log('🖥️', `启动 Playwright 拟人真机搜索：需补足 ${neededPoints} 分 → ${totalSearches} 次搜索，间隔 ${intervalSec} 秒 + 0~${jitterSec} 秒浮动，预计约 ${(estimatedSec/60).toFixed(0)} 分钟（最长 ${(worstSec/60).toFixed(0)} 分钟，上限 180 分钟）`, '', accName);

    this.shouldStop = false;
    let completed = 0;
    let stoppedByStagnation = false;

    try {
      const { browser, context } = await this.launchBrowser(acc);
      const page = await this.createPage(context);
      this.page = page;

      for (let i = 0; i < totalSearches; i++) {
        if (this.shouldStop) {
          logger.log('🛑', `搜索流程被用户手动中断`, '', accName);
          break;
        }

        const query = await rewardsApi.getHotSearchWord();
        completed++;

        this.updateState({
          status: 'navigating',
          currentQuery: query,
          searchCount: completed,
          totalTarget: totalSearches,
          pointsNeeded: neededPoints,
          nextSearchIn: 0,
          lastAction: `[第 ${completed}/${totalSearches} 轮] 正在打开必应主页...`
        });

        await page.goto('https://cn.bing.com', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await this.delay(rewardsApi.randomRange(1000, 2000));

        this.updateState({
          status: 'typing',
          lastAction: `[第 ${completed}/${totalSearches} 轮] 正在模拟真人键盘键入: "${query}"...`
        });

        logger.log('🔍', `[搜索 ${completed}/${totalSearches}] 键入关键词: "${query}"`, '', accName);

        const searchInputSelector = '#sb_form_q';
        await page.waitForSelector(searchInputSelector, { timeout: 10000 });
        await page.click(searchInputSelector);
        await this.delay(200);

        for (const char of query) {
          await page.type(searchInputSelector, char, { delay: rewardsApi.randomRange(50, 110) });
        }
        await this.delay(400);

        this.updateState({
          status: 'dwelling',
          lastAction: `[第 ${completed}/${totalSearches} 轮] 按下 Enter，浏览搜索结果中...`
        });

        await page.keyboard.press('Enter');
        await page.waitForTimeout(rewardsApi.randomRange(3000, 6000));

        // 模拟浏览结果滚轮
        await page.mouse.wheel(0, rewardsApi.randomRange(350, 800));
        await this.delay(rewardsApi.randomRange(3000, 5000));

        // 每完成一次搜索就回调一次，让 WebUI 实时看到进度增长
        if (typeof onProgress === 'function') {
          try {
            onProgress(completed, totalSearches);
          } catch {}
        }

        // 停滞保护：探测官网真实进度，连续 N 次不涨就停手
        if (typeof probeProgress === 'function' && i < totalSearches - 1) {
          let official = null;
          try {
            official = await probeProgress();
          } catch {}
          const result = stagnation.observe(official);
          if (result.stagnant) {
            stoppedByStagnation = true;
            logger.log(
              '🛑',
              `连续 ${result.stagnantCount} 次搜索官网进度没有增加（停留在 ${result.bestProgress} 分），判定搜索额度已到顶，主动停止本轮搜索以免触发风控`,
              '',
              accName
            );
            break;
          }
        }

        // 如果已经是最后一次，不等待
        if (i === totalSearches - 1) break;

        // 计算下一次搜索的拟人休眠时间（基础间隔 + 0~浮动 秒）
        const waitSec = intervalSec + rewardsApi.randomRange(0, jitterSec);
        logger.log('⏳', `拟人呼吸间隔休眠：${(waitSec / 60).toFixed(1)} 分钟后执行第 ${completed + 1} 次搜索...`, '', accName);

        // 逐秒倒计时更新，便于 WebUI 前端实时显示倒计时
        for (let s = waitSec; s > 0; s--) {
          if (this.shouldStop) break;
          this.updateState({
            status: 'waiting',
            nextSearchIn: s,
            lastAction: `拟人呼吸休眠中 (倒计时 ${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')})`
          });
          await this.delay(1000);
        }
      }

      await this.commitBrowserSession();
      await this.closeBrowser();
      if (stoppedByStagnation) {
        logger.log('🛑', `账号 [${accName}] 因进度停滞提前结束，本轮共执行 ${completed} 次检索（未打满的额度留到下一轮）`, '', accName);
      } else {
        logger.log('🎉', `账号 [${accName}] 拟人平缓搜索完成！共执行 ${completed} 次检索`, '', accName);
      }
      return completed;
    } catch (e) {
      logger.log('🔴', `拟人搜索流程发生异常: ${e.message}`, '', accName);
      await this.closeBrowser();
      throw e;
    }
  }

  stop() {
    this.shouldStop = true;
    this.updateState({ status: 'stopped', lastAction: '正在中止浏览器任务...' });
  }

  /**
   * 完成任务区打孔卡 (Quest Punch Card)
   *
   * 这类任务（如「十月必看五大亮点」）每天只解锁一个小任务，完成当天任务后
   * 需要等满 24 小时才解锁下一个，所以每次只能推进一格，属于正常现象。
   * 当前解锁的那一项在页面上是一个指向 bing.com 搜索的链接，用真实点击完成。
   */
  async runQuestPunchCards(acc, quests = []) {
    const accName = acc?.name || '当前账号';
    const pending = (quests || []).filter(q => q && !q.done);
    if (pending.length === 0) return { attempted: 0, completed: 0, details: [] };

    let attempted = 0;
    let completed = 0;
    const completedSteps = [];

    try {
      this.shouldStop = false;
      const { context } = await this.launchBrowser(acc);
      const page = await this.createPage(context);
      this.page = page;

      for (const quest of pending) {
        if (this.shouldStop) break;

        const questName = quest.title || quest.questId || '任务打孔卡';
        this.updateState({
          status: 'navigating',
          lastAction: `正在检查任务打孔卡「${questName}」...`
        });

        try {
          await page.goto(quest.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await this.delay(2500);
          const pageTitle = (await page.title().catch(() => '')) || questName;
          const displayName = pageTitle.replace(/\s*[–-]\s*Microsoft Rewards\s*$/i, '').trim() || questName;

          // 给「当前解锁且未完成」的那一项打标记，方便后续精确点击
          const cta = await page.evaluate(() => {
            const links = [...document.querySelectorAll('a[href]')];
            for (const a of links) {
              const href = a.getAttribute('href') || '';
              if (a.getAttribute('aria-disabled') === 'true' || a.getAttribute('data-disabled') === 'true') continue;
              if (/\/account\/general|\/rewards\/about|\/rewards\/faq|\/rewards\/redeem/i.test(href)) continue;
              if (a.closest('header') || a.closest('footer')) continue;
              if (!(/bing\.com\/search\?/i.test(href) || /bing\.com\/|microsoft\.com\/|microsoftedgewelcome/i.test(href))) continue;
              a.setAttribute('data-msr-quest-cta', '1');
              return { href, text: (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) };
            }
            return null;
          });

          if (!cta) {
            logger.log('💤', `打孔卡「${displayName}」今日任务未解锁或已完成，跳过`, '', accName);
            continue;
          }

          attempted++;
          logger.log('🧩', `执行打孔卡「${displayName}」今日任务: ${cta.text || cta.href}`, '', accName);
          this.updateState({
            status: 'dwelling',
            lastAction: `正在完成打孔卡任务: ${cta.text || displayName}`
          });

          // 优先真实点击（会触发官网自己的上报逻辑）；点不动或没跳转就退化为直接导航。
          // 注意必须校验「确实跳到了任务页」才计入完成，否则会出现「没做成也报成功」。
          const beforeUrl = page.url();
          const newPagePromise = context.waitForEvent('page', { timeout: 6000 }).catch(() => null);
          try {
            await page.click('a[data-msr-quest-cta="1"]', { timeout: 8000 });
          } catch {
            await page.goto(cta.href, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          }
          // 新开标签页的任务也要接住，但不要为了等它白等满 6 秒
          const newPage = await Promise.race([newPagePromise, this.delay(2500).then(() => null)]);
          const workPage = newPage || page;
          await workPage.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});

          let landedUrl = '';
          try { landedUrl = String(workPage.url() || ''); } catch {}
          const navigated = !!newPage
            || (landedUrl !== beforeUrl && /^https?:\/\/([a-z0-9-]+\.)*bing\.com\//i.test(landedUrl));

          if (navigated) {
            await this.delay(rewardsApi.randomRange(3500, 6000));
            await workPage.mouse.wheel(0, rewardsApi.randomRange(300, 800)).catch(() => {});
            await this.delay(rewardsApi.randomRange(2000, 4000));
          }
          if (newPage) await newPage.close().catch(() => {});

          if (navigated) {
            completed++;
            const stepName = cta.text || `第 ${completed} 项`;
            completedSteps.push({
              questId: quest.questId,
              title: displayName,
              stepName,
              at: Date.now()
            });
            logger.log('✅', `打孔卡「${displayName}」今日任务已完成 (${stepName})`, '', accName);
            await this.delay(rewardsApi.randomRange(2500, 5000));
          } else {
            logger.log('🟡', `打孔卡「${displayName}」点击后没有跳转到任务页，本次跳过`, '', accName);
          }
        } catch (e) {
          logger.log('🟡', `打孔卡「${questName}」处理失败: ${e.message}`, '', accName);
        }
      }

      await this.commitBrowserSession();
      await this.closeBrowser();
    } catch (e) {
      logger.log('🔴', `打孔卡任务流程异常: ${e.message}`, '', accName);
      await this.closeBrowser();
    }

    return { attempted, completed, details: completedSteps };
  }

  /**
   * 打开 rewards.bing.com/dashboard 领取待领取的额外积分
   */
  async claimDashboardPoints(acc) {
    const accName = acc?.name || '当前账号';
    const execPath = this.getExecutablePath();
    if (!execPath) return 0;

    let claimed = 0;
    try {
      const { context } = await this.launchBrowser(acc);
      const page = await this.createPage(context);
      await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 45000 });
      // 等待 React 页面水合完成
      await this.delay(3500);

      // 必须精确锁定 button，不能使用 div:has-text，否则会命中最外层的整个页面根 div 导致点击无效
      const cardBtn = page.locator('button').filter({ hasText: '可领取' }).first();
      if ((await cardBtn.count()) > 0) {
        const text = await cardBtn.innerText().catch(() => '');
        const m = text.match(/可领取[\s\S]*?(\d+)/) || text.match(/(\d+)/);
        const pts = m ? parseInt(m[1], 10) : 0;
        if (pts > 0) {
          logger.log('🎁', `账号 [${accName}] 发现 ${pts} 点待领取积分，正在触发自动领取...`, '', accName);
          await cardBtn.click({ timeout: 6000 });
          await this.delay(2000);

          let hasMore = true;
          let rounds = 0;
          while (hasMore && rounds < 5) {
            rounds++;
            const confirmBtn = page.locator('div[role="dialog"] button, button').filter({ hasText: /领取积分/ }).first();
            if ((await confirmBtn.count()) > 0 && await confirmBtn.isVisible().catch(() => false)) {
              await confirmBtn.click({ timeout: 5000 }).catch(() => {});
              await this.delay(2500);
              claimed = pts;
            } else {
              hasMore = false;
            }
          }
          if (claimed > 0) {
            logger.log('🎉', `账号 [${accName}] 成功领取待领积分 +${claimed} 分！`, '', accName);
          }
        }
      }
      await this.commitBrowserSession();
      await this.closeBrowser();
    } catch (e) {
      logger.log('🟡', `账号 [${accName}] 领取待领积分异常: ${e.message}`, '', accName);
      await this.closeBrowser();
    }
    return claimed;
  }
}

export const browserManager = new BrowserManager();
export default browserManager;
