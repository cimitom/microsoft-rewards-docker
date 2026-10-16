/**
 * 账号上下文锁
 *
 * 这个项目的账号上下文（networkClient.activeCookie / rewardsApi.currentAccountId /
 * logger 的账号前缀）是「全局可变状态」：谁最后调用 setCurrentAccount，后续所有
 * 请求就都算在谁头上。
 *
 * 于是出现过一个隐蔽的多账号串号问题：定时任务正在跑账号 A 的搜索时，如果恰好有人
 * 打开/刷新 WebUI（页面加载会自动调 /api/status/sync）或点了「体检」「单次测搜」，
 * 那些接口会调用 setCurrentAccount(账号 B)，把全局上下文切到 B —— 结果 A 的后续
 * 搜索、卡片领取、阅读上报全部记到了 B 头上（日志也会串台）。
 *
 * 这里用一把「按持有者标识可重入」的锁来串行化所有会改写账号上下文的流程：
 *   - 定时/手动任务执行持有 'task-run'，内部嵌套调用传同一个标识即可重入；
 *   - WebUI 的同步 / 体检 / 测搜在锁被占用时直接跳过，绝不抢占上下文。
 */
export class AccountContextLock {
  constructor() {
    this.owner = null;
    this.depth = 0;
  }

  isBusy() {
    return this.owner !== null;
  }

  /** 当前持有者标识（未占用时为 null） */
  currentOwner() {
    return this.owner;
  }

  /**
   * 非阻塞获取。同一个 owner 重复获取视为重入，直接成功。
   * @returns {boolean} 是否拿到（或本来就持有）
   */
  tryAcquire(owner) {
    if (this.owner !== null && this.owner !== owner) return false;
    this.owner = owner;
    this.depth += 1;
    return true;
  }

  /**
   * 带超时的阻塞获取。用于任务执行入口：短暂等待 WebUI 的同步流程收尾。
   */
  async acquire(owner, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.tryAcquire(owner)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise(r => setTimeout(r, 250));
    }
  }

  release(owner) {
    if (this.owner !== owner) return;
    this.depth -= 1;
    if (this.depth <= 0) {
      this.depth = 0;
      this.owner = null;
    }
  }
}

export const accountContextLock = new AccountContextLock();
/**
 * Chromium 浏览器资源锁：积分任务的搜索/打孔卡共用这一把锁。
 * Epic 已改用独立 Firefox 引擎与 firefoxSlotLock，因此可与微软任务并行。
 * 与 accountContextLock 是两件不同的事，不要合并：
 *   - accountContextLock 保护「全局账号上下文」，只在积分任务内部使用；
 *   - browserSlotLock 保护微软 Chromium；
 *   - firefoxSlotLock 保护 Epic Firefox。
 */
export const browserSlotLock = new AccountContextLock();
/**
 * Firefox 浏览器资源锁。
 *
 * Epic 改用 Firefox 后，它与微软的 Chromium 是两套独立进程。
 * 8GB 内存环境允许并行运行，因此这里使用独立锁；低内存部署仍可通过
 * 上层配置选择串行执行。
 */
export const firefoxSlotLock = new AccountContextLock();
export default accountContextLock;
