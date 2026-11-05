import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { prepareRecordingSkill, publishRecordingDraft } from '../../cua/skills/create.js';
import { recordingSkillFixture, installImportedFixture } from '../helpers/skill-import-fixture.js';
import { loadReviewSkill, saveReviewSkill } from '../../review/service/review-skill.js';
import { RecordingWorkflow } from '../../review/service/recording-workflow.js';
import { RecordingCardStore } from '../../review/service/recording-cards.js';
import { readSkill } from '../../cua/skills/assets.js';

test('分析只创建独立草稿，编辑后的 YAML 经原打包导入链路发布，原视频不变', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await recordingSkillFixture(root);
  await mkdir(fixture.skillsRoot);
  await writeFile(path.join(fixture.recording, 'inputs', 'capture.mp4'), 'original-video');
  const draftRoot = path.join(root, 'draft');
  const controller = new AbortController();
  let calls = 0;
  const skillName = await prepareRecordingSkill(
    {
      ...fixture,
      draftRoot,
      language: 'zh-CN',
      progress: new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
      signal: controller.signal,
    },
    {
      runRecorder: async () => {
        calls++;
      },
    },
  );
  const view = await loadReviewSkill(draftRoot, skillName);
  (view.document.tasks as { flow: Record<string, unknown>[] }[])[0].flow.unshift({ sleep: 1234 });
  await saveReviewSkill(draftRoot, skillName, { ...view, expectedRevision: view.revision });
  await publishRecordingDraft(
    { ...fixture, draftRoot, skillName },
    {
      fetch: async (_url, init) => {
        await installImportedFixture(init!.body as FormData, fixture.skillsRoot);
        return Response.json({ success: true });
      },
    },
  );
  assert.equal(
    ((await readSkill(fixture.skillsRoot, skillName)).document.tasks as { flow: Record<string, unknown>[] }[])[0].flow[0].sleep,
    1234,
  );
  assert.equal(calls, 1);
  assert.equal(await readFile(path.join(fixture.recording, 'inputs', 'capture.mp4'), 'utf8'), 'original-video');
});

test('分析停止等待处理结束，状态持久化并能在服务重开后恢复', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-stop-'));
  const cards = new RecordingCardStore(path.join(root, 'workbench', 'console.sqlite'));
  const inputs = path.join(root, 'recordings', 'Recording_1', 'inputs');
  await mkdir(inputs, { recursive: true });
  await writeFile(path.join(inputs, 'video.mp4'), 'video');
  await writeFile(path.join(inputs, 'events.txt'), 'events');
  const card = cards.create({ name: '测试任务', description: '' });
  cards.beginRecording(card.id);
  cards.completeRecording('Recording_1');
  const options = {
    dataRoot: root,
    cards,
    skillsRoot: path.join(root, 'skills'),
    recordingsRoot: path.join(root, 'recordings'),
  };
  const manager = new RecordingWorkflow(options, {
    prepare: async ({ signal, progress }) => {
      progress.write('正在处理步骤1\n');
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('取消处理')), { once: true }),
      );
      return 'unreachable';
    },
  });
  await manager.analyze(card.id, 'zh-CN');
  assert.equal(manager.status(card.id).phase, 'analyzing');
  await assert.rejects(manager.analyze(card.id, 'zh-CN'), /已有任务/);
  assert.equal((await manager.stop(card.id)).phase, 'stopped');
  await manager.close();
  const restored = new RecordingWorkflow(options);
  assert.equal(restored.status(card.id).phase, 'stopped');
  assert.match(restored.status(card.id).log, /步骤1/);
  await restored.close();
  cards.close();
  t.after(() => rm(root, { recursive: true, force: true }));
});
