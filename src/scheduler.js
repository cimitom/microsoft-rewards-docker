import cron from 'node-cron';
import configManager from './config.js';
import logger from './logger.js';
import taskManager from './core/taskManager.js';

class Scheduler {
  constructor() {
    this.job = null;
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
    if (!this.plannedDailyRuns[today]) {
      this.plannedDailyRuns[today] = {};
    }

    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();

    const accounts = configManager.getAccounts().filter(a => a.enabled !== false);
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      if (this.plannedDailyRuns[today][acc.id]) continue;

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

      // 容器在窗口中途启动时不要立刻开跑，仍然随机延后 1~20 分钟（保持拟人化）
      const nowOffset = this.minutesIntoWindow(startMin, wraps, nowMin);
      if (nowOffset >= offset && nowOffset < windowLength) {
        offset = Math.min(windowLength - 1, nowOffset + 1 + Math.floor(Math.random() * 20));
      }

      this.plannedDailyRuns[today][acc.id] = {
        startMin,
        endMin,
        wraps,
        windowLength,
        offset,
        executed: false
      };
    }

    // 清理历史日期的计划，避免 plannedDailyRuns 无限增长
    // 注意：对象 key 是字符串，today 是数字，必须转成字符串比较
    const todayKey = String(today);
    for (const key of Object.keys(this.plannedDailyRuns)) {
      if (key !== todayKey) delete this.plannedDailyRuns[key];
    }
  }

  /**
   * 供 WebUI 展示：每个账号的下次启动情况。
   * 返回 { [accountId]: { status, plannedAt, minutesUntil, windowStart, windowEnd, isNextDay } }
   * status: scheduled(今日已排定) / imminent(窗口内即将启动) / done(今日已完成)
   *         / no-credential(未配凭据) / disabled(账号停用) / schedule-off(定时关闭)
   */
  getNextRunInfo() {
    const cfg = configManager.get();
    const scheduleEnabled = cfg.schedule?.enabled !== false;
    if (scheduleEnabled) this.initTodayPlan();

    const today = this.getTodayNum();
    const plans = this.plannedDailyRuns[today] || {};
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const fmt = (m) => `${String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;
    const result = {};

    const accounts = configManager.getAccounts();
    accounts.forEach((acc, index) => {
      const slot = acc.timeSlot || configManager.getDefaultTimeSlot(index);
      const startHour = slot.startHour ?? 9;
      const endHour = slot.endHour ?? ((startHour + 4) % 24);
      const info = {
        status: 'scheduled',
        plannedAt: null,
        minutesUntil: null,
        isNextDay: false,
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
        const plan = plans[acc.id];
        if (plan?.executed) {
          info.status = 'done';
        } else if (plan) {
          // 计划时刻 = 本次窗口起点 + 随机偏移。
          // 跨零点窗口要注意：若当前处于凌晨尾部（如 21:00-01:00 的 00:30），
          // 窗口起点在「昨天」，否则会把计划时刻算到明天去。
          const startDate = new Date(now);
          startDate.setHours(0, 0, 0, 0);
          startDate.setMinutes(plan.startMin);
          if (plan.wraps && nowMin < plan.endMin) {
            startDate.setDate(startDate.getDate() - 1);
          }
          const planAt = new Date(startDate.getTime() + plan.offset * 60000);
          const diffMin = Math.round((planAt.getTime() - now.getTime()) / 60000);
          const nowOffset = this.minutesIntoWindow(plan.startMin, plan.wraps, nowMin);
          const inWindow = nowOffset >= 0 && nowOffset < plan.windowLength;

          if (inWindow && diffMin > 0) {
            info.status = 'scheduled';
            info.plannedAt = fmt(planAt.getHours() * 60 + planAt.getMinutes());
            info.minutesUntil = diffMin;
            info.isNextDay = planAt.getDate() !== now.getDate();
          } else if (inWindow) {
            // 计划时刻已过但还没执行：调度器下一分钟就会启动
            info.status = 'imminent';
            info.minutesUntil = 0;
          } else {
            // 今日窗口已经过去（且今日未执行），下次要等明天
            info.status = 'window-passed';
          }
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
  }

  stop() {
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
  }

  restart() {
    this.start();
  }
}

export const scheduler = new Scheduler();
export default scheduler;
