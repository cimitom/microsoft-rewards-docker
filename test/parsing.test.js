import test from 'node:test';
import assert from 'node:assert/strict';
import networkClient from '../src/network.js';
import rewardsApi from '../src/core/api.js';

/**
 * 用最小化的官网页面片段做解析回归。
 * 这些解析是整条链路最脆弱的部分（微软一改版就会失效），
 * 至少保证「字段位置变了」能在测试里立刻暴露。
 */
const EARN_FIXTURE = `
<script>self.__next_f.push([1,"x:\\"pointsCounters\\":{\\"dailyOffer\\":77,\\"pc\\":{\\"max\\":60,\\"progress\\":60,\\"originalMax\\":60},\\"totalPoints\\":137,\\"boostActivated\\":false}"])</script>
<script>self.__next_f.push([1,"y:\\"balance\\":51355,\\"availablePoints\\":51355"])</script>
<script>self.__next_f.push([1,"a:\\"children\\":\\"今日积分\\",\\"b\\":{\\"className\\":\\"text-pageHeader\\",\\"children\\":\\"137\\"}"])</script>
<script>self.__next_f.push([1,"b:\\"partner\\":\\"bingapp\\",\\"isCurrentDayCompleted\\":true,\\"completedDays\\":4,\\"currentDay\\":3,\\"activitiesCompleted\\":1,\\"activitiesTotal\\":1,\\"c\\":1"])</script>
<script>self.__next_f.push([1,"c:\\"activityCards\\":[{\\"isCompleted\\":true,\\"offerId\\":\\"A\\"},{\\"isCompleted\\":false,\\"offerId\\":\\"B\\"}]"])</script>
<script>self.__next_f.push([1,"d:\\"href\\":\\"/earn/quest/ENWW_pcparent_FY27_BingMonthlyPC_Oct_punchcard\\""])</script>
`;

function withStubbedNetwork(html, fn) {
  const origRequest = networkClient.request;
  const origRead = rewardsApi.getReadProgress;
  const origBalance = rewardsApi.getBalance;
  networkClient.request = async () => html;
  rewardsApi.getReadProgress = async () => null;
  rewardsApi.getBalance = async () => null;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      networkClient.request = origRequest;
      rewardsApi.getReadProgress = origRead;
      rewardsApi.getBalance = origBalance;
    });
}

test('getRewardsInfo 解析官网「今日积分」与余额', async () => {
  await withStubbedNetwork(EARN_FIXTURE, async () => {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.ok(info, '应返回解析结果');
    assert.equal(info.todayPoints, 137, '今日积分必须来自官网卡片');
    assert.equal(info.balance, 51355);
    assert.deepEqual(info.pc, { progress: 60, max: 60 });
  });
});

test('getRewardsInfo 解析必应应用连签真实状态', async () => {
  await withStubbedNetwork(EARN_FIXTURE, async () => {
    const info = await rewardsApi.getRewardsInfo(1);
    assert.equal(info.streaks.bingapp.isCurrentDayCompleted, true);
    assert.equal(info.streaks.bingapp.completedDays, 4);
  });
});

test('getActivityCardStatus 统计 activityCards 完成情况', async () => {
  await withStubbedNetwork(EARN_FIXTURE, async () => {
    const status = await rewardsApi.getActivityCardStatus();
    assert.deepEqual(status, { total: 2, completed: 1 });
  });
});

test('getQuestPunchCards 提取任务区打孔卡链接', async () => {
  await withStubbedNetwork(EARN_FIXTURE, async () => {
    const quests = await rewardsApi.getQuestPunchCards();
    assert.equal(quests.length, 1);
    assert.equal(quests[0].questId, 'ENWW_pcparent_FY27_BingMonthlyPC_Oct_punchcard');
    assert.match(quests[0].url, /^https:\/\/rewards\.bing\.com\/earn\/quest\//);
  });
});

test('discoverCards 给卡片打上分类，供独立开关过滤', async () => {
  const cardsFixture = `
  <script>self.__next_f.push([1,"a:{\\"offerId\\":\\"Gamification_DailySet_ZHCN_20261015_Child1\\",\\"hash\\":\\"h1\\",\\"points\\":10,\\"title\\":\\"每日活动\\"}"])</script>
  <script>self.__next_f.push([1,"b:{\\"offerId\\":\\"ZHstar_Rewards_DailyGlobalOffer_Evergreen_Monday\\",\\"hash\\":\\"h2\\",\\"points\\":5,\\"title\\":\\"拼图\\"}"])</script>
  `;
  await withStubbedNetwork(cardsFixture, async () => {
    const cards = await rewardsApi.discoverCards();
    const byId = Object.fromEntries(cards.map(c => [c.offerId, c.category]));
    assert.equal(byId['Gamification_DailySet_ZHCN_20261015_Child1'], 'dailyset');
    assert.equal(byId['ZHstar_Rewards_DailyGlobalOffer_Evergreen_Monday'], 'promo');
  });
});
