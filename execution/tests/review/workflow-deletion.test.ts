import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import Fastify from 'fastify';
import { RecordingCardStore } from '../../review/service/recording-cards.js';
import { RecordingWorkflow } from '../../review/service/recording-workflow.js';
import { replaceRecordingDraft } from '../../review/service/skill-replacement.js';
import { deleteRecording } from '../../review/service/asset-deletion.js';
import { registerRecordingCardRoutes } from '../../review/server/recording-card-routes.js';
import type { RecorderControl } from '../../review/service/windows-recorder.js';
import { assembleSkillFixture } from '../helpers/skill-fixture.js';

async function recording(root: string, id: string): Promise<void> {
  const inputs = path.join(root, id, 'inputs');
  await mkdir(inputs, { recursive: true });
  await writeFile(path.join(inputs, 'capture.mp4'), 'video');
  await writeFile(path.join(inputs, 'events.txt'), 'events');
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('工作流状态等待超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-deletion-'));
  const dataRoot = path.join(root, 'data');
  const skillsRoot = path.join(root, 'skills');
  const recordingsRoot = path.join(root, 'recordings');
  await mkdir(skillsRoot);
  await recording(recordingsRoot, 'Recording_1');
  const cards = new RecordingCardStore(path.join(dataRoot, 'workbench', 'console.sqlite'));
  const card = cards.create({ name: '删除关联技能', description: '' });
  cards.beginRecording(card.id); cards.completeRecording('Recording_1'); cards.visit(card.id);
  const controls = { failPrepare: false, failRemoval: false, executing: false, gate: undefined as Promise<void> | undefined };
  const workflow = new RecordingWorkflow({ dataRoot, skillsRoot, recordingsRoot, cards, beforeDelete: () => {
    if (controls.executing) throw Object.assign(new Error('关联 Skill 正在执行'), { statusCode: 409 });
  } }, {
    prepare: async ({ draftRoot }) => {
      if (controls.failPrepare) throw new Error('分析失败');
      await assembleSkillFixture(path.join(draftRoot, 'linked-example'), 'linked-example');
      return 'linked-example';
    },
    publish: options => replaceRecordingDraft(options),
    deleteRecording: async (id, options) => {
      if (controls.gate) await controls.gate;
      if (controls.failRemoval) throw new Error('录制目录被占用');
      return deleteRecording(id, options);
    },
  });
  const app = Fastify();
  registerRecordingCardRoutes(app, cards, { status: () => ({ phase: 'idle' }) } as RecorderControl,
    async () => ({ configured: true, envName: 'CUA_RECORDINGS_ROOT', recordings: [] }), () => workflow.isBusy(), id => workflow.remove(id));
  t.after(async () => { await app.close(); await workflow.close(); cards.close(); await rm(root, { recursive: true, force: true }); });
  return { root, dataRoot, skillsRoot, recordingsRoot, cards, card, controls, workflow, app, url: `/api/recording-cards/${card.id}` };
}

async function generate(setup: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  await setup.workflow.analyze(setup.card.id, 'zh-CN');
  await until(() => ['done', 'failed'].includes(setup.workflow.status(setup.card.id).phase));
}

test('首页删除清理关联 Skill、草稿、ZIP、录制及最近访问，不影响其他技能', async t => {
  const setup = await fixture(t);
  await generate(setup);
  const status = setup.workflow.status(setup.card.id);
  assert.equal(status.phase, 'done', status.error);
  await writeFile(path.join(status.draftRoot, `${status.skillName}.zip`), 'archive');
  const unrelated = path.join(setup.skillsRoot, 'unrelated');
  await assembleSkillFixture(unrelated, 'unrelated');
  const response = await setup.app.inject({ method: 'DELETE', url: setup.url });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { deleted: true });
  for (const target of [status.draftRoot, path.join(setup.skillsRoot, status.skillName), path.join(setup.recordingsRoot, 'Recording_1')]) {
    await assert.rejects(access(target), { code: 'ENOENT' });
  }
  assert.throws(() => setup.cards.get(setup.card.id), /不存在/);
  assert.deepEqual(setup.cards.recent(), []);
  await access(path.join(unrelated, 'task.yaml'));
});

test('删除未生成的空卡片不要求 Skill 根配置', async t => {
  const setup = await fixture(t);
  const card = setup.cards.create({ name: '空卡片', description: '' });
  const workflow = new RecordingWorkflow({ dataRoot: setup.dataRoot, cards: setup.cards });
  await workflow.remove(card.id);
  await workflow.close();
  assert.throws(() => setup.cards.get(card.id), /不存在/);
  assert.equal(setup.cards.get(setup.card.id).name, '删除关联技能');
});

test('重新分析失败并重录后删除，仍清理旧 Skill 及所有已关联草稿', async t => {
  const setup = await fixture(t);
  await generate(setup);
  const old = setup.workflow.status(setup.card.id);
  setup.controls.failPrepare = true;
  await generate(setup);
  const failed = setup.workflow.status(setup.card.id);
  assert.equal(failed.phase, 'failed');
  await recording(setup.recordingsRoot, 'Recording_2');
  setup.cards.beginRecording(setup.card.id); setup.cards.completeRecording('Recording_2');
  assert.equal(setup.workflow.status(setup.card.id).phase, 'idle');
  await setup.workflow.remove(setup.card.id);
  for (const target of [old.draftRoot, failed.draftRoot, path.join(setup.skillsRoot, old.skillName), path.join(setup.recordingsRoot, 'Recording_2')]) {
    await assert.rejects(access(target), { code: 'ENOENT' });
  }
});

test('关联资产已不存在时仍能删除，同步目录不会复活卡片', async t => {
  const setup = await fixture(t);
  await generate(setup);
  await rm(path.join(setup.dataRoot, 'workbench', 'drafts'), { recursive: true });
  await rm(path.join(setup.skillsRoot, 'linked-example'), { recursive: true });
  await rm(path.join(setup.recordingsRoot, 'Recording_1'), { recursive: true });
  await setup.workflow.remove(setup.card.id);
  setup.cards.importRecordings([{ id: 'Recording_1', ready: true, errors: [] }]);
  assert.equal(setup.cards.list('', 1, 16).total, 0);
});

test('清理录制失败保留卡片、访问和草稿，重试可继续完成删除', async t => {
  const setup = await fixture(t);
  await generate(setup);
  const status = setup.workflow.status(setup.card.id);
  setup.controls.failRemoval = true;
  const failed = await setup.app.inject({ method: 'DELETE', url: setup.url });
  assert.equal(failed.statusCode, 500);
  assert.match(failed.body, /录制目录被占用/);
  assert.equal(setup.cards.get(setup.card.id).name, '删除关联技能');
  assert.equal(setup.cards.recent().length, 1);
  await access(status.draftRoot);
  assert.equal(setup.workflow.isBusy(), false);
  setup.controls.failRemoval = false;
  const retried = await setup.app.inject({ method: 'DELETE', url: setup.url });
  assert.equal(retried.statusCode, 200, retried.body);
  await assert.rejects(access(status.draftRoot), { code: 'ENOENT' });
});

test('普通 Skill 和执行中保护失败时不删除卡片、草稿或原始录制', async t => {
  const setup = await fixture(t);
  await generate(setup);
  const status = setup.workflow.status(setup.card.id);
  setup.controls.executing = true;
  assert.equal((await setup.app.inject({ method: 'DELETE', url: setup.url })).statusCode, 409);
  setup.controls.executing = false;
  const formal = path.join(setup.skillsRoot, status.skillName);
  await rm(formal, { recursive: true });
  await mkdir(formal); await writeFile(path.join(formal, 'SKILL.md'), 'ordinary skill');
  assert.equal((await setup.app.inject({ method: 'DELETE', url: setup.url })).statusCode, 500);
  await access(status.draftRoot);
  await access(path.join(formal, 'SKILL.md'));
  await access(path.join(setup.recordingsRoot, 'Recording_1', 'inputs', 'capture.mp4'));
  assert.equal(setup.cards.get(setup.card.id).name, '删除关联技能');
});

test('删除期间阻止生成、发布、录制和重复删除，录制中的卡片不能开始清理', async t => {
  const setup = await fixture(t);
  await generate(setup);
  setup.cards.beginRecording(setup.card.id);
  await assert.rejects(setup.workflow.remove(setup.card.id), /正在录制/);
  setup.cards.clearSession();
  let release!: () => void;
  setup.controls.gate = new Promise<void>(resolve => { release = resolve; });
  const deleting = setup.workflow.remove(setup.card.id);
  try {
    assert.equal(setup.workflow.isBusy(), true);
    await assert.rejects(setup.workflow.analyze(setup.card.id, 'zh-CN'), /正在删除/);
    await assert.rejects(setup.workflow.publish(setup.card.id), /正在删除/);
    assert.equal((await setup.app.inject({ method: 'DELETE', url: setup.url })).statusCode, 409);
    const response = await setup.app.inject({ method: 'POST', url: `${setup.url}/record`, payload: { displayId: 'screen' } });
    assert.equal(response.statusCode, 409);
  } finally { release(); await deleting; }
  assert.equal(setup.workflow.isBusy(), false);
});
