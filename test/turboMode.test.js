import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskManager } from '../src/core/taskManager.js';

test('极速模式状态管理：支持开启与读取，且单次任务执行时被自动消耗重置', async () => {
  const tm = new TaskManager();
  assert.equal(tm.isTurboMode(), false, '默认极速模式应为关闭');

  tm.setTurboMode(true);
  assert.equal(tm.isTurboMode(), true, '设置后极速模式应当开启');

  // 模拟执行：进入 runAll 后应立即消费 turboMode 并将其恢复为 false
  // 覆盖 checkRegion 避免在单测环境下因无网络或非国区退出
  const rewardsApi = (await import('../src/core/api.js')).default;
  const origCheckRegion = rewardsApi.checkRegion;
  rewardsApi.checkRegion = async () => false; // 触发地区检查拦截以快速返回

  try {
    await tm.runAll(true);
    assert.equal(tm.isTurboMode(), false, '执行一次后极速模式必须自动恢复为关闭');
  } finally {
    rewardsApi.checkRegion = origCheckRegion;
    tm.stop();
  }
});
