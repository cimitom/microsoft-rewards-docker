import test from 'node:test';
import assert from 'node:assert/strict';
import rewardsApi from '../src/core/api.js';

test('getHotSearchWord 支持排重：在传入 exclude 时绝对不返回已有词', async () => {
  const origList = rewardsApi.hotWordList;
  const origIndex = rewardsApi.hotWordIndex;
  const origFetch = rewardsApi.fetchSearchWordList;

  try {
    rewardsApi.hotWordList = ['搜索词A', '搜索词B', '搜索词C'];
    rewardsApi.hotWordIndex = 0;
    rewardsApi.fetchSearchWordList = async () => ({ success: true, sample: ['搜索词A', '搜索词B', '搜索词C'] });

    const used = new Set(['搜索词A']);
    const word1 = await rewardsApi.getHotSearchWord({ exclude: used });
    assert.equal(word1, '搜索词B', '应当自动跳过已在 exclude 中的搜索词A');
    used.add(word1);

    const word2 = await rewardsApi.getHotSearchWord({ exclude: used });
    assert.equal(word2, '搜索词C');
    used.add(word2);

    // 热词已全部在 exclude 中，应当自动进入 fallbackSentence 并确保不重复
    const word3 = await rewardsApi.getHotSearchWord({ exclude: used });
    assert.ok(typeof word3 === 'string' && word3.length > 0);
    assert.equal(used.has(word3), false, '兜底生成的关键词也不能与已有词重复');
  } finally {
    rewardsApi.hotWordList = origList;
    rewardsApi.hotWordIndex = origIndex;
    rewardsApi.fetchSearchWordList = origFetch;
  }
});

test('单轮 20 次搜索能连续生成 20 个互不相同的关键词', async () => {
  const used = new Set();
  for (let i = 0; i < 20; i++) {
    const word = await rewardsApi.getHotSearchWord({ exclude: used });
    assert.ok(typeof word === 'string' && word.length > 0);
    assert.equal(used.has(word), false, `第 ${i + 1} 次搜索关键词 "${word}" 发生重复`);
    used.add(word);
  }
  assert.equal(used.size, 20);
});
