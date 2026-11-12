import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { prepareRecordingSkill, publishRecordingDraft } from '../../cua/skills/create.js';
import { RecordingWorkflow } from '../../review/service/recording-workflow.js';
import { RecordingCardStore } from '../../review/service/recording-cards.js';
import { loadReviewSkill, saveReviewSkill } from '../../review/service/review-skill.js';
import { recordingSkillFixture, installImportedFixture } from '../helpers/skill-import-fixture.js';

async function fixture(t: TestContext, beforePublish = async () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'automatic-skill-'));
  const assets = await recordingSkillFixture(root);
  await mkdir(assets.skillsRoot);
  await writeFile(path.join(assets.recording, 'inputs', 'capture.mp4'), 'original-video');
  const cards = new RecordingCardStore(path.join(root, 'workbench', 'console.sqlite'));
  const card = cards.create({ name: '自动生成任务', description: '' });
  cards.beginRecording(card.id); cards.completeRecording('Recording_1');
  const calls = { prepare: 0, publish: 0 };
  const manager = new RecordingWorkflow({ dataRoot: root, cards, skillsRoot: assets.skillsRoot, recordingsRoot: root }, {
    prepare: options => prepareRecordingSkill({ ...options, pythonExecutable: process.execPath }, {
      runRecorder: async () => { calls.prepare++; options.progress.write('CUA_TRACE_PROGRESS {"completed":4,"total":4}\n'); },
    }),
    publish: async options => {
      calls.publish++;
      await beforePublish();
      await publishRecordingDraft({ ...options, executionRoot: assets.executionRoot }, {
        fetch: async (_url, init) => {
          await installImportedFixture(init!.body as FormData, assets.skillsRoot);
          return Response.json({ success: true });
        },
      });
    },
  });
  t.after(async () => { await manager.close(); cards.close(); await rm(root, { recursive: true, force: true }); });
  return { ...assets, card, calls, manager };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待工作流状态超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('生成自动完成分析、ZIP 宿主导入和正式资源确认，未确认前不能进入结果', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const setup = await fixture(t, () => gate);
  try {
    await setup.manager.analyze(setup.card.id, 'zh-CN');
    await until(() => setup.manager.status(setup.card.id).phase === 'publishing');
    await assert.rejects(setup.manager.result(setup.card.id), /尚未完成导入/);
    await assert.rejects(setup.manager.stop(setup.card.id), /导入中不能中止/);
    assert.match(setup.manager.status(setup.card.id).log, /正在打包并同步到 GDE/);
  } finally { release(); }
  await until(() => setup.manager.status(setup.card.id).phase === 'done');
  const status = setup.manager.status(setup.card.id);
  assert.deepEqual(setup.calls, { prepare: 1, publish: 1 });
  assert.match(status.log, /已同步到 GDE，正式 Skill 资源校验完成/);
  assert.equal((await setup.manager.result(setup.card.id)).installPath, path.join(setup.skillsRoot, status.skillName));
  const draftPath = path.join(status.draftRoot, status.skillName, 'task.yaml');
  const original = await readFile(draftPath, 'utf8');
  const formal = await loadReviewSkill(setup.skillsRoot, status.skillName);
  (formal.document.tasks as { flow: Record<string, unknown>[] }[])[0].flow = [{ aiTap: '点击修改后的按钮' }];
  assert.doesNotMatch(await readFile(path.join(setup.skillsRoot, status.skillName, 'task.yaml'), 'utf8'), /修改后的按钮/);
  await saveReviewSkill(setup.skillsRoot, status.skillName, { ...formal, expectedRevision: formal.revision });
  assert.match(await readFile(path.join(setup.skillsRoot, status.skillName, 'task.yaml'), 'utf8'), /修改后的按钮/);
  assert.equal(await readFile(draftPath, 'utf8'), original);
  assert.equal(await readFile(path.join(setup.recording, 'inputs', 'capture.mp4'), 'utf8'), 'original-video');
});

test('宿主导入失败保留失败状态，手动重试只重新同步且不重新分析', async t => {
  let fails = true;
  const setup = await fixture(t, async () => { if (fails) throw new Error('GDE 拒绝导入'); });
  await setup.manager.analyze(setup.card.id, 'zh-CN');
  await until(() => setup.manager.status(setup.card.id).phase === 'failed');
  assert.match(setup.manager.status(setup.card.id).error, /GDE 拒绝导入/);
  await assert.rejects(setup.manager.result(setup.card.id), /尚未完成导入/);
  fails = false;
  await setup.manager.publish(setup.card.id);
  await until(() => setup.manager.status(setup.card.id).phase === 'done');
  assert.deepEqual(setup.calls, { prepare: 1, publish: 2 });
});
