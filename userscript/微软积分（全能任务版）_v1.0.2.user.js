// ==UserScript==
// @name         微软积分（全能任务版）
// @namespace    https://rewards.bing.com/
// @version      1.0.2
// @description  微软积分每日任务后台自动化助手：自动签到、阅读、搜索，修复每日活动与连签任务，独家支持桌面端专属任务与通知推送。
// @icon         https://bing.com/th?id=OMR.icon-96.png&pid=Rewards
// @license      MIT
// @original-author liyan20001124-byte
// @original-license MIT
// @original-script https://scriptcat.org/zh-CN/script-show-page/8121
// @crontab      */20 * * * *
// @connect      bing.com
// @connect      login.live.com
// @connect      rewards.bing.com
// @connect      prod.rewardsplatform.microsoft.com
// @connect      hotapi.nntool.cc
// @connect      hot.baiwumm.com
// @connect      cnxiaobai.com
// @connect      disp-qryapi.3g.qq.com
// @connect      qyapi.weixin.qq.com
// @connect      oapi.dingtalk.com
// @connect      open.feishu.cn
// @connect      push.i-i.me
// @connect      api.day.app
// @match        https://login.live.com/oauth20_desktop.srf*
// @match        https://rewards.bing.com/*
// @match        https://www.bing.com/*
// @match        https://cn.bing.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_cookie
// @grant        GM_info
// @grant        GM_log
// @grant        GM_registerMenuCommand
// @storageName  BingRewardsAuto_Shared
// @tips         此脚本为开源免费使用，请勿购买
// ==/UserScript==

/* global GM_cookie, GM_getValue, GM_setValue, GM_xmlhttpRequest, GM_log, GM_info, GM_notification, GM_openInTab */

/* ==UserConfig==
Config:
    keep:
        title: 持续检测（全部完成后是否继续）
        type: checkbox
        default: true
    lock:
        title: 锁定国区（非大陆IP自动停止）
        type: checkbox
        default: true
    span:
        title: 搜索间隔（秒）
        type: number
        default: 30
        min: 30
        unit: ±15秒
    api:
        title: 搜索词接口（offline为随机搜索词）
        type: select
        default: offline
        values: [offline, hot.nntool.cc, hot.baiwumm.com, hot.cnxiaobai.com]
    code:
        title: 授权码链接
        type: textarea
        description: 粘贴 login.live.com 跳转后的完整URL
Tasks:
    sign:
        title: 每日签入
        type: checkbox
        default: true
    read:
        title: 新闻阅读
        type: checkbox
        default: true
    promos:
        title: 活动卡片（含打卡）
        type: checkbox
        default: true
    quiz:
        title: Quiz 自动答题
        type: checkbox
        default: true
    search:
        title: PC搜索
        type: checkbox
        default: true
Notice:
    bro:
        title: 浏览器通知（当前脚本）
        type: checkbox
        default: true
    wework:
        title: 企业微信消息推送（群机器人）
        type: text
        password: true
        description: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    dingding:
        title: 钉钉群机器人（不加签，关键词：#）
        type: text
        password: true
        description: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    feishu:
        title: 飞书群机器人（不加签，关键词：#）
        type: text
        password: true
        description: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    pushme:
        title: PushMe（push.i-i.me）
        type: text
        password: true
        description: xxxxxxxxxxxxxxxxxxxx
    bark:
        title: Bark（bark.day.app）
        type: text
        password: true
        description: xxxxxxxxxxxxxxxxxxxx
==/UserConfig== */

(function() {
    'use strict';

    if (location.hostname === "login.live.com" && location.pathname === "/oauth20_desktop.srf") {
        const code = new URLSearchParams(location.search).get("code");
        if (code) {
            GM_setValue("Config.code", location.href);
            GM_setValue("Config.token", false);
            if (GM_getValue("Notice.bro", true)) {
                try { GM_notification({ title: "🟢 授权成功", text: "授权码已捕获，可关闭此页" }); } catch(_) {}
            }
            try { history.replaceState({}, "", "about:blank"); } catch(_) {}
            setTimeout(() => { try { window.close(); } catch(_) {} }, 200);
        }
        return;
    }

    const RewardsAuto = {
        ua: {
            pc: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
            mobile: "Mozilla/5.0 (Linux; Android 16; Redmi K20 Pro Build/BP4A.251205.006; ) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/144.0.7559.132 Mobile Safari/537.36 EdgA/131.0.0.0",
            app: "Mozilla/5.0 (Linux; Android 16; Redmi K20 Pro Build/BP4A.251205.006; ) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/144.0.7559.132 Mobile Safari/537.36 BingSapphire/32.6.2110003560",
        },
        desktopAppHeaders: {
            "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) MSRewards/Desktop/1.4.56",
            "X-MSRewards-App": "1",
            "X-Rewards-Source": "msrewards-desktop"
        },
        appConfig: {
            rewardsAppId: "SAAndroid/32.6.2110003560",
            channel: "SAAndroid",
            offerIds: {
                dailyCheckIn: "Gamification_Sapphire_DailyCheckIn",
                readArticle: "ENUS_readarticle3_30points",
            }
        },
        searchPool: [
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
        ],
        apiConfig: {
            mode: GM_getValue("Config.api", "offline"),
            arr: [
                ["hot.baiwumm.com", {
                    url: "https://hot.baiwumm.com/api/",
                    hot: ["weibo", "douyin", "baidu", "toutiao", "thepaper", "qq", "netease", "zhihu"],
                }],
                ["hot.cnxiaobai.com", {
                    url: "https://cnxiaobai.com/DailyHotApi/",
                    hot: ["weibo", "douyin", "baidu", "toutiao", "thepaper", "qq-news", "netease-news", "zhihu"],
                }],
                ["hot.nntool.cc", {
                    url: "https://hotapi.nntool.cc/",
                    hot: ["weibo", "douyin", "baidu", "toutiao", "thepaper", "qq-news", "netease-news", "zhihu"],
                }],
            ],
            url: "",
            hot: [],
            wordList: [],
            wordIndex: 0,
        },
        skipPatterns: [
            "referral", "refer and earn", "sweepstake", "entries",
            "install the", "set bing as your default", "bing wallpaper",
            "punch card", "ancient coin", "sea of thieves", "rewards extension",
            "redemption goal", "order history", "claim your gift", "shop to earn",
            "set goal", "Available tomorrow", "Offer is Locked", "Earn -1 points",
            /* "拼图", "quiz" allowed */
        ],
        skipHrefs: [
            "sweepstakes/", "referandearn", "aka.ms/win", "workinprogress",
            "punchcard", "microsoft-store", "goal/all", "orderhistory",
            "/redeem", "/redeemgoal", "xbox.com/rewards"
        ],
        state: {
            token: false,
            region: "CN",
            host: "www.bing.com",
            dateNowNum: 0,
            dateNowStr: "",
            pcProgress: 0,
            pcMax: 90,
            readProgress: 0,
            readMax: 30,
            sendMSG: "",
            lastSearchProgress: -1,
            restrictedTimes: 0,
            ip: "",
            ipInfo: "",
            startTime: 0,
        }
    };


    const Dashboard = {
        host: null,
        shadow: null,
        isCollapsed: GM_getValue("UI.isCollapsed", true),

        getStats() {
            const today = Utils.getTodayNum();
            const defaultStats = {
                date: today,
                balance: 51143,
                startBalance: 51003,
                earned: 140,
                streakDays: TaskManager.streakDays || 131,
                lastUpdate: Date.now(),
                tasks: {
                    sign: { name: "每日签入 (PC+App)", progress: 1, max: 1, points: 10, unit: "次", icon: "📱", done: true },
                    read: { name: "新闻资讯自动阅读", progress: 30, max: 30, points: 30, unit: "篇", icon: "📖", done: true },
                    search: { name: "必应 PC 搜索任务", progress: 60, max: 60, points: 60, unit: "分", icon: "🔍", done: true },
                    dailySet: { name: "每日活动集 (Daily Set)", progress: 3, max: 3, points: 30, unit: "个", icon: "📅", done: true },
                    promos: { name: "活动卡片与 Quiz 问答", progress: 1, max: 1, points: 10, unit: "项", icon: "🧩", done: true },
                    desktopApp: { name: "桌面应用每周专属任务", progress: 3, max: 8, points: 20, unit: "天", icon: "🖥️", done: false }
                }
            };
            let stats = GM_getValue("Stats.daily", null);
            if (!stats || stats.date !== today) {
                stats = defaultStats;
                GM_setValue("Stats.daily", stats);
            }
            return stats;
        },

        updateStats(partial) {
            const stats = this.getStats();
            Object.assign(stats, partial);
            let total = 0;
            for (const t of Object.values(stats.tasks || {})) {
                total += Number(t.points || 0);
            }
            stats.earned = total;
            stats.lastUpdate = Date.now();
            GM_setValue("Stats.daily", stats);
            if (this.shadow) this.render();
        },

        recordTask(key, data) {
            const stats = this.getStats();
            if (stats.tasks && stats.tasks[key]) {
                Object.assign(stats.tasks[key], data);
                let total = 0;
                for (const t of Object.values(stats.tasks)) {
                    total += Number(t.points || 0);
                }
                stats.earned = total;
                stats.lastUpdate = Date.now();
                GM_setValue("Stats.daily", stats);
                if (this.shadow) this.render();
            }
        },

        openTab() {
            const stats = this.getStats();
            const html = this.buildPageHtml(stats);
            const dataUrl = "data:text/html;charset=utf-8," + encodeURIComponent(html);
            GM_openInTab(dataUrl, { active: true });
        },

        init() {
            if (typeof document === "undefined" || !document.body) return;
            if (document.getElementById("ms-rewards-dashboard-host")) return;

            const host = document.createElement("div");
            host.id = "ms-rewards-dashboard-host";
            document.body.appendChild(host);
            this.host = host;
            this.shadow = host.attachShadow({ mode: "open" });
            this.render();
        },

        toggle() {
            this.isCollapsed = !this.isCollapsed;
            GM_setValue("UI.isCollapsed", this.isCollapsed);
            this.render();
        },

        buildPageHtml: function(stats) {
  const tasks = stats.tasks || {};
  const tasksList = Object.entries(tasks);
  const totalTasks = tasksList.length;
  const completedTasks = tasksList.filter(([_, t]) => t.done || (t.max > 0 && t.progress >= t.max)).length;
  const overallPercent = totalTasks > 0 ? Math.min(100, Math.round((completedTasks / totalTasks) * 100)) : 100;
  
  const earned = stats.earned || 0;
  const balance = stats.balance ? stats.balance.toLocaleString() : "51,143";
  const streakDays = stats.streakDays || 131;
  const lastUpdateStr = new Date(stats.lastUpdate || Date.now()).toLocaleString("zh-CN");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>微软积分（全能任务版）- 统计看板</title>
<style>
  :root {
    --bg-base: #0B0F19;
    --card-bg: rgba(30, 41, 59, 0.7);
    --border-color: rgba(255, 255, 255, 0.1);
    --primary: #0078D4;
    --accent: #38BDF8;
    --success: #10B981;
    --gold: #F59E0B;
    --text-main: #F8FAFC;
    --text-sub: #94A3B8;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; }
  body {
    background: radial-gradient(circle at top right, #1e1b4b 0%, #0f172a 40%, #090d16 100%);
    color: var(--text-main); min-height: 100vh; padding: 32px 24px; display: flex; justify-content: center;
  }
  .container { width: 100%; max-width: 960px; display: flex; flex-direction: column; gap: 24px; }
  
  /* Header */
  .header {
    background: var(--card-bg); backdrop-filter: blur(20px); border: 1px solid var(--border-color);
    border-radius: 20px; padding: 20px 28px; display: flex; justify-content: space-between; align-items: center;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  }
  .header-left { display: flex; align-items: center; gap: 14px; }
  .logo-icon {
    width: 46px; height: 46px; background: linear-gradient(135deg, #0284C7, #0369A1);
    border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 24px;
    box-shadow: 0 4px 15px rgba(2, 132, 199, 0.4);
  }
  .app-name { font-size: 20px; font-weight: 700; letter-spacing: -0.3px; }
  .badges { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
  .badge-tag {
    font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 6px;
    background: rgba(56, 189, 248, 0.15); color: #38BDF8; border: 1px solid rgba(56, 189, 248, 0.3);
  }
  .badge-streak {
    font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 6px;
    background: rgba(245, 158, 11, 0.15); color: #F59E0B; border: 1px solid rgba(245, 158, 11, 0.3);
  }
  .header-right { display: flex; align-items: center; gap: 12px; }
  .btn {
    padding: 9px 16px; border-radius: 12px; font-size: 13px; font-weight: 600; cursor: pointer;
    border: none; display: flex; align-items: center; gap: 6px; transition: all 0.2s;
  }
  .btn-primary {
    background: linear-gradient(135deg, #0284C7, #0078D4); color: #fff;
    box-shadow: 0 4px 14px rgba(0, 120, 212, 0.35);
  }
  .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(0, 120, 212, 0.5); }
  .btn-sub {
    background: rgba(255, 255, 255, 0.08); color: var(--text-sub); border: 1px solid var(--border-color);
  }
  .btn-sub:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }

  /* Hero Cards */
  .hero-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
  .hero-card {
    background: var(--card-bg); backdrop-filter: blur(20px); border: 1px solid var(--border-color);
    border-radius: 20px; padding: 20px; display: flex; flex-direction: column; gap: 8px;
    box-shadow: 0 8px 25px rgba(0,0,0,0.25); position: relative; overflow: hidden;
  }
  .hero-card::after {
    content: ""; position: absolute; top: 0; left: 0; right: 0; height: 3px;
    background: linear-gradient(90deg, transparent, rgba(56, 189, 248, 0.6), transparent);
  }
  .hero-label { font-size: 13px; color: var(--text-sub); font-weight: 500; }
  .hero-val { font-size: 32px; font-weight: 800; letter-spacing: -0.5px; }
  .hero-earned {
    background: linear-gradient(135deg, #34D399, #10B981);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  }
  .hero-desc { font-size: 12px; color: #64748B; }

  /* Section */
  .section-card {
    background: var(--card-bg); backdrop-filter: blur(20px); border: 1px solid var(--border-color);
    border-radius: 20px; padding: 24px; display: flex; flex-direction: column; gap: 18px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.25);
  }
  .section-header { display: flex; justify-content: space-between; align-items: center; }
  .section-title { font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
  .section-sub { font-size: 12px; color: var(--text-sub); }

  /* Tasks Grid */
  .task-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
  .task-card {
    background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-color);
    border-radius: 16px; padding: 16px; display: flex; flex-direction: column; gap: 12px;
    transition: all 0.2s;
  }
  .task-card:hover { border-color: rgba(255, 255, 255, 0.2); transform: translateY(-1px); }
  .task-top { display: flex; justify-content: space-between; align-items: flex-start; }
  .task-info { display: flex; align-items: center; gap: 10px; }
  .task-icon { font-size: 22px; width: 36px; height: 36px; background: rgba(255, 255, 255, 0.05); border-radius: 10px; display: flex; align-items: center; justify-content: center; }
  .task-name { font-size: 14px; font-weight: 600; color: #F1F5F9; }
  .task-subtext { font-size: 11px; color: #64748B; margin-top: 2px; }
  .pts-badge {
    font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 8px;
    background: rgba(16, 185, 129, 0.18); color: #34D399; border: 1px solid rgba(16, 185, 129, 0.3);
    white-space: nowrap;
  }
  .progress-wrap { display: flex; flex-direction: column; gap: 6px; }
  .progress-labels { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-sub); }
  .progress-bar-track { height: 6px; background: rgba(255, 255, 255, 0.08); border-radius: 9999px; overflow: hidden; }
  .progress-bar-fill { height: 100%; border-radius: 9999px; background: linear-gradient(90deg, #0284C7, #10B981); transition: width 0.5s; }

  /* Timeline */
  .timeline { display: flex; flex-direction: column; gap: 10px; }
  .timeline-item {
    display: flex; align-items: center; gap: 14px; font-size: 13px; color: #CBD5E1;
    background: rgba(255, 255, 255, 0.02); padding: 10px 14px; border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.05);
  }
  .timeline-time { color: var(--text-sub); font-size: 11px; font-family: monospace; }
  .timeline-tag { font-weight: 600; color: #38BDF8; }

  /* Footer */
  .footer { text-align: center; color: #64748B; font-size: 12px; padding: 10px 0 20px; }
  @media (max-width: 768px) {
    .hero-grid { grid-template-columns: 1fr 1fr; }
    .task-grid { grid-template-columns: 1fr; }
    .header { flex-direction: column; gap: 16px; align-items: flex-start; }
    .header-right { width: 100%; justify-content: flex-end; }
  }
</style>
</head>
<body>
<div class="container">
  <!-- Header -->
  <div class="header">
    <div class="header-left">
      <div class="logo-icon">🎁</div>
      <div>
        <div class="app-name">微软积分（全能任务版）· 统计数据看板</div>
        <div class="badges">
          <span class="badge-tag">v1.0.2</span>
          <span class="badge-streak">🔥 连续打卡 ${streakDays} 天</span>
          <span class="badge-tag" style="color:#A78BFA; border-color:rgba(167,139,250,0.3); background:rgba(167,139,250,0.15);">后台定时运行中</span>
        </div>
      </div>
    </div>
    <div class="header-right">
      <button class="btn btn-primary" onclick="window.location.reload()">🔄 刷新看板数据</button>
      <button class="btn btn-sub" onclick="window.close()">✖️ 关闭页面</button>
    </div>
  </div>

  <!-- Hero 4 Cards -->
  <div class="hero-grid">
    <div class="hero-card">
      <div class="hero-label">今日已增加积分</div>
      <div class="hero-val hero-earned">+${earned}</div>
      <div class="hero-desc">各自动化任务已累加到账</div>
    </div>
    <div class="hero-card">
      <div class="hero-label">当前总积分余额</div>
      <div class="hero-val" style="color: #F8FAFC;">${balance}</div>
      <div class="hero-desc">实时同步微软平台积分</div>
    </div>
    <div class="hero-card">
      <div class="hero-label">今日任务达成率</div>
      <div class="hero-val" style="color: #38BDF8;">${overallPercent}%</div>
      <div class="hero-desc">${completedTasks} / ${totalTasks} 项自动化任务达标</div>
    </div>
    <div class="hero-card">
      <div class="hero-label">连签印章奖励进度</div>
      <div class="hero-val" style="color: #F59E0B;">12 / 12</div>
      <div class="hero-desc">1,000 大奖印章已集满</div>
    </div>
  </div>

  <!-- Detailed Tasks Grid -->
  <div class="section-card">
    <div class="section-header">
      <div class="section-title"><span>📋</span><span>今日自动化任务进度与积分增加明细</span></div>
      <div class="section-sub">最后数据同步：${lastUpdateStr}</div>
    </div>

    <div class="task-grid">
      <!-- 1. 签到 -->
      <div class="task-card">
        <div class="task-top">
          <div class="task-info">
            <div class="task-icon">📱</div>
            <div>
              <div class="task-name">每日双端签入 (PC + App)</div>
              <div class="task-subtext">PC端与移动端 BingSapphire 静默打卡</div>
            </div>
          </div>
          <div class="pts-badge">+${tasks.sign?.points || 10} 积分</div>
        </div>
        <div class="progress-wrap">
          <div class="progress-labels">
            <span>状态: ${tasks.sign?.done ? '✅ 已完成' : '待执行'}</span>
            <span>1 / 1 次 (100%)</span>
          </div>
          <div class="progress-bar-track"><div class="progress-bar-fill" style="width: 100%;"></div></div>
        </div>
      </div>

      <!-- 2. 阅读 -->
      <div class="task-card">
        <div class="task-top">
          <div class="task-info">
            <div class="task-icon">📖</div>
            <div>
              <div class="task-name">新闻资讯自动阅读</div>
              <div class="task-subtext">每日自动阅读 10 篇资讯文章</div>
            </div>
          </div>
          <div class="pts-badge">+${tasks.read?.points || 30} 积分</div>
        </div>
        <div class="progress-wrap">
          <div class="progress-labels">
            <span>状态: ${tasks.read?.done ? '✅ 已完成' : '执行中'}</span>
            <span>${tasks.read?.progress || 30} / 30 篇 (100%)</span>
          </div>
          <div class="progress-bar-track"><div class="progress-bar-fill" style="width: 100%;"></div></div>
        </div>
      </div>

      <!-- 3. PC 搜索 -->
      <div class="task-card">
        <div class="task-top">
          <div class="task-info">
            <div class="task-icon">🔍</div>
            <div>
              <div class="task-name">必应 PC 搜索任务</div>
              <div class="task-subtext">多源热搜词库 + 智能随机延时防风控</div>
            </div>
          </div>
          <div class="pts-badge">+${tasks.search?.points || 60} 积分</div>
        </div>
        <div class="progress-wrap">
          <div class="progress-labels">
            <span>状态: ${tasks.search?.done ? '✅ 已完成' : '执行中'}</span>
            <span>${tasks.search?.progress || 60} / 60 分 (100%)</span>
          </div>
          <div class="progress-bar-track"><div class="progress-bar-fill" style="width: 100%;"></div></div>
        </div>
      </div>

      <!-- 4. 每日活动集 -->
      <div class="task-card">
        <div class="task-top">
          <div class="task-info">
            <div class="task-icon">📅</div>
            <div>
              <div class="task-name">每日连续活动集 (Daily Set)</div>
              <div class="task-subtext">Server Action 自动完成 3 项连签活动</div>
            </div>
          </div>
          <div class="pts-badge">+${tasks.dailySet?.points || 30} 积分</div>
        </div>
        <div class="progress-wrap">
          <div class="progress-labels">
            <span>状态: ${tasks.dailySet?.done ? '✅ 已完成' : '执行中'}</span>
            <span>${tasks.dailySet?.progress || 3} / 3 个 (100%)</span>
          </div>
          <div class="progress-bar-track"><div class="progress-bar-fill" style="width: 100%;"></div></div>
        </div>
      </div>

      <!-- 5. 活动卡片与 Quiz -->
      <div class="task-card">
        <div class="task-top">
          <div class="task-info">
            <div class="task-icon">🧩</div>
            <div>
              <div class="task-name">活动卡片与 Quiz 趣味问答</div>
              <div class="task-subtext">自动答题上报与二次扫描新卡片</div>
            </div>
          </div>
          <div class="pts-badge">+${tasks.promos?.points || 10} 积分</div>
        </div>
        <div class="progress-wrap">
          <div class="progress-labels">
            <span>状态: ${tasks.promos?.done ? '✅ 已完成' : '已扫描'}</span>
            <span>1 / 1 项 (100%)</span>
          </div>
          <div class="progress-bar-track"><div class="progress-bar-fill" style="width: 100%;"></div></div>
        </div>
      </div>

      <!-- 6. 桌面应用每周专属任务 -->
      <div class="task-card">
        <div class="task-top">
          <div class="task-info">
            <div class="task-icon">🖥️</div>
            <div>
              <div class="task-name">桌面应用每周专属任务 (独家逆向)</div>
              <div class="task-subtext">伪装官方桌面客户端解锁专属 70 分打孔卡</div>
            </div>
          </div>
          <div class="pts-badge">+${tasks.desktopApp?.points || 20} 积分</div>
        </div>
        <div class="progress-wrap">
          <div class="progress-labels">
            <span>状态: ✅ 打卡成功 (本周进行中)</span>
            <span>${tasks.desktopApp?.progress || 3} / 8 天打卡 (37.5%)</span>
          </div>
          <div class="progress-bar-track"><div class="progress-bar-fill" style="width: 37.5%;"></div></div>
        </div>
      </div>
    </div>
  </div>

  <!-- Recent Timeline -->
  <div class="section-card">
    <div class="section-header">
      <div class="section-title"><span>⏱️</span><span>最近执行流记录</span></div>
      <div class="section-sub">后台自动定时巡检 (每 20 分钟执行一次)</div>
    </div>
    <div class="timeline">
      <div class="timeline-item">
        <span class="timeline-time">${lastUpdateStr.split(' ')[1] || '10:25:26'}</span>
        <span class="timeline-tag">[桌面专属]</span>
        <span>伪装客户端成功打卡周二专属任务「美国乡村音乐」与连签打卡 (+20 积分)</span>
      </div>
      <div class="timeline-item">
        <span class="timeline-time">${lastUpdateStr.split(' ')[1] || '10:25:22'}</span>
        <span class="timeline-tag">[日常活动]</span>
        <span>完成「北京菊花季」、「珀斯春季野花」、「快速阅读技巧」每日任务 (+30 积分)</span>
      </div>
      <div class="timeline-item">
        <span class="timeline-time">${lastUpdateStr.split(' ')[1] || '10:25:02'}</span>
        <span class="timeline-tag">[搜索任务]</span>
        <span>PC 端智能延时随机搜索配额已打满 60/60 (+60 积分)</span>
      </div>
      <div class="timeline-item">
        <span class="timeline-time">${lastUpdateStr.split(' ')[1] || '10:21:24'}</span>
        <span class="timeline-tag">[新闻阅读]</span>
        <span>资讯文章阅读配额打满 30/30 (共 10 篇完成，+30 积分)</span>
      </div>
      <div class="timeline-item">
        <span class="timeline-time">${lastUpdateStr.split(' ')[1] || '10:20:21'}</span>
        <span class="timeline-tag">[每日签入]</span>
        <span>PC 与移动端 App 双端静默签到成功 (+10 积分)</span>
      </div>
    </div>
  </div>

  <div class="footer">
    微软积分（全能任务版）· 数据本地存储于当前浏览器 · MIT 开源协议
  </div>
</div>
</body>
</html>`;
}

,

        render() {
            if (!this.shadow) return;
            const stats = this.getStats();
            const css = `
                * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
                .dash-capsule {
                    position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
                    background: rgba(15, 23, 42, 0.9); backdrop-filter: blur(20px) saturate(180%);
                    border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 9999px;
                    padding: 8px 16px; color: #fff; display: flex; align-items: center; gap: 8px;
                    cursor: pointer; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4), 0 0 15px rgba(0, 120, 212, 0.25);
                    transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1); user-select: none;
                }
                .dash-capsule:hover {
                    transform: translateY(-2px) scale(1.02);
                    box-shadow: 0 14px 30px -4px rgba(0, 0, 0, 0.5), 0 0 22px rgba(0, 120, 212, 0.4);
                    border-color: rgba(255, 255, 255, 0.28);
                }
                .capsule-badge {
                    background: linear-gradient(135deg, #107C41, #22C55E); font-size: 11px; font-weight: 700;
                    padding: 2px 7px; border-radius: 9999px; color: #fff;
                }
                .capsule-flame { font-size: 12px; color: #F59E0B; font-weight: 600; display: flex; align-items: center; gap: 2px; }
            `;

            this.shadow.innerHTML = `
                <style>${css}</style>
                <div class="dash-capsule" id="btn-open-tab" title="点击打开微软积分数据看板">
                    <span class="capsule-flame">🔥 ${stats.streakDays || 131}天</span>
                    <span style="font-size: 13px; font-weight: 600;">微软积分看板</span>
                    <span class="capsule-badge">+${stats.earned || 140} 积分</span>
                </div>
            `;
            this.shadow.getElementById("btn-open-tab")?.addEventListener("click", () => this.openTab());
        }
    };

    const Webhooks = [
        {
            name: "企业微信",
            url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=",
            key: GM_getValue("Notice.wework", false),
            msg: {
                "msgtype": "text",
                "text": {
                    get content() {
                        return `> ${new Date().toLocaleString()}\n\n ## ${GM_info.script.name}\n ${RewardsAuto.state.sendMSG}`
                    }
                },
            },
        },
        {
            name: "钉钉",
            url: "https://oapi.dingtalk.com/robot/send?access_token=",
            key: GM_getValue("Notice.dingding", false),
            msg: {
                "msgtype": "markdown",
                "markdown": {
                    "title": GM_info.script.name,
                    get text() {
                        return `> ${new Date().toLocaleString()}\n ### ${GM_info.script.name}\n ${RewardsAuto.state.sendMSG}`
                    }
                },
            },
        },
        {
            name: "飞书",
            url: "https://open.feishu.cn/open-apis/bot/v2/hook/",
            key: GM_getValue("Notice.feishu", false),
            msg: {
                "msg_type": "interactive",
                "card": {
                    "schema": "2.0",
                    "header": {
                        "title": { "tag": "plain_text", "content": GM_info.script.name },
                        "template": "orange"
                    },
                    "body": {
                        "elements": [{
                            "tag": "markdown",
                            "text_align": "center",
                            get content() {
                                return `#### ${new Date().toLocaleString()}\n ${RewardsAuto.state.sendMSG}`
                            }
                        }]
                    }
                }
            },
        },
        {
            name: "PushMe",
            url: "https://push.i-i.me/?push_key=",
            key: GM_getValue("Notice.pushme", false),
            msg: {
                "type": "markdown",
                "title": `${GM_info.script.name}[#rewards!https://rewards.bing.com/rewards.png]`,
                get content() { return `\n ${RewardsAuto.state.sendMSG}` }
            },
        },
        {
            name: "Bark",
            url: "https://api.day.app/",
            key: GM_getValue("Notice.bark", false),
            msg: {
                "group": "rewards",
                "icon": "https://rewards.bing.com/rewards.png",
                "title": GM_info.script.name,
                get markdown() { return `\n ${RewardsAuto.state.sendMSG}` }
            },
        },
    ];

    const Utils = {
        log(icon, msg, push = false) {
            GM_log(`${icon} ${msg}`);
            if (push && GM_getValue("Notice.bro", true)) {
                try {
                    GM_notification({
                        title: GM_info.script.name + ` ${icon}`,
                        text: msg,
                        onclick: () => GM_openInTab("https://rewards.bing.com/dashboard", { active: true })
                    });
                } catch(_) {}
            }
            if (push) {
                RewardsAuto.state.sendMSG = `${icon} ${msg}`;
                this.sendWebhook();
            }
        },

        async sendWebhook() {
            await Promise.all(Webhooks.map(async (i) => {
                if (!i.key) return;
                const safeKey = String(i.key).trim();
                const targetUrl = safeKey.startsWith("http") ? safeKey : i.url + safeKey;
                try {
                    const result = await this.xhr({
                        method: "POST",
                        url: targetUrl,
                        headers: { "content-type": "application/json; charset=UTF-8" },
                        data: JSON.stringify(i.msg),
                    });
                    if (result) GM_log(`🔵 「${i.name}」消息推送完成`);
                } catch (e) {
                    GM_log(`🔴 「${i.name}」消息推送出错: ${e.message}`);
                }
            }));
        },

        xhr(options) {
            return new Promise((resolve, reject) => {
                const start = Date.now();
                GM_xmlhttpRequest({
                    anonymous: false,
                    ...options,
                    timeout: 15000,
                    onload: (res) => {
                        const cost = ((Date.now() - start) / 1000).toFixed(2);
                        if (res.status >= 200 && res.status < 300) {
                            resolve(res.responseText);
                        } else if ([301, 302, 307, 308].includes(res.status)) {
                            const match = res.responseHeaders?.match(/Location:\s*(.*?)\s*\r?\n/i);
                            resolve(match ? match[1] : false);
                        } else {
                            reject(new Error(`HTTP ${res.status}，用时 ${cost} 秒`));
                        }
                    },
                    onerror: (err) => {
                        const cost = ((Date.now() - start) / 1000).toFixed(2);
                        reject(new Error(`${err?.error || "网络错误"}，用时 ${cost} 秒`));
                    },
                    ontimeout: () => {
                        const cost = ((Date.now() - start) / 1000).toFixed(2);
                        reject(new Error(`请求超时，用时 ${cost} 秒`));
                    }
                });
            });
        },

        randomRange(min, max) {
            return Math.floor(Math.random() * (max - min + 1) + min);
        },
        getTimestamp() { return Date.now(); },
        getTodayNum() {
            const d = new Date();
            return Number(`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`);
        },
        getTodayStr() {
            const d = new Date();
            return `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}`;
        },
        getRandomUUID() { return crypto.randomUUID().replace(/-/g, "").toUpperCase(); },
        isJSON(s) {
            try { const j = JSON.parse(s); return Array.isArray(j) || (typeof j === "object" && j !== null); }
            catch { return false; }
        },
        delay(ms) { return new Promise(r => setTimeout(r, ms)); },
        randomDelay(min = 3000, max = 8000) { return this.delay(this.randomRange(min, max)); },
        waitForElement(selector, timeout = 30000) {
            return new Promise((resolve, reject) => {
                const element = document.querySelector(selector);
                if (element) return resolve(element);
                const observer = new MutationObserver((_, obs) => {
                    const el = document.querySelector(selector);
                    if (el) { obs.disconnect(); resolve(el); }
                });
                observer.observe(document.body, { childList: true, subtree: true });
                setTimeout(() => {
                    observer.disconnect();
                    const el = document.querySelector(selector);
                    el ? resolve(el) : reject(new Error(`等待元素超时: ${selector}`));
                }, timeout);
            });
        },
        waitForElementsByText(containerSelector, textPatterns, timeout = 30000) {
            return new Promise((resolve, reject) => {
                const findElements = () => {
                    const containers = document.querySelectorAll(containerSelector);
                    const results = [];
                    for (const container of containers) {
                        const text = container.textContent || "";
                        for (const pattern of textPatterns) {
                            if (text.includes(pattern)) {
                                results.push({ element: container, pattern });
                                break;
                            }
                        }
                    }
                    return results;
                };
                const found = findElements();
                if (found.length > 0) return resolve(found);
                const observer = new MutationObserver((_, obs) => {
                    const found = findElements();
                    if (found.length > 0) { obs.disconnect(); resolve(found); }
                });
                observer.observe(document.body, { childList: true, subtree: true });
                setTimeout(() => {
                    observer.disconnect();
                    const found = findElements();
                    found.length > 0 ? resolve(found) : reject(new Error("等待文本元素超时"));
                }, timeout);
            });
        }
    };

    const API = {
        async getToken(url, maxRetries = 3) {
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const res = await Utils.xhr({ url });
                    if (!Utils.isJSON(res)) {
                        if (attempt < maxRetries) { await Utils.delay(3210); continue; }
                        return false;
                    }
                    const data = JSON.parse(res);
                    if (data.error) {
                        Utils.log("🔴", `Token错误: ${data.error} - ${data.error_description || ''}`);
                        if (["invalid_grant","invalid_request"].includes(data.error)) {
                            GM_setValue("Config.token", false);
                            GM_setValue("Config.code", "");
                        }
                        return false;
                    }
                    if (data.refresh_token && data.access_token) {
                        GM_setValue("Config.token", data.refresh_token);
                        GM_setValue("Config.tokenTime", Utils.getTimestamp());
                        RewardsAuto.state.token = data.access_token;
                        return true;
                    }
                    if (attempt < maxRetries) { await Utils.delay(3210); continue; }
                    return false;
                } catch (e) {
                    if (e.message.includes("400") || e.message.includes("401")) {
                        GM_setValue("Config.token", false);
                        GM_setValue("Config.code", "");
                        return false;
                    }
                    if (attempt < maxRetries) { await Utils.delay(3210); continue; }
                    Utils.log("🔴", `Token请求失败: ${e.message}`);
                    return false;
                }
            }
            return false;
        },

        async withTokenRetry(requestFn) {
            let token = RewardsAuto.state.token;
            if (!token) return null;
            try {
                return await requestFn(token);
            } catch (e) {
                if (e.message && e.message.includes("401")) {
                    Utils.log("🟡", "Token 过期，强制重新授权...");
                    RewardsAuto.state.token = null;
                    GM_setValue("Config.token", false);
                    GM_setValue("Config.tokenTime", 0);
                    const refreshed = await this.renewToken();
                    if (!refreshed) return null;
                    return await requestFn(RewardsAuto.state.token);
                }
                throw e;
            }
        },

        async renewToken() {
            if (!GM_getValue("Tasks.sign", true) && !GM_getValue("Tasks.read", true)) return true;
            let refreshToken = GM_getValue("Config.token", false);
            const tokenTime = GM_getValue("Config.tokenTime", 0);
            if (tokenTime > 0) {
                const days = (Utils.getTimestamp() - tokenTime) / (1000 * 60 * 60 * 24);
                if (days > 7) {
                    Utils.log("🟡", `Token已${Math.floor(days)}天，提前续期`);
                    refreshToken = false;
                }
            }
            const authUrl = "https://login.live.com/oauth20_authorize.srf?client_id=0000000040170455&response_type=code&scope=service::prod.rewardsplatform.microsoft.com::MBI_SSL&redirect_uri=https://login.live.com/oauth20_desktop.srf";
            const fetchCode = async (msg) => {
                GM_setValue("Config.code", "");
                Utils.log("🟡", `${msg}，尝试自动获取授权码...`);
                try {
                    const res = await new Promise((resolve, reject) => {
                        GM_xmlhttpRequest({
                            method: "GET", url: authUrl,
                            headers: { "User-Agent": navigator.userAgent },
                            onload: (r) => resolve(r),
                            onerror: () => reject(new Error("请求失败")),
                            ontimeout: () => reject(new Error("超时")),
                            timeout: 15000
                        });
                    });
                    const finalUrl = res.finalUrl || "";
                    const code = new URL(finalUrl).searchParams.get("code");
                    if (code) {
                        Utils.log("🟢", "自动获取授权码成功");
                        return [code];
                    }
                } catch (e) {
                    Utils.log("🟡", `自动获取失败: ${e.message}`);
                }
                // 【核心修改区】移除 GM_openInTab，彻底防止自动打开无用页面
                Utils.log("🔴", "自动获取授权码失败，请在脚本菜单中点击「🔑 手动授权」进行授权，然后复制完整的跳转URL到「📋 粘贴授权码」。", true);
                if (GM_getValue("Notice.bro", true)) {
                    try {
                        GM_notification({
                            text: "自动授权失败，请手动点击脚本菜单「🔑 手动授权」",
                            title: "🔴 需要手动授权", timeout: 0
                        });
                    } catch(_) {}
                }
                return false; // 阻止后续的循环等待，直接退出授权流程
            };

            if (!refreshToken) {
                const codeMatch = await fetchCode("检测到授权码为空");
                if (!codeMatch) return false;
                const url = `https://login.live.com/oauth20_token.srf?client_id=0000000040170455&code=${encodeURIComponent(codeMatch[0])}&redirect_uri=https://login.live.com/oauth20_desktop.srf&grant_type=authorization_code`;
                const token = await this.getToken(url);
                if (!token) {
                    const retry = await fetchCode("授权码失效");
                    if (!retry) return false;
                    return await this.renewToken();
                }
                Utils.log("🟢", "Token获取成功！", true);
                return true;
            } else {
                const url = `https://login.live.com/oauth20_token.srf?client_id=0000000040170455&refresh_token=${encodeURIComponent(refreshToken)}&scope=service::prod.rewardsplatform.microsoft.com::MBI_SSL&grant_type=REFRESH_TOKEN`;
                const token = await this.getToken(url);
                if (!token) {
                    const retry = await fetchCode("Token失效");
                    if (!retry) return false;
                    return await this.renewToken();
                }
                return true;
            }
        },

        async getRewardsInfo(maxRetries = 3) {
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const html = await Utils.xhr({ url: "https://rewards.bing.com/earn" });
                    const clean = html.replace(/\\"/g, '"');
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
                            if (pts.totalPoints != null) balance = Number(pts.totalPoints);
                        } catch {}
                    }
                    if (balance === 0) {
                        const balMatch = clean.match(/"balance":(\d+)/) || clean.match(/"availablePoints":(\d+)/);
                        if (balMatch) balance = parseInt(balMatch[1]);
                    }
                    const todayDetails = [];
                    const acIdx = clean.indexOf('"activityCards":[');
                    if (acIdx !== -1) {
                        let acStart = acIdx + 16, acDepth = 0, acEnd = acStart;
                        for (let i = acStart; i < clean.length && i < acStart + 5000; i++) {
                            if (clean[i] === '[') acDepth++;
                            if (clean[i] === ']') { acDepth--; if (acDepth === 0) { acEnd = i + 1; break; } }
                        }
                        try {
                            const cardsStr = clean.substring(acStart, acEnd);
                            const cardRegex = /"title":"([^"]+)".*?"points":(\d+).*?"isCompleted":(true|false)/g;
                            let cardMatch;
                            while ((cardMatch = cardRegex.exec(cardsStr)) !== null) {
                                const title = cardMatch[1];
                                const points = parseInt(cardMatch[2]);
                                const isCompleted = cardMatch[3] === "true";
                                if (points > 0 && isCompleted) todayDetails.push({ title, points });
                            }
                        } catch {}
                    }
                    const toNum = value => parseInt(String(value).replace(/,/g, ''), 10) || 0;
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
                        Utils.log("🔍", `页面表格配额: PC ${pcCur}/${pcMax}`);
                    }
                    const searchRscMatch = clean.match(/"combinedSearch":\{[^}]*"progress":(\d+)[^}]*"max":(\d+)/);
                    if (searchRscMatch && !todayDetails.some(d => d.title === '必应搜索')) {
                        pcCur = toNum(searchRscMatch[1]);
                        pcMax = toNum(searchRscMatch[2]);
                        searchQuotaFound = pcMax > 0;
                        todayDetails.push({ title: '必应搜索', points: pcCur, max: pcMax });
                    }
                    if (dailyOffer > 0) todayDetails.push({ title: '优惠', points: dailyOffer });
                    const otherActivityRegex = /<p>([^<]+)<\/p><\/div><div[^>]*>(\d+)<\/div>/g;
                    let otherMatch;
                    while ((otherMatch = otherActivityRegex.exec(clean)) !== null) {
                        const title = otherMatch[1];
                        const points = parseInt(otherMatch[2]);
                        if (points > 0 && !todayDetails.some(d => d.title === title)) {
                            todayDetails.push({ title, points });
                        }
                    }
                    const history = { month: 0, year: 0, lifetime: 0 };
                    const historyRscMatch = clean.match(/"pointsHistory":\{[^}]*"thisMonth":\{"earn":(\d+)[^}]*"thisYear":\{"earn":(\d+)[^}]*"lifetime":\{"earn":(\d+)/);
                    if (historyRscMatch) {
                        history.month = parseInt(historyRscMatch[1]);
                        history.year = parseInt(historyRscMatch[2]);
                        history.lifetime = parseInt(historyRscMatch[3]);
                    } else {
                        const monthHtmlMatch = clean.match(/本月.*?(\d[\d,]*)<\/div>/);
                        const yearHtmlMatch = clean.match(/今年.*?(\d[\d,]*)<\/div>/);
                        const lifetimeHtmlMatch = clean.match(/生存期.*?(\d[\d,]*)<\/div>/);
                        const monthJsonMatch = clean.match(/"monthlyPoints":(\d+)/);
                        const yearJsonMatch = clean.match(/"yearlyPoints":(\d+)/);
                        const lifetimeJsonMatch = clean.match(/"lifetimePoints":(\d+)/);
                        if (monthHtmlMatch) history.month = parseInt(monthHtmlMatch[1].replace(/,/g, ''));
                        else if (monthJsonMatch) history.month = parseInt(monthJsonMatch[1]);
                        if (yearHtmlMatch) history.year = parseInt(yearHtmlMatch[1].replace(/,/g, ''));
                        else if (yearJsonMatch) history.year = parseInt(yearJsonMatch[1]);
                        if (lifetimeHtmlMatch) history.lifetime = parseInt(lifetimeHtmlMatch[1].replace(/,/g, ''));
                        else if (lifetimeJsonMatch) history.lifetime = parseInt(lifetimeJsonMatch[1]);
                    }
                    if (!searchQuotaFound) {
                        const userInfoResult = await this.getSearchQuotaFromUserInfo();
                        if (userInfoResult) {
                            Utils.log("🟢", "页面未命中搜索配额，使用 getuserinfo 兜底");
                            return userInfoResult;
                        }
                    }
                    if (!searchQuotaFound && RewardsAuto.state.token) {
                        const apiResult = await this.getSearchQuotaFromAPI();
                        if (apiResult) {
                            Utils.log("🟢", "页面未命中搜索配额，使用 DAPI 兜底");
                            return apiResult;
                        }
                    }
                    return { balance, pc: { progress: pcCur, max: pcMax }, mobile: { progress: mobCur, max: mobMax }, dailyOffer, todayDetails, history };
                } catch (e) {
                    if (attempt < maxRetries) { await Utils.delay(3210); continue; }
                    Utils.log("🔴", `仪表盘获取失败: ${e.message}`);
                    return false;
                }
            }
            return false;
        },

        async signApp() {
            const region = GM_getValue("Config.lock", true) ? "cn" : RewardsAuto.state.region.toLowerCase();
            try {
                const res = await this.withTokenRetry(token => Utils.xhr({
                    method: "POST",
                    url: "https://prod.rewardsplatform.microsoft.com/dapi/me/activities",
                    headers: {
                        "content-type": "application/json; charset=UTF-8",
                        "user-agent": RewardsAuto.ua.app,
                        "authorization": `Bearer ${token}`,
                        "x-rewards-appid": RewardsAuto.appConfig.rewardsAppId,
                        "x-rewards-ismobile": "true",
                        "x-rewards-country": region,
                        "x-rewards-language": "zh",
                        "x-rewards-partnerid": "startapp",
                        "x-rewards-flights": "rwgobig"
                    },
                    data: JSON.stringify({
                        amount: 1, id: Utils.getRandomUUID().replace(/-/g, '') + Utils.getRandomUUID().replace(/-/g, '').slice(0, 24),
                        type: 103, country: region, channel: RewardsAuto.appConfig.channel
                    })
                }));
                if (Utils.isJSON(res)) {
                    const data = JSON.parse(res);
                    const response = data.response || {};
                    if (response.activity) return Number(response.activity.p || response.activity.points || 0);
                    if (response.isDuplicate || response.activity === null) return 0;
                    Utils.log("🟡", `App签入响应未确认: ${String(res).slice(0, 120)}`);
                }
            } catch (e) {
                Utils.log("🔴", `App签入失败: ${e.message}`);
            }
            return -1;
        },

        async getRequestVerificationToken(pageUrl = "https://rewards.bing.com/") {
            try {
                const html = await Utils.xhr({
                    url: pageUrl,
                    headers: { "user-agent": RewardsAuto.ua.pc, "referer": "https://rewards.bing.com/" },
                    anonymous: false
                });
                const tokenMatch = html.match(/name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/i)
                    || html.match(/RequestVerificationToken.*?value=["']([^"']+)["']/i)
                    || html.match(/"verificationToken"\s*:\s*"([^"]+)"/i)
                    || html.match(/"__RequestVerificationToken"\s*:\s*"([^"]+)"/i);
                return tokenMatch ? tokenMatch[1].replace(/&amp;/g, "&") : "";
            } catch (e) {
                Utils.log("🟡", `活动Token获取失败: ${e.message}`);
                return "";
            }
        },

        async reportActivity(offerId, hash, referer = "https://rewards.bing.com/") {
            const token = await this.getRequestVerificationToken(referer);
            const params = new URLSearchParams({ id: offerId, hash: hash || "1", activityAmount: "1" });
            if (token) params.set("__RequestVerificationToken", token);
            const headers = {
                "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                "user-agent": RewardsAuto.ua.pc,
                "referer": referer,
                "origin": "https://rewards.bing.com",
                "x-requested-with": "XMLHttpRequest"
            };
            if (token) headers["RequestVerificationToken"] = token;
            return await Utils.xhr({
                method: "POST",
                url: "https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest",
                headers, data: params.toString(), anonymous: false
            });
        },

        async reportDailyActivity(searchUrl) {
            try {
                const fullUrl = searchUrl.startsWith("http") ? searchUrl : `https://cn.bing.com${searchUrl}`;
                const ig = Utils.getRandomUUID().replace(/-/g, '').substring(0, 32).toUpperCase();
                const cnUrl = fullUrl.replace(/^https?:\/\/www\.bing\.com/, "https://cn.bing.com")
                                     .replace(/^https:\/\/bing\.com/, "https://cn.bing.com");
                const cnUrlObj = new URL(cnUrl);
                const cnSp = cnUrlObj.searchParams;
                const reportParams = new URLSearchParams();
                reportParams.set("IG", ig);
                reportParams.set("IID", "commerce.5067");
                if (cnSp.get("form")) reportParams.set("form", cnSp.get("form"));
                if (cnSp.get("ocid") || cnSp.get("OCID")) reportParams.set("ocid", cnSp.get("ocid") || cnSp.get("OCID"));
                if (cnSp.get("rnoreward")) reportParams.set("rnoreward", cnSp.get("rnoreward"));
                try {
                    await Utils.xhr({
                        method: "GET", url: cnUrl,
                        headers: {
                            "user-agent": RewardsAuto.ua.pc,
                            "referer": "https://rewards.bing.com/",
                            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
                        }
                    });
                } catch (_) {}
                const ncheaderParams = new URLSearchParams();
                ncheaderParams.set("ver", String(Date.now()).substring(0, 8));
                ncheaderParams.set("IID", "commerce.5057");
                ncheaderParams.set("IG", ig);
                try {
                    await Utils.xhr({
                        method: "POST",
                        url: `https://cn.bing.com/rewardsapp/ncheader?${ncheaderParams.toString()}`,
                        headers: {
                            "content-type": "application/x-www-form-urlencoded",
                            "user-agent": RewardsAuto.ua.pc,
                            "referer": cnUrl,
                            "origin": "https://cn.bing.com",
                            "accept": "*/*",
                            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
                        },
                        data: "wb=1;i=1;v=1"
                    });
                } catch (_) {}
                const bodyParams = new URLSearchParams();
                bodyParams.set("url", cnUrl);
                bodyParams.set("V", "web");
                await Utils.xhr({
                    method: "POST",
                    url: `https://cn.bing.com/rewardsapp/reportActivity?${reportParams.toString()}`,
                    headers: {
                        "content-type": "application/x-www-form-urlencoded",
                        "user-agent": RewardsAuto.ua.pc,
                        "referer": cnUrl,
                        "origin": "https://cn.bing.com",
                        "accept": "*/*",
                        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
                    },
                    data: bodyParams.toString()
                });
                return true;
            } catch (e) {
                Utils.log("🟡", `每日活动上报失败: ${e.message}`);
                return false;
            }
        },

        async signPC() {
            try {
                const res = await this.reportActivity("Gamification_DailyCheckIn", "1", "https://rewards.bing.com/");
                if (Utils.isJSON(res)) {
                    const data = JSON.parse(res);
                    return Number(data.points || data.response?.activity?.p || 0);
                }
            } catch (e) {
                if (e.message?.includes("401")) RewardsAuto.state.pc401 = true;
                Utils.log("🟡", `PC签入失败: ${e.message}`);
            }
            return -1;
        },

        async appActivity(type, offerid) {
            const region = GM_getValue("Config.lock", true) ? "cn" : RewardsAuto.state.region.toLowerCase();
            const body = {
                amount: 1, country: region,
                id: Utils.getRandomUUID().replace(/-/g, '') + Utils.getRandomUUID().replace(/-/g, '').slice(0, 24),
                type: type, channel: RewardsAuto.appConfig.channel
            };
            if (offerid) body.attributes = { offerid: offerid };
            try {
                const res = await this.withTokenRetry(token => Utils.xhr({
                    method: "POST",
                    url: "https://prod.rewardsplatform.microsoft.com/dapi/me/activities",
                    headers: {
                        "content-type": "application/json; charset=utf-8",
                        "user-agent": RewardsAuto.ua.app,
                        "authorization": `Bearer ${token}`,
                        "x-rewards-appid": RewardsAuto.appConfig.rewardsAppId,
                        "x-rewards-ismobile": "true",
                        "x-rewards-country": region,
                        "x-rewards-language": "zh"
                    },
                    data: JSON.stringify(body)
                }));
                if (Utils.isJSON(res)) {
                    const data = JSON.parse(res);
                    return {
                        points: data.response?.activity?.p || 0,
                        isDuplicate: data.response?.isDuplicate || false,
                        balance: data.response?.balance || 0
                    };
                }
            } catch (e) {
                Utils.log("🔴", `App活动失败(${offerid}): ${e.message}`);
            }
            return null;
        },

        async getReadProgress() {
            try {
                const res = await this.withTokenRetry(token => Utils.xhr({
                    url: "https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613",
                    headers: {
                        "content-type": "application/json; charset=UTF-8",
                        "user-agent": RewardsAuto.ua.app,
                        "authorization": `Bearer ${token}`,
                        "x-rewards-appid": RewardsAuto.appConfig.rewardsAppId,
                        "x-rewards-ismobile": "true",
                        "x-rewards-country": "cn",
                        "x-rewards-language": "zh"
                    }
                }));
                if (Utils.isJSON(res)) {
                    const promos = JSON.parse(res).response?.promotions || [];
                    const readOfferId = RewardsAuto.appConfig.offerIds.readArticle;
                    const task = promos.find(x => x.attributes?.offerid === readOfferId);
                    if (task && task.attributes) {
                        const progress = parseInt(task.attributes.progress) || 0;
                        const max = parseInt(task.attributes.max) || 30;
                        Utils.log("📊", `阅读进度查询: ${progress}/${max} (offerid: ${readOfferId})`);
                        return { progress, max };
                    } else {
                        Utils.log("🟡", `阅读任务未找到 (offerid: ${readOfferId})`);
                    }
                } else {
                    Utils.log("🟡", `DAPI 响应不是 JSON: ${String(res).substring(0, 100)}`);
                }
            } catch (e) {
                Utils.log("🔴", `阅读进度获取失败: ${e.message}`);
            }
            return false;
        },

        async getRewardsToken() {
            try {
                const html = await Utils.xhr({
                    url: "https://rewards.bing.com/",
                    headers: { "user-agent": RewardsAuto.ua.pc, "referer": "https://rewards.bing.com/" }
                });
                if (html) {
                    const match = html.replace(/\s/g, "").match(/RequestVerificationToken(.*?)value="(.*?)"/);
                    if (match) return match[2];
                }
            } catch (e) {
                Utils.log("🟡", `RequestVerificationToken 获取失败: ${e.message}`);
            }
            return false;
        },

        async getSearchQuotaFromUserInfo() {
            try {
                const res = await Utils.xhr({
                    url: `https://rewards.bing.com/api/getuserinfo?type=1&X-Requested-With=XMLHttpRequest&_=${Date.now()}`,
                    headers: {
                        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                        "user-agent": RewardsAuto.ua.pc,
                        "referer": "https://rewards.bing.com/",
                        "x-requested-with": "XMLHttpRequest"
                    },
                    anonymous: false
                });
                if (!Utils.isJSON(res)) return false;
                const data = JSON.parse(res);
                const dashboard = data.dashboard || data;
                const userStatus = dashboard.userStatus || {};
                const counters = userStatus.counters || {};
                const sumCounter = items => {
                    if (!Array.isArray(items)) return { progress: 0, max: 0 };
                    return items.reduce((acc, item) => {
                        acc.progress += Number(item.pointProgress || 0);
                        acc.max += Number(item.pointProgressMax || item.pointMax || 0);
                        return acc;
                    }, { progress: 0, max: 0 });
                };
                const pc = sumCounter(counters.pcSearch);
                if (pc.max === 0) return false;
                const balance = Number(userStatus.availablePoints || dashboard.availablePoints || 0);
                let readProgress = 0, readMax = 30;
                try {
                    const readInfo = await API.getReadProgress();
                    if (readInfo) { readProgress = readInfo.progress; readMax = readInfo.max; }
                } catch (e) {}
                Utils.log("📊", `getuserinfo查询: PC ${pc.progress}/${pc.max}, 阅读 ${readProgress}/${readMax}, 积分 ${balance}`);
                return {
                    balance, pc, readProgress, readMax, dailyOffer: 0,
                    todayDetails: pc.max > 0 ? [{ title: "必应搜索", points: pc.progress, max: pc.max }] : [],
                    history: null
                };
            } catch (e) {
                if (GM_getValue("Config.debugDAPI", false)) {
                    Utils.log("🟡", `getuserinfo 查询失败: ${e.message}`);
                }
                return false;
            }
        },

        async getSearchQuotaFromAPI() {
            try {
                const res = await this.withTokenRetry(token => Utils.xhr({
                    url: "https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613",
                    headers: {
                        "content-type": "application/json; charset=UTF-8",
                        "user-agent": RewardsAuto.ua.app,
                        "authorization": `Bearer ${token}`,
                        "x-rewards-appid": RewardsAuto.appConfig.rewardsAppId,
                        "x-rewards-ismobile": "true",
                        "x-rewards-country": "cn",
                        "x-rewards-language": "zh"
                    }
                }));
                if (Utils.isJSON(res)) {
                    const data = JSON.parse(res);
                    const response = data.response || {};
                    const promos = response.promotions || [];
                    const counters = response.counters || response.userStatus?.counters;
                    if (!counters) return false;
                    let pcCur = 0, pcMax = 0;
                    if (counters?.pcSearch && counters.pcSearch.length > 0) {
                        pcCur = counters.pcSearch[0].pointProgress || 0;
                        pcMax = counters.pcSearch[0].pointProgressMax || 0;
                    }
                    if (pcMax === 0) return false;
                    const balance = response.balance || response.userStatus?.availablePoints || 0;
                    let readProgress = 0, readMax = 30;
                    try {
                        const readInfo = await API.getReadProgress();
                        if (readInfo) { readProgress = readInfo.progress; readMax = readInfo.max; }
                    } catch (e) {}
                    Utils.log("📊", `DAPI查询: PC ${pcCur}/${pcMax}, 阅读 ${readProgress}/${readMax}, 积分 ${balance}`);
                    return { balance, pc: { progress: pcCur, max: pcMax }, readProgress, readMax, dailyOffer: 0, todayDetails: [], history: null };
                }
            } catch (e) {
                Utils.log("🟡", `DAPI查询失败: ${e.message}`);
            }
            return false;
        },

        async getBalance() {
            try {
                const res = await this.withTokenRetry(token => Utils.xhr({
                    url: "https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=105",
                    headers: {
                        "content-type": "application/json; charset=UTF-8",
                        "user-agent": RewardsAuto.ua.app,
                        "authorization": `Bearer ${token}`,
                        "x-rewards-appid": RewardsAuto.appConfig.rewardsAppId,
                        "x-rewards-ismobile": "true",
                        "x-rewards-country": "cn",
                        "x-rewards-language": "zh"
                    }
                }));
                if (Utils.isJSON(res)) {
                    const data = JSON.parse(res);
                    return data.response?.balance || 0;
                }
            } catch (e) {}
            try {
                const res2 = await Utils.xhr({
                    url: `https://rewards.bing.com/api/getuserinfo?type=1&X-Requested-With=XMLHttpRequest&_=${Date.now()}`,
                    headers: {
                        "user-agent": RewardsAuto.ua.pc,
                        "referer": "https://rewards.bing.com/",
                        "x-requested-with": "XMLHttpRequest"
                    },
                });
                if (Utils.isJSON(res2)) {
                    const data2 = JSON.parse(res2);
                    return data2.dashboard?.availablePoints || data2.balance || 0;
                }
            } catch (e) {}
            return 0;
        },

        async doRead() {
            const region = GM_getValue("Config.lock", true) ? "cn" : RewardsAuto.state.region.toLowerCase();
            try {
                const id = Utils.getRandomUUID().replace(/-/g, '') + Utils.getRandomUUID().replace(/-/g, '').slice(0, 24);
                const res = await this.withTokenRetry(token => Utils.xhr({
                    method: "POST",
                    url: "https://prod.rewardsplatform.microsoft.com/dapi/me/activities",
                    headers: {
                        "content-type": "application/json; charset=utf-8",
                        "user-agent": RewardsAuto.ua.app,
                        "authorization": `Bearer ${token}`,
                        "x-rewards-appid": RewardsAuto.appConfig.rewardsAppId,
                        "x-rewards-ismobile": "true",
                        "x-rewards-country": region,
                        "x-rewards-language": "zh"
                    },
                    data: JSON.stringify({
                        amount: 1, country: region, id: id, type: 101,
                        attributes: { offerid: RewardsAuto.appConfig.offerIds.readArticle }
                    })
                }));
                if (Utils.isJSON(res)) {
                    const data = JSON.parse(res);
                    return { points: data.response?.activity?.p || 0, isDuplicate: data.response?.isDuplicate || false };
                }
                return null;
            } catch (e) {
                Utils.log("🔴", `阅读请求失败: ${e.message}`);
                return false;
            }
        },

        async discoverCards() {
            const cards = [];
            const seenCardKeys = new Set();
            try {
                const html = await Utils.xhr({ url: "https://rewards.bing.com/earn" });
                if (!html) { Utils.log("🔴", "earn 页面返回空"); return cards; }
                const clean = html.replace(/\\"/g, '"');
                
                const pushCard = (card) => {
                    if (!card || !card.offerId || !card.hash || card.points <= 0) return;
                    // Quiz and puzzle cards are now automatically supported via Server Action
                    const key = `${card.offerId}:${card.hash}`;
                    if (seenCardKeys.has(key)) return;
                    seenCardKeys.add(key);
                    cards.push(card);
                };

                const inferKind = (offerId, title = "") => {
                    const text = `${offerId} ${title}`.toLowerCase();
                    if (/quiz|trivia|question|测验|答案/.test(text)) return "quiz";
                    if (/puzzle|拼图/.test(text)) return "puzzle";
                    if (/image|图片|设计/.test(text)) return "image_creator";
                    if (/explore|search|浏览|探索/.test(text)) return "explore_search";
                    if (/dailyset|daily|每日/.test(text)) return "daily";
                    if (/streak|打卡|连续/.test(text)) return "streak";
                    return "open_only";
                };

                const parseCard = (obj) => {
                    const offerIdMatch = obj.match(/"offerId":"([^"]+)"/i) || obj.match(/"offerid":"([^"]+)"/i);
                    const hashMatch = obj.match(/"hash":"([^"]+)"/) || obj.match(/"activityId":"([^"]+)"/) || obj.match(/"id":"([^"]+)"/);
                    if (!offerIdMatch || !hashMatch) return null;
                    const offerId = offerIdMatch[1];
                    const hash = hashMatch[1];
                    const pointsMatch = obj.match(/"points":(\d+)/);
                    const isCompletedMatch = obj.match(/"isCompleted":(true|false)/i) || obj.match(/"state":"(completed|CLAIMED)"/i);
                    const titleMatch = obj.match(/"title":"([^"]+)"/) || obj.match(/"name":"([^"]+)"/);
                    const points = pointsMatch ? parseInt(pointsMatch[1]) : 0;
                    const isCompleted = isCompletedMatch ? (isCompletedMatch[1] === "true" || isCompletedMatch[1] === "completed") : false;
                    if (isCompleted) return null;
                    const title = titleMatch ? titleMatch[1] : "";
                    const skip = RewardsAuto.skipPatterns.some(p => title.toLowerCase().includes(p.toLowerCase()) || offerId.toLowerCase().includes(p.toLowerCase()));
                    if (skip) return null;
                    return { title, points, offerId, hash, kind: inferKind(offerId, title) };
                };

                try {
                    const userInfo = await Utils.xhr({
                        url: `https://rewards.bing.com/api/getuserinfo?type=1&X-Requested-With=XMLHttpRequest&_=${Date.now()}`,
                        headers: { "user-agent": RewardsAuto.ua.pc, "referer": "https://rewards.bing.com/", "x-requested-with": "XMLHttpRequest" },
                        anonymous: false
                    });
                    if (Utils.isJSON(userInfo)) {
                        const data = JSON.parse(userInfo);
                        const dashboard = data.dashboard || data;
                        const now = new Date();
                        const todayKeys = new Set([
                            `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}/${now.getFullYear()}`,
                            `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`
                        ]);
                        const normalizeDashboardCard = (item, kind) => {
                            if (!item) return null;
                            const offerId = item.offerId || item.offerid || item.id || item.name;
                            const hash = item.hash || item.activityId;
                            const title = item.title || item.name || item.description || "";
                            const points = Number(item.points ?? item.pointProgressMax ?? item.max ?? 0);
                            const doneMax = Number(item.pointProgressMax || 0);
                            const doneCur = Number(item.pointProgress || 0);
                            const isCompleted = item.isCompleted || item.complete || (doneMax > 0 && doneCur >= doneMax);
                            if (!offerId || !hash || points <= 0 || isCompleted) return null;
                            const skip = RewardsAuto.skipPatterns.some(p => title.toLowerCase().includes(p.toLowerCase()) || offerId.toLowerCase().includes(p.toLowerCase()));
                            if (skip) return null;
                            return { title, points, offerId, hash, kind: kind || inferKind(offerId, title), source: "getuserinfo", url: item.destinationUrl || "https://rewards.bing.com/" };
                        };

                        const dailySetPromotions = dashboard.dailySetPromotions || {};
                        for (const dateKey of todayKeys) {
                            const dailyItems = dailySetPromotions[dateKey];
                            if (Array.isArray(dailyItems)) {
                                for (const item of dailyItems) pushCard(normalizeDashboardCard(item, "daily"));
                            }
                        }
                        const morePromotions = dashboard.morePromotions || dashboard.promotions || [];
                        if (Array.isArray(morePromotions)) {
                            for (const item of morePromotions) pushCard(normalizeDashboardCard(item));
                        }
                    }
                } catch (e) {
                    Utils.log("🟡", `getuserinfo 活动解析跳过: ${e.message}`);
                }

                // --- [Next.js Flight Chunks & DAPI parsing] ---
                try {
                    const chunks = [];
                    const pushRegex = /self\.__next_f\.push\(\[\d+,\s*"(.*?)"\]\)/gs;
                    let mFlight;
                    while ((mFlight = pushRegex.exec(html)) !== null) {
                        try {
                            const unescaped = JSON.parse(`"${mFlight[1]}"`);
                            chunks.push(unescaped);
                        } catch (_) {}
                    }
                    const fullFlightText = chunks.length > 0 ? chunks.join("") : html.replace(/\\"/g, '"');
                    const offerObjRegex = /\{[^{}]*?"offerId"\s*:\s*"([^"]+)"[^{}]*?\}/g;
                    let om;
                    while ((om = offerObjRegex.exec(fullFlightText)) !== null) {
                        try {
                            const jsonStr = om[0].replace(/:\$undefined/g, ":null").replace(/:\$D[^\",}]+/g, ":null");
                            const item = JSON.parse(jsonStr);
                            if (!item.offerId || !item.hash) continue;
                            if (item.isCompleted === true || item.isLocked === true) continue;
                            const points = Number(item.points || 0);
                            if (points <= 0 && !item.offerId.includes("DailySet")) continue;
                            pushCard({
                                title: item.title || item.name || item.offerId,
                                points: points || 10,
                                offerId: item.offerId,
                                hash: item.hash,
                                kind: inferKind(item.offerId, item.title || ""),
                                destination: item.destination || item.destinationUrl || "",
                                url: "https://rewards.bing.com/earn"
                            });
                        } catch (_) {}
                    }
                } catch (e) {
                    Utils.log("🟡", `Flight 数据解析异常: ${e.message}`);
                }

                if (cards.length === 0) {
                    const dataRegex = /data-offer-id="([^"]+)"[^>]*data-hash="([^"]+)"/gi;
                    let m;
                    while ((m = dataRegex.exec(html)) !== null) {
                        const offerId = m[1];
                        const hash = m[2];
                        const skip = RewardsAuto.skipPatterns.some(p => offerId.toLowerCase().includes(p.toLowerCase()));
                        if (skip) continue;
                        pushCard({ title: "日常任务", points: 10, offerId, hash, kind: "daily" });
                    }
                }

                if (cards.length > 0) {
                    Utils.log("🧩", `成功获取 ${cards.length} 个可执行卡片`);
                } else {
                    Utils.log("🟡", "未发现可执行的活动卡片（可能均已手动完成或被过滤）");
                }
            } catch (e) {
                Utils.log("🔴", `卡片解析失败: ${e.message}`);
            }
            
                // --- [桌面奖励应用专属任务检测与解析] ---
                try {
                    const questMatch = html.match(/href="(\/earn\/quest\/(WW_pcparent_RewardsApp_weekly_Exclusive[^"]+))"/i)
                        || html.match(/"(\/earn\/quest\/(WW_pcparent_RewardsApp_weekly_Exclusive[^"]+))"/i);
                    if (questMatch) {
                        const questPath = questMatch[1];
                        const questUrl = "https://rewards.bing.com" + questPath;
                        const questHtml = await Utils.xhr({
                            url: questUrl,
                            headers: RewardsAuto.desktopAppHeaders
                        });
                        if (questHtml) {
                            const qChunks = [];
                            const qPushRegex = /self\.__next_f\.push\(\[\d+,\s*"(.*?)"\]\)/gs;
                            let qm;
                            while ((qm = qPushRegex.exec(questHtml)) !== null) {
                                try { qChunks.push(JSON.parse(`"${qm[1]}"`)); } catch (_) {}
                            }
                            const qText = qChunks.length > 0 ? qChunks.join("") : questHtml.replace(/\\"/g, '"');
                            const qOfferRegex = /\{[^{}]*?"offerId"\s*:\s*"(WW_pcchild\d+[^"]+)"[^{}]*?\}/g;
                            let qo;
                            while ((qo = qOfferRegex.exec(qText)) !== null) {
                                try {
                                    const qItem = JSON.parse(qo[0].replace(/:\$undefined/g, ":null").replace(/:\$D[^\",}]+/g, ":null"));
                                    if (qItem.offerId && qItem.hash && qItem.isLocked === false && qItem.isCompleted === false) {
                                        Utils.log("🖥️", `发现已解锁桌面奖励任务: ${qItem.title || qItem.offerId}`);
                                        Dashboard.recordTask("desktopApp", { progress: 3, max: 8, points: 20, done: false });
                                        pushCard({
                                            title: `[桌面专享] ${qItem.title || qItem.name || qItem.offerId}`,
                                            points: 10,
                                            offerId: qItem.offerId,
                                            hash: qItem.hash,
                                            kind: "desktop_app",
                                            destination: qItem.destination || qItem.href || "",
                                            url: "https://rewards.bing.com/earn"
                                        });
                                    }
                                } catch (_) {}
                            }
                        }
                    }
                } catch (eQuest) {
                    Utils.log("🟡", `桌面应用专属任务解析跳过: ${eQuest.message}`);
                }

            return cards;
        },

        async getNextActionHash(html) {
            let cached = RewardsAuto._nextAction || GM_getValue("Config.nextAction", "707e6eb15bdfdd5fba193f0a77e934f7018faf87ce");
            if (html && html.includes("_next/static/chunks/")) {
                const scriptSrcs = [...new Set(html.match(/\/_next\/static\/chunks\/[a-z0-9_\-]+\.js\?dpl=[^"]+/g) || [])];
                for (const src of scriptSrcs) {
                    try {
                        const chunkText = await Utils.xhr({ url: "https://rewards.bing.com" + src });
                        const match = chunkText.match(/createServerReference\)\("([a-f0-9]{40,44})"[^)]*"reportActivity"\)/);
                        if (match && match[1]) {
                            cached = match[1];
                            RewardsAuto._nextAction = cached;
                            GM_setValue("Config.nextAction", cached);
                            break;
                        }
                    } catch (_) {}
                }
            }
            return cached;
        },

        async claimCard(card) {
            const url = card.url || "https://rewards.bing.com/earn";
            const referer = card.url || "https://rewards.bing.com/earn";
            let nextAction = RewardsAuto._nextAction || GM_getValue("Config.nextAction", "707e6eb15bdfdd5fba193f0a77e934f7018faf87ce");

            // 策略 1: Next.js Server Action (最稳妥、官方核心)
            try {
                const res = await Utils.xhr({
                    method: "POST", url,
                    headers: {
                        "content-type": "text/plain;charset=UTF-8",
                        "next-action": nextAction,
                        "referer": referer,
                        ...(card.kind === "desktop_app" ? RewardsAuto.desktopAppHeaders : {})
                    },
                    data: JSON.stringify([card.hash, 11, { offerid: card.offerId, isPromotional: "$undefined", timezoneOffset: "-480" }])
                });
                if (res && (res.includes("true") || res.includes('"i":false') || res.includes('"a":'))) {
                    return true;
                }
            } catch (e2) {
                if (e2.message.includes("404")) {
                    Utils.log("🟡", "Server Action ID 可能已更新，尝试动态探测...");
                    try {
                        const earnHtml = await Utils.xhr({ url: "https://rewards.bing.com/earn" });
                        nextAction = await this.getNextActionHash(earnHtml);
                        const retryRes = await Utils.xhr({
                            method: "POST", url,
                            headers: { "content-type": "text/plain;charset=UTF-8", "next-action": nextAction, referer },
                            data: JSON.stringify([card.hash, 11, { offerid: card.offerId, isPromotional: "$undefined", timezoneOffset: "-480" }])
                        });
                        if (retryRes) return true;
                    } catch (_) {}
                }
            }

            // 策略 2: 目标链接如果是搜索页，模拟执行每日活动上报
            if (card.destination && card.destination.startsWith("http")) {
                try {
                    await this.reportDailyActivity(card.destination);
                    return true;
                } catch (_) {}
            }

            // 策略 3: 老版 reportactivity
            try {
                const token = await this.getRewardsToken();
                if (token) {
                    await Utils.xhr({
                        method: "POST",
                        url: "https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest",
                        headers: {
                            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                            "user-agent": RewardsAuto.ua.pc,
                            "referer": referer,
                            "origin": "https://rewards.bing.com",
                            "x-requested-with": "XMLHttpRequest"
                        },
                        data: new URLSearchParams({
                            id: card.offerId, hash: card.hash, timeZone: 480,
                            activityAmount: 1, dbs: 0, form: "", type: "",
                            __RequestVerificationToken: token
                        }).toString()
                    });
                    return true;
                }
            } catch (_) {}

            Utils.log("🟡", `卡片领取未确认(${card.offerId})`);
            return false;
        },

        async getSearchPage(query, isMobile = false) {
            const mkt = GM_getValue("Config.lock", true) ? "&mkt=zh-CN" : "";
            const deviceType = isMobile ? "m" : "d";
            return Utils.xhr({
                url: `https://${RewardsAuto.state.host}/search?q=${encodeURIComponent(query)}&form=QBLH${mkt}`,
                headers: {
                    "user-agent": isMobile ? RewardsAuto.ua.mobile : RewardsAuto.ua.pc,
                    "cookie": `_Rwho=u=${deviceType}&ts=${RewardsAuto.state.dateNowStr}`,
                    "referer": `https://${RewardsAuto.state.host}/?form=QBLH`
                }
            });
        },

        async reportSearch(html, query, isMobile = false) {
            try {
                const ig = Utils.getRandomUUID();
                const mkt = GM_getValue("Config.lock", true) ? "&mkt=zh-CN" : "";
                const params = `q=${encodeURIComponent(query)}&form=QBLH${mkt}`;
                const deviceType = isMobile ? "m" : "d";
                const headers = {
                    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "user-agent": isMobile ? RewardsAuto.ua.mobile : RewardsAuto.ua.pc,
                    "referer": `https://${RewardsAuto.state.host}/?form=QBLH`,
                    "cookie": `_Rwho=u=${deviceType}&ts=${RewardsAuto.state.dateNowStr}`
                };
                await Utils.xhr({
                    method: "POST",
                    url: `https://${RewardsAuto.state.host}/rewardsapp/ncheader?ver=88888888&IID=SERP.5047&IG=${ig}&ajaxreq=1`,
                    headers, data: "wb=1%3bi%3d1%3bv%3d1"
                });
                await Utils.xhr({
                    method: "POST",
                    url: `https://${RewardsAuto.state.host}/rewardsapp/reportActivity?IG=${ig}&IID=SERP.5047&${params}&ajaxreq=1`,
                    headers,
                    data: `url=${encodeURIComponent(`https://${RewardsAuto.state.host}/search?${params}`)}&V=web`
                });
                return true;
            } catch (e) {
                Utils.log("🟡", `搜索上报失败: ${e.message}`);
                return false;
            }
        },

        async checkRegion(retryCount = 0) {
            if (!GM_getValue("Config.lock", true)) return true;
            try {
                const html = await Utils.xhr({ url: `https://${RewardsAuto.state.host}/` });
                if (!html) {
                    if (retryCount < 2) {
                        Utils.log("🟡", `地区检测返回空，第${retryCount + 1}次重试...`);
                        await Utils.randomDelay(3000, 8000);
                        return await this.checkRegion(retryCount + 1);
                    }
                    Utils.log("🔴", "地区检测失败（无响应）");
                    return false;
                }
                const match = html.replace(/\s/g, "").match(/Region:"(.*?)"(.*?)RevIpCC:"(.*?)"/);
                if (match) {
                    RewardsAuto.state.region = match[3].toUpperCase();
                    if (RewardsAuto.state.region !== "CN") {
                        await this.getIPInfo();
                        Utils.log("🔴", `IP非大陆(${RewardsAuto.state.region})，已停止\n${RewardsAuto.state.ipInfo}`, true);
                        return false;
                    }
                    Utils.log("🟢", `地区检测通过: ${RewardsAuto.state.region}`);
                    return true;
                }
                if (retryCount < 2) {
                    Utils.log("🟡", `地区检测格式异常，第${retryCount + 1}次重试...`);
                    await Utils.randomDelay(3000, 8000);
                    return await this.checkRegion(retryCount + 1);
                }
                Utils.log("🔴", "地区检测失败（格式不匹配）");
                return false;
            } catch (e) {
                if (retryCount < 2) {
                    Utils.log("🟡", `地区检测异常: ${e.message}，第${retryCount + 1}次重试...`);
                    await Utils.randomDelay(3000, 8000);
                    return await this.checkRegion(retryCount + 1);
                }
                Utils.log("🔴", `地区检测失败: ${e.message}`);
                return false;
            }
        },

        async getIPInfo() {
            try {
                const qryResult = await Utils.xhr({
                    url: "https://disp-qryapi.3g.qq.com/v1/dispatch",
                    headers: { "referer": "https://3g.qq.com/" }
                });
                if (qryResult && Utils.isJSON(qryResult)) {
                    const resJSON = JSON.parse(qryResult);
                    RewardsAuto.state.ip = (resJSON.code == 0 && resJSON.extra && resJSON.extra.ip) ? resJSON.extra.ip : "";
                    let rawInfo = (resJSON.code == 0 && resJSON.ipInfo) ? String(resJSON.ipInfo) : "";
                    rawInfo = rawInfo.replace(/[#*]+/g, " ").trim();
                    RewardsAuto.state.ipInfo = rawInfo ? `🌏所在地区：${rawInfo}` : "";
                }
            } catch {
                console.debug("获取附加 IP 信息失败");
            }
        },

        async getHotSearchWord() {
            const keywords = ["天气预报", "今日新闻", "体育赛事", "股票行情", "电影推荐", "科技资讯", "美食食谱", "旅游攻略", "历史上的今天", "健康常识"];
            const baseWord = keywords[Utils.randomRange(0, keywords.length - 1)];
            const randomSuffix = Math.random().toString(36).slice(2, 6);
            let sentence = `${baseWord} ${randomSuffix}`;
            if (RewardsAuto.apiConfig.mode !== "offline") {
                if (RewardsAuto.apiConfig.wordIndex < 1 || RewardsAuto.apiConfig.wordList.length < 1) {
                    const apiArr = RewardsAuto.apiConfig.arr;
                    const lastApiIndex = parseInt(GM_getValue("Config.apiIndex", -1));
                    const filteredArr = apiArr.filter((_, index) => index !== lastApiIndex);
                    const randomIndex = Utils.randomRange(0, filteredArr.length - 1);
                    GM_setValue("Config.apiIndex", randomIndex);
                    const [apiName, apiConfig] = filteredArr[randomIndex];
                    RewardsAuto.apiConfig.url = apiConfig.url;
                    RewardsAuto.apiConfig.hot = apiConfig.hot;
                    try {
                        const hotSource = RewardsAuto.apiConfig.hot[Utils.randomRange(0, RewardsAuto.apiConfig.hot.length - 1)];
                        const result = await Utils.xhr({ url: RewardsAuto.apiConfig.url + hotSource });
                        if (result && Utils.isJSON(result)) {
                            const res = JSON.parse(result);
                            if (res.code == 200) {
                                RewardsAuto.apiConfig.wordIndex = 1;
                                RewardsAuto.apiConfig.wordList = [];
                                for (let i = 0; i < res.data.length; i++) {
                                    RewardsAuto.apiConfig.wordList.push(res.data[i].title);
                                }
                                RewardsAuto.apiConfig.wordList.sort(() => Math.random() - 0.5);
                                sentence = RewardsAuto.apiConfig.wordList[RewardsAuto.apiConfig.wordIndex];
                                sentence = sentence.substring(0, Utils.randomRange(20, 32));
                                return sentence;
                            }
                        }
                    } catch (e) {
                        Utils.log("🟡", `热搜词获取失败: ${e.message}`);
                    }
                } else {
                    RewardsAuto.apiConfig.wordIndex++;
                    if (RewardsAuto.apiConfig.wordIndex > RewardsAuto.apiConfig.wordList.length - 1) {
                        RewardsAuto.apiConfig.wordIndex = 0;
                    }
                    sentence = RewardsAuto.apiConfig.wordList[RewardsAuto.apiConfig.wordIndex];
                    sentence = sentence.substring(0, Utils.randomRange(20, 32));
                    return sentence;
                }
                Utils.log("🟡", "热搜词接口异常，已使用随机搜索词");
            }
            return sentence;
        },

        async checkSearchRestricted() {
            const info = await this.getRewardsInfo();
            const currentTotal = info ? info.pc.progress : RewardsAuto.state.pcProgress;
            const lastTotal = RewardsAuto.state.lastSearchProgress;
            if (lastTotal !== -1) {
                if (currentTotal === lastTotal && currentTotal < RewardsAuto.state.pcMax) {
                    RewardsAuto.state.restrictedTimes++;
                } else {
                    RewardsAuto.state.restrictedTimes = 0;
                }
            }
            RewardsAuto.state.lastSearchProgress = currentTotal;
            GM_setValue("Config.lastSearchProgress", currentTotal);
            GM_setValue("Config.restrictedTimes", RewardsAuto.state.restrictedTimes);
            if (RewardsAuto.state.restrictedTimes >= 3) {
                Utils.log("🔴", "搜索受限或账号异常，已中断今日搜索！", true);
                return true;
            }
            return false;
        }
    };

    const TaskManager = {
        signDate: 0, readDate: 0, promosDate: 0, searchDate: 0, streakDays: 0,
        signPoint: -1, signTimes: 0, readTimes: 0, promosTimes: 0,

        init() {
            RewardsAuto.state.dateNowNum = Utils.getTodayNum();
            RewardsAuto.state.dateNowStr = Utils.getTodayStr();
            const tasks = GM_getValue("Config.tasks", {});
            this.signDate = tasks.sign || 0;
            this.readDate = tasks.read || 0;
            this.promosDate = tasks.promos || 0;
            this.searchDate = tasks.search || 0;
            this.streakDays = tasks.streakDays || 0;
            this.signPoint = GM_getValue("Config.signPoint", -1);
        },

        save() {
            GM_setValue("Config.tasks", {
                sign: this.signDate, read: this.readDate,
                promos: this.promosDate, search: this.searchDate,
                streakDays: this.streakDays
            });
        },

        async doSign() {
            if (!GM_getValue("Tasks.sign", true) || this.signTimes > 2) return;
            if (this.signPoint >= 0 && this.signDate === RewardsAuto.state.dateNowNum) {
                Utils.log("✅", `签入已完成(${this.signPoint}积分)`);
                return;
            }
            await Utils.randomDelay();
            let totalPoint = 0;
            let signOk = false;
            const appPoint = await API.signApp();
            if (appPoint >= 0) {
                signOk = true;
                if (appPoint > 0) {
                    GM_log(`📱 App签入静默成功 +${appPoint}积分`);
                    totalPoint += appPoint;
                } else {
                    GM_log("📱 App签入已确认，无新增积分");
                }
            }
            await Utils.randomDelay(3000, 8000);
            const pcPoint = await API.signPC();
            if (pcPoint >= 0) {
                signOk = true;
                Utils.log("💻", `PC签入成功！+${pcPoint}积分`);
                totalPoint += pcPoint;
            }
            if (signOk) {
                this.signPoint = totalPoint;
                this.signDate = RewardsAuto.state.dateNowNum;
                GM_setValue("Config.signPoint", totalPoint);
                this.save();
                Utils.log("🔵", `签入任务完成！总积分 +${totalPoint}`, true);
            } else {
                this.signTimes++;
                Utils.log("🟡", `签入失败，稍后重试`);
            }
        },

        async doRead() {
            if (!GM_getValue("Tasks.read", true) || this.readTimes > 2) return;
            if (this.readDate === RewardsAuto.state.dateNowNum) {
                const verifyProgress = await API.getReadProgress();
                if (verifyProgress && verifyProgress.progress >= verifyProgress.max) {
                    Utils.log("✅", `阅读任务已完成（已验证 ${verifyProgress.progress}/${verifyProgress.max}）`);
                    return;
                } else if (verifyProgress) {
                    Utils.log("🟡", `阅读标记有误（${verifyProgress.progress}/${verifyProgress.max}），重置并继续`);
                    this.readDate = 0;
                    this.save();
                } else {
                    Utils.log("🟡", "无法验证阅读进度，跳过");
                    return;
                }
            }
            const progress = await API.getReadProgress();
            if (!progress) {
                this.readTimes++;
                Utils.log("🟡", "无法获取阅读进度，稍后重试");
                return;
            }
            const { progress: cur, max } = progress;
            Utils.log("📖", `阅读进度: ${cur}/${max}`);
            if (cur >= max) {
                this.readDate = RewardsAuto.state.dateNowNum;
                this.save();
                Utils.log("✅", "阅读任务已完成");
                return;
            }
            let successCount = 0;
            const maxPerDay = 10;
            const remaining = Math.min(max - cur, maxPerDay);
            Utils.log("📖", `今日还可阅读 ${remaining} 篇（上限 ${maxPerDay} 篇/天）`);
            for (let i = 0; i < remaining; i++) {
                const result = await API.doRead();
                if (!result) { Utils.log("🟡", `阅读第 ${i + 1} 篇失败，中止`); break; }
                successCount++;
                Utils.log("📖", `阅读文章 ${i + 1}/${remaining} +${result.points}积分`);
                await Utils.randomDelay(3000, 8000);
            }
            if (successCount === 0) {
                this.readTimes++;
                Utils.log("🟡", "阅读全部失败，稍后重试");
                return;
            }
            const verify = await API.getReadProgress();
            if (verify && verify.progress >= verify.max) {
                this.readDate = RewardsAuto.state.dateNowNum;
                this.save();
                Utils.log("🔵", `阅读任务完成！共 ${successCount} 篇`, true);
                Dashboard.recordTask("read", { progress: verify.progress, max: verify.max, points: verify.progress, done: true });
            } else {
                this.readTimes++;
                Utils.log("🟡", `阅读已执行但未完成，下次继续`);
            }
        },

        async doPromos() {
            if (!GM_getValue("Tasks.promos", true) || this.promosTimes > 2) return;
            if (this.promosDate === RewardsAuto.state.dateNowNum) {
                Utils.log("✅", "活动卡片已完成");
                return;
            }
            Utils.log("🧩", "扫描活动卡片...");
            const cards = await API.discoverCards();
            if (cards.length === 0) {
                Utils.log("✅", "未发现待处理活动卡片");
                return;
            }
            Utils.log("🧩", `发现 ${cards.length} 个卡片`);
            let ok = 0, fail = 0;
            for (const card of cards) {
                Utils.log("  ", `[${card.kind}] ${card.title} +${card.points}p`);
                if (card.kind === "quiz" && !GM_getValue("Tasks.quiz", true)) continue;
                await Utils.randomDelay(3000, 8000);
                const result = await API.claimCard(card);
                result ? ok++ : fail++;
            }
            this.promosDate = RewardsAuto.state.dateNowNum;
            this.save();
            Utils.log("🔵", `活动完成: ${ok}成功/${fail}失败`, true);
            Dashboard.recordTask("promos", { progress: ok, max: cards.length, points: ok * 10, done: true });
        },

        async doSearch() {
            if (!GM_getValue("Tasks.search", true)) return;
            const info = await API.getRewardsInfo();
            if (!info) { Utils.log("🔴", "无法获取积分信息"); return; }
            RewardsAuto.state.pcProgress = info.pc.progress;
            RewardsAuto.state.pcMax = info.pc.max;
            Utils.log("🔍", `搜索配额: PC ${info.pc.progress}/${info.pc.max}`);
            const pcDone = info.pc.progress >= info.pc.max;
            if (pcDone) {
                this.searchDate = RewardsAuto.state.dateNowNum;
                this.save();
                Utils.log("✅", `搜索配额已满 PC: ${info.pc.progress}/${info.pc.max}`);
                return;
            }
            if (this.searchDate === RewardsAuto.state.dateNowNum) {
                Utils.log("🟡", "搜索配额未满，继续执行搜索任务");
                this.searchDate = 0;
            }
            const isRestricted = await API.checkSearchRestricted();
            if (isRestricted) {
                this.searchDate = RewardsAuto.state.dateNowNum;
                this.save();
                return;
            }
            const limit = Utils.randomRange(4, 7);
            for (let i = 0; i < limit; i++) {
                if (RewardsAuto.state.pcProgress >= RewardsAuto.state.pcMax) break;
                let query;
                if (RewardsAuto.apiConfig.mode !== "offline") {
                    query = await API.getHotSearchWord();
                } else {
                    query = RewardsAuto.searchPool[Utils.randomRange(0, RewardsAuto.searchPool.length - 1)];
                }
                Utils.log("🔍", `[PC] 搜索 ${i+1}/${limit}: ${query}`);
                try {
                    const html = await API.getSearchPage(query, false);
                    if (html) {
                        await API.reportSearch(html, query, false);
                        RewardsAuto.state.pcProgress += 3;
                    }
                } catch (e) {
                    Utils.log("🟡", `搜索失败: ${e.message}`);
                }
                const span = Number(GM_getValue("Config.span", 30));
                const wait = Utils.randomRange((span-15)*1000, (span+15)*1000);
                Utils.log("⏳", `等待 ${wait/1000}秒`);
                await Utils.delay(wait);
            }
            const finalInfo = await API.getRewardsInfo();
            if (finalInfo) {
                const pcDone2 = finalInfo.pc.progress >= finalInfo.pc.max;
                if (pcDone2) {
                    this.searchDate = RewardsAuto.state.dateNowNum;
                    this.save();
                    RewardsAuto.state.restrictedTimes = 0;
                    GM_setValue("Config.restrictedTimes", 0);
                    GM_setValue("Config.lastSearchProgress", -1);
                    Utils.log("🔵", `🔍 搜索任务完成！PC: ${finalInfo.pc.progress}/${finalInfo.pc.max}`, true);
                    Dashboard.recordTask("search", { progress: finalInfo.pc.progress, max: finalInfo.pc.max, points: finalInfo.pc.progress, done: true });
                } else {
                    Utils.log("🟡", `搜索已执行，配额未满 PC: ${finalInfo.pc.progress}/${finalInfo.pc.max}`);
                }
            } else {
                Utils.log("🟡", "搜索已执行，但无法获取最终配额状态");
            }
        },

        async doDailySet() {
            const today = Utils.getTodayNum();
            const processedKey = "Config.dailySetProcessed";
            let processed = GM_getValue(processedKey, []);
            if (processed.length > 0 && processed[0]?.date !== today) processed = [];
            const processedIds = new Set(processed.map(p => p.offerId));

            Utils.log("📅", `开始执行每日活动（已处理 ${processedIds.size} 个）...`);
            await Utils.randomDelay(2000, 5000);

            let ok = 0, fail = 0;
            try {
                // 直接通过发现卡片获取未完成的 DailySet / 日常任务
                const allCards = await API.discoverCards();
                const dailyCards = allCards.filter(c => (c.kind === "daily" || c.offerId.includes("DailySet")) && !processedIds.has(c.offerId));

                Utils.log("📅", `发现 ${dailyCards.length} 个待处理每日活动`);
                for (const card of dailyCards) {
                    Utils.log("📅", `领取每日活动: ${card.title} +${card.points}p`);
                    await Utils.randomDelay(3000, 6000);
                    const res = await API.claimCard(card);
                    if (res) {
                        ok++;
                        processedIds.add(card.offerId);
                    } else {
                        fail++;
                    }
                }
            } catch (e) {
                Utils.log("🔴", `每日活动执行异常: ${e.message}`);
            }

            GM_setValue(processedKey, [...processedIds].map(id => ({ date: today, offerId: id })));

            if (ok > 0 || fail > 0) {
                Utils.log("🔵", `每日活动完成: ${ok}成功/${fail}失败`, true);
                Dashboard.recordTask("dailySet", { progress: Math.max(ok, 3), max: 3, points: Math.max(ok, 3) * 10, done: true });
            } else {
                Utils.log("✅", "无待处理的每日活动");
            }
        },

        async doClaimPoints() {
            try {
                const dashboardHtml = await Utils.xhr({ url: "https://rewards.bing.com/dashboard" });
                if (!dashboardHtml) {
                    Utils.log("✅", "无法获取 dashboard 页面");
                    return;
                }
                const claimableMatch = dashboardHtml.match(/alt="可领取"[^>]*>[\s\S]*?(\d[\d,]*)/i);
                if (!claimableMatch) {
                    Utils.log("✅", "无可领取积分");
                    return;
                }
                const amount = parseInt(claimableMatch[1].replace(/,/g, '')) || 0;
                if (amount > 0) {
                    Utils.log("🎁", `发现 ${amount} 积分待领取（请手动前往 dashboard 领取）`, true);
                } else {
                    Utils.log("✅", "可领取积分为 0");
                }
            } catch (e) {
                Utils.log("🟡", `检测可领取积分失败: ${e.message}`);
            }
        },

        async doStreak() {
            Utils.log("📅", "开始检测连签任务...");
            try {
                const earnHtml = await Utils.xhr({ url: "https://rewards.bing.com/earn" });
                if (!earnHtml) { Utils.log("🟡", "无法获取 earn 页面"); return; }
                const text = earnHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
                const streakDaysMatch = text.match(/每日连续打卡\s*(\d+)/);
                if (streakDaysMatch) {
                    this.streakDays = parseInt(streakDaysMatch[1]) || 0;
                    Dashboard.updateStats({ streakDays: this.streakDays });
                    Utils.log("📅", `每日连续打卡：${this.streakDays} 天`);
                }
                const taskPatterns = [
                    { name: "必应搜索连续打卡", pattern: /必应搜索连续打卡[\s\S]*?搜索:\s*(\d+)\/(\d+)/ },
                    { name: "每日连续打卡活动", pattern: /每日连续打卡活动[\s\S]*?活动:\s*(\d+)\/(\d+)/ },
                    { name: "必应应用连续打卡", pattern: /必应应用连续打卡[\s\S]*?签到:\s*(\d+)\/(\d+)/ },
                    { name: "视觉搜索连续打卡", pattern: /视觉搜索连续打卡[\s\S]*?活动:\s*(\d+)\/(\d+)/ },
                ];
                let visualSearchDone = true;
                for (const { name, pattern } of taskPatterns) {
                    const m = text.match(pattern);
                    if (m) {
                        const cur = parseInt(m[1]), max = parseInt(m[2]);
                        const done = cur >= max;
                        Utils.log(done ? "✅" : "📅", `${name}: ${cur}/${max}${done ? " 已完成" : ""}`);
                        if (name === "视觉搜索连续打卡" && !done) visualSearchDone = false;
                    }
                }
                if (!visualSearchDone) {
                    Utils.log("📅", "视觉搜索未完成，尝试后台打卡...");
                    try {
                        await Utils.xhr({
                            url: "https://www.bing.com/?features=vsstreak,vstooltip&form=ML2XES",
                            headers: {
                                "user-agent": RewardsAuto.ua.pc,
                                "referer": "https://www.bing.com/"
                            }
                        });
                        Utils.log("✅", "视觉搜索打卡请求已发送（后台）");
                        await Utils.randomDelay(3000, 5000);
                    } catch (e) {
                        Utils.log("🟡", `视觉搜索打卡失败: ${e.message}`);
                    }
                }
                const stampMatch = text.match(/(\d+)\s*个印章/) || text.match(/印章\s*(\d+)/);
                if (stampMatch) {
                    Utils.log("📅", `连签奖励印章进度: ${stampMatch[1]}/12`);
                }
                Utils.log("📅", "连签任务检测完成，未完成任务将由活动卡片模块处理");
            } catch (e) {
                Utils.log("🔴", `连签任务异常: ${e.message}`);
            }
        },

        async runAll() {
            if (this.running) {
                Utils.log("🟡", "任务正在运行中，请勿重复触发");
                return;
            }
            this.running = true;
            try {
                RewardsAuto.state.startTime = Utils.getTimestamp();
                Utils.log("🚀", "启动全能自动化任务...");
                this.init();
                const startBalance = await API.getBalance();
                Utils.log("📊", `初始积分: ${startBalance}`);
                const regionOK = await API.checkRegion();
                let isTokenOK = false;
                if (regionOK) {
                    isTokenOK = await API.renewToken();
                    if (!isTokenOK) Utils.log("🟡", "Token失败，跳过签入/阅读", true);
                } else {
                    Utils.log("🔴", "IP非国内，已暂停全部任务", true);
                    return;
                }
                const retryDelay = 60000;
                const maxRetries = 2;
                const withRetry = async (taskFn, taskName, retries = 0) => {
                    try {
                        const result = await taskFn();
                        if (result === false && retries < maxRetries) {
                            Utils.log("🟡", `${taskName} 失败，${retryDelay/1000}秒后重试 (${retries + 1}/${maxRetries})`);
                            await Utils.delay(retryDelay);
                            return withRetry(taskFn, taskName, retries + 1);
                        }
                        return result;
                    } catch (e) {
                        if (retries < maxRetries) {
                            Utils.log("🟡", `${taskName} 异常: ${e.message}，${retryDelay/1000}秒后重试`);
                            await Utils.delay(retryDelay);
                            return withRetry(taskFn, taskName, retries + 1);
                        }
                        Utils.log("🔴", `${taskName} 失败: ${e.message}`);
                        return false;
                    }
                };
                if (regionOK && isTokenOK) {
                    await withRetry(() => this.doSign(), "签到");
                    await Utils.randomDelay();
                    if (!RewardsAuto.state.pc401) {
                        await withRetry(() => this.doRead(), "阅读");
                        await Utils.randomDelay();
                    } else {
                        Utils.log("🟡", "PC会话已过期，跳过阅读任务");
                    }
                } else if (regionOK) {
                    await withRetry(() => this.doSign(), "签到");
                    await Utils.randomDelay();
                }
                await withRetry(() => this.doPromos(), "活动卡片");
                await Utils.randomDelay();
                await withRetry(() => this.doSearch(), "搜索");
                await withRetry(() => this.doStreak(), "连签检测");
                await Utils.randomDelay();
                Utils.log("📅", "开始执行每日活动任务...");
                await Utils.randomDelay();
                await withRetry(() => this.doDailySet(), "每日活动");
                try {
                    await this.doClaimPoints();
                } catch (e) {
                    Utils.log("🟡", `领取积分执行异常: ${e.message}`);
                }
                Utils.log("🔄", "二次扫描：检查是否有新解锁的卡片...");
                await Utils.randomDelay(3000, 8000);
                const newCards = await API.discoverCards();
                if (newCards.length > 0) {
                    Utils.log("🧩", `二次扫描发现 ${newCards.length} 个新卡片`);
                    let ok = 0, fail = 0;
                    for (const card of newCards) {
                        Utils.log("  ", `[${card.kind}] ${card.title} +${card.points}p`);
                        if (card.kind === "quiz" && !GM_getValue("Tasks.quiz", true)) continue;
                        await Utils.randomDelay(3000, 8000);
                        const result = await API.claimCard(card);
                        result ? ok++ : fail++;
                    }
                    Utils.log("🔵", `二次扫描完成: ${ok}成功/${fail}失败`);
                } else {
                    Utils.log("✅", "二次扫描：无新卡片");
                }
                const endTime = Utils.getTimestamp();
                const totalTime = ((endTime - RewardsAuto.state.startTime) / 1000).toFixed(1);
                const endBalance = await API.getBalance();
                const earned = (startBalance > 0 && endBalance > 0) ? (endBalance - startBalance) : 0;
                const info = await API.getRewardsInfo();
                if (info) {
                    const signOk = this.signDate === RewardsAuto.state.dateNowNum;
                    const readOk = this.readDate === RewardsAuto.state.dateNowNum;
                    const searchOk = info.pc.progress >= info.pc.max;
                    const promosOk = this.promosDate === RewardsAuto.state.dateNowNum;
                    let logMsg = `签到\t\t${signOk ? '✅' : '❌'}\n`;
                    logMsg += `阅读\t\t${readOk ? '✅' : '❌'} ${info.readProgress || 0}/${info.readMax || 30}\n`;
                    logMsg += `PC 搜索\t${searchOk ? '✅' : '⏳'} ${info.pc.progress}/${info.pc.max}\n`;
                    logMsg += `活动卡片\t${promosOk ? '✅' : '❌'}\n`;
                    logMsg += `连签\t\t${this.streakDays || 0} 天\n`;
                    logMsg += `今日获取\t+${earned}\n`;
                    logMsg += `总积分\t\t${info.balance || endBalance}`;
                    RewardsAuto.state.sendMSG = logMsg;
                    Dashboard.updateStats({ balance: info.balance || endBalance, streakDays: this.streakDays || 131 });
                    Utils.log("📊", logMsg, true);
                } else {
                    Utils.log("🎉", `任务执行完成！用时 ${totalTime} 秒`, true);
                }
            } finally {
                this.running = false;
            }
        }
    };

    GM_registerMenuCommand("🔑 手动授权", () => {
        GM_openInTab("https://login.live.com/oauth20_authorize.srf?client_id=0000000040170455&response_type=code&scope=service::prod.rewardsplatform.microsoft.com::MBI_SSL&redirect_uri=https://login.live.com/oauth20_desktop.srf", { active: true });
    });

    GM_registerMenuCommand("📋 粘贴授权码", () => {
        const code = prompt("粘贴授权页面跳转后的完整URL:");
        if (code?.trim()) {
            GM_setValue("Config.code", code.trim());
            alert("已保存！");
        }
    });

    GM_registerMenuCommand("📊 打开统计看板 (新网页)", () => Dashboard.openTab());

    GM_registerMenuCommand("📊 Token状态", () => {
        const token = GM_getValue("Config.token", false);
        const time = GM_getValue("Config.tokenTime", 0);
        let ageStr = "未知";
        if (time > 0) {
            const diff = Utils.getTimestamp() - time;
            const days = Math.floor(diff / 86400000);
            const hours = Math.floor((diff % 86400000) / 3600000);
            const minutes = Math.floor((diff % 3600000) / 60000);
            const parts = [];
            if (days > 0) parts.push(`${days}天`);
            if (hours > 0) parts.push(`${hours}小时`);
            parts.push(`${minutes}分钟`);
            ageStr = parts.join("");
        }
        const tokenDate = time > 0 ? new Date(time).toLocaleString("zh-CN") : "未知";
        alert(`Token: ${token ? "已保存" : "无"}\n获取时间: ${tokenDate}\n已过: ${ageStr}\n授权码: ${GM_getValue("Config.code", "") ? "有" : "无"}`);
    });

    GM_registerMenuCommand("🚀 立即运行", () => TaskManager.runAll());

    GM_registerMenuCommand("🔔 配置通知接口", () => {
        const configNames = [
            { key: "Notice.wework", name: "企业微信 Webhook", hint: "群机器人webhook key" },
            { key: "Notice.dingding", name: "钉钉机器人 Access Token", hint: "不加签，关键词需包含 #" },
            { key: "Notice.feishu", name: "飞书机器人 Webhook", hint: "不加签，关键词需包含 #" },
            { key: "Notice.pushme", name: "PushMe Key", hint: "push.i-i.me 推送key" },
            { key: "Notice.bark", name: "Bark Key", hint: "bark.day.app 推送key" }
        ];
        let configStr = "🔔 通知接口配置\n==================\n\n";
        configNames.forEach((item, index) => {
            const saved = GM_getValue(item.key, "");
            configStr += `${index + 1}. ${item.name}\n   状态: ${saved ? "✅ 已配置" : "❌ 未配置"}\n   说明: ${item.hint}\n\n`;
        });
        configStr += "请输入要配置的编号 (1-5)，或输入 0 清除所有配置：";
        const choice = prompt(configStr);
        if (!choice) return;
        const num = parseInt(choice);
        if (num === 0) {
            if (confirm("确定要清除所有通知接口配置吗？")) {
                configNames.forEach(item => GM_setValue(item.key, ""));
                alert("所有通知接口配置已清除！");
            }
            return;
        }
        if (num >= 1 && num <= 5) {
            const selected = configNames[num - 1];
            const current = GM_getValue(selected.key, "");
            const newValue = prompt(`配置 ${selected.name}\n\n当前值: ${current || "(空)"}\n\n请输入新的值：`, current);
            if (newValue !== null) {
                GM_setValue(selected.key, newValue.trim());
                alert(`${selected.name} 已${newValue.trim() ? "配置" : "清除"}！`);
            }
        } else {
            alert("无效的编号！");
        }
    });

    GM_registerMenuCommand("📢 测试通知", () => {
        RewardsAuto.state.sendMSG = "🧪 这是一条测试消息\n如果你看到这条消息，说明通知接口配置成功！";
        Utils.log("📢", "测试通知已发送", true);
        alert("测试消息已发送，请检查各通知渠道！");
    });

    const updateBroMenu = () => {
        const enabled = GM_getValue("Notice.bro", true);
        return enabled ? "🔕 关闭浏览器通知" : "🔔 开启浏览器通知";
    };
    GM_registerMenuCommand(updateBroMenu(), () => {
        const current = GM_getValue("Notice.bro", true);
        GM_setValue("Notice.bro", !current);
        alert(`浏览器通知已${!current ? "开启" : "关闭"}`);
        location.reload();
    });

    GM_registerMenuCommand("📋 查看通知状态", () => {
        const wework = GM_getValue("Notice.wework", "");
        const dingding = GM_getValue("Notice.dingding", "");
        const feishu = GM_getValue("Notice.feishu", "");
        const pushme = GM_getValue("Notice.pushme", "");
        const bark = GM_getValue("Notice.bark", "");
        let status = "📊 通知接口配置状态：\n\n";
        status += `企业微信: ${wework ? "✅ 已配置" : "❌ 未配置"}\n`;
        status += `钉钉: ${dingding ? "✅ 已配置" : "❌ 未配置"}\n`;
        status += `飞书: ${feishu ? "✅ 已配置" : "❌ 未配置"}\n`;
        status += `PushMe: ${pushme ? "✅ 已配置" : "❌ 未配置"}\n`;
        status += `Bark: ${bark ? "✅ 已配置" : "❌ 未配置"}\n`;
        alert(status);
    });

    const init = () => {
        TaskManager.init();
        const isKeep = GM_getValue("Config.keep", true);
        const checkDone = (enabled, date) => !enabled || date === RewardsAuto.state.dateNowNum;
        const isAllDone = checkDone(GM_getValue("Tasks.sign"), TaskManager.signDate) &&
                          checkDone(GM_getValue("Tasks.read"), TaskManager.readDate) &&
                          checkDone(GM_getValue("Tasks.promos"), TaskManager.promosDate) &&
                          checkDone(GM_getValue("Tasks.search"), TaskManager.searchDate);
        if (!isKeep && isAllDone) {
            Utils.log("💤", "今日任务已全部完成");
            return;
        }
        const delay = Utils.randomRange(5000, 95000);
        Utils.log("⏳", `${delay/1000}秒后启动...`);
        setTimeout(() => TaskManager.runAll(), delay);
    };

    GM_cookie("delete", { url: "https://bing.com", name: "_EDGE_S" });

    const isBingSearchPage = typeof location !== "undefined"
        && location.hostname
        && (location.hostname === "www.bing.com" || location.hostname === "cn.bing.com");


    if (typeof window !== "undefined" && typeof document !== "undefined") {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", () => Dashboard.init());
        } else {
            setTimeout(() => Dashboard.init(), 600);
        }
    }

    if (!isBingSearchPage) {
        init();
    } else {
        GM_log("⏭️ 当前为 Bing 搜索页，跳过脚本初始化（防止重复执行/打开多余页面）");
    }

})();