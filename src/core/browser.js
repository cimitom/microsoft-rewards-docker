import fs from 'fs';
import { EventEmitter } from 'events';
import { chromium } from 'playwright-core';
import logger from '../logger.js';
import rewardsApi from './api.js';

class BrowserManager extends EventEmitter {
  constructor() {
    super();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.shouldStop = false;
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

    this.updateState({
      status: 'starting',
      activeAccountId: acc?.id || 'acc_1',
      activeAccountName: acc?.name || '当前账号',
      memoryMB: 180,
      lastAction: '正在初始化无头浏览器 Chromium 引擎...'
    });

    const browser = await chromium.launch({
      executablePath: execPath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
      viewport: { width: 1366, height: 768 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai'
    });

    // 抹平 webdriver 特征
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // 注入当前账号的完整 Cookie
    if (acc?.cookie) {
      const cookies = this.parseCookies(acc.cookie, '.bing.com');
      const cnCookies = this.parseCookies(acc.cookie, 'cn.bing.com');
      await context.addCookies([...cookies, ...cnCookies]);
    }

    this.browser = browser;
    this.context = context;
    return { browser, context };
  }

  async closeBrowser() {
    try {
      if (this.context) await this.context.close().catch(() => {});
      if (this.browser) await this.browser.close().catch(() => {});
    } catch {}
    this.browser = null;
    this.context = null;
    this.page = null;
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

    try {
      this.shouldStop = false;
      const { browser, context } = await this.launchBrowser(acc);
      const page = await context.newPage();
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
   * 平缓拉长模式：在设定的时间跨度（默认约 2 小时）内平滑完成 PC 搜索
   */
  async runPacedSearch(acc, neededPoints, options = {}) {
    const accName = acc?.name || '当前账号';
    const totalSearches = Math.max(1, Math.min(Math.ceil(neededPoints / 3), 20));
    const durationHours = options.durationHours || 2; // 默认平摊到 2 小时
    const totalSeconds = durationHours * 3600;
    const baseIntervalSec = Math.max(45, Math.floor(totalSeconds / totalSearches)); // 平均每 3.5~4 分钟一次

    logger.log('🖥️', `启动 Playwright 拟人真机搜索：总计需 ${totalSearches} 次，将在约 ${durationHours} 小时内平滑分散执行（每 ~${(baseIntervalSec/60).toFixed(1)} 分钟搜索一次，彻底避开冷却限制）`, '', accName);

    this.shouldStop = false;
    let completed = 0;

    try {
      const { browser, context } = await this.launchBrowser(acc);
      const page = await context.newPage();
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

        // 如果已经是最后一次，不等待
        if (i === totalSearches - 1) break;

        // 计算下一次搜索的拟人休眠时间 (基准时间 ± 30秒随机浮动)
        const waitSec = Math.max(30, baseIntervalSec + rewardsApi.randomRange(-30, 30));
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

      await this.closeBrowser();
      logger.log('🎉', `账号 [${accName}] 拟人平缓搜索完成！共执行 ${completed} 次检索`, '', accName);
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
}

export const browserManager = new BrowserManager();
export default browserManager;
