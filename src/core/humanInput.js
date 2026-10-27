const DEFAULT_DELAY = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function randomBetween(min, max, rng = Math.random) {
  const low = Math.min(Number(min), Number(max));
  const high = Math.max(Number(min), Number(max));
  return low + (high - low) * rng();
}

function cubicPoint(start, control1, control2, end, t) {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * start.x + b * control1.x + c * control2.x + d * end.x,
    y: a * start.y + b * control1.y + c * control2.y + d * end.y
  };
}

/**
 * 生成一条带轻微过冲和抖动的鼠标轨迹。
 * 纯函数便于单测，不依赖 Playwright。
 */
export function buildHumanPath(start, end, options = {}) {
  const rng = options.rng || Math.random;
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const steps = Math.max(8, Math.min(36, Math.round(distance / 28) + Math.round(randomBetween(6, 14, rng))));
  const bend = Math.min(90, Math.max(12, distance * 0.12));
  const side = rng() > 0.5 ? 1 : -1;
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const nx = distance > 0 ? -(end.y - start.y) / distance : 0;
  const ny = distance > 0 ? (end.x - start.x) / distance : 0;
  const overshootX = end.x + nx * side * randomBetween(2, 9, rng);
  const overshootY = end.y + ny * side * randomBetween(2, 9, rng);
  const control1 = {
    x: start.x + (midX - start.x) * 0.55 + nx * side * bend * 0.35,
    y: start.y + (midY - start.y) * 0.55 + ny * side * bend * 0.35
  };
  const control2 = {
    x: midX + (overshootX - midX) * 0.6 + nx * side * bend,
    y: midY + (overshootY - midY) * 0.6 + ny * side * bend
  };
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const point = cubicPoint(start, control1, control2, { x: overshootX, y: overshootY }, t);
    if (i > 0 && i < steps) {
      point.x += randomBetween(-0.8, 0.8, rng);
      point.y += randomBetween(-0.8, 0.8, rng);
    }
    points.push(point);
  }
  points.push({ x: end.x, y: end.y });
  return points;
}

export async function humanMove(page, x, y, options = {}) {
  if (!page?.mouse?.move) return;
  const viewport = page.viewportSize?.() || { width: 1366, height: 768 };
  const start = options.start || {
    x: randomBetween(40, Math.max(41, viewport.width - 40), options.rng),
    y: randomBetween(40, Math.max(41, viewport.height - 40), options.rng)
  };
  const points = buildHumanPath(start, { x, y }, options);
  for (const point of points) {
    await page.mouse.move(point.x, point.y);
    await DEFAULT_DELAY(randomBetween(6, 18, options.rng));
  }
  return { x, y };
}

export async function humanClick(locator, options = {}) {
  const page = options.page || locator.page?.();
  if (!page) throw new Error('humanClick 缺少页面对象');
  const timeout = Math.max(1000, Number(options.timeout) || 10000);
  if (typeof locator.scrollIntoViewIfNeeded === 'function') {
    await locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
  }
  const box = typeof locator.boundingBox === 'function'
    ? await locator.boundingBox({ timeout }).catch(() => null)
    : null;
  if (!box || box.width <= 0 || box.height <= 0) {
    return locator.click({ timeout, noWaitAfter: options.noWaitAfter });
  }
  const rng = options.rng || Math.random;
  const target = {
    x: box.x + box.width * randomBetween(0.32, 0.68, rng),
    y: box.y + box.height * randomBetween(0.32, 0.68, rng)
  };
  const start = options.start || {
    x: randomBetween(30, 900, rng),
    y: randomBetween(30, 650, rng)
  };
  await humanMove(page, target.x, target.y, { ...options, rng, start });
  await DEFAULT_DELAY(randomBetween(35, 130, rng));
  await page.mouse.down({ button: 'left' });
  await DEFAULT_DELAY(randomBetween(45, 145, rng));
  await page.mouse.up({ button: 'left' });
  if (options.afterClickDelay !== false) {
    await DEFAULT_DELAY(randomBetween(60, 180, rng));
  }
  return target;
}

export async function humanType(page, text, options = {}) {
  const value = String(text ?? '');
  const rng = options.rng || Math.random;
  for (const char of value) {
    await page.keyboard.type(char, { delay: randomBetween(options.minDelay || 35, options.maxDelay || 95, rng) });
    if (/[，。！？,.!?]/.test(char)) {
      await DEFAULT_DELAY(randomBetween(80, 220, rng));
    }
  }
}

export async function humanWheel(page, options = {}) {
  const rng = options.rng || Math.random;
  const times = Math.max(1, Math.min(4, Number(options.times) || 1));
  for (let i = 0; i < times; i++) {
    await page.mouse.wheel(0, randomBetween(options.min || 260, options.max || 760, rng));
    await DEFAULT_DELAY(randomBetween(180, 650, rng));
  }
}

