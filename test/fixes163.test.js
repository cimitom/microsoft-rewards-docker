import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-fixes-'));
process.env.MSR_DATA_DIR = tmpDir;

const { default: configManager, SECRET_PLACEHOLDER, SECRET_CLEAR } = await import('../src/config.js');
const { default: rewardsApi } = await import('../src/core/api.js');
const { default: scheduler } = await import('../src/scheduler.js');
const { default: networkClient } = await import('../src/network.js');
const { TaskManager } = await import('../src/core/taskManager.js');

test('SECRET_CLEAR 和 null 可以彻底清空凭据，而不是被旧值复原', () => {
  configManager.upsertAccount({
    id: 'acc_clear_test',
    name: '清空测试账号',
    cookie: 'ORIGINAL_COOKIE',
    refreshToken: 'ORIGINAL_REFRESH_TOKEN',
    accessToken: 'ORIGINAL_ACCESS_TOKEN'
  });

  let acc = configManager.findAccount('acc_clear_test');
  assert.equal(acc.cookie, 'ORIGINAL_COOKIE');
  assert.equal(acc.refreshToken, 'ORIGINAL_REFRESH_TOKEN');

  // 1. 用 null 清空 Token
  configManager.upsertAccount({
    id: 'acc_clear_test',
    accessToken: null,
    refreshToken: null
  });
  acc = configManager.findAccount('acc_clear_test');
  assert.equal(acc.accessToken, '', 'accessToken 应被清空为字符串');
  assert.equal(acc.refreshToken, '', 'refreshToken 应被清空为字符串');
  assert.equal(acc.cookie, 'ORIGINAL_COOKIE', '未声明清空的 cookie 仍保留');

  // 2. 用 SECRET_CLEAR 清空 Cookie
  configManager.upsertAccount({
    id: 'acc_clear_test',
    cookie: SECRET_CLEAR
  });
  acc = configManager.findAccount('acc_clear_test');
  assert.equal(acc.cookie, '', 'cookie 应被清空');
});

test('getHotSearchWord 在热词耗尽且网络失败时不抛异常且绝不返回 undefined', async () => {
  rewardsApi.hotWordList = ['词1', '词2'];
  rewardsApi.hotWordIndex = 2; // 模拟已取完

  // 模拟网络请求失败
  const origFetch = rewardsApi.fetchSearchWordList;
  rewardsApi.fetchSearchWordList = async () => ({ success: false, sample: [] });

  try {
    const word = await rewardsApi.getHotSearchWord();
    assert.ok(typeof word === 'string' && word.length > 0, '必须返回非空字符串兜底词');
    assert.notEqual(word, 'undefined', '不能返回字符串 undefined');
    assert.notEqual(word, undefined, '不能返回 undefined');
  } finally {
    rewardsApi.fetchSearchWordList = origFetch;
  }
});

test('scheduler 计划落盘与跨实例恢复：已执行状态不丢失', () => {
  const today = scheduler.getTodayNum();
  scheduler.ensureDayPlans(today, false);
  const plan = scheduler.plannedDailyRuns[String(today)]?.acc_1;
  if (plan) {
    plan.executed = true;
    scheduler.savePlans();

    // 重新从磁盘加载
    scheduler.plannedDailyRuns = {};
    scheduler.loadPlans();
    assert.equal(scheduler.plannedDailyRuns[String(today)]?.acc_1?.executed, true, '重启后已执行状态必须保持 true');
  }
});

test('getRewardsInfo 解析 dashboard 待领取额外积分与必应应用连签真实状态', async () => {
  const dashHtml = `
    <div>
      <p class="text-labelControl">可领取</p>
      <img alt="可领取" src="icon.svg">
      <div class="flex"><p class="text-pageHeader">12</p></div>
      <p class="text-metadata">领取</p>
    </div>
    <button>
      <p class="text-globalBody2Strong">必应应用连续打卡</p>
      <div class="sr-only"><div>已完成连续打卡 3 天，共 7 天。</div></div>
      <div class="line-clamp-2">签到: 1/1</div>
    </button>
  `;
  const origRequest = networkClient.request;
  networkClient.request = async (opt) => {
    if (opt.url.includes('/dashboard')) return dashHtml;
    return '<script>self.__next_f.push([1,"x:\\"pointsCounters\\":{\\"pc\\":{\\"max\\":60,\\"progress\\":60}}"])</script>';
  };
  try {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.equal(info.claimablePoints, 12, '待领取额外积分应解析为 12');
    assert.equal(info.streaks.bingapp.isCurrentDayCompleted, true, '签到 1/1 应判定为当日已完成');
    assert.equal(info.streaks.bingapp.completedDays, 3);
  } finally {
    networkClient.request = origRequest;
  }
});

test('getRewardsInfo 解析月度打孔卡（十月必看五大亮点）与到期天数', async () => {
  const earnHtml = `
    <div>
      <h1>十月必看五大亮点：服饰、玩具、手机、超值优惠和AI设备</h1>
      <p>+50</p>
      <p>状态: 2/5 个任务</p>
      <p>到期日期 14 天后</p>
      <a href="/earn/quest/ENWW_pcparent_FY27_BingMonthlyPC_Oct_punchcard">查看</a>
    </div>
  `;
  const origRequest = networkClient.request;
  networkClient.request = async (opt) => {
    if (opt.url.includes('/earn')) return earnHtml;
    return '';
  };
  try {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.ok(info.monthlyQuest, '必须识别出月度打孔卡');
    assert.equal(info.monthlyQuest.progress, 2);
    assert.equal(info.monthlyQuest.max, 5);
    assert.equal(info.monthlyQuest.points, 50);
    assert.match(info.monthlyQuest.title, /十月必看五大亮点/);
    assert.match(info.monthlyQuest.expiresText, /14 天后/);
  } finally {
    networkClient.request = origRequest;
  }
});

test('TaskManager recordPunchCardSteps 记录多步时间戳且支持同天多步', () => {
  const tm = new TaskManager();
  const accId = 'acc_test_steps';
  tm.ensureAccountStats(accId);

  const now = Date.now();
  tm.recordPunchCardSteps(accId, [
    { title: '十月必看五大亮点', stepName: '服装季来了', at: now - 3600000 },
    { title: '十月必看五大亮点', stepName: '热门玩具与礼物创意', at: now }
  ]);

  const st = tm.ensureAccountStats(accId);
  const mQuest = st.tasks.monthlyQuest;
  assert.ok(mQuest);
  assert.equal(mQuest.progress, 2);
  assert.equal(mQuest.stepLogs.length, 2);
  assert.equal(mQuest.stepLogs[0].name, '服装季来了');
  assert.equal(mQuest.stepLogs[1].name, '热门玩具与礼物创意');
  assert.ok(mQuest.stepLogs[1].at > mQuest.stepLogs[0].at);
});

test('getRewardsInfo 动态解析多打孔卡（包含万圣节 A 50-point Halloween treat）', async () => {
  const flightHtml = `
    <script>self.__next_f.push([1,"\\"text-globalBody2Strong\\",\\"children\\":\\"A 50-point Halloween treat\\",\\"b\\":{\\"children\\":\\"0/6 个任务\\"}"])</script>
    <script>self.__next_f.push([1,"\\"text-globalBody2Strong\\",\\"children\\":\\"桌面奖励应用每周专属任务\\",\\"b\\":{\\"children\\":\\"5/8 个任务\\"}"])</script>
    <script>self.__next_f.push([1,"\\"text-globalBody2Strong\\",\\"children\\":\\"十月必看五大亮点：服饰、玩具、手机、超值优惠和AI设备\\",\\"b\\":{\\"children\\":\\"3/5 个任务\\"}"])</script>
  `;
  const origRequest = networkClient.request;
  networkClient.request = async (opt) => {
    if (opt.url.includes('/earn')) return flightHtml;
    return '';
  };
  try {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.ok(Array.isArray(info.quests), '必须返回全量 quests 数组');
    assert.equal(info.quests.length, 3, '应解析出全部 3 个打孔卡任务');
    const h = info.quests.find(q => q.title.includes('Halloween'));
    assert.ok(h, '必须包含 Halloween 打孔卡');
    assert.equal(h.max, 6);
    assert.equal(h.progress, 0);
    assert.equal(h.icon, '🎃');
  } finally {
    networkClient.request = origRequest;
  }
});

test('TaskManager 根据官网动态增删打孔卡卡片', () => {
  const tm = new TaskManager();
  const accId = 'acc_dynamic_sync';
  const accCfg = { id: accId, name: '动态卡片测试账号', cookie: 'MOCK_COOKIE' };
  tm.ensureAccountStats(accId);

  // 1. 官网有 3 个打孔卡：Desktop, Monthly, Halloween
  const mockInfo = {
    todayPoints: 50,
    quests: [
      { title: '桌面奖励应用每周专属任务', progress: 4, max: 8, points: 20 },
      { title: '十月必看五大亮点', progress: 2, max: 5, points: 50 },
      { title: 'A 50-point Halloween treat', progress: 1, max: 6, points: 50, icon: '🎃' }
    ]
  };

  const origGetRewards = rewardsApi.getRewardsInfo;
  const origStreak = rewardsApi.checkStreak;
  rewardsApi.getRewardsInfo = async () => mockInfo;
  rewardsApi.checkStreak = async () => ({ streakDays: 5 });

  // 同步状态
  return tm.syncAccountOfficialStatus(accCfg, { owned: true }).then(() => {
    const st = tm.ensureAccountStats(accId);
    const punchCards = Object.values(st.tasks).filter(t => t.isPunchCard);
    assert.equal(punchCards.length, 3, '应动态生成 3 个打孔卡');
    assert.ok(st.tasks.quest_halloween, '应包含万圣节打孔卡');
    assert.equal(st.tasks.quest_halloween.icon, '🎃');

    // 2. 模拟万圣节任务活动结束后官网只有 1 个任务
    mockInfo.quests = [
      { title: '桌面奖励应用每周专属任务', progress: 8, max: 8, points: 20 }
    ];

    return tm.syncAccountOfficialStatus(accCfg, { owned: true }).then(() => {
      const stAfter = tm.ensureAccountStats(accId);
      const punchCardsAfter = Object.values(stAfter.tasks).filter(t => t.isPunchCard);
      assert.equal(punchCardsAfter.length, 1, '下线活动应自动移除，只保留 1 个打孔卡');
      assert.equal(stAfter.tasks.quest_halloween, undefined, '万圣节卡片应已自动清除');
      assert.equal(stAfter.tasks.desktopApp.done, true);
    });
  }).finally(() => {
    rewardsApi.getRewardsInfo = origGetRewards;
    rewardsApi.checkStreak = origStreak;
  });
});
