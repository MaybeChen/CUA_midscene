import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { RecordingCardStore } from '../../review/service/recording-cards.js';
import { registerRecordingCardRoutes } from '../../review/server/recording-card-routes.js';
import type { RecorderControl } from '../../review/service/windows-recorder.js';

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cua-cards-'));
  const file = path.join(root, 'console.sqlite');
  const store = new RecordingCardStore(file);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { store, file };
}

test('卡片可先于录制创建，改名不修改录制身份，访问不改变业务版本', async (t) => {
  const { store, file } = await fixture(t);
  const card = store.create({ name: '报销流程', description: '填写报销单' });
  assert.equal(card.recordingId, null);
  store.beginRecording(card.id);
  store.completeRecording('Recording_actual');
  const recorded = store.get(card.id);
  store.visit(card.id);
  store.visit(card.id);
  assert.equal(store.recent().length, 1);
  assert.deepEqual(store.get(card.id), recorded);
  const renamed = store.update(
    card.id,
    { name: '新名称', description: '更新描述' },
    recorded.version,
  );
  assert.equal(renamed.recordingId, 'Recording_actual');
  assert.equal(store.recent()[0].name, '新名称');
  assert.throws(
    () =>
      store.update(
        card.id,
        { name: '冲突', description: '' },
        recorded.version,
      ),
    /已更新/,
  );
  const second = new RecordingCardStore(file);
  try {
    assert.equal(second.get(card.id).name, '新名称');
    assert.equal(second.recent().length, 1);
  } finally {
    second.close();
  }
});

test('导入幂等、删除不复活、重录保留原录制索引且清理访问记录', async (t) => {
  const { store } = await fixture(t);
  const entries = [{ id: 'Recording_old', ready: true, errors: [] }];
  store.importRecordings(entries);
  store.importRecordings(entries);
  assert.equal(store.list('', 1, 16).total, 1);
  const card = store.list('', 1, 16).cards[0];
  store.beginRecording(card.id);
  assert.throws(() => store.remove(card.id), /正在录制/);
  store.clearSession();
  assert.equal(store.get(card.id).recordingId, 'Recording_old');
  store.beginRecording(card.id);
  store.completeRecording('Recording_new');
  store.importRecordings(entries);
  assert.equal(store.list('', 1, 16).total, 1);
  store.visit(card.id);
  store.remove(card.id);
  store.importRecordings([
    ...entries,
    { id: 'Recording_new', ready: true, errors: [] },
  ]);
  assert.equal(store.list('', 1, 16).total, 0);
  assert.equal(store.recent().length, 0);
});

test('分页及字面搜索不把百分号和下划线当作通配符', async (t) => {
  const { store } = await fixture(t);
  for (let i = 0; i < 19; i++)
    store.create({ name: `流程${i}`, description: '' });
  store.create({ name: '100%_完成', description: '' });
  assert.equal(store.list('', 1, 16).cards.length, 16);
  assert.equal(store.list('', 2, 16).cards.length, 4);
  assert.equal(store.list('%_', 1, 16).total, 1);
  assert.equal(store.list('', 100, 16).page, 2);
});

test('卡片接口校验输入并通过实际录制完成通知关联，不猜测最新文件', async (t) => {
  const { store } = await fixture(t);
  const app = Fastify();
  const recorder = {
    status: () => ({ phase: 'idle' }),
    start: async () => ({ phase: 'armed' }),
  } as unknown as RecorderControl;
  registerRecordingCardRoutes(app, store, recorder, async () => ({
    configured: true,
    envName: 'CUA_RECORDINGS_ROOT',
    recordings: [],
  }));
  t.after(async () => {
    await app.close();
  });
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/recording-cards',
        payload: { name: '  ', description: '' },
      })
    ).statusCode,
    400,
  );
  const created = await app.inject({
    method: 'POST',
    url: '/api/recording-cards',
    payload: { name: '任务', description: '' },
  });
  assert.equal(created.statusCode, 201);
  const card = created.json();
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/recording-cards/${card.id}/record`,
        payload: { displayId: 'screen-1' },
      })
    ).statusCode,
    200,
  );
  assert.equal(store.activeCard(), card.id);
  store.completeRecording('Recording_exact');
  assert.equal(
    (await app.inject(`/api/recording-cards/${card.id}`)).json().recordingId,
    'Recording_exact',
  );
  assert.equal(
    (await app.inject('/api/recording-cards?page=-1')).statusCode,
    400,
  );
});
