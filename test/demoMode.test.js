import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-demo-mode-'));
process.env.MSR_DATA_DIR = tmpDir;
process.env.NODE_ENV = 'production';
process.env.MSR_ENABLE_DEMO = '1';
process.env.EPIC_DEMO = '1';

const { default: configManager } = await import('../src/config.js');
const { EpicManager } = await import('../src/core/epic.js');
const { isDemoMode } = await import('../src/core/demoMode.js');

test('生产环境忽略遗留演示环境变量', () => {
  assert.equal(isDemoMode(), false);
});

test('生产实例启动时清理已落盘的 demo Epic 账号与记录', () => {
  configManager.update({
    epic: {
      accounts: [
        { id: 'demo_epic_1', name: '演示账号 A', storageState: { cookies: [], origins: [] } },
        { id: 'epic_real_1', name: '真实账号', storageState: { cookies: [], origins: [] } }
      ],
      claimRecords: [
        { accountId: 'demo_epic_1', title: '演示游戏', status: 'claimed' },
        { accountId: 'epic_real_1', title: '真实游戏', status: 'owned' }
      ]
    }
  });

  new EpicManager();

  assert.deepEqual(configManager.getEpicAccounts().map(acc => acc.id), ['epic_real_1']);
  assert.deepEqual(configManager.getEpicClaimRecords(20).map(record => record.accountId), ['epic_real_1']);
});
