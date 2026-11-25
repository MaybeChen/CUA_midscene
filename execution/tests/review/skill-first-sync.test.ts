import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import Fastify from 'fastify';
import { RecordingCardStore } from '../../review/service/recording-cards.js';
import { RecordingWorkflow } from '../../review/service/recording-workflow.js';
import { registerRecordingCardRoutes } from '../../review/server/recording-card-routes.js';
import { listRecordings } from '../../cua/recording/recording-catalog.js';
import type { RecorderControl } from '../../review/service/windows-recorder.js';
import type { WorkflowStatus } from '../../review/shared/workflow.js';
import { createSkillFixture } from '../helpers/skill-fixture.js';
import { seedWorkflowMetadata, readWorkflowMetadata } from '../helpers/workflow-metadata-fixture.js';

function stored(cardId = 'original-card'): WorkflowStatus {
  return { cardId, recordingId: 'Recording_linked', skillName: 'linked-task', phase: 'done', draftRoot: '', error: '', log: '' };
}

async function recording(root: string, id: string): Promise<void> {
  const inputs = path.join(root, id, 'inputs');
  await mkdir(inputs, { recursive: true });
  await writeFile(path.join(inputs, 'capture.mp4'), 'test video');
  await writeFile(path.join(inputs, 'events.txt'), 'test events');
}

async function fixture(t: TestContext, prepare: (cards: RecordingCardStore) => WorkflowStatus[] = () => [stored()]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-first-'));
  const skillsRoot = path.join(root, 'skills');
  const recordingsRoot = path.join(root, 'recordings');
  await createSkillFixture(skillsRoot, 'linked-task');
  await recording(recordingsRoot, 'Recording_linked');
  await recording(recordingsRoot, 'Recording_free');
  const cards = new RecordingCardStore(path.join(root, 'workbench', 'console.sqlite'));
  const options = { dataRoot: root, skillsRoot, recordingsRoot, cards };
  const initial = new RecordingWorkflow(options);
  await initial.close();
  seedWorkflowMetadata(root, prepare(cards));
  const workflow = new RecordingWorkflow(options);
  const app = Fastify();
  registerRecordingCardRoutes(app, cards, { status: () => ({ phase: 'idle' }) } as RecorderControl,
    () => listRecordings(options), () => workflow.isBusy(), id => workflow.remove(id), {
      synchronize: entries => workflow.synchronizeSkills(entries),
      skillName: id => workflow.status(id).skillName || undefined,
    });
  t.after(async () => { await app.close(); await workflow.close(); cards.close(); await rm(root, { recursive: true, force: true }); });
  return { root, cards, workflow, app, skillsRoot, recordingsRoot };
}

test('优先恢复 Skill 的持久化录制映射，再为未关联录制建卡，不产生重复资产卡', async t => {
  const setup = await fixture(t);
  const response = await setup.app.inject({ method: 'POST', url: '/api/recording-cards/sync' });
  assert.equal(response.statusCode, 200, response.body);
  const cards = (await setup.app.inject('/api/recording-cards')).json().cards;
  assert.equal(cards.length, 2);
  const linked = cards.find((card: { skillName: string }) => card.skillName === 'linked-task');
  assert.equal(linked.id, 'original-card');
  assert.equal(linked.recordingId, 'Recording_linked');
  assert.equal(setup.workflow.status(linked.id).phase, 'done');
  assert.equal(cards.filter((card: { recordingId: string }) => card.recordingId === 'Recording_linked').length, 1);
  assert.ok(cards.some((card: { recordingId: string }) => card.recordingId === 'Recording_free'));
  await setup.workflow.synchronizeSkills();
  assert.equal(setup.cards.all().length, 2);
  assert.equal(readWorkflowMetadata(setup.root).find(row => row.cardId === linked.id)?.recordingId, 'Recording_linked');
});

test('恢复卡片关联时保留人工名称、描述与访问，重复扫描不更新卡片版本', async t => {
  const setup = await fixture(t, cards => {
    const card = cards.create({ name: '人工名称', description: '人工描述' });
    cards.visit(card.id);
    return [stored(card.id)];
  });
  const id = setup.cards.recent()[0].id;
  const visit = setup.cards.recent()[0].lastVisitedAt;
  await setup.workflow.synchronizeSkills();
  const bound = setup.cards.get(id);
  assert.equal(bound.name, '人工名称');
  assert.equal(bound.description, '人工描述');
  assert.equal(bound.recordingId, 'Recording_linked');
  assert.equal(setup.cards.recent()[0].lastVisitedAt, visit);
  await setup.workflow.synchronizeSkills();
  assert.deepEqual(setup.cards.get(id), bound);
});

test('录制已有卡片时复用该卡片并迁移孤立工作流，持久化中不留旧卡片映射', async t => {
  const setup = await fixture(t, cards => {
    const card = cards.create({ name: '保留原录制卡片', description: '' });
    cards.beginRecording(card.id); cards.completeRecording('Recording_linked');
    return [stored('missing-card')];
  });
  const original = setup.cards.all()[0];
  await setup.workflow.synchronizeSkills();
  assert.equal(setup.cards.all().length, 2);
  assert.equal(setup.workflow.status(original.id).skillName, 'linked-task');
  assert.deepEqual(setup.cards.get(original.id), original);
  const rows = readWorkflowMetadata(setup.root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cardId, original.id);
});

test('暂缺资产不提示错误并保留历史映射，目录恢复后在同一卡片补齐关联', async t => {
  const setup = await fixture(t);
  await rm(path.join(setup.recordingsRoot, 'Recording_linked'), { recursive: true });
  const result = await setup.workflow.synchronizeSkills();
  assert.deepEqual(result.warnings, []);
  assert.equal(setup.cards.get('original-card').recordingId, null);
  assert.equal((await setup.workflow.result('original-card')).name, 'linked-task');
  assert.equal(readWorkflowMetadata(setup.root)[0].recordingId, 'Recording_linked');
  await recording(setup.recordingsRoot, 'Recording_linked');
  await setup.workflow.synchronizeSkills();
  assert.equal(setup.cards.get('original-card').recordingId, 'Recording_linked');
  assert.equal(setup.cards.all().length, 2);
});

test('新录制不会被历史关联覆盖，生成失败的草稿、日志和待导入名称均保留', async t => {
  const setup = await fixture(t, cards => {
    const card = cards.create({ name: '已重新录制', description: '' });
    cards.beginRecording(card.id); cards.completeRecording('Recording_new');
    return [{ ...stored(card.id), phase: 'failed', pendingSkillName: 'retry-task', error: '导入失败', log: '待重试日志' }];
  });
  await recording(setup.recordingsRoot, 'Recording_new');
  const original = setup.cards.all()[0];
  const persisted = readWorkflowMetadata(setup.root);
  await setup.workflow.synchronizeSkills();
  assert.deepEqual(setup.cards.get(original.id), original);
  assert.deepEqual(readWorkflowMetadata(setup.root), persisted);
  assert.equal(setup.cards.all().length, 2);
});

test('多个来源有冲突时提示并保留映射，不猜测关联录制', async t => {
  const setup = await fixture(t, () => [stored('first'), { ...stored('second'), recordingId: 'Recording_free' }]);
  const persisted = readWorkflowMetadata(setup.root);
  const result = await setup.workflow.synchronizeSkills();
  assert.match(result.warnings.join('\n'), /多个录制资产关联/);
  assert.deepEqual(readWorkflowMetadata(setup.root), persisted);
  assert.equal(setup.cards.all().length, 0);
});

test('目录仍存在的未关联资产可恢复缺失卡片，历史导入标记不阻止首页补齐', async t => {
  const setup = await fixture(t);
  await setup.workflow.synchronizeSkills();
  const free = setup.cards.all().find(card => card.recordingId === 'Recording_free')!;
  setup.cards.remove(free.id);
  await setup.workflow.synchronizeSkills();
  const restored = setup.cards.all().find(card => card.recordingId === 'Recording_free')!;
  assert.ok(restored);
  assert.notEqual(restored.id, free.id);
  assert.equal(setup.cards.all().length, 2);
});

test('录制目录读取失败时仍同步 Skill 并提示，已有映射不丢失', async t => {
  const setup = await fixture(t);
  const result = await setup.workflow.synchronizeSkills(async () => { throw new Error('录制目录不可读'); });
  assert.match(result.warnings.join('\n'), /录制目录扫描失败.*录制目录不可读/);
  assert.equal(setup.cards.all().length, 1);
  assert.equal((await setup.workflow.result('original-card')).name, 'linked-task');
  assert.equal(readWorkflowMetadata(setup.root)[0].recordingId, 'Recording_linked');
});
