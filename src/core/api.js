import crypto from 'crypto';
import configManager from '../config.js';
import networkClient from '../network.js';
import logger from '../logger.js';
import authManager from './auth.js';

export const USER_AGENTS = {
  pc: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  mobile: 'Mozilla/5.0 (Linux; Android 16; Redmi K20 Pro Build/BP4A.251205.006; ) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/144.0.7559.132 Mobile Safari/537.36 EdgA/131.0.0.0',
  app: 'Mozilla/5.0 (Linux; Android 16; Redmi K20 Pro Build/BP4A.251205.006; ) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/144.0.7559.132 Mobile Safari/537.36 BingSapphire/32.6.2110003560'
};

export const DESKTOP_APP_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) MSRewards/Desktop/1.4.56',
  'X-MSRewards-App': '1',
  'X-Rewards-Source': 'msrewards-desktop'
};

export const APP_CONFIG = {
  rewardsAppId: 'SAAndroid/32.6.2110003560',
  channel: 'SAAndroid',
  offerIds: {
    dailyCheckIn: 'Gamification_Sapphire_DailyCheckIn',
    readArticle: 'ENUS_readarticle3_30points'
  }
};

export const SEARCH_POOL = [
  "what is the weather forecast tomorrow",
  "how do I make sourdough bread at home",
  "where can I find cheap flights to tokyo",
  "why is the sky blue scientific explanation",
  "how to learn rust programming in 2026",
  "what time does the world cup final start",
  "how to fix a leaky kitchen faucet step by step",
  "what are the best vr games of 2026",
  "how to start a vegetable garden in spring",
  "where to watch new movies this week",
  "how to take care of a bonsai tree",
  "what is the difference between python async and threading",
  "how to meditate properly for beginners",
  "what is the origin of halloween traditions",
  "how do solar panels actually work",
  "what is the best mechanical keyboard for typing",
  "how to tie a windsor knot tie",
  "what causes northern lights aurora borealis",
  "how to brew the perfect espresso at home",
  "what are the symptoms of vitamin d deficiency",
  "how to sleep better naturally tonight",
  "why do cats purr when they are happy",
  "best coffee shops in san francisco downtown",
  "italian restaurants near times square",
  "tokyo cherry blossom season 2026 forecast",
  "rtx 5070 ti benchmark vs rtx 4080 super",
  "iphone 17 release date and features",
  "tesla stock price today nasdaq",
  "best noise cancelling headphones under 300",
  "fastest electric cars 0 to 60 mph",
  "vintage camera brands collectors guide",
  "budget gaming laptop with rtx 4070 2026",
  "easy chocolate chip cookies recipe from scratch",
  "30 minute home workout routine no equipment",
  "stretching exercises for lower back pain relief",
  "easy origami crane folding instructions",
  "git rebase vs merge which one to use",
  "markdown cheat sheet with examples",
  "japanese hiragana chart pronunciation",
  "ancient rome history quick overview",
  "pomodoro technique for focus and productivity",
  "healthy breakfast ideas under 10 minutes",
  "天气预报", "今日新闻热点", "美食食谱家常菜", "旅游攻略", "健康养生知识",
  "科技资讯", "电影推荐", "股票行情", "体育赛事", "历史上的今天"
];

const SKIP_PATTERNS = [
  "referral", "refer and earn", "sweepstake", "entries",
  "install the", "set bing as your default", "bing wallpaper",
  "punch card", "ancient coin", "sea of thieves", "rewards extension",
  "redemption goal", "order history", "claim your gift", "shop to earn",
  "set goal", "Available tomorrow", "Offer is Locked", "Earn -1 points"
];

export class RewardsApi {
  constructor() {
    this.region = 'CN';
    this.host = 'www.bing.com';
    this.cachedNextAction = '707e6eb15bdfdd5fba193f0a77e934f7018faf87ce';
    this.hotWordIndex = 0;
    this.hotWordList = [];
    this.restrictedTimes = 0;
    this.lastSearchProgress = -1;
  }

  randomRange(min, max) {
    return Math.floor(Math.random() * (max - min + 1) + min);
  }

  delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  randomDelay(min = 3000, max = 8000) {
    return this.delay(this.randomRange(min, max));
  }

  getRandomUUID() {
    return crypto.randomUUID().replace(/-/g, '').toUpperCase();
  }

  isJSON(str) {
    if (!str || typeof str !== 'string') return false;
    try {
      const j = JSON.parse(str);
      return Array.isArray(j) || (typeof j === 'object' && j !== null);
    } catch {
      return false;
    }
  }

  setCurrentAccount(acc) {
    this.currentAccountId = acc?.id || 'acc_1';
    networkClient.setActiveCookie(acc?.cookie || null);
  }

  async withTokenRetry(requestFn) {
    let token = authManager.getAccessToken(this.currentAccountId);
    if (!token) {
      await authManager.refreshToken(false, this.currentAccountId);
      token = authManager.getAccessToken(this.currentAccountId);
    }
    if (!token) return null;

    try {
      return await requestFn(token);
    } catch (e) {
      if (e.message && e.message.includes('401')) {
        logger.log('🟡', 'Token 可能已过期，尝试重新刷新续期...');
        const ok = await authManager.refreshToken(true, this.currentAccountId);
        if (!ok) return null;
        token = authManager.getAccessToken(this.currentAccountId);
        return await requestFn(token);
      }
      throw e;
    }
  }

  /**
   * 地区与 IP 检测
   */
  async checkRegion(retryCount = 0) {
    const cfg = configManager.get();
    if (!cfg.network?.lockRegion) return true;

    try {
      const html = await networkClient.request({
        url: `https://${this.host}/`,
        headers: { 'user-agent': USER_AGENTS.pc }
      });

      if (!html) {
        if (retryCount < 2) {
          logger.log('🟡', `地区检测无返回，重试中 (${retryCount + 1}/2)...`);
          await this.randomDelay(3000, 6000);
          return await this.checkRegion(retryCount + 1);
        }
        return false;
      }

      const match = String(html).replace(/\s/g, '').match(/Region:"(.*?)"(.*?)RevIpCC:"(.*?)"/);
      if (match) {
        this.region = match[3].toUpperCase();
        if (this.region !== 'CN') {
          const ipInfo = await this.getIPInfo();
          logger.log('🔴', `检测到当前出口 IP 位于非大陆地区 (${this.region})，为了避免被微软风控，自动化已停止！${ipInfo}`);
          return false;
        }
        logger.log('🟢', `地区检测通过: ${this.region}（中国大陆）`);
        return true;
      }

      if (retryCount < 2) {
        await this.randomDelay(3000, 6000);
        return await this.checkRegion(retryCount + 1);
      }
      return false;
    } catch (e) {
      if (retryCount < 2) {
        await this.randomDelay(3000, 6000);
        return await this.checkRegion(retryCount + 1);
      }
      logger.log('🔴', `地区检测异常: ${e.message}`);
      return false;
    }
  }

  async getIPInfo() {
    try {
      const res = await networkClient.request({
        url: 'https://disp-qryapi.3g.qq.com/v1/dispatch',
        headers: { 'referer': 'https://3g.qq.com/' }
      });
      const data = typeof res === 'string' && this.isJSON(res) ? JSON.parse(res) : res;
      if (data && data.code === 0) {
        const ip = data.extra?.ip || '';
        const rawInfo = (data.ipInfo || '').replace(/[#*]+/g, ' ').trim();
        return ` 出口IP: ${ip} 所在地: ${rawInfo}`;
      }
    } catch {}
    return '';
  }

  /**
   * 获取当前总积分余额
   */
  async getBalance() {
    try {
      const res = await this.withTokenRetry(token => networkClient.request({
        url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=105',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'user-agent': USER_AGENTS.app,
          'authorization': `Bearer ${token}`,
          'x-rewards-appid': APP_CONFIG.rewardsAppId,
          'x-rewards-ismobile': 'true',
          'x-rewards-country': 'cn',
          'x-rewards-language': 'zh'
        }
      }));
      const data = typeof res === 'string' && this.isJSON(res) ? JSON.parse(res) : res;
      if (data?.response?.balance) {
        return Number(data.response.balance);
      }
    } catch {}

    try {
      const res2 = await networkClient.request({
        url: `https://rewards.bing.com/api/getuserinfo?type=1&X-Requested-With=XMLHttpRequest&_=${Date.now()}`,
        headers: {
          'user-agent': USER_AGENTS.pc,
          'referer': 'https://rewards.bing.com/',
          'x-requested-with': 'XMLHttpRequest'
        }
      });
      const data2 = typeof res2 === 'string' && this.isJSON(res2) ? JSON.parse(res2) : res2;
      return Number(data2?.dashboard?.availablePoints || data2?.dashboard?.userStatus?.availablePoints || data2?.balance || 0);
    } catch {}
    return 0;
  }

  /**
   * 获取用户积分、各项任务配额与明细 (Dashboard Info)
   */
  async getRewardsInfo(maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const html = await networkClient.request({
          url: 'https://rewards.bing.com/earn',
          headers: { 'user-agent': USER_AGENTS.pc }
        });
        const clean = String(html).replace(/\\"/g, '"');
        let balance = 0;
        let pcMax = 60, pcCur = 0, mobMax = 0, mobCur = 0;
        let dailyOffer = 0;
        let searchQuotaFound = false;

        const pcIdx = clean.indexOf('"pointsCounters":{');
        if (pcIdx !== -1) {
          let start = pcIdx + 17, depth = 0, end = start;
          for (let i = start; i < clean.length && i < start + 500; i++) {
            if (clean[i] === '{') depth++;
            if (clean[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
          }
          try {
            const pts = JSON.parse(clean.substring(start, end));
            pcMax = pts.pc?.max ?? 60;
            pcCur = pts.pc?.progress ?? 0;
            mobMax = pts.mobile?.max ?? 0;
            mobCur = pts.mobile?.progress ?? 0;
            dailyOffer = pts.dailyOffer ?? 0;
          } catch {}
        }

        const balMatch = clean.match(/"balance":(\d+)/) || clean.match(/"availablePoints":(\d+)/);
        if (balMatch) {
          balance = parseInt(balMatch[1], 10);
        } else {
          const cookieStr = networkClient.getCookieString('https://rewards.bing.com');
          const mCookieBal = cookieStr.match(/rc=(\d+)/) || cookieStr.match(/rb=(\d+)/);
          if (mCookieBal) {
            balance = parseInt(mCookieBal[1], 10);
          }
        }

        // 如果页面未取到有效余额，尝试通过移动端 DAPI 接口获取真实账户余额
        if (balance === 0) {
          try {
            const tokenBal = await this.getBalance();
            if (tokenBal > 0) balance = tokenBal;
          } catch {}
        }

        const todayDetails = [];
        const toNum = v => parseInt(String(v).replace(/,/g, ''), 10) || 0;
        const searchRowMatch = clean.match(/<p>\s*必应搜索\s*<\/p>\s*<\/div>\s*<div(?=[^>]*justify-self-end)[^>]*>([\s\S]{0,500}?)<\/div>/i);
        const searchHtmlMatch = searchRowMatch
          ? (searchRowMatch[1].match(/<span[^>]*>([\d,]+)<\/span>\s*<span[^>]*>\s*\/\s*([\d,]+)\s*<\/span>/i)
              || searchRowMatch[1].match(/([\d,]+)\s*\/\s*([\d,]+)/))
          : null;
        if (searchHtmlMatch) {
          pcCur = toNum(searchHtmlMatch[1]);
          pcMax = toNum(searchHtmlMatch[2]);
          searchQuotaFound = pcMax > 0;
          todayDetails.push({ title: '必应搜索', points: pcCur, max: pcMax });
        }

        const searchRscMatch = clean.match(/"combinedSearch":\{[^}]*"progress":(\d+)[^}]*"max":(\d+)/);
        if (searchRscMatch && !todayDetails.some(d => d.title === '必应搜索')) {
          pcCur = toNum(searchRscMatch[1]);
          pcMax = toNum(searchRscMatch[2]);
          searchQuotaFound = pcMax > 0;
          todayDetails.push({ title: '必应搜索', points: pcCur, max: pcMax });
        }

        let readProgress = 0, readMax = 30;
        try {
          const readInfo = await this.getReadProgress();
          if (readInfo) {
            readProgress = readInfo.progress;
            readMax = readInfo.max;
          }
        } catch {}

        // 桌面专属任务状态与到期天数动态解析
        let desktopProgress = 3, desktopMax = 8;
        let desktopExpiresText = '到期日期 5 天后';
        const desktopIdx = clean.indexOf('桌面奖励应用每周专属任务');
        if (desktopIdx !== -1) {
          const chunk = clean.substring(Math.max(0, desktopIdx - 500), desktopIdx + 2000);
          const mProg = chunk.match(/(\d+)\/(\d+)\s*个任务/);
          if (mProg) {
            desktopProgress = parseInt(mProg[1], 10);
            desktopMax = parseInt(mProg[2], 10);
          }
          const mExp = chunk.match(/expiresAt[^\"]*\"[^\"]*?(\d{4}-\d{2}-\d{2}T[^\"]+)\"/);
          if (mExp) {
            const expDate = new Date(mExp[1]);
            const diff = Math.max(0, Math.ceil((expDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
            desktopExpiresText = `到期日期 ${diff} 天后`;
          }
        }

        // 印章进度提取 (如 8/12)
        let stampsProgress = 8, stampsMax = 12;
        const stampMatch = clean.match(/"aria-label":"收集的印章"[^}]*?"aria-valuemax":(\d+)[^}]*?"aria-valuenow":(\d+)/)
          || clean.match(/aria-label="收集的印章"[^>]*?aria-valuemax="(\d+)"[^>]*?aria-valuenow="(\d+)"/);
        if (stampMatch) {
          stampsMax = parseInt(stampMatch[1], 10) || 12;
          stampsProgress = parseInt(stampMatch[2], 10) || 8;
        }

        return {
          balance,
          pc: { progress: pcCur, max: pcMax },
          mobile: { progress: mobCur, max: mobMax },
          readProgress,
          readMax,
          dailyOffer,
          todayDetails,
          desktopApp: {
            progress: desktopProgress,
            max: desktopMax,
            expiresText: desktopExpiresText
          },
          stamps: {
            progress: stampsProgress,
            max: stampsMax
          }
        };
      } catch (e) {
        if (attempt < maxRetries) {
          await this.delay(3000);
          continue;
        }
        logger.log('🔴', `获取仪表盘信息失败: ${e.message}`);
        return null;
      }
    }
    return null;
  }

  /**
   * 移动端 App 签入
   */
  async signApp() {
    const region = 'cn';
    try {
      const res = await this.withTokenRetry(token => networkClient.request({
        method: 'POST',
        url: 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'user-agent': USER_AGENTS.app,
          'authorization': `Bearer ${token}`,
          'x-rewards-appid': APP_CONFIG.rewardsAppId,
          'x-rewards-ismobile': 'true',
          'x-rewards-country': region,
          'x-rewards-language': 'zh',
          'x-rewards-partnerid': 'startapp',
          'x-rewards-flights': 'rwgobig'
        },
        data: JSON.stringify({
          amount: 1,
          id: this.getRandomUUID().slice(0, 32),
          type: 103,
          country: region,
          channel: APP_CONFIG.channel
        })
      }));

      const data = typeof res === 'string' && this.isJSON(res) ? JSON.parse(res) : res;
      if (data?.response) {
        if (data.response.activity) {
          return Number(data.response.activity.p || data.response.activity.points || 0);
        }
        if (data.response.isDuplicate || data.response.activity === null) {
          return 0;
        }
      }
    } catch (e) {
      logger.log('🔴', `App 签入异常: ${e.message}`);
    }
    return -1;
  }

  /**
   * PC 端签入
   */
  async signPC() {
    // 优先采用 Server Action 方式签入（避免官方旧接口 401 报废）
    try {
      const ok = await this.claimCard({
        offerId: 'Gamification_DailyCheckIn',
        hash: '1',
        url: 'https://rewards.bing.com/earn'
      });
      if (ok) return 10;
    } catch {}

    try {
      const token = await this.getRequestVerificationToken();
      const params = new URLSearchParams({
        id: 'Gamification_DailyCheckIn',
        hash: '1',
        activityAmount: '1'
      });
      if (token) params.set('__RequestVerificationToken', token);

      const headers = {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'user-agent': USER_AGENTS.pc,
        'referer': 'https://rewards.bing.com/',
        'origin': 'https://rewards.bing.com',
        'x-requested-with': 'XMLHttpRequest'
      };
      if (token) headers['RequestVerificationToken'] = token;

      const res = await networkClient.request({
        method: 'POST',
        url: 'https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest',
        headers,
        data: params.toString()
      });

      const data = typeof res === 'string' && this.isJSON(res) ? JSON.parse(res) : res;
      if (data) {
        return Number(data.points || data.response?.activity?.p || 0);
      }
    } catch (e) {
      // 官方改版后旧接口频报 401，移动端已签入成功时静默处理
    }
    return 0;
  }

  async getRequestVerificationToken(pageUrl = 'https://rewards.bing.com/') {
    try {
      const html = await networkClient.request({
        url: pageUrl,
        headers: { 'user-agent': USER_AGENTS.pc, 'referer': 'https://rewards.bing.com/' }
      });
      const tokenMatch = String(html).match(/name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/i)
        || String(html).match(/RequestVerificationToken.*?value=["']([^"']+)["']/i)
        || String(html).match(/"verificationToken"\s*:\s*"([^"]+)"/i)
        || String(html).match(/"__RequestVerificationToken"\s*:\s*"([^"]+)"/i);
      return tokenMatch ? tokenMatch[1].replace(/&amp;/g, '&') : '';
    } catch {
      return '';
    }
  }

  /**
   * 查询新闻资讯阅读进度
   */
  async getReadProgress() {
    try {
      const res = await this.withTokenRetry(token => networkClient.request({
        url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'user-agent': USER_AGENTS.app,
          'authorization': `Bearer ${token}`,
          'x-rewards-appid': APP_CONFIG.rewardsAppId,
          'x-rewards-ismobile': 'true',
          'x-rewards-country': 'cn',
          'x-rewards-language': 'zh'
        }
      }));

      const data = typeof res === 'string' && this.isJSON(res) ? JSON.parse(res) : res;
      const promos = data?.response?.promotions || [];
      const readOfferId = APP_CONFIG.offerIds.readArticle;
      const task = promos.find(x => x.attributes?.offerid === readOfferId);
      if (task?.attributes) {
        const progress = parseInt(task.attributes.progress) || 0;
        const max = parseInt(task.attributes.max) || 30;
        return { progress, max };
      }
    } catch (e) {
      logger.log('🔴', `阅读进度查询失败: ${e.message}`);
    }
    return null;
  }

  /**
   * 执行单篇新闻阅读打卡
   */
  async doReadArticle() {
    const region = 'cn';
    try {
      const res = await this.withTokenRetry(token => networkClient.request({
        method: 'POST',
        url: 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'user-agent': USER_AGENTS.app,
          'authorization': `Bearer ${token}`,
          'x-rewards-appid': APP_CONFIG.rewardsAppId,
          'x-rewards-ismobile': 'true',
          'x-rewards-country': region,
          'x-rewards-language': 'zh'
        },
        data: JSON.stringify({
          amount: 1,
          country: region,
          id: this.getRandomUUID().slice(0, 32),
          type: 101,
          attributes: { offerid: APP_CONFIG.offerIds.readArticle }
        })
      }));

      const data = typeof res === 'string' && this.isJSON(res) ? JSON.parse(res) : res;
      if (data?.response) {
        return {
          points: data.response?.activity?.p || 0,
          isDuplicate: data.response?.isDuplicate || false
        };
      }
      return null;
    } catch (e) {
      logger.log('🔴', `阅读上报失败: ${e.message}`);
      return false;
    }
  }

  /**
   * 扫描活动卡片
   */
  async discoverCards() {
    const cards = [];
    const seenCardKeys = new Set();

    const pushCard = (card) => {
      if (!card || !card.offerId || !card.hash || card.points <= 0) return;
      const key = `${card.offerId}:${card.hash}`;
      if (seenCardKeys.has(key)) return;
      seenCardKeys.add(key);
      cards.push(card);
    };

    const inferKind = (offerId = '', title = '') => {
      const text = `${offerId} ${title}`.toLowerCase();
      if (/quiz|trivia|question|测验|答案/.test(text)) return 'quiz';
      if (/puzzle|拼图/.test(text)) return 'puzzle';
      if (/image|图片|设计/.test(text)) return 'image_creator';
      if (/explore|search|浏览|探索/.test(text)) return 'explore_search';
      if (/dailyset|daily|每日/.test(text)) return 'daily';
      if (/streak|打卡|连续/.test(text)) return 'streak';
      return 'open_only';
    };

    try {
      const html = await networkClient.request({
        url: 'https://rewards.bing.com/earn',
        headers: { 'user-agent': USER_AGENTS.pc }
      });
      if (!html) return cards;

      // 1. Next.js Flight Chunks 解析
      try {
        const chunks = [];
        const pushRegex = /self\.__next_f\.push\(\[\d+,\s*"(.*?)"\]\)/gs;
        let mFlight;
        while ((mFlight = pushRegex.exec(String(html))) !== null) {
          try {
            const unescaped = JSON.parse(`"${mFlight[1]}"`);
            chunks.push(unescaped);
          } catch {}
        }
        const fullFlightText = chunks.length > 0 ? chunks.join('') : String(html).replace(/\\"/g, '"');
        const offerObjRegex = /\{[^{}]*?"offerId"\s*:\s*"([^"]+)"[^{}]*?\}/g;
        let om;
        while ((om = offerObjRegex.exec(fullFlightText)) !== null) {
          try {
            const jsonStr = om[0].replace(/:\$undefined/g, ':null').replace(/:\$D[^\",}]+/g, ':null');
            const item = JSON.parse(jsonStr);
            if (!item.offerId || !item.hash) continue;
            if (item.isCompleted === true || item.isLocked === true) continue;
            const points = Number(item.points || 0);
            if (points <= 0 && !item.offerId.includes('DailySet')) continue;
            pushCard({
              title: item.title || item.name || item.offerId,
              points: points || 10,
              offerId: item.offerId,
              hash: item.hash,
              kind: inferKind(item.offerId, item.title || ''),
              destination: item.destination || item.destinationUrl || '',
              url: 'https://rewards.bing.com/earn'
            });
          } catch {}
        }
      } catch (e) {
        logger.log('🟡', `Flight 卡片数据解析异常: ${e.message}`);
      }

      // 2. 桌面客户端专属任务检测 (独家 70 积分/周)
      try {
        const questMatch = String(html).match(/href="(\/earn\/quest\/(WW_pcparent_RewardsApp_weekly_Exclusive[^"]+))"/i)
          || String(html).match(/"(\/earn\/quest\/(WW_pcparent_RewardsApp_weekly_Exclusive[^"]+))"/i);
        if (questMatch) {
          const questUrl = 'https://rewards.bing.com' + questMatch[1];
          const questHtml = await networkClient.request({
            url: questUrl,
            headers: DESKTOP_APP_HEADERS
          });
          if (questHtml) {
            const qChunks = [];
            const qPushRegex = /self\.__next_f\.push\(\[\d+,\s*"(.*?)"\]\)/gs;
            let qm;
            while ((qm = qPushRegex.exec(String(questHtml))) !== null) {
              try { qChunks.push(JSON.parse(`"${qm[1]}"`)); } catch {}
            }
            const qText = qChunks.length > 0 ? qChunks.join('') : String(questHtml).replace(/\\"/g, '"');
            const qOfferRegex = /\{[^{}]*?"offerId"\s*:\s*"(WW_pcchild\d+[^"]+)"[^{}]*?\}/g;
            let qo;
            while ((qo = qOfferRegex.exec(qText)) !== null) {
              try {
                const qItem = JSON.parse(qo[0].replace(/:\$undefined/g, ':null').replace(/:\$D[^\",}]+/g, ':null'));
                if (qItem.offerId && qItem.hash && qItem.isLocked === false && qItem.isCompleted === false) {
                  logger.log('🖥️', `发现桌面端专享打卡任务: ${qItem.title || qItem.offerId}`);
                  pushCard({
                    title: `[桌面专享] ${qItem.title || qItem.name || qItem.offerId}`,
                    points: 10,
                    offerId: qItem.offerId,
                    hash: qItem.hash,
                    kind: 'desktop_app',
                    destination: qItem.destination || qItem.href || '',
                    url: 'https://rewards.bing.com/earn'
                  });
                }
              } catch {}
            }
          }
        }
      } catch (eQuest) {
        logger.log('🟡', `桌面专属任务解析跳过: ${eQuest.message}`);
      }
    } catch (e) {
      logger.log('🔴', `扫描活动卡片失败: ${e.message}`);
    }

    return cards;
  }

  async getNextActionHash(html) {
    if (html && html.includes('_next/static/chunks/')) {
      const scriptSrcs = [...new Set(html.match(/\/_next\/static\/chunks\/[a-z0-9_\-]+\.js\?dpl=[^"]+/g) || [])];
      for (const src of scriptSrcs) {
        try {
          const chunkText = await networkClient.request({ url: 'https://rewards.bing.com' + src });
          const match = String(chunkText).match(/createServerReference\)\("([a-f0-9]{40,44})"[^)]*"reportActivity"\)/);
          if (match && match[1]) {
            this.cachedNextAction = match[1];
            break;
          }
        } catch {}
      }
    }
    return this.cachedNextAction;
  }

  /**
   * 完成单张卡片打卡
   */
  async claimCard(card) {
    const url = card.url || 'https://rewards.bing.com/earn';
    const referer = card.url || 'https://rewards.bing.com/earn';
    let nextAction = this.cachedNextAction;

    // 策略 1: Next.js Server Action
    try {
      const headers = {
        'content-type': 'text/plain;charset=UTF-8',
        'next-action': nextAction,
        'referer': referer
      };
      if (card.kind === 'desktop_app') {
        Object.assign(headers, DESKTOP_APP_HEADERS);
      }
      const res = await networkClient.request({
        method: 'POST',
        url,
        headers,
        data: JSON.stringify([card.hash, 11, { offerid: card.offerId, isPromotional: '$undefined', timezoneOffset: '-480' }])
      });
      const str = String(res);
      if (str.includes('true') || str.includes('"i":false') || str.includes('"a":')) {
        return true;
      }
    } catch (e) {
      if (e.message && e.message.includes('404')) {
        try {
          const earnHtml = await networkClient.request({ url: 'https://rewards.bing.com/earn' });
          nextAction = await this.getNextActionHash(earnHtml);
          const retryRes = await networkClient.request({
            method: 'POST',
            url,
            headers: { 'content-type': 'text/plain;charset=UTF-8', 'next-action': nextAction, referer },
            data: JSON.stringify([card.hash, 11, { offerid: card.offerId, isPromotional: '$undefined', timezoneOffset: '-480' }])
          });
          if (retryRes) return true;
        } catch {}
      }
    }

    // 策略 2: 每日活动目标链接搜索上报
    if (card.destination && card.destination.startsWith('http')) {
      try {
        await this.reportDailyActivity(card.destination);
        return true;
      } catch {}
    }

    // 策略 3: 老版 reportactivity
    try {
      const token = await this.getRequestVerificationToken();
      if (token) {
        await networkClient.request({
          method: 'POST',
          url: 'https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest',
          headers: {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'user-agent': USER_AGENTS.pc,
            'referer': referer,
            'origin': 'https://rewards.bing.com',
            'x-requested-with': 'XMLHttpRequest'
          },
          data: new URLSearchParams({
            id: card.offerId,
            hash: card.hash,
            timeZone: 480,
            activityAmount: 1,
            dbs: 0,
            form: '',
            type: '',
            __RequestVerificationToken: token
          }).toString()
        });
        return true;
      }
    } catch {}

    return false;
  }

  async reportDailyActivity(searchUrl) {
    try {
      const fullUrl = searchUrl.startsWith('http') ? searchUrl : `https://cn.bing.com${searchUrl}`;
      const ig = this.getRandomUUID().substring(0, 32).toUpperCase();
      const cnUrl = fullUrl.replace(/^https?:\/\/www\.bing\.com/, 'https://cn.bing.com')
                           .replace(/^https:\/\/bing\.com/, 'https://cn.bing.com');
      const cnUrlObj = new URL(cnUrl);
      const cnSp = cnUrlObj.searchParams;
      const reportParams = new URLSearchParams();
      reportParams.set('IG', ig);
      reportParams.set('IID', 'commerce.5067');
      if (cnSp.get('form')) reportParams.set('form', cnSp.get('form'));
      if (cnSp.get('ocid') || cnSp.get('OCID')) reportParams.set('ocid', cnSp.get('ocid') || cnSp.get('OCID'));

      await networkClient.request({
        method: 'GET',
        url: cnUrl,
        headers: {
          'user-agent': USER_AGENTS.pc,
          'referer': 'https://rewards.bing.com/'
        }
      });

      await networkClient.request({
        method: 'POST',
        url: `https://cn.bing.com/rewardsapp/reportActivity?${reportParams.toString()}`,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': USER_AGENTS.pc,
          'referer': cnUrl,
          'origin': 'https://cn.bing.com'
        },
        data: new URLSearchParams({ url: cnUrl, V: 'web' }).toString()
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 探测并获取当前词库明细列表（用于前端测试与热词轮询）
   */
  async fetchSearchWordList(mode = 'offline') {
    if (mode === 'offline') {
      const sample = SEARCH_POOL.slice(0, 20);
      return { success: true, mode: 'offline', name: '本地离线智能词库', count: SEARCH_POOL.length, sample };
    }

    const apiMap = {
      'baidu.official': { url: 'https://top.baidu.com/api/board?platform=wise&tab=realtime', name: '百度官方实时热搜榜 (直连)' },
      'hot.cnxiaobai.com': { url: 'https://cnxiaobai.com/DailyHotApi/baidu', name: 'DailyHotApi 聚合榜单 (cnxiaobai)' },
      'hot.nntool.cc': { url: 'https://hotapi.nntool.cc/baidu', name: '今日热榜聚合榜单 (nntool)' }
    };

    const target = apiMap[mode] || apiMap['baidu.official'];
    try {
      const res = await networkClient.request({ url: target.url });
      const data = typeof res === 'string' && this.isJSON(res) ? JSON.parse(res) : res;
      let words = [];

      if (mode === 'baidu.official') {
        const rawList = data?.data?.cards?.[0]?.content?.[0]?.content || [];
        words = rawList.map(item => item.word).filter(Boolean);
      } else {
        if (data && Array.isArray(data.data)) {
          words = data.data.map(item => item.title || item.word).filter(Boolean);
        }
      }

      if (words.length > 0) {
        return { success: true, mode, name: target.name, count: words.length, sample: words.slice(0, 20) };
      }
      return { success: false, mode, name: target.name, message: '接口返回数据为空或格式变动' };
    } catch (e) {
      return { success: false, mode, name: target.name, message: `网络请求失败: ${e.message}` };
    }
  }

  /**
   * 获取热搜词（支持多 API 轮换与本地随机词池）
   */
  async getHotSearchWord() {
    const cfg = configManager.get();
    const mode = cfg.tasks?.searchApi || 'baidu.official';
    const baseWord = SEARCH_POOL[this.randomRange(0, SEARCH_POOL.length - 1)];
    const randomSuffix = Math.random().toString(36).slice(2, 6);
    let sentence = `${baseWord} ${randomSuffix}`;

    if (mode !== 'offline') {
      try {
        if (this.hotWordList.length === 0 || this.hotWordIndex >= this.hotWordList.length) {
          const listResult = await this.fetchSearchWordList(mode);
          if (listResult.success && Array.isArray(listResult.sample) && listResult.sample.length > 0) {
            this.hotWordList = listResult.sample;
            this.hotWordIndex = 0;
          }
        }
        if (this.hotWordList.length > 0) {
          sentence = this.hotWordList[this.hotWordIndex++];
          return sentence.slice(0, 30);
        }
      } catch (e) {
        logger.log('🟡', `热搜词获取接口异常: ${e.message}，切换到离线词池`, '', this.currentAccountName || '');
      }
    }
    return sentence;
  }

  /**
   * 执行 PC 端搜索请求与奖励上报
   */
  async doSearchOnce(query) {
    const ig = this.getRandomUUID();
    const mkt = '&mkt=zh-CN';
    const searchUrl = `https://${this.host}/search?q=${encodeURIComponent(query)}&form=QBLH${mkt}`;
    const dateNowStr = `${new Date().getMonth() + 1}/${new Date().getDate()}/${new Date().getFullYear()}`;

    // 1. 请求搜索页面
    await networkClient.request({
      url: searchUrl,
      headers: {
        'user-agent': USER_AGENTS.pc,
        'cookie': `_Rwho=u=d&ts=${dateNowStr}`,
        'referer': `https://${this.host}/?form=QBLH`
      }
    });

    // 2. 模拟报送 ncheader
    try {
      await networkClient.request({
        method: 'POST',
        url: `https://${this.host}/rewardsapp/ncheader?ver=88888888&IID=SERP.5047&IG=${ig}&ajaxreq=1`,
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'user-agent': USER_AGENTS.pc,
          'referer': `https://${this.host}/?form=QBLH`,
          'cookie': `_Rwho=u=d&ts=${dateNowStr}`
        },
        data: 'wb=1%3bi%3d1%3bv%3d1'
      });
    } catch {}

    // 3. 模拟报送 reportActivity
    const params = `q=${encodeURIComponent(query)}&form=QBLH${mkt}`;
    await networkClient.request({
      method: 'POST',
      url: `https://${this.host}/rewardsapp/reportActivity?IG=${ig}&IID=SERP.5047&${params}&ajaxreq=1`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'user-agent': USER_AGENTS.pc,
        'referer': `https://${this.host}/?form=QBLH`,
        'cookie': `_Rwho=u=d&ts=${dateNowStr}`
      },
      data: `url=${encodeURIComponent(`https://${this.host}/search?${params}`)}&V=web`
    });

    return true;
  }

  /**
   * 连签任务检测与视觉搜索
   */
  async checkStreak() {
    try {
      const html = await networkClient.request({
        url: 'https://rewards.bing.com/earn',
        headers: { 'user-agent': USER_AGENTS.pc }
      });
      if (!html) return null;

      const text = String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
      let streakDays = 0;
      const mStreak = text.match(/每日连续打卡\s*(\d+)/);
      if (mStreak) {
        streakDays = parseInt(mStreak[1]) || 0;
      }

      // 检测视觉搜索
      const vsMatch = text.match(/视觉搜索连续打卡[\s\S]*?活动:\s*(\d+)\/(\d+)/);
      if (vsMatch) {
        const cur = parseInt(vsMatch[1]);
        const max = parseInt(vsMatch[2]);
        if (cur < max) {
          logger.log('📅', '检测到视觉搜索未打卡，正在后台补签...');
          await networkClient.request({
            url: 'https://www.bing.com/?features=vsstreak,vstooltip&form=ML2XES',
            headers: { 'user-agent': USER_AGENTS.pc, 'referer': 'https://www.bing.com/' }
          });
          await this.randomDelay(2000, 4000);
        }
      }

      return { streakDays };
    } catch (e) {
      logger.log('🔴', `连签检测异常: ${e.message}`);
      return null;
    }
  }

  /**
   * 检测 Dashboard 额外积分
   */
  async checkClaimablePoints() {
    try {
      const html = await networkClient.request({
        url: 'https://rewards.bing.com/dashboard',
        headers: { 'user-agent': USER_AGENTS.pc }
      });
      const claimableMatch = String(html).match(/alt="可领取"[^>]*>[\s\S]*?(\d[\d,]*)/i);
      if (claimableMatch) {
        const amount = parseInt(claimableMatch[1].replace(/,/g, '')) || 0;
        if (amount > 0) {
          logger.log('🎁', `发现 ${amount} 点额外积分待手动确认领奖`);
        }
      }
    } catch {}
  }
}

export const rewardsApi = new RewardsApi();
export default rewardsApi;
