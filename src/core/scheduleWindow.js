export const RUN_HOURS = Array.from({ length: 24 }, (_, index) => index);
export const RUN_WINDOW_MINUTES = 60;
export const MAX_START_DELAY_MINUTES = 10;

function normalizeRunHourValues(value) {
  const values = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  return [...new Set(values
    .map(item => Number(item))
    .filter(item => Number.isInteger(item) && RUN_HOURS.includes(item)))]
    .sort((a, b) => a - b);
}

export function normalizeRunHours(value, fallback = [9]) {
  const valid = normalizeRunHourValues(value);
  if (valid.length > 0) return valid;
  return normalizeRunHours(fallback, [9]);
}

/**
 * 账号级运行档位：每个账号最多只能占用一个一小时窗口。
 * 显式传入空数组表示未排期，等同于暂停自动任务。
 */
export function normalizeAccountRunHours(value) {
  const [first] = normalizeRunHourValues(value);
  return first === undefined ? [] : [first];
}

export function buildTimeSlot(runHours) {
  const [startHour] = normalizeAccountRunHours(runHours);
  if (startHour === undefined) return null;
  return {
    startHour,
    endHour: (startHour + 1) % 24,
    randomDelayMin: MAX_START_DELAY_MINUTES,
    durationHours: 1
  };
}

/**
 * 清理历史配置中的档位冲突。
 *
 * 按账号当前顺序保留先占用者；后出现重叠的账号会被清空全部选择，
 * 由用户重新手动选择。返回值同时标记配置是否发生变化，便于持久化。
 */
export function reconcileAccountRunHours(accounts = []) {
  const claimed = new Map();
  const cleared = [];
  let changed = false;

  for (const acc of accounts) {
    if (!acc || typeof acc !== 'object') continue;
    const requested = normalizeRunHourValues(acc.runHours);
    const selectedHour = requested[0];
    const conflictHour = requested.find(hour => claimed.has(hour));
    let nextHours = [];

    if (selectedHour !== undefined && conflictHour === undefined) {
      nextHours = [selectedHour];
      claimed.set(selectedHour, acc);
    } else if (conflictHour !== undefined) {
      const owner = claimed.get(conflictHour);
      cleared.push({
        id: acc.id,
        name: acc.name || acc.id,
        hour: conflictHour,
        occupiedBy: owner?.id || '',
        occupiedByName: owner?.name || owner?.id || ''
      });
    }

    const nextSlot = buildTimeSlot(nextHours);
    if (JSON.stringify(acc.runHours) !== JSON.stringify(nextHours)
      || JSON.stringify(acc.timeSlot) !== JSON.stringify(nextSlot)) {
      changed = true;
    }
    acc.runHours = nextHours;
    acc.timeSlot = nextSlot;
  }

  return { cleared, changed };
}

/**
 * 每天只在最早可用的已勾选小时档启动一次。
 * 当天若已经错过该档的 10 分钟启动宽限，则顺延到下一个已勾选档位。
 */
export function selectRunHour(runHours, { isToday = false, nowMin = 0 } = {}) {
  const hours = normalizeRunHours(runHours);
  if (!isToday) return { hour: hours[0], expired: false };
  const available = hours.find(hour => nowMin <= hour * 60 + MAX_START_DELAY_MINUTES);
  if (available !== undefined) return { hour: available, expired: false };
  return { hour: hours[hours.length - 1], expired: true };
}
