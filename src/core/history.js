import fs from 'fs';
import path from 'path';
import { DATA_DIR, writeFileAtomic } from '../fsUtil.js';

const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

class HistoryManager {
  constructor() {
    this.ensureFile();
  }

  ensureFile() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(HISTORY_FILE)) {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify({ accounts: {}, global: {} }, null, 2), 'utf-8');
    }
  }

  load() {
    try {
      this.ensureFile();
      const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (!data.accounts || typeof data.accounts !== 'object') {
        data.accounts = {};
      }
      if (!data.global || typeof data.global !== 'object') {
        data.global = {};
      }
      return data;
    } catch {
      return { accounts: {}, global: {} };
    }
  }

  save(data) {
    try {
      this.ensureFile();
      writeFileAtomic(HISTORY_FILE, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    } catch (e) {
      console.error('[History] 保存历史记录失败:', e.message);
    }
  }

  formatDate(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  getDayLabel(d) {
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${month}-${day}`;
  }

  getWeekday(d) {
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return days[d.getDay()];
  }

  getDefaultBreakdown(earned = 140) {
    if (earned <= 0) {
      return [
        { name: "每日双端签入", points: 0, icon: "📱" },
        { name: "新闻资讯阅读", points: 0, icon: "📖" },
        { name: "必应 PC 搜索", points: 0, icon: "🔍" },
        { name: "每日活动集", points: 0, icon: "📅" },
        { name: "活动卡片与Quiz", points: 0, icon: "🧩" }
      ];
    }
    return [
      { name: "每日双端签入", points: 10, icon: "📱" },
      { name: "新闻资讯阅读", points: 30, icon: "📖" },
      { name: "必应 PC 搜索", points: Math.max(0, earned - 80), icon: "🔍" },
      { name: "每日活动集", points: 30, icon: "📅" },
      { name: "活动卡片与Quiz", points: 10, icon: "🧩" }
    ];
  }

  /**
   * 记录特定账号的当日账单
   */
  recordAccountDay(accountId, dateStr, data) {
    const history = this.load();
    if (!history.accounts[accountId]) {
      history.accounts[accountId] = {};
    }
    history.accounts[accountId][dateStr] = {
      date: dateStr,
      timestamp: Date.now(),
      earned: data.earned || 0,
      balance: data.balance || 0,
      breakdown: data.breakdown || this.getDefaultBreakdown(data.earned || 0)
    };
    this.save(history);
  }

  /**
   * 记录全局汇总账单
   */
  recordGlobalDay(dateStr, data) {
    const history = this.load();
    history.global[dateStr] = {
      date: dateStr,
      timestamp: Date.now(),
      earned: data.earned || 0,
      balance: data.balance || 0,
      breakdown: data.breakdown || this.getDefaultBreakdown(data.earned || 0)
    };
    this.save(history);
  }

  /**
   * 获取历史记录（支持特定账号与全局汇总）
   */
  getHistory(days = 7, accountId = 'all', taskManagerStats = {}) {
    const history = this.load();
    const result = [];
    const now = new Date();
    const isAll = !accountId || accountId === 'all';

    // 确定当前账号或全局当前状态
    let currentBalance = 0;
    let currentEarned = 0;
    let accountHistoryMap = {};
    const statsAccounts = taskManagerStats.accounts || {};
    const accountNameOf = (id) => statsAccounts[id]?.name || id;

    if (isAll) {
      // 汇总模式的当前值必须是“各账号相加”，不能回退到旧版顶层字段（那只是主账号自己的值）
      const hasAccounts = Object.keys(statsAccounts).length > 0;
      const sumEarned = Object.values(statsAccounts).reduce((a, s) => a + Number(s?.earned || 0), 0);
      const sumBalance = Object.values(statsAccounts).reduce((a, s) => a + Number(s?.balance || 0), 0);
      currentEarned = taskManagerStats.summary?.totalEarned ?? (hasAccounts ? sumEarned : Number(taskManagerStats.earned || 0));
      currentBalance = taskManagerStats.summary?.totalBalance ?? (hasAccounts ? sumBalance : Number(taskManagerStats.balance || 0));
    } else {
      const accSt = taskManagerStats.accounts?.[accountId] || taskManagerStats;
      currentBalance = accSt.balance || 0;
      currentEarned = accSt.earned || 0;
      accountHistoryMap = history.accounts?.[accountId] || {};
    }

    for (let i = days - 1; i >= 0; i--) {
      const targetDate = new Date(now.getTime() - i * 86400000);
      const dateKey = this.formatDate(targetDate);
      const dayLabel = this.getDayLabel(targetDate);
      const weekday = i === 0 ? '今天' : this.getWeekday(targetDate);

      if (isAll) {
        // 汇总模式：始终以“各账号当天记录相加”为准，并附带每个账号的明细
        let dayEarned = 0;
        let dayBalance = 0;
        let foundAny = false;
        const accountsBreakdown = [];

        for (const [accId, accHist] of Object.entries(history.accounts || {})) {
          const rec = accHist?.[dateKey];
          if (!rec) continue;
          const earned = Number(rec.earned || 0);
          const balance = Number(rec.balance || 0);
          dayEarned += earned;
          dayBalance += balance;
          accountsBreakdown.push({ id: accId, name: accountNameOf(accId), earned, balance });
          foundAny = true;
        }

        // 没有任何账号记录时，才退回旧版全局汇总记录
        if (!foundAny && history.global?.[dateKey]) {
          dayEarned = Number(history.global[dateKey].earned || 0);
          dayBalance = Number(history.global[dateKey].balance || 0);
          foundAny = true;
        }

        if (i === 0) {
          // 今天用各账号实时统计之和，保证与首页 Hero 数值一致
          const liveBreakdown = Object.entries(statsAccounts).map(([id, s]) => ({
            id,
            name: s?.name || accountNameOf(id),
            earned: Number(s?.earned || 0),
            balance: Number(s?.balance || 0)
          }));
          result.push({
            date: dateKey,
            dayLabel,
            weekday,
            earned: currentEarned,
            balance: currentBalance,
            accounts: liveBreakdown,
            breakdown: this.getDefaultBreakdown(currentEarned)
          });
        } else if (foundAny) {
          result.push({
            date: dateKey,
            dayLabel,
            weekday,
            earned: dayEarned,
            balance: dayBalance,
            accounts: accountsBreakdown,
            breakdown: this.getDefaultBreakdown(dayEarned)
          });
        } else {
          // 预估历史趋势 (基于当前总余额回退)
          const seed = (targetDate.getDate() * 19) % 25;
          const estEarned = Math.max(0, 140 + seed);
          const estBalance = Math.max(0, currentBalance - (i * 150));
          result.push({
            date: dateKey,
            dayLabel,
            weekday,
            earned: estEarned,
            balance: estBalance,
            breakdown: this.getDefaultBreakdown(estEarned)
          });
        }
      } else {
        // 单账号独立模式：只返回该账号自己的账单
        if (i === 0) {
          result.push({
            date: dateKey,
            dayLabel,
            weekday,
            earned: currentEarned,
            balance: currentBalance,
            breakdown: this.getDefaultBreakdown(currentEarned)
          });
        } else if (accountHistoryMap[dateKey]) {
          result.push({
            ...accountHistoryMap[dateKey],
            dayLabel,
            weekday
          });
        } else {
          // 如果该账号早前没有记录，根据该账号自己的真实余额生成合理区间
          let estEarned = 0;
          let estBalance = currentBalance;
          if (currentBalance > 1000) {
            // 大号平缓增长
            const seed = (targetDate.getDate() * 17) % 20;
            estEarned = 130 + seed;
            estBalance = Math.max(0, currentBalance - (i * 140));
          } else {
            // 新号（如几十分~几百分），早前天数为 0 或微量
            estEarned = i > 1 ? 0 : Math.min(currentBalance, 30);
            estBalance = Math.max(0, currentBalance - (i * 30));
          }

          result.push({
            date: dateKey,
            dayLabel,
            weekday,
            earned: estEarned,
            balance: estBalance,
            breakdown: this.getDefaultBreakdown(estEarned)
          });
        }
      }
    }

    return result;
  }
}

export const historyManager = new HistoryManager();
export default historyManager;
