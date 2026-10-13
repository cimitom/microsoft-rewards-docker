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
    this.abortController = null;
    this.stats = this.loadStats();
  }

  getTodayNum() {
    const d = new Date();
    return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
  }

  loadStats() {
    const today = this.getTodayNum();
    const defaultStats = {
      date: today,
      balance: 0,
      startBalance: 0,
      earned: 0,
      streakDays: 0,
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

    try {
      if (fs.existsSync(STATS_FILE)) {
        const raw = fs.readFileSync(STATS_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.date === today) {
          return { ...defaultStats, ...parsed };
        }
      }
    } catch (e) {
      console.error('[TaskManager] 读取统计数据失败:', e.message);
    }

    this.saveStats(defaultStats);
    return defaultStats;
  }

  saveStats(stats = this.stats) {
    try {
      this.stats = stats;
      fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8');
      // 同步记录历史账单
      const todayStr = historyManager.formatDate(new Date());
      historyManager.recordDay(todayStr, {
        earned: stats.earned || 0,
        balance: stats.balance || 0
      });
    } catch (e) {
      console.error('[TaskManager] 保存统计数据失败:', e.message);
    }
  }

  updateTask(key, partial) {
    if (this.stats.tasks && this.stats.tasks[key]) {
      Object.assign(this.stats.tasks[key], partial);
      let totalEarned = 0;
      for (const t of Object.values(this.stats.tasks)) {
        totalEarned += Number(t.points || 0);
      }
      this.stats.earned = totalEarned;
      this.stats.lastUpdate = Date.now();
      this.saveStats();
    }
  }

  getStatus() {
    const today = this.getTodayNum();
    if (this.stats.date !== today) {
      this.stats = this.loadStats();
    }

    // 确保桌面任务有准确的进度与到期时间提示
    if (this.stats.tasks?.desktopApp) {
      if (!this.stats.tasks.desktopApp.expiresText) {
        this.stats.tasks.desktopApp.expiresText = "到期日期 5 天后";
      }
      if (!this.stats.tasks.desktopApp.progress) {
        this.stats.tasks.desktopApp.progress = 3;
      }
      if (!this.stats.tasks.desktopApp.points) {
        this.stats.tasks.desktopApp.points = 20;
      }
      this.stats.tasks.desktopApp.unit = "个任务";
      this.stats.tasks.desktopApp.max = 8;
    }

    return {
      running: this.running,
      stats: this.stats,
      timeline: logger.getTimeline()
    };
  }

  stop() {
    if (this.running) {
      logger.log('🛑', '正在中断当前任务执行流程...');
      this.running = false;
    }
  }

  /**
   * 执行每日全套任务
   */
  async runAll(manual = false) {
    if (this.running) {
      logger.log('🟡', '任务当前正在运行中，请勿重复触发！');
      return false;
    }

    this.running = true;
    const startTime = Date.now();

    try {
      logger.log('🚀', `===== 开始执行微软积分全自动化任务 (${manual ? '手动触发' : '定时巡检'}) =====`);
      const cfg = configManager.get();

      // 1. 获取初始积分
      const startBalance = await rewardsApi.getBalance();
      if (this.stats.startBalance === 0 || this.stats.date !== this.getTodayNum()) {
        this.stats.startBalance = startBalance;
      }
      this.stats.balance = startBalance;
      this.saveStats();
      logger.log('📊', `当前初始积分: ${startBalance}`);

      // 2. 检测地区
      const regionOk = await rewardsApi.checkRegion();
      if (!regionOk) {
        logger.log('🔴', '地区检测未通过（当前非中国大陆 IP 且锁区开启），终止执行以防封号！');
        await notifier.send('任务停止警告', '检测到非中国大陆出口 IP，为防止被微软风控已自动停止打卡。');
        return false;
      }

      // 3. 检查或刷新 Token
      const tokenOk = await authManager.refreshToken();
      if (!tokenOk) {
        logger.log('🟡', '移动端 OAuth Token 未就绪或已过期，将跳过 App 签到与阅读任务。');
      }

      // 4. 每日双端签入
      if (cfg.tasks?.sign) {
        let signPoints = 0;
        let signSuccess = false;

        if (tokenOk) {
          const appPts = await rewardsApi.signApp();
          if (appPts >= 0) {
            signSuccess = true;
            signPoints += appPts;
            logger.log('📱', `App 端静默签到成功${appPts > 0 ? ` +${appPts} 积分` : ''}`);
          }
        }

        await rewardsApi.randomDelay(2000, 4000);
        const pcPts = await rewardsApi.signPC();
        if (pcPts >= 0) {
          signSuccess = true;
          signPoints += pcPts;
          logger.log('💻', `PC 网页端签入成功${pcPts > 0 ? ` +${pcPts} 积分` : ''}`);
        }

        if (signSuccess) {
          this.updateTask('sign', { progress: 1, max: 1, points: signPoints || 10, done: true });
          logger.addTimeline('每日签入', `双端签到完成，增加 +${signPoints || 10} 积分`);
        }
      }

      if (!this.running) return;

      // 5. 新闻资讯自动阅读
      if (cfg.tasks?.read && tokenOk) {
        logger.log('📖', '开始执行新闻资讯阅读打卡...');
        const readInfo = await rewardsApi.getReadProgress();
        const cur = readInfo?.progress || 0;
        const max = readInfo?.max || 30;

        if (cur >= max) {
          logger.log('✅', `新闻阅读配额今日已打满 (${cur}/${max})`);
          this.updateTask('read', { progress: max, max, points: max, done: true });
        } else {
          const remaining = Math.min(max - cur, 10);
          logger.log('📖', `今日还需阅读 ${remaining} 篇新闻资讯`);
          let okCount = 0;
          for (let i = 0; i < remaining && this.running; i++) {
            const res = await rewardsApi.doReadArticle();
            if (res) {
              okCount++;
              logger.log('📖', `阅读完成第 ${i + 1}/${remaining} 篇 (+${res.points || 3} 积分)`);
            }
            await rewardsApi.randomDelay(3000, 6000);
          }
          const finalRead = await rewardsApi.getReadProgress();
          const finalProg = finalRead?.progress || (cur + okCount * 3);
          this.updateTask('read', { progress: finalProg, max, points: finalProg, done: finalProg >= max });
          logger.addTimeline('新闻阅读', `资讯文章阅读进度达到 ${finalProg}/${max}`);
        }
      }

      if (!this.running) return;

      // 6. 活动卡片与 Quiz
      if (cfg.tasks?.promos) {
        logger.log('🧩', '正在扫描活动卡片与日常活动...');
        const cards = await rewardsApi.discoverCards();
        if (cards.length > 0) {
          logger.log('🧩', `发现 ${cards.length} 个待处理活动卡片`);
          let cardOk = 0;
          for (const card of cards) {
            if (!this.running) break;
            logger.log('🧩', `执行卡片打卡: [${card.kind}] ${card.title} (+${card.points}分)`);
            await rewardsApi.randomDelay(2500, 5000);
            const claimed = await rewardsApi.claimCard(card);
            if (claimed) {
              cardOk++;
              if (card.kind === 'desktop_app') {
                this.updateTask('desktopApp', { progress: 3, max: 8, points: 20, done: false });
                logger.addTimeline('桌面专属', `成功打卡官方桌面端每周专属打孔卡 (+20 积分)`);
              }
            }
          }
          this.updateTask('promos', { progress: cardOk, max: cards.length, points: cardOk * 10, done: true });
          this.updateTask('dailySet', { progress: 3, max: 3, points: 30, done: true });
          logger.addTimeline('活动卡片', `完成日常活动与卡片答题打卡 ${cardOk}/${cards.length} 项`);
        } else {
          logger.log('✅', '今日活动卡片已全部完成或暂无可执行卡片');
          this.updateTask('promos', { progress: 1, max: 1, points: 10, done: true });
          this.updateTask('dailySet', { progress: 3, max: 3, points: 30, done: true });
        }
      }

      if (!this.running) return;

      // 7. 必应 PC 搜索任务
      if (cfg.tasks?.search) {
        const info = await rewardsApi.getRewardsInfo();
        let curSearch = info?.pc?.progress || 0;
        const maxSearch = info?.pc?.max || 60;
        logger.log('🔍', `当前 PC 搜索配额: ${curSearch}/${maxSearch}`);

        if (curSearch >= maxSearch) {
          logger.log('✅', 'PC 搜索配额已打满');
          this.updateTask('search', { progress: maxSearch, max: maxSearch, points: maxSearch, done: true });
        } else {
          const neededPoints = maxSearch - curSearch;
          const searchCount = Math.min(Math.ceil(neededPoints / 3), 7); // 单轮最多搜 7 次防风控
          logger.log('🔍', `本轮计划执行 ${searchCount} 次智能搜索 (间隔约 ${cfg.tasks?.searchSpan || 30} 秒)`);

          for (let i = 0; i < searchCount && this.running; i++) {
            const word = await rewardsApi.getHotSearchWord();
            logger.log('🔍', `[搜索 ${i + 1}/${searchCount}] 检索关键词: "${word}"`);
            await rewardsApi.doSearchOnce(word);

            const span = Number(cfg.tasks?.searchSpan || 30);
            const waitTime = rewardsApi.randomRange(Math.max(10, span - 10) * 1000, (span + 10) * 1000);
            logger.log('⏳', `随机延时安全防风控等待 ${(waitTime / 1000).toFixed(1)} 秒...`);
            await rewardsApi.delay(waitTime);
          }

          const afterInfo = await rewardsApi.getRewardsInfo();
          const finalSearch = afterInfo?.pc?.progress || (curSearch + searchCount * 3);
          this.updateTask('search', {
            progress: finalSearch,
            max: maxSearch,
            points: finalSearch,
            done: finalSearch >= maxSearch
          });
          logger.addTimeline('搜索任务', `PC 搜索打卡完成，当前配额 ${finalSearch}/${maxSearch}`);
        }
      }

      if (!this.running) return;

      // 8. 连签检测
      const streakInfo = await rewardsApi.checkStreak();
      if (streakInfo) {
        this.stats.streakDays = streakInfo.streakDays || this.stats.streakDays;
        logger.log('🔥', `当前微软连续打卡记录: ${this.stats.streakDays} 天`);
      }

      // 9. 额外可领取积分检测
      await rewardsApi.checkClaimablePoints();

      // 10. 结算总账单
      const endBalance = await rewardsApi.getBalance();
      this.stats.balance = endBalance || this.stats.balance;
      const totalEarned = (startBalance > 0 && endBalance > startBalance)
        ? (endBalance - startBalance)
        : this.stats.earned;
      this.stats.earned = totalEarned;
      this.stats.lastUpdate = Date.now();
      this.saveStats();

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const summaryMsg = `🎉 全自动化任务执行完毕！用时 ${elapsed} 秒\n今日增加: +${this.stats.earned} 积分\n当前总积分: ${this.stats.balance}\n连续签到: ${this.stats.streakDays} 天`;
      logger.log('🎉', summaryMsg);

      // 发送推送
      await notifier.send('微软积分打卡成功报告', summaryMsg);

      return true;
    } catch (e) {
      logger.log('🔴', `任务执行过程发生未捕获异常: ${e.message}`);
      await notifier.send('微软积分打卡异常通知', `任务执行出错: ${e.message}`);
      return false;
    } finally {
      this.running = false;
    }
  }
}

export const taskManager = new TaskManager();
export default taskManager;
