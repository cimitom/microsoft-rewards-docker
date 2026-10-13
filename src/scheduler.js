import cron from 'node-cron';
import configManager from './config.js';
import logger from './logger.js';
import taskManager from './core/taskManager.js';

class Scheduler {
  constructor() {
    this.job = null;
  }

  start() {
    this.stop();
    const cfg = configManager.get();
    if (!cfg.schedule?.enabled) {
      logger.log('⏸️', '后台自动定时巡检当前已禁用');
      return;
    }

    const cronExpr = cfg.schedule?.cron || '*/25 * * * *';
    if (!cron.validate(cronExpr)) {
      logger.log('🔴', `无效的 Cron 表达式 "${cronExpr}"，已回退至默认 "*/25 * * * *"`);
    }

    const validExpr = cron.validate(cronExpr) ? cronExpr : '*/25 * * * *';
    this.job = cron.schedule(validExpr, async () => {
      const accounts = configManager.getAccounts().filter(a => a.enabled !== false);
      const hasValidAccount = accounts.some(a => a.cookie || a.refreshToken);
      if (!hasValidAccount) {
        logger.log('🟡', '定时任务跳过：尚未配置任何已启用的微软账户 Cookie 或 Token');
        return;
      }

      const status = taskManager.getStatus('all');
      const allDone = status.summary?.overallPercent === 100;
      const currentCfg = configManager.get();
      if (allDone && !currentCfg.tasks?.keepRunning) {
        logger.log('💤', '今日所有账号任务均已全部达成，跳过本次巡检');
        return;
      }

      // 随机延迟 5~45 秒启动以防固定时间点特征风控
      const delaySec = Math.floor(Math.random() * 40) + 5;
      logger.log('⏰', `定时巡检触发，将在 ${delaySec} 秒随机安全延时后启动...`);
      setTimeout(() => {
        taskManager.runAll(false);
      }, delaySec * 1000);
    });

    logger.log('🟢', `后台定时调度器已启动，执行周期: [${validExpr}]`);
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
