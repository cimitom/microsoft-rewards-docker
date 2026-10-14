import cron from 'node-cron';
import configManager from './config.js';
import logger from './logger.js';
import taskManager from './core/taskManager.js';
import epicManager from './core/epic.js';

class Scheduler {
  constructor() {
    this.job = null;
    this.epicJob = null;
    this.plannedDailyRuns = {};
  }

  getTodayNum() {
    const d = new Date();
    return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
  }

  /**
   * 当前时刻距离窗口起点的分钟数（支持跨零点窗口，如 22:00 - 02:00）。
   * 返回值 < 0 表示还没进入窗口。
   */
  minutesIntoWindow(startMin, wraps, nowMin) {
    return wraps
      ? (nowMin >= startMin ? nowMin - startMin : 1440 - startMin + nowMin)
      : (nowMin - startMin);
  }

  initTodayPlan() {
    const today = this.getTodayNum();
    this.ensureDayPlans(today, true);

    // 只清理历史日期，保留今天与预排的明天
    const todayKey = String(today);
    for (const key of Object.keys(this.plannedDailyRuns)) {
      if (key < todayKey) delete this.plannedDailyRuns[key];
    }
  }

  /**
   * 为指定日期生成各账号的当日计划（已存在则跳过）。
   * isToday=true 时，若当前已在窗口内则把偏移推到「现在之后」，避免中途启动立刻开跑。
   */
  ensureDayPlans(dateNum, isToday) {
    const key = String(dateNum);
    if (!this.plannedDailyRuns[key]) {
      this.plannedDailyRuns[key] = {};
    }
    const plans = this.plannedDailyRuns[key];
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();

    const accounts = configManager.getAccounts().filter(a => a.enabled !== false);
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      if (plans[acc.id]) continue;

      const slot = acc.timeSlot || configManager.getDefaultTimeSlot(i);
      const startHour = slot.startHour ?? 9;
      const endHour = slot.endHour ?? ((startHour + 4) % 24);
      const startMin = startHour * 60;
      const endMin = endHour * 60;
      // 支持跨零点窗口（例如 22:00 - 02:00）
      const wraps = endMin <= startMin;
      const windowLength = wraps ? (1440 - startMin + endMin) : (endMin - startMin);

      // 窗口内随机偏移 0 ~ randomDelayMin 分钟
      const maxDelay = Math.max(1, Math.min(59, slot.randomDelayMin || 60));
      let offset = Math.floor(Math.random() * maxDelay);

      if (isToday) {
        // 容器在窗口中途启动时不要立刻开跑，仍然随机延后 1~20 分钟（保持拟人化）
        const nowOffset = this.minutesIntoWindow(startMin, wraps, nowMin);
        if (nowOffset >= offset && nowOffset < windowLength) {
          offset = Math.min(windowLength - 1, nowOffset + 1 + Math.floor(Math.random() * 20));
        }
      }

      plans[acc.id] = {
        startMin,
        endMin,
        wraps,
        windowLength,
        offset,
        executed: false
      };
    }
  }

  /** 日期编号（YYYYMMDD）偏移若干天 */
  shiftDateNum(dateNum, deltaDays) {
    const d = new Date(
      Math.floor(dateNum / 10000),
      Math.floor((dateNum % 10000) / 100) - 1,
      dateNum % 100,
      12, 0, 0, 0
    );
    d.setDate(d.getDate() + deltaDays);
    return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
  }

  /** 某天计划的绝对执行时间戳（窗口起点日 + 偏移分钟） */
  planTimestamp(dateNum, plan, baseDayOffset = 0) {
    const base = new Date(
      Math.floor(dateNum / 10000),
      Math.floor((dateNum % 10000) / 100) - 1,
      dateNum % 100
    );
    if (baseDayOffset) base.setDate(base.getDate() + baseDayOffset);
    return base.getTime() + (plan.startMin + plan.offset) * 60000;
  }

  /**
   * 供 WebUI 展示：每个账号距下次自动执行的倒计时。
   * 返回 { [accountId]: { status, minutesUntil, nextRunAt, windowStart, windowEnd } }
   * status: scheduled(已排定) / imminent(即将启动)
   *         / no-credential(未配凭据) / disabled(账号停用) / schedule-off(定时关闭)
   */
  getNextRunInfo() {
    const cfg = configManager.get();
    const scheduleEnabled = cfg.schedule?.enabled !== false;
    const today = this.getTodayNum();
    const tomorrow = this.shiftDateNum(today, 1);

    if (scheduleEnabled) {
      this.initTodayPlan();
      // 预排明天：这样「今日已完成」的账号也能给出确切的下次执行倒计时
      this.ensureDayPlans(tomorrow, false);
    }

    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const todayPlans = this.plannedDailyRuns[String(today)] || {};
    const tomorrowPlans = this.plannedDailyRuns[String(tomorrow)] || {};
    const fmt = (m) => `${String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;
    const result = {};

    configManager.getAccounts().forEach((acc, index) => {
      const slot = acc.timeSlot || configManager.getDefaultTimeSlot(index);
      const startHour = slot.startHour ?? 9;
      const endHour = slot.endHour ?? ((startHour + 4) % 24);
      const info = {
        status: 'unknown',
        minutesUntil: null,
        nextRunAt: null,
        windowStart: fmt(startHour * 60),
        windowEnd: fmt(endHour * 60)
      };

      if (acc.enabled === false) {
        info.status = 'disabled';
      } else if (!acc.cookie && !acc.refreshToken) {
        info.status = 'no-credential';
      } else if (!scheduleEnabled) {
        info.status = 'schedule-off';
      } else {
        const todayPlan = todayPlans[acc.id];
        const tomorrowPlan = tomorrowPlans[acc.id];
        let nextAt = null;

        if (todayPlan && !todayPlan.executed) {
          // 跨零点窗口处于凌晨尾部时，窗口起点在昨天
          const baseDayOffset = (todayPlan.wraps && nowMin < todayPlan.endMin) ? -1 : 0;
          const plannedAt = this.planTimestamp(today, todayPlan, baseDayOffset);
          if (plannedAt > now.getTime()) {
            nextAt = plannedAt;
          } else {
            const nowOffset = this.minutesIntoWindow(todayPlan.startMin, todayPlan.wraps, nowMin);
            const inWindow = nowOffset >= 0 && nowOffset < todayPlan.windowLength;
            if (inWindow) nextAt = now.getTime(); // 窗口内，调度器下一分钟启动
          }
        }
        if (nextAt === null && tomorrowPlan) {
          nextAt = this.planTimestamp(tomorrow, tomorrowPlan, 0);
        }

        if (nextAt !== null) {
          info.nextRunAt = nextAt;
          info.minutesUntil = Math.max(0, Math.round((nextAt - now.getTime()) / 60000));
          info.status = info.minutesUntil <= 0 ? 'imminent' : 'scheduled';
        }
      }
      result[acc.id] = info;
    });

    return result;
  }

  start() {
    this.stop();
    const cfg = configManager.get();
    if (!cfg.schedule?.enabled) {
      logger.log('⏸️', '后台自动定时巡检当前已禁用');
      // Epic 自动领取独立于微软定时开关
      this.startEpicJob();
      return;
    }

    // 每分钟检查一次拟人化时段调度
    this.job = cron.schedule('* * * * *', async () => {
      if (taskManager.running) return;

      const today = this.getTodayNum();
      this.initTodayPlan();

      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const todayPlans = this.plannedDailyRuns[today] || {};

      const accounts = configManager.getAccounts().filter(a => a.enabled !== false);
      for (const acc of accounts) {
        if (!acc.cookie && !acc.refreshToken) continue;

        const plan = todayPlans[acc.id];
        if (!plan || plan.executed) continue;

        // 距离窗口起点的分钟数（跨零点窗口也能正确计算）
        const nowOffset = this.minutesIntoWindow(plan.startMin, plan.wraps, nowMin);

        const inWindow = nowOffset >= 0 && nowOffset < plan.windowLength;
        if (inWindow && nowOffset >= plan.offset) {
          plan.executed = true;
          const fmt = (m) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
          logger.log('⏰', `到达账号 [${acc.name}] 拟人作息窗口 (${fmt(plan.startMin)} - ${fmt(plan.endMin)}，今日随机命中 ${fmt(plan.startMin + plan.offset)})，启动打卡...`, '', acc.name);
          try {
            await taskManager.runAll(false, acc.id);
          } catch (e) {
            logger.log('🔴', `定时任务执行异常: ${e.message}`, '', acc.name);
          }
          break; // 一次只启动一个账号，保持单队列
        }
      }
    });

    logger.log('🟢', `后台时段拟人调度引擎已就绪 (9-13 / 13-17 / 17-21 / 21-次日01 时段错峰 + 60分钟随机浮动)`);
    this.startEpicJob();
  }

  /** Epic 免费游戏：每天过了配置整点后自动领取一次 */
  startEpicJob() {
    if (this.epicJob) {
      this.epicJob.stop();
      this.epicJob = null;
    }
    const cfg = configManager.get();
    if (cfg.epic?.enabled === false) {
      logger.log('⏸️', 'Epic 免费游戏自动领取已禁用');
      return;
    }

    // 每小时第 5 分钟检查一次：过了设定整点且今天还没领过就执行
    this.epicJob = cron.schedule('5 * * * *', async () => {
      if (epicManager.running) return;
      const c = configManager.get();
      if (c.epic?.enabled === false) return;

      const hour = Number(c.epic?.autoClaimHour ?? 10);
      const now = new Date();
      if (now.getHours() < hour) return;

      const today = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
      if (c.epic?.lastAutoClaimDate === today) return;

      const accounts = configManager.getEpicAccounts().filter(a => a.enabled !== false && a.storageState?.cookies?.length);
      if (accounts.length === 0) return;

      // 先记账再执行，避免异常导致每小时重复触发
      configManager.update({ epic: { lastAutoClaimDate: today } });
      logger.log('🎮', `Epic 每日自动领取开始（${accounts.length} 个账号）`);
      try {
        await epicManager.claimAll();
      } catch (e) {
        logger.log('🔴', `Epic 自动领取异常: ${e.message}`);
      }
    });

    logger.log('🎮', `Epic 免费游戏自动领取已就绪（每天 ${cfg.epic?.autoClaimHour ?? 10}:05 后检查）`);
  }

  stop() {
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
    if (this.epicJob) {
      this.epicJob.stop();
      this.epicJob = null;
    }
  }

  restart() {
    this.start();
  }
}

export const scheduler = new Scheduler();
export default scheduler;
