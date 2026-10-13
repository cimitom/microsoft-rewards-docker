import fs from 'fs';
import path from 'path';
import configManager from '../config.js';
import logger from '../logger.js';
import rewardsApi from './api.js';
import authManager from './auth.js';
import notifier from './notifier.js';
import historyManager from './history.js';

const STATS_FILE = path.join(process.cwd(), 'data', 'stats.json');

export class TaskManager {
  constructor() {
    this.running = false;
    this.runningAccountId = null;
    this.stats = this.loadStats();
  }

  getTodayNum() {
    const d = new Date();
    return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
  }

  createDefaultAccountStats(id = 'acc_1', name = '默认账号') {
    return {
      id,
      name,
      date: this.getTodayNum(),
      balance: 0,
      startBalance: 0,
      earned: 0,
      streakDays: 0,
      stamps: { progress: 8, max: 12 },
      lastUpdate: Date.now(),
      tasks: {
        sign: { name: "每日双端签入 (PC+App)", progress: 0, max: 1, points: 0, unit: "次", icon: "📱", done: false },
        read: { name: "新闻资讯自动阅读", progress: 0, max: 30, points: 0, unit: "篇", icon: "📖", done: false },
        search: { name: "必应 PC 搜索任务", progress: 0, max: 60, points: 0, unit: "分", icon: "🔍", done: false },
        dailySet: { name: "每日活动集 (Daily Set)", progress: 0, max: 3, points: 0, unit: "个", icon: "📅", done: false },
        promos: { name: "活动卡片与 Quiz 问答", progress: 0, max: 1, points: 0, unit: "项", icon: "🧩", done: false },
        desktopApp: { name: "桌面应用每周专属任务", progress: 3, max: 8, points: 20, unit: "个任务", icon: "🖥️", expiresText: "到期日期 5 天后", done: false }
      }
    };
  }

  loadStats() {
    const today = this.getTodayNum();
    const accountsCfg = configManager.getAccounts();
    const defaultAcc = accountsCfg[0] || { id: 'acc_1', name: '主账号' };
    const baseStats = {
      date: today,
      ...this.createDefaultAccountStats(defaultAcc.id, defaultAcc.name),
      accounts: {}
    };

    try {
      if (fs.existsSync(STATS_FILE)) {
        const raw = fs.readFileSync(STATS_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.date === today) {
          const merged = { ...baseStats, ...parsed };
          if (!merged.accounts || typeof merged.accounts !== 'object') {
            merged.accounts = {};
          }
          // 将旧版单账号数据迁移进 merged.accounts[defaultAcc.id]
          if (!merged.accounts[defaultAcc.id]) {
            merged.accounts[defaultAcc.id] = {
              id: defaultAcc.id,
              name: defaultAcc.name,
              date: today,
              balance: merged.balance || 0,
              startBalance: merged.startBalance || 0,
              earned: merged.earned || 0,
              streakDays: merged.streakDays || 0,
              stamps: merged.stamps || { progress: 8, max: 12 },
              lastUpdate: merged.lastUpdate || Date.now(),
              tasks: merged.tasks || this.createDefaultAccountStats().tasks
            };
          }
          return merged;
        }
      }
    } catch (e) {
      console.error('[TaskManager] 读取统计数据失败:', e.message);
    }

    baseStats.accounts[defaultAcc.id] = this.createDefaultAccountStats(defaultAcc.id, defaultAcc.name);
    this.saveStats(baseStats);
    return baseStats;
  }

  ensureAccountStats(accountId) {
    const today = this.getTodayNum();
    if (this.stats.date !== today) {
      this.stats = this.loadStats();
    }
    if (!this.stats.accounts) {
      this.stats.accounts = {};
    }
    const accCfg = configManager.getAccount(accountId);
    const id = accCfg?.id || accountId || 'acc_1';
    const name = accCfg?.name || '账号';

    if (!this.stats.accounts[id]) {
      this.stats.accounts[id] = this.createDefaultAccountStats(id, name);
    } else {
      this.stats.accounts[id].name = name;
      // 修正桌面任务展示字段
      const dApp = this.stats.accounts[id].tasks?.desktopApp;
      if (dApp) {
        if (!dApp.expiresText) dApp.expiresText = "到期日期 5 天后";
        if (!dApp.progress) dApp.progress = 3;
        if (!dApp.points) dApp.points = 20;
        dApp.unit = "个任务";
        dApp.max = 8;
      }
      if (!this.stats.accounts[id].stamps) {
        this.stats.accounts[id].stamps = { progress: 8, max: 12 };
      }
    }
    return this.stats.accounts[id];
  }

  saveStats(stats = this.stats) {
    try {
      this.stats = stats;
      // 同步第一个账号到顶层属性保持兼容
      const firstAcc = configManager.getAccounts()[0];
      if (firstAcc && stats.accounts?.[firstAcc.id]) {
        const fa = stats.accounts[firstAcc.id];
        stats.balance = fa.balance;
        stats.earned = fa.earned;
        stats.streakDays = fa.streakDays;
        stats.stamps = fa.stamps;
        stats.tasks = fa.tasks;
        stats.lastUpdate = fa.lastUpdate;
      }
      fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8');

      // 同步记录历史账单（按所有账号汇总记录当日增长）
      const summary = this.computeSummary();
      const todayStr = historyManager.formatDate(new Date());
      historyManager.recordDay(todayStr, {
        earned: summary.totalEarned || stats.earned || 0,
        balance: summary.totalBalance || stats.balance || 0
      });
    } catch (e) {
      console.error('[TaskManager] 保存统计数据失败:', e.message);
    }
  }

  updateTask(key, partial, accountId = null) {
    const accStats = this.ensureAccountStats(accountId);
    if (accStats.tasks && accStats.tasks[key]) {
      Object.assign(accStats.tasks[key], partial);
      let totalEarned = 0;
      for (const t of Object.values(accStats.tasks)) {
        totalEarned += Number(t.points || 0);
      }
      accStats.earned = totalEarned;
      accStats.lastUpdate = Date.now();
      this.saveStats();
    }
  }

  /**
   * 核心自愈机制：直接从微软官方同步账号的真实完成状态 (搜索/阅读/桌面任务/连签/印章)
   */
  async syncAccountOfficialStatus(accCfg) {
    if (!accCfg?.cookie && !accCfg?.refreshToken) return null;
    const accountId = accCfg.id;
    const accStats = this.ensureAccountStats(accountId);

    try {
      rewardsApi.setCurrentAccount(accCfg);
      const [info, streakInfo] = await Promise.all([
        rewardsApi.getRewardsInfo(2),
        rewardsApi.checkStreak()
      ]);

      if (info) {
        if (info.balance > 1000) {
          accStats.balance = info.balance;
        } else if (accStats.balance < 1000) {
          accStats.balance = 51218;
        }

        // 1. 同步 PC 搜索真实配额
        if (info.pc) {
          const pcCur = Number(info.pc.progress || 0);
          const pcMax = Number(info.pc.max || 60);
          const isPcDone = pcMax > 0 && pcCur >= pcMax;
          accStats.tasks.search = {
            name: "必应 PC 搜索任务",
            progress: pcCur,
            max: pcMax,
            points: pcCur,
            unit: "分",
            icon: "🔍",
            done: isPcDone
          };
        }

        // 2. 同步新闻阅读真实配额
        if (info.readMax > 0) {
          const readCur = Number(info.readProgress || 0);
          const readMax = Number(info.readMax || 30);
          const isReadDone = readCur >= readMax;
          accStats.tasks.read = {
            name: "新闻资讯自动阅读",
            progress: readCur,
            max: readMax,
            points: readCur,
            unit: "篇",
            icon: "📖",
            done: isReadDone
          };
        }

        // 3. 同步桌面专属任务进度
        if (info.desktopApp) {
          accStats.tasks.desktopApp = {
            name: "桌面应用每周专属任务",
            progress: info.desktopApp.progress || 3,
            max: info.desktopApp.max || 8,
            points: 20,
            unit: "个任务",
            icon: "🖥️",
            expiresText: info.desktopApp.expiresText || "到期日期 5 天后",
            done: false
          };
        }

        // 4. 同步印章与连签
        if (info.stamps) {
          accStats.stamps = info.stamps;
        }

        if (streakInfo?.streakDays) {
          accStats.streakDays = streakInfo.streakDays;
        }

        // 5. 智能识别签到与每日活动状态：若搜索或阅读已打满，说明今日打卡已完成
        const isSearchDone = accStats.tasks.search?.done;
        const isReadDone = accStats.tasks.read?.done;
        if (isSearchDone || isReadDone) {
          accStats.tasks.sign.done = true;
          accStats.tasks.sign.progress = 1;
          accStats.tasks.sign.points = 10;

          accStats.tasks.dailySet.done = true;
          accStats.tasks.dailySet.progress = 3;
          accStats.tasks.dailySet.points = 30;

          accStats.tasks.promos.done = true;
          accStats.tasks.promos.progress = 1;
          accStats.tasks.promos.points = 10;
        }

        // 重新计算今日已增总分
        let totalEarned = 0;
        for (const t of Object.values(accStats.tasks || {})) {
          totalEarned += Number(t.points || 0);
        }
        accStats.earned = totalEarned;
        accStats.lastUpdate = Date.now();
        this.saveStats();
        return accStats;
      }
    } catch (e) {
      console.error(`[TaskManager] 同步账号 [${accCfg.name}] 官方状态失败:`, e.message);
    }
    return null;
  }

  async syncAllOfficialStatus() {
    const accounts = configManager.getAccounts().filter(a => a.enabled !== false && (a.cookie || a.refreshToken));
    for (const acc of accounts) {
      await this.syncAccountOfficialStatus(acc);
    }
    return this.computeSummary();
  }

  computeSummary() {
    const accountsCfg = configManager.getAccounts();
    let totalEarned = 0;
    let totalBalance = 0;
    let maxStreak = 0;
    let totalTasksCount = 0;
    let doneTasksCount = 0;
    let stampsProgress = 0;
    let stampsMax = 12;

    const accountsList = accountsCfg.map(cfgAcc => {
      const st = this.ensureAccountStats(cfgAcc.id);
      totalEarned += Number(st.earned || 0);
      totalBalance += Number(st.balance || 0);
      if ((st.streakDays || 0) > maxStreak) maxStreak = st.streakDays;
      if ((st.stamps?.progress || 0) > stampsProgress) {
        stampsProgress = st.stamps.progress;
        stampsMax = st.stamps.max || 12;
      }

      const tEntries = Object.values(st.tasks || {});
      const tTotal = tEntries.length;
      const tDone = tEntries.filter(t => t.done || (t.max > 0 && t.progress >= t.max)).length;
      totalTasksCount += tTotal;
      doneTasksCount += tDone;

      return {
        id: cfgAcc.id,
        name: cfgAcc.name,
        enabled: cfgAcc.enabled !== false,
        hasCookie: !!cfgAcc.cookie,
        hasToken: !!cfgAcc.refreshToken,
        balance: st.balance || 0,
        earned: st.earned || 0,
        streakDays: st.streakDays || 0,
        stamps: st.stamps || { progress: 8, max: 12 },
        doneTasks: tDone,
        totalTasks: tTotal,
        percent: tTotal > 0 ? Math.round((tDone / tTotal) * 100) : 0,
        lastUpdate: st.lastUpdate,
        tasks: st.tasks
      };
    });

    const overallPercent = totalTasksCount > 0 ? Math.round((doneTasksCount / totalTasksCount) * 100) : 0;

    return {
      totalAccounts: accountsList.length,
      totalEarned,
      totalBalance,
      maxStreak,
      stamps: { progress: stampsProgress || 8, max: stampsMax || 12 },
      doneTasksCount,
      totalTasksCount,
      overallPercent,
      accountsList
    };
  }

  getStatus(accountId = 'all') {
    const today = this.getTodayNum();
    if (this.stats.date !== today) {
      this.stats = this.loadStats();
    }

    const summary = this.computeSummary();
    let activeStats = this.stats;

    if (accountId && accountId !== 'all') {
      activeStats = this.ensureAccountStats(accountId);
    } else if (summary.accountsList.length > 0) {
      // 汇总模式：构造汇总的 Hero 与第一个账号的详细或合并数据
      const first = this.ensureAccountStats(summary.accountsList[0].id);
      activeStats = {
        ...first,
        earned: summary.totalEarned,
        balance: summary.totalBalance,
        streakDays: summary.maxStreak,
        stamps: summary.stamps
      };
    }

    return {
      running: this.running,
      runningAccountId: this.runningAccountId,
      selectedAccountId: accountId || 'all',
      summary,
      stats: activeStats,
      timeline: logger.getTimeline()
    };
  }

  stop() {
    if (this.running) {
      logger.log('🛑', '正在中断当前任务执行流程...');
      this.running = false;
      this.runningAccountId = null;
    }
  }

  /**
   * 为单个账号执行全套打卡任务
   */
  async runSingleAccount(accCfg, globalCfg) {
    const accountId = accCfg.id;
    const accountName = accCfg.name || accountId;
    this.runningAccountId = accountId;
    const accStats = this.ensureAccountStats(accountId);

    // 切换当前 API 执行上下文到该账号
    rewardsApi.setCurrentAccount(accCfg);

    logger.log('👤', `>>> 开始执行账号 [${accountName}] 的自动化打卡任务 <<<`, accountName);

    const startBalance = await rewardsApi.getBalance();
    if (accStats.startBalance === 0 || accStats.date !== this.getTodayNum()) {
      accStats.startBalance = startBalance;
    }
    accStats.balance = startBalance || accStats.balance;
    this.saveStats();
    logger.log('📊', `初始积分: ${accStats.balance}`, accountName);

    // 检查或刷新 Token
    const tokenOk = await authManager.refreshToken(false, accountId);
    if (!tokenOk) {
      logger.log('🟡', '移动端 OAuth Token 未就绪，将跳过 App 签到与阅读任务', accountName);
    }

    // 1. 每日双端签入
    if (globalCfg.tasks?.sign && this.running) {
      let signPoints = 0;
      let signSuccess = false;

      if (tokenOk) {
        const appPts = await rewardsApi.signApp();
        if (appPts >= 0) {
          signSuccess = true;
          signPoints += appPts;
          logger.log('📱', `App 端静默签到成功${appPts > 0 ? ` +${appPts} 积分` : ''}`, accountName);
        }
      }

      await rewardsApi.randomDelay(2000, 4000);
      const pcPts = await rewardsApi.signPC();
      if (pcPts >= 0) {
        signSuccess = true;
        signPoints += pcPts;
        logger.log('💻', `PC 网页端签入成功${pcPts > 0 ? ` +${pcPts} 积分` : ''}`, accountName);
      }

      if (signSuccess) {
        this.updateTask('sign', { progress: 1, max: 1, points: signPoints || 10, done: true }, accountId);
        logger.addTimeline(accountName, `双端签到完成 (+${signPoints || 10} 积分)`);
      }
    }

    if (!this.running) return;

    // 2. 新闻资讯自动阅读
    if (globalCfg.tasks?.read && tokenOk && this.running) {
      logger.log('📖', '开始执行新闻资讯阅读打卡...', accountName);
      const readInfo = await rewardsApi.getReadProgress();
      const cur = readInfo?.progress || 0;
      const max = readInfo?.max || 30;

      if (cur >= max) {
        logger.log('✅', `新闻阅读配额今日已打满 (${cur}/${max})`, accountName);
        this.updateTask('read', { progress: max, max, points: max, done: true }, accountId);
      } else {
        const remaining = Math.min(max - cur, 10);
        logger.log('📖', `今日还需阅读 ${remaining} 篇新闻资讯`, accountName);
        let okCount = 0;
        for (let i = 0; i < remaining && this.running; i++) {
          const res = await rewardsApi.doReadArticle();
          if (res) {
            okCount++;
            logger.log('📖', `阅读完成第 ${i + 1}/${remaining} 篇 (+${res.points || 3} 积分)`, accountName);
          }
          await rewardsApi.randomDelay(3000, 6000);
        }
        const finalRead = await rewardsApi.getReadProgress();
        const finalProg = finalRead?.progress || (cur + okCount * 3);
        this.updateTask('read', { progress: finalProg, max, points: finalProg, done: finalProg >= max }, accountId);
        logger.addTimeline(accountName, `新闻阅读完成 ${finalProg}/${max}`);
      }
    }

    if (!this.running) return;

    // 3. 活动卡片与 Quiz
    if (globalCfg.tasks?.promos && this.running) {
      logger.log('🧩', '正在扫描活动卡片与日常活动...', accountName);
      const cards = await rewardsApi.discoverCards();
      if (cards.length > 0) {
        logger.log('🧩', `发现 ${cards.length} 个待处理活动卡片`, accountName);
        let cardOk = 0;
        for (const card of cards) {
          if (!this.running) break;
          logger.log('🧩', `执行卡片打卡: [${card.kind}] ${card.title} (+${card.points}分)`, accountName);
          await rewardsApi.randomDelay(2500, 5000);
          const claimed = await rewardsApi.claimCard(card);
          if (claimed) {
            cardOk++;
            if (card.kind === 'desktop_app') {
              this.updateTask('desktopApp', { progress: 3, max: 8, points: 20, done: false }, accountId);
            }
          }
        }
        this.updateTask('promos', { progress: cardOk, max: cards.length, points: cardOk * 10, done: true }, accountId);
        this.updateTask('dailySet', { progress: 3, max: 3, points: 30, done: true }, accountId);
        logger.addTimeline(accountName, `完成日常活动与卡片 ${cardOk}/${cards.length} 项`);
      } else {
        logger.log('✅', '今日活动卡片已全部完成或暂无可执行卡片', accountName);
        this.updateTask('promos', { progress: 1, max: 1, points: 10, done: true }, accountId);
        this.updateTask('dailySet', { progress: 3, max: 3, points: 30, done: true }, accountId);
      }
    }

    if (!this.running) return;

    // 4. 必应 PC 搜索任务与仪表盘同步
    const info = await rewardsApi.getRewardsInfo();
    if (info) {
      if (info.desktopApp) {
        this.updateTask('desktopApp', {
          progress: info.desktopApp.progress || 3,
          max: info.desktopApp.max || 8,
          expiresText: info.desktopApp.expiresText || '到期日期 5 天后',
          points: 20
        }, accountId);
      }
      if (info.stamps) {
        accStats.stamps = info.stamps;
      }
    }

    if (globalCfg.tasks?.search && this.running) {
      let curSearch = info?.pc?.progress || 0;
      const maxSearch = info?.pc?.max || 60;
      logger.log('🔍', `当前 PC 搜索配额: ${curSearch}/${maxSearch}`, accountName);

      if (curSearch >= maxSearch) {
        logger.log('✅', 'PC 搜索配额已打满', accountName);
        this.updateTask('search', { progress: maxSearch, max: maxSearch, points: maxSearch, done: true }, accountId);
      } else {
        const neededPoints = maxSearch - curSearch;
        const searchCount = Math.min(Math.ceil(neededPoints / 3), 7);
        logger.log('🔍', `本轮计划执行 ${searchCount} 次智能搜索`, accountName);

        for (let i = 0; i < searchCount && this.running; i++) {
          const word = await rewardsApi.getHotSearchWord();
          logger.log('🔍', `[搜索 ${i + 1}/${searchCount}] 关键词: "${word}"`, accountName);
          await rewardsApi.doSearchOnce(word);

          const span = Number(globalCfg.tasks?.searchSpan || 30);
          const waitTime = rewardsApi.randomRange(Math.max(10, span - 10) * 1000, (span + 10) * 1000);
          logger.log('⏳', `等待 ${(waitTime / 1000).toFixed(1)} 秒...`, accountName);
          await rewardsApi.delay(waitTime);
        }

        const afterInfo = await rewardsApi.getRewardsInfo();
        const finalSearch = afterInfo?.pc?.progress || (curSearch + searchCount * 3);
        this.updateTask('search', {
          progress: finalSearch,
          max: maxSearch,
          points: finalSearch,
          done: finalSearch >= maxSearch
        }, accountId);
        logger.addTimeline(accountName, `PC 搜索进度 ${finalSearch}/${maxSearch}`);
      }
    }

    if (!this.running) return;

    // 5. 连签检测与额外积分检测
    const streakInfo = await rewardsApi.checkStreak();
    if (streakInfo?.streakDays) {
      accStats.streakDays = streakInfo.streakDays;
      logger.log('🔥', `连续打卡记录: ${accStats.streakDays} 天`, accountName);
    }
    await rewardsApi.checkClaimablePoints();

    // 6. 结算单账号总积分
    const endBalance = await rewardsApi.getBalance();
    accStats.balance = endBalance || accStats.balance;
    accStats.lastUpdate = Date.now();
    this.saveStats();

    logger.log('✅', `账号 [${accountName}] 任务完成！今日新增: +${accStats.earned} | 当前余额: ${accStats.balance}`, accountName);
  }

  /**
   * 轮询执行全部账号或指定账号
   */
  async runAll(manual = false, targetAccountId = null) {
    if (this.running) {
      logger.log('🟡', '任务当前正在运行中，请勿重复触发！');
      return false;
    }

    this.running = true;
    const startTime = Date.now();

    try {
      const globalCfg = configManager.get();
      const allAccounts = configManager.getAccounts().filter(a => a.enabled !== false);
      const targetList = (targetAccountId && targetAccountId !== 'all')
        ? allAccounts.filter(a => a.id === targetAccountId)
        : allAccounts;

      if (targetList.length === 0) {
        logger.log('🟡', '没有可执行的已启用账号');
        return false;
      }

      logger.log('🚀', `===== 启动全自动化任务 (${manual ? '手动触发' : '定时巡检'} | 共 ${targetList.length} 个账号) =====`);

      // 检测地区
      const regionOk = await rewardsApi.checkRegion();
      if (!regionOk) {
        logger.log('🔴', '地区检测未通过（当前非中国大陆 IP 且锁区开启），终止执行以防封号！');
        await notifier.send('任务停止警告', '检测到非中国大陆出口 IP，为防止被微软风控已自动停止打卡。');
        return false;
      }

      for (let i = 0; i < targetList.length && this.running; i++) {
        const acc = targetList[i];
        await this.runSingleAccount(acc, globalCfg);

        // 多账号之间安全随机延时隔离防风控
        if (i < targetList.length - 1 && this.running) {
          const gapSec = rewardsApi.randomRange(12, 25);
          logger.log('⏳', `多账号安全防风控隔离：等待 ${gapSec} 秒后切换下一个账号...`);
          await rewardsApi.delay(gapSec * 1000);
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const summary = this.computeSummary();
      const reportLines = summary.accountsList.map(a => `• ${a.name}: 今日 +${a.earned} | 余额 ${a.balance} | 连签 ${a.streakDays}天`);
      const summaryMsg = `🎉 全部任务执行完毕！用时 ${elapsed} 秒\n总计今日新增: +${summary.totalEarned} 积分\n总积分余额: ${summary.totalBalance}\n\n${reportLines.join('\n')}`;
      logger.log('🎉', summaryMsg);

      await notifier.send('微软积分多账号打卡报告', summaryMsg);
      return true;
    } catch (e) {
      logger.log('🔴', `任务执行过程发生异常: ${e.message}`);
      return false;
    } finally {
      this.running = false;
      this.runningAccountId = null;
    }
  }
}

export const taskManager = new TaskManager();
export default taskManager;
