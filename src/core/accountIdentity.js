/**
 * 网页端 Cookie 与移动端 Token 是否明显属于不同账号。
 * DAPI 与网页端偶尔有同步延迟，所以只把超过 100 分的差异视为绑定错误。
 */
export function isBalanceMismatch(webBalance, mobileBalance, threshold = 100) {
  const web = Number(webBalance);
  const mobile = Number(mobileBalance);
  return Number.isFinite(web) && Number.isFinite(mobile)
    && web > 0 && mobile > 0
    && Math.abs(web - mobile) > Math.max(0, Number(threshold) || 0);
}
