import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHumanPath, randomBetween } from '../src/core/humanInput.js';

test('拟人鼠标轨迹从起点附近开始并在目标点结束', () => {
  let seed = 0;
  const rng = () => {
    seed = (seed + 0.173) % 1;
    return seed;
  };
  const start = { x: 10, y: 20 };
  const end = { x: 410, y: 320 };
  const points = buildHumanPath(start, end, { rng });
  assert.ok(points.length >= 10);
  assert.ok(Math.hypot(points[0].x - start.x, points[0].y - start.y) < 0.001);
  assert.deepEqual(points.at(-1), end);
  assert.ok(points.some(point => point.x > start.x && point.x < end.x));
});

test('随机范围在给定上下界内', () => {
  const values = Array.from({ length: 100 }, () => randomBetween(5, 9, Math.random));
  assert.ok(values.every(value => value >= 5 && value <= 9));
});

