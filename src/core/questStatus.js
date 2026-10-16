/**
 * 判断打孔卡子任务是否已经完成。
 *
 * 不能只看文案：例如“开始搜索”的描述里会写“(1/5 天已完成)”，
 * 但子任务本身仍未完成。页面的成功图标 / 空圆圈才是可靠状态。
 */
export function isQuestSubtaskCompleted({ hasSuccessIcon = false, hasEmptyCircle = false, rawText = '' } = {}) {
  if (hasSuccessIcon) return true;
  if (hasEmptyCircle) return false;
  return /(^|\n)\s*(已完成|Complete|Completed)\s*($|\n)/i.test(String(rawText || ''));
}
