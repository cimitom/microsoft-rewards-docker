import fs from 'fs';
import path from 'path';
import configManager from '../config.js';
import logger from '../logger.js';
import rewardsApi from './api.js';
import authManager from './auth.js';
import notifier from './notifier.js';
import historyManager from './history.js';
import browserManager from './browser.js';
import { accountContextLock } from './contextLock.js';
import { DATA_DIR, writeFileAtomic } from '../fsUtil.js';

const STATS_FILE = path.join(DATA_DIR, 'stats.json');

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
      stamps: { progress: 0, max: 12 },
      lastUpdate: Date.now(),
      tasks: {
        sign: { name: "每日双端签入 (PC+App)", progress: 0, max: 1, points: 0, unit: "次", icon: "📱", done: false },
        read: { name: "新闻资讯自动阅读", progress: 0, max: 30, points: 0, unit: "篇", icon: "📖", done: false },
        search: { name: "必应 PC 搜索任务", progress: 0, max: 60, points: 0, unit: "分", icon: "🔍", done: false },
        dailySet: { name: "每日活动集 (Daily Set)", progress: 0, max: 3, points: 0, unit: "个", icon: "📅", done: false },
        promos: { name: "活动卡片与 Quiz 问答", progress: 0, max: 1, points: 0, unit: "项", icon: "🧩", done: false },
        desktopApp: { name: "桌面应用每周专属任务", progress: 0, max: 8, points: 20, unit: "个任务", icon: "🖥️", expiresText: "", available: false, done: false }
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
              stamps: merged.stamps || { progress: 0, max: 12 },
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
    const accCfg = configManager.resolveAccount(accountId);
    const id = accCfg?.id || accountId || 'acc_1';
    const name = accCfg?.name || '账号';

    if (!this.stats.accounts[id]) {
      this.stats.accounts[id] = this.createDefaultAccountStats(id, name);
    } else {
      this.stats.accounts[id].name = name;
      // 修正桌面任务展示字段
      const dApp = this.stats.accounts[id].tasks?.desktopApp;
      if (dApp) {
        if (dApp.expiresText === undefined) dApp.expiresText = "";
        // 注意：这里以前会把 progress 0 改写成 3，导致所有账号都显示假的 3/8
        if (dApp.progress === undefined || dApp.progress === null) dApp.progress = 0;
        if (dApp.points === undefined || dApp.points === null) dApp.points = 20;
        dApp.unit = "个任务";
        dApp.max = 8;
        if (dApp.available === undefined) dApp.available = false;
      }
      if (!this.stats.accounts[id].stamps) {
        this.stats.accounts[id].stamps = { progress: 0, max: 12 };
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
      writeFileAtomic(STATS_FILE, JSON.stringify(stats, null, 2), { encoding: 'utf-8', mode: 0o600 });

      // 同步记录历史账单（包含单账号账单与全局汇总）
      const summary = this.computeSummary();
      const todayStr = historyManager.formatDate(new Date());

      // 1. 记录每个账号的账单
      if (stats.accounts) {
        for (const [accId, aStat] of Object.entries(stats.accounts)) {
          historyManager.recordAccountDay(accId, todayStr, {
            earned: aStat.earned || 0,
            balance: aStat.balance || 0
          });
        }
      }

      // 2. 记录全局汇总账单
      historyManager.recordGlobalDay(todayStr, {
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
   * 删除账号时清理它的统计与账单，避免留下孤儿数据
   */
  removeAccountStats(accountId) {
    if (!accountId) return false;
    if (this.stats?.accounts?.[accountId]) {
      delete this.stats.accounts[accountId];
      this.saveStats();
      return true;
    }
    return false;
  }

  /**
   * 核心自愈机制：直接从微软官方同步账号的真实完成状态 (搜索/阅读/桌面任务/连签/印章)
   */
  async syncAccountOfficialStatus(accCfg, options = {}) {
    if (!accCfg?.cookie && !accCfg?.refreshToken) return null;
    // owned=true 表示调用方（任务执行）已经持有账号上下文锁，可以安全切换上下文。
    // 否则如果此刻有任务在跑，直接跳过 —— 抢走全局 Cookie/Token 上下文会把
    // 正在执行的任务算到别的账号头上。
    const owned = options.owned === true;
    // 非任务流程（WebUI 同步）也要自己持锁，否则两个并发的同步请求会互相
    // 抢全局上下文，同样可能把 A 的请求算到 B 头上。
    if (!owned && !accountContextLock.tryAcquire('web-sync')) return null;
    const accountId = accCfg.id;
    // 注意：加锁之后的所有逻辑都必须包在 try 里，否则中途抛异常会导致锁泄漏，
    // 后续定时任务与同步会一直拿不到锁。
    let accStats = null;
    let prevContext = null;

    try {
      accStats = this.ensureAccountStats(accountId);
      // 同步期间的日志统一归属到该账号（结束后整体还原，避免串台）
      prevContext = rewardsApi.snapshotAccountContext();
      logger.setAccountContext(accCfg.name || accountId);
      rewardsApi.setCurrentAccount(accCfg);
      const [info, streakInfo] = await Promise.all([
        rewardsApi.getRewardsInfo(2),
        rewardsApi.checkStreak()
      ]);

      if (info) {
        if (info.balance !== undefined && info.balance !== null) {
          accStats.balance = Number(info.balance);
          // 自动修复历史遗留错误（如新号误存为51218）
          if (accStats.startBalance > 1000 && accStats.balance < 1000) {
            accStats.startBalance = accStats.balance;
          }
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

        // 3. 同步桌面专属任务进度（用真实值，不再用 3/8 兜底）
        if (info.desktopApp) {
          const dProgress = Number(info.desktopApp.progress ?? 0);
          const dMax = Number(info.desktopApp.max ?? 8) || 8;
          accStats.tasks.desktopApp = {
            name: "桌面应用每周专属任务",
            progress: dProgress,
            max: dMax,
            points: dProgress >= dMax ? 20 : 0,
            unit: "个任务",
            icon: "🖥️",
            expiresText: info.desktopApp.expiresText || "",
            available: info.desktopApp.available !== false,
            done: dProgress >= dMax
          };
        }

        // 4. 同步印章与连签
        if (info.stamps) {
          accStats.stamps = info.stamps;
        }

        // 同步连签任务（必应搜索 / 每日活动 / 必应应用）真实状态。
        // 「必应应用连续打卡」是官网独立展示的一项，脚本 UI 之前完全没有体现，
        // 导致明明没签成功也看不出来，这里如实记录并在未完成时给出提示。
        if (info.streaks) {
          accStats.streaks = info.streaks;
          const appStreak = info.streaks.bingapp;
          if (appStreak && appStreak.isCurrentDayCompleted === false) {
            logger.log('📱', `必应应用连续打卡今日未完成 (已完成 ${appStreak.completedDays || 0}/7 天)，执行任务时会自动补签`);
          }
        }

        if (streakInfo?.streakDays) {
          accStats.streakDays = streakInfo.streakDays;
        }

        // 5. 智能识别签到与每日活动状态
        //    这里只是「推断」：旧逻辑用 or（搜索或阅读任一打满就全标完成），
        //    误报很多（明明没做却显示已完成）。现在要求两者都打满才推断，
        //    并且不碰 promos —— 它有自己的真实进度（x/4 张卡片）。
        const isSearchDone = accStats.tasks.search?.done;
        const isReadDone = accStats.tasks.read?.done;
        if (isSearchDone && isReadDone) {
          const inferDone = (key, progress, points) => {
            const t = accStats.tasks[key];
            if (!t) return;
            if (Number(t.progress || 0) < progress) t.progress = progress;
            if (!t.points) t.points = points;
            t.done = true;
          };
          inferDone('sign', 1, 10);
          inferDone('dailySet', 3, 30);
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
    } finally {
      if (prevContext) rewardsApi.restoreAccountContext(prevContext);
      if (!owned) accountContextLock.release('web-sync');
    }
    return null;
  }

  async syncAllOfficialStatus() {
    // 任务执行期间不做同步，避免与执行流程争抢账号上下文
    if (!accountContextLock.tryAcquire('web-sync')) return this.computeSummary();
    try {
      const accounts = configManager.getAccounts().filter(a => a.enabled !== false && (a.cookie || a.refreshToken));
      for (const acc of accounts) {
        // 外层已持有 web-sync 锁，这里用 owned 明确告知，不再重复加/解锁
        await this.syncAccountOfficialStatus(acc, { owned: true });
      }
      return this.computeSummary();
    } finally {
      accountContextLock.release('web-sync');
    }
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
        authDiagnosis: cfgAcc.authDiagnosis || null,
        balance: st.balance || 0,
        earned: st.earned || 0,
        streakDays: st.streakDays || 0,
        stamps: st.stamps || { progress: 0, max: 12 },
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
      stamps: { progress: stampsProgress || 0, max: stampsMax || 12 },
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

    // 打卡明细按账号过滤：单账号视图只保留该账号的记录，汇总视图返回全部
    const allTimeline = logger.getTimeline();
    let timeline = allTimeline;
    if (accountId && accountId !== 'all') {
      const targetName = (configManager.getAccounts().find(a => a.id === accountId) || {}).name;
      if (targetName) {
        timeline = allTimeline.filter(t => (t.accountName || t.tag) === targetName);
      }
    }

    return {
      running: this.running,
      runningAccountId: this.runningAccountId,
      selectedAccountId: accountId || 'all',
      summary,
      stats: activeStats,
      timeline
    };
  }

  stop() {
    if (this.running) {
      logger.log('🛑', '正在中断当前任务执行流程...');
      this.running = false;
      this.runningAccountId = null;
    }
    browserManager.stop();
  }

  /**
   * 单次安全测试搜索 (仅搜 1 次，检验按键输入流与积分变化)
   */
  async runSingleTestSearch(accountId = null) {
    // 必须用 resolveAccount：getAccount() 在 id 不存在时会回退到第一个账号，
    // 那样「测试副账号」可能实际跑在主账号上。
    const acc = configManager.resolveAccount(accountId);
    if (!acc) throw new Error('未找到对应账号');
    // 注意持有者标识必须与任务执行（'task-run'）不同：
    // 同一个标识会被当成「重入」而放行，那样任务跑着的时候照样能抢上下文。
    if (!accountContextLock.tryAcquire('web-action')) {
      throw new Error('已有任务正在执行，请稍后再试（避免账号上下文串台）');
    }
    try {
      rewardsApi.setCurrentAccount(acc);
      const result = await browserManager.singleTestSearch(acc);
      // 搜索完成后同步一次最新官网数据（同一持有者，可重入）
      await this.syncAccountOfficialStatus(acc, { owned: true });
      return result;
    } finally {
      accountContextLock.release('web-action');
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
    // 切换日志账号上下文：该账号下未显式传账号名的日志也会自动带上账号名
    logger.setAccountContext(accountName);

    logger.log('👤', `>>> 开始执行账号 [${accountName}] 的自动化打卡任务 <<<`, accountName);

    // 1. 运行前先从官方同步一次真实进度（确保增量起点100%准确）
    await this.syncAccountOfficialStatus(accCfg, { owned: true });

    // 2. 检查是否所有任务今日均已达标完成
    const taskValues = Object.values(accStats.tasks || {});
    const isAllDone = taskValues.length > 0 && taskValues.every(t => t.done || (t.max > 0 && t.progress >= t.max));
    if (isAllDone && !globalCfg.tasks?.keepRunning) {
      logger.log('💤', `账号 [${accountName}] 今日所有打卡任务已全部满额达成，无需重复执行，直接结束！`, '', accountName);
      return;
    }

    const startBalance = await rewardsApi.getBalance();
    if (startBalance !== null && (accStats.startBalance === 0 || accStats.date !== this.getTodayNum())) {
      accStats.startBalance = startBalance;
    }
    if (startBalance !== null) accStats.balance = startBalance;
    this.saveStats();
    logger.log('📊', `当前积分: ${accStats.balance}`, accountName);

    // 检查或刷新 Token
    const tokenOk = await authManager.refreshToken(false, accountId);
    if (!tokenOk) {
      logger.log('🟡', '移动端 OAuth Token 未就绪，将跳过 App 签到与阅读任务', accountName);
    }

    // 1. 每日双端签入 (若已签到则直接跳过)
    if (globalCfg.tasks?.sign && this.running) {
      if (accStats.tasks.sign?.done) {
        logger.log('✅', '每日签入已完成，跳过', accountName);
      } else {
        let signPoints = 0;
        let signSuccess = false;

        if (tokenOk) {
          const appRes = await rewardsApi.signApp();
          if (appRes) {
            signSuccess = true;
            signPoints += Number(appRes.points || 0);
            if (appRes.points > 0) {
              logger.log('📱', `App 端静默签到成功 +${appRes.points} 积分`, accountName);
            } else if (appRes.isDuplicate) {
              logger.log('📱', 'App 端今日已签到过，跳过', accountName);
            } else {
              logger.log('📱', `App 端签到已提交 (${appRes.offerId || 'Gamification_Sapphire_DailyCheckIn'})`, accountName);
            }
          } else {
            logger.log('🟡', 'App 端签到未成功（Token 或接口异常），下次巡检会自动重试', accountName);
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
    }

    if (!this.running) return;

    // 2. 新闻资讯自动阅读 (严格增量模式：缺几篇读几篇)
    if (globalCfg.tasks?.read && tokenOk && this.running) {
      const readInfo = await rewardsApi.getReadProgress();
      const cur = readInfo?.progress || accStats.tasks.read?.progress || 0;
      const max = readInfo?.max || accStats.tasks.read?.max || 30;

      if (cur >= max) {
        logger.log('✅', `新闻阅读配额今日已打满 (${cur}/${max})，跳过`, accountName);
        this.updateTask('read', { progress: max, max, points: max, done: true }, accountId);
      } else {
        const remaining = Math.min(max - cur, 10);
        logger.log('📖', `今日还需阅读 ${remaining} 篇新闻资讯 (当前进度 ${cur}/${max})`, accountName);
        let okCount = 0;
        for (let i = 0; i < remaining && this.running; i++) {
          const res = await rewardsApi.doReadArticle();
          if (res) {
            okCount++;
            logger.log('📖', `阅读完成第 ${i + 1}/${remaining} 篇 (+${res.points || 3} 积分)`, accountName);
            // 实时写入进度：否则整个阅读过程（约 1 分钟）界面会一直停在 0/30
            const liveProg = Math.min(max, cur + okCount * 3);
            this.updateTask('read', {
              progress: liveProg,
              max,
              points: liveProg,
              done: liveProg >= max
            }, accountId);
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
              // 桌面专属任务按真实进度累加，不再写死 3
              const dCur = this.ensureAccountStats(accountId).tasks?.desktopApp || {};
              const dProgress = Number(dCur.progress || 0) + 1;
              const dMax = Number(dCur.max || 8) || 8;
              this.updateTask('desktopApp', {
                progress: dProgress,
                max: dMax,
                points: 20,
                available: true,
                done: dProgress >= dMax
              }, accountId);
            }
            // 实时更新卡片进度，避免整个扫描过程界面停在 0/x
            this.updateTask('promos', {
              progress: cardOk,
              max: cards.length,
              points: cardOk * 10,
              done: cardOk >= cards.length
            }, accountId);
          }
        }
        // 只有全部卡片都成功打卡才算完成，避免出现「1/4 却标记已完成」的自相矛盾状态
        this.updateTask('promos', {
          progress: cardOk,
          max: cards.length,
          points: cardOk * 10,
          done: cardOk >= cards.length
        }, accountId);
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
        const dProgress = Number(info.desktopApp.progress ?? 0);
        const dMax = Number(info.desktopApp.max ?? 8) || 8;
        this.updateTask('desktopApp', {
          progress: dProgress,
          max: dMax,
          expiresText: info.desktopApp.expiresText || '',
          points: dProgress >= dMax ? 20 : 0,
          available: info.desktopApp.available !== false,
          done: dProgress >= dMax
        }, accountId);
      }
      if (info.stamps) {
        accStats.stamps = info.stamps;
      }
    }

    if (globalCfg.tasks?.search && this.running) {
      const curSearch = info?.pc?.progress || 0;
      const maxSearch = info?.pc?.max || 60;
      // 本地实时进度：官方页面刷新有延迟，用它兜底避免进度倒退
      let liveSearch = curSearch;
      const applySearchProgress = (completed) => {
        liveSearch = Math.max(liveSearch, Math.min(maxSearch, curSearch + completed * 3));
        this.updateTask('search', {
          progress: liveSearch,
          max: maxSearch,
          points: liveSearch,
          done: liveSearch >= maxSearch
        }, accountId);
      };
      logger.log('🔍', `当前 PC 搜索配额: ${curSearch}/${maxSearch}`, accountName);

      if (curSearch >= maxSearch) {
        logger.log('✅', 'PC 搜索配额已打满', accountName);
        this.updateTask('search', { progress: maxSearch, max: maxSearch, points: maxSearch, done: true }, accountId);
      } else {
        const neededPoints = maxSearch - curSearch;
        const searchMode = globalCfg.tasks?.searchEngineMode || 'browser';
        const hasBrowser = !!browserManager.getExecutablePath();

        if (searchMode === 'browser' && hasBrowser) {
          try {
            await browserManager.runPacedSearch(accCfg, neededPoints, {
              // 每搜完一次就刷新进度，否则整个搜索过程界面都不动
              onProgress: applySearchProgress
            });
          } catch (e) {
            logger.log('🟡', `无头浏览器运行异常: ${e.message}，正在切换为轻量协议兜底`, '', accountName);
            await this.fallbackHttpSearch(accCfg, neededPoints, curSearch, maxSearch, globalCfg, applySearchProgress);
          }
        } else {
          await this.fallbackHttpSearch(accCfg, neededPoints, curSearch, maxSearch, globalCfg, applySearchProgress);
        }

        const afterInfo = await rewardsApi.getRewardsInfo();
        const official = afterInfo?.pc?.progress || 0;
        // 官方页面可能尚未刷新，取官方值与本地实时值的较大者，避免进度倒退
        const finalSearch = Math.max(official, liveSearch, curSearch);
        this.updateTask('search', {
          progress: finalSearch,
          max: maxSearch,
          points: finalSearch,
          done: finalSearch >= maxSearch
        }, accountId);
        logger.addTimeline(accountName, `PC 搜索打卡完成，当前配额 ${finalSearch}/${maxSearch}`);
      }
    }

    if (!this.running) return;

    // 4.5 任务区打孔卡 (如「十月必看五大亮点」这类每天解锁一个的任务)
    //     旧版本完全没处理这类任务，导致官网上长期停在 0/5。
    if (globalCfg.tasks?.promos && this.running && browserManager.getExecutablePath()) {
      // 打孔卡每天只解锁一个新任务，每个账号每天推进一次即可，
      // 否则每次定时巡检都去开任务页既没意义也徒增风控暴露面。
      const cur = this.ensureAccountStats(accountId);
      const todayKey = this.getTodayNum();
      if (cur.questPunchCardDate === todayKey) {
        // 今日已推进过，静默跳过
      } else {
        try {
          const quests = await rewardsApi.getQuestPunchCards();
          const pendingQuests = quests.filter(q => !q.done);
          if (pendingQuests.length > 0) {
            const questRes = await browserManager.runQuestPunchCards(accCfg, pendingQuests);
            if (questRes.completed > 0) {
              logger.addTimeline(accountName, `任务打孔卡推进 ${questRes.completed} 项`);
            }
          }
          cur.questPunchCardDate = todayKey;
          this.saveStats();
        } catch (e) {
          logger.log('🟡', `任务打孔卡处理异常: ${e.message}`, '', accountName);
        }
      }
    }

    if (!this.running) return;

    // 5. 连签检测与额外积分检测
    //    视觉搜索补签只在任务执行期尝试（每账号每天一次），读取进度的同步流程不再触发
    const streakInfo = await rewardsApi.checkStreak({ allowVisualSearchCheckIn: true });
    if (streakInfo?.streakDays) {
      accStats.streakDays = streakInfo.streakDays;
      logger.log('🔥', `连续打卡记录: ${accStats.streakDays} 天`, accountName);
    }
    await rewardsApi.checkClaimablePoints();

    // 6. 结算单账号总积分
    const endBalance = await rewardsApi.getBalance();
    if (endBalance !== null) accStats.balance = endBalance;
    accStats.lastUpdate = Date.now();
    this.saveStats();

    logger.log('✅', `账号 [${accountName}] 任务完成！今日新增: +${accStats.earned} | 当前余额: ${accStats.balance}`, accountName);
  }

  async fallbackHttpSearch(accCfg, neededPoints, curSearch, maxSearch, globalCfg, onProgress = null) {
    const accountName = accCfg.name || accCfg.id;
    // 每次搜索最多 +3 分，上限 20 次可覆盖单账号 60 分上限；
    // 旧实现写死最多 7 次（21 分），轻量模式下永远打不满搜索任务。
    const searchCount = Math.max(1, Math.min(Math.ceil(neededPoints / 3), 20));
    // 与拟人模式共用全局搜索节奏，并同样受 3 小时执行窗口约束
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const wantedIntervalSec = clamp(Number(globalCfg.tasks?.searchIntervalSec ?? 180) || 180, 60, 900);
    const jitterSec = clamp(Number(globalCfg.tasks?.searchJitterSec ?? 30) || 30, 30, 300);
    const perSearchBudget = Math.floor((3 * 3600) / searchCount);
    const intervalSec = Math.max(60, Math.min(wantedIntervalSec, perSearchBudget - jitterSec));
    logger.log('🔍', `[轻量模式] 计划执行 ${searchCount} 次搜索请求，间隔 ${intervalSec} 秒 + 0~${jitterSec} 秒浮动`, '', accountName);

    for (let i = 0; i < searchCount && this.running; i++) {
      const word = await rewardsApi.getHotSearchWord();
      logger.log('🔍', `[搜索 ${i + 1}/${searchCount}] 关键词: "${word}"`, '', accountName);
      await rewardsApi.doSearchOnce(word);

      // 轻量模式同样实时刷新进度
      if (typeof onProgress === 'function') {
        try {
          onProgress(i + 1);
        } catch {}
      }

      const waitSec = intervalSec + rewardsApi.randomRange(0, jitterSec);
      const waitTime = waitSec * 1000;
      logger.log('⏳', `等待 ${(waitTime / 1000).toFixed(1)} 秒...`, '', accountName);
      await rewardsApi.delay(waitTime);
    }
  }

  /**
   * 轮询执行全部账号或指定账号
   */
  async runAll(manual = false, targetAccountId = null) {
    if (this.running) {
      logger.log('🟡', '任务当前正在运行中，请勿重复触发！');
      return false;
    }

    // 抢占账号上下文锁：执行期间 WebUI 的同步 / 体检 / 测搜都会自动跳过，
    // 避免它们把全局 Cookie/Token 上下文切到别的账号，导致任务算错账号。
    const locked = await accountContextLock.acquire('task-run', 60000);
    if (!locked) {
      logger.log('🟡', '账号上下文正被其它操作占用，请稍后重试');
      return false;
    }

    this.running = true;
    const startTime = Date.now();

    try {
      const globalCfg = configManager.get();
      // 没有 Cookie 也没有 Token 的账号直接跳过：
      // 否则它会在没有凭据的情况下执行，可能误用到别的账号的会话
      const allAccounts = configManager.getAccounts()
        .filter(a => a.enabled !== false && (a.cookie || a.refreshToken));
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
      logger.setAccountContext('');
      accountContextLock.release('task-run');
    }
  }
}

export const taskManager = new TaskManager();
export default taskManager;
