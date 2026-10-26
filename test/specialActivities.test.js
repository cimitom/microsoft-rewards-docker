import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPECIAL_ACTIVITIES,
  buildSpecialActivityTask,
  extractActivityCardsFromHtml,
  extractSpecialActivitiesFromHtml,
  findSpecialActivity,
  isSpecialActivityAttemptedToday
} from '../src/core/specialActivities.js';

const html = `<script>self.__next_f.push([1,"{\\"activityCards\\":[{\\"title\\":\\"浏览器中的奖励\\",\\"description\\":\\"添加我们的新浏览器扩展并赚取30积分。\\",\\"destination\\":\\"https://www.bing.com/set/browserextension/rewards?channel=rwdamc\\",\\"isCompleted\\":false,\\"points\\":0,\\"offerId\\":\\"WW_Rewards_AdHoc_RewardsExtensionBrowser_20191028\\",\\"hash\\":\\"task-hash-123\\"},{\\"title\\":\\"兑换推荐\\",\\"destination\\":\\"https://rewards.microsoft.com/redeem/test\\",\\"isCompleted\\":false,\\"points\\":0,\\"offerId\\":\\"ZHCN_Encourage_Redemption_RecommendedSKU\\"}]}"])</script>`;

test('零积分活动卡片仍可被完整解析', () => {
  const cards = extractActivityCardsFromHtml(html);
  assert.equal(cards.length, 2);
  const extension = cards.find(card => card.offerId === SPECIAL_ACTIVITIES.browserExtension.offerId);
  assert.ok(extension);
  assert.equal(extension.points, 0);
  assert.equal(extension.isCompleted, false);
  assert.equal(extension.hash, 'task-hash-123');
});

test('只把精确匹配的扩展活动识别为特殊任务', () => {
  const activities = extractSpecialActivitiesFromHtml(html);
  assert.equal(activities.length, 1);
  assert.equal(activities[0].key, SPECIAL_ACTIVITIES.browserExtension.key);
  assert.equal(activities[0].awardPoints, 30);
  assert.equal(activities[0].title, '浏览器中的奖励');
  assert.equal(findSpecialActivity(activities, SPECIAL_ACTIVITIES.browserExtension.key)?.offerId,
    SPECIAL_ACTIVITIES.browserExtension.offerId);
});

test('完成状态来自官网并映射为 30 分任务', () => {
  const completedHtml = `<script>{"offerId":"${SPECIAL_ACTIVITIES.browserExtension.offerId}","title":"浏览器中的奖励","description":"添加我们的新浏览器扩展并赚取30积分。","destination":"https://www.bing.com/set/browserextension/rewards?channel=rwdamc","isCompleted":true,"points":0,"hash":"task-hash-123"}</script>`;
  const completed = extractSpecialActivitiesFromHtml(completedHtml)[0];
  const task = buildSpecialActivityTask(completed, {}, 1792937000000);
  assert.equal(completed.isCompleted, true);
  assert.equal(task.done, true);
  assert.equal(task.progress, 1);
  assert.equal(task.points, 30);
  assert.equal(task.awardPoints, 30);
  assert.match(task.statusMessage, /延迟入账/);
});

test('同一天已尝试过的账号不会再次点击', () => {
  const now = new Date(2026, 9, 25, 22, 0, 0).getTime();
  const earlier = new Date(2026, 9, 25, 10, 0, 0).getTime();
  assert.equal(isSpecialActivityAttemptedToday({ lastAttemptAt: earlier }, now), true);
  assert.equal(isSpecialActivityAttemptedToday({ lastAttemptAt: earlier - 24 * 60 * 60 * 1000 }, now), false);
  assert.equal(isSpecialActivityAttemptedToday({}, now), false);
});
