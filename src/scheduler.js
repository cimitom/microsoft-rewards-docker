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

  initTodayPlan() {
    const today = this.getTodayNum();
    if (!this.plannedDailyRuns[today]) {
      this.plannedDailyRuns[today] = {};
    }

    const accounts = configManager.getAccounts().filter(a => a.enabled !== false);
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      const slot = acc.timeSlot || configManager.getDefaultTimeSlot(i);
      if (!this.plannedDailyRuns[today][acc.id]) {
        // 在时段开始时刻内生成 0 ~ randomDelayMin (默认60分钟) 的随机延迟分钟
        const maxDelay = slot.randomDelayMin || 60;
        const randomMin = Math.floor(Math.random() * Math.min(59, maxDelay));
        this.plannedDailyRuns[today][acc.id] = {
          startHour: slot.startHour ?? 6,
          endHour: slot.endHour ?? 10,
          plannedMinute: randomMin,
          executed: false
        };
      }
    }
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
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();
      const todayPlans = this.plannedDailyRuns[today] || {};

      const accounts = configManager.getAccounts().filter(a => a.enabled !== false);
      for (const acc of accounts) {
        if (!acc.cookie && !acc.refreshToken) continue;

        const plan = todayPlans[acc.id];
        if (!plan || plan.executed) continue;

        // 检查是否到达该账号的专属拟人作息时间窗口
        const isStartHourMatch = (currentHour === plan.startHour && currentMinute >= plan.plannedMinute);
        const isWithinWindow = (currentHour > plan.startHour && currentHour < plan.endHour);

        if (isStartHourMatch || isWithinWindow) {
          plan.executed = true;
          logger.log('⏰', `到达账号 [${acc.name}] 拟人作息窗口 (${plan.startHour}:00 - ${plan.endHour}:00，今日随机命中 ${String(plan.startHour).padStart(2,'0')}:${String(plan.plannedMinute).padStart(2,'0')})，启动打卡...`, '', acc.name);
          try {
            await taskManager.runAll(false, acc.id);
          } catch (e) {
            logger.log('🔴', `定时任务执行异常: ${e.message}`, '', acc.name);
          }
          break; // 一次只启动一个账号，保持单队列
        }
      }
    });

    logger.log('🟢', `后台时段拟人调度引擎已就绪 (6-10 / 10-14 / 14-18 / 18-22 时段错峰 + 60分钟随机浮动)`);
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
