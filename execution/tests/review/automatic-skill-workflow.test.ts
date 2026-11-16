import { networkImportError } from '../../cua/skills/import-failure.js';
import assert from 'node:assert/strict';
import { access, cp, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { prepareRecordingSkill, publishRecordingDraft } from '../../cua/skills/create.js';
import { RecordingWorkflow } from '../../review/service/recording-workflow.js';
import { RecordingCardStore } from '../../review/service/recording-cards.js';
import { replaceRecordingDraft } from '../../review/service/skill-replacement.js';
import { loadReviewSkill, saveReviewSkill } from '../../review/service/review-skill.js';
import { recordingSkillFixture, installImportedFixture } from '../helpers/skill-import-fixture.js';

async function fixture(t: TestContext, beforePublish = async () => {}, beforePrepare: (recording: string) => Promise<void> = async () => {}, replace?: typeof replaceRecordingDraft) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'automatic-skill-'));
  const assets = await recordingSkillFixture(root);
  await mkdir(assets.skillsRoot);
  const snapshots = await Promise.all(['_trace.json', '_processed_log.json', '_processed_log_sc.json'].map(async suffix =>
    [suffix, await readFile(path.join(assets.recording, `Recording_1${suffix}`))] as const));
  await writeFile(path.join(assets.recording, 'inputs', 'capture.mp4'), 'original-video');
  const cards = new RecordingCardStore(path.join(root, 'workbench', 'console.sqlite'));
  const card = cards.create({ name: '自动生成任务', description: '' });
  cards.beginRecording(card.id); cards.completeRecording('Recording_1');
  const calls = { prepare: 0, publish: 0 };
  const manager = new RecordingWorkflow({ dataRoot: root, cards, skillsRoot: assets.skillsRoot, recordingsRoot: root }, {
    prepare: options => prepareRecordingSkill({ ...options, pythonExecutable: process.execPath }, {
      runRecorder: async () => {
        calls.prepare++;
        for (const [suffix, bytes] of snapshots) await writeFile(path.join(options.recording, `${path.basename(options.recording)}${suffix}`), bytes);
        await beforePrepare(options.recording);
        options.progress.write('CUA_TRACE_PROGRESS {"completed":4,"total":4}\n');
      },
    }),
    replace,
    deleteSkill: async ({ skillName }) => { await rm(path.join(assets.skillsRoot, skillName), { recursive: true, force: true }); },
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
  return { ...assets, root, cards, card, calls, manager };
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
    await assert.rejects(setup.manager.stop(setup.card.id), /同步中不能中止/);
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

test('宿主导入失败保留草稿，手动重试直接写入正式目录且不重新分析或重传 ZIP', async t => {
  const setup = await fixture(t, async () => { throw new Error('GDE 拒绝导入'); });
  await setup.manager.analyze(setup.card.id, 'zh-CN');
  await until(() => setup.manager.status(setup.card.id).phase === 'failed');
  assert.match(setup.manager.status(setup.card.id).error, /GDE 拒绝导入/);
  await assert.rejects(setup.manager.result(setup.card.id), /尚未完成导入/);
  await setup.manager.publish(setup.card.id);
  await until(() => setup.manager.status(setup.card.id).phase === 'done');
  assert.deepEqual(setup.calls, { prepare: 1, publish: 1 });
});

test('重新生成直接替换同名 Skill 并清理旧资产，保留录制输入及其他文件', async t => {
  let oldDraft = '';
  let oldSkill = '';
  const setup = await fixture(t, async () => {}, async recording => {
    const tracePath = path.join(recording, 'Recording_1_trace.json');
    const trace = JSON.parse(await readFile(tracePath, 'utf8'));
    if (oldDraft) { trace.skill.name = 'new-model-name'; trace.skill.goal = '重新生成后的目标'; }
    await writeFile(tracePath, JSON.stringify(trace));
  });
  await setup.manager.analyze(setup.card.id, 'zh-CN');
  await until(() => setup.manager.status(setup.card.id).phase === 'done');
  const previous = setup.manager.status(setup.card.id);
  oldDraft = previous.draftRoot;
  oldSkill = path.join(setup.skillsRoot, previous.skillName);
  await writeFile(path.join(oldSkill, 'obsolete.txt'), 'remove-old-file');
  await mkdir(path.join(setup.recording, 'screenshots'), { recursive: true });
  await writeFile(path.join(setup.recording, 'screenshots', 'old-unused.png'), 'old-image');
  await writeFile(path.join(setup.recording, 'notes.txt'), 'keep-notes');
  await mkdir(path.join(setup.skillsRoot, 'ordinary'));
  await writeFile(path.join(setup.skillsRoot, 'ordinary', 'SKILL.md'), 'keep ordinary');
  await setup.manager.analyze(setup.card.id, 'zh-CN');
  await until(() => ['done', 'failed'].includes(setup.manager.status(setup.card.id).phase));
  const current = setup.manager.status(setup.card.id);
  assert.equal(current.phase, 'done', current.error);
  assert.equal(current.skillName, previous.skillName);
  assert.notEqual(current.draftRoot, previous.draftRoot);
  assert.deepEqual(setup.calls, { prepare: 2, publish: 1 });
  await assert.rejects(access(path.join(oldSkill, 'obsolete.txt')), { code: 'ENOENT' });
  await assert.rejects(access(oldDraft), { code: 'ENOENT' });
  assert.match(current.log, /替换 GDE Skill 目录/);
  assert.match((await setup.manager.result(setup.card.id)).content, /重新生成后的目标/);
  assert.match(current.log, /已清理 1 批旧生成资产/);
  await assert.rejects(access(path.join(setup.recording, 'screenshots')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(setup.recording, 'inputs', 'capture.mp4'), 'utf8'), 'original-video');
  assert.equal(await readFile(path.join(setup.recording, 'inputs', 'events.txt'), 'utf8'), 'original events');
  assert.equal(await readFile(path.join(setup.recording, 'notes.txt'), 'utf8'), 'keep-notes');
  assert.equal(await readFile(path.join(setup.skillsRoot, 'ordinary', 'SKILL.md'), 'utf8'), 'keep ordinary');
});

test('重新分析失败保留上一版本，再次生成仍清理原版本和失败草稿', async t => {
  let fails = false;
  const setup = await fixture(t, async () => {}, async () => { if (fails) throw new Error('模型分析失败'); });
  await setup.manager.analyze(setup.card.id, 'zh-CN');
  await until(() => setup.manager.status(setup.card.id).phase === 'done');
  const old = setup.manager.status(setup.card.id);
  fails = true;
  await setup.manager.analyze(setup.card.id, 'zh-CN');
  await until(() => setup.manager.status(setup.card.id).phase === 'failed');
  const failedDraft = setup.manager.status(setup.card.id).draftRoot;
  await access(path.join(setup.skillsRoot, old.skillName));
  await access(old.draftRoot);
  fails = false;
  await setup.manager.analyze(setup.card.id, 'zh-CN');
  await until(() => ['done', 'failed'].includes(setup.manager.status(setup.card.id).phase));
  const current = setup.manager.status(setup.card.id);
  assert.equal(current.phase, 'done', current.error);
  assert.equal(current.skillName, old.skillName);
  await assert.rejects(access(old.draftRoot), { code: 'ENOENT' });
  await assert.rejects(access(failedDraft), { code: 'ENOENT' });
});

test('重新录制后再次生成，仍能清理该卡片之前关联的 Skill 和草稿', async t => {
  const setup = await fixture(t);
  await setup.manager.analyze(setup.card.id, 'zh-CN');
  await until(() => setup.manager.status(setup.card.id).phase === 'done');
  const old = setup.manager.status(setup.card.id);
  const recording = path.join(setup.root, 'Recording_2', 'inputs');
  await mkdir(recording, { recursive: true });
  await copyFile(path.join(setup.recording, 'inputs', 'capture.mp4'), path.join(recording, 'capture.mp4'));
  await copyFile(path.join(setup.recording, 'inputs', 'events.txt'), path.join(recording, 'events.txt'));
  setup.cards.beginRecording(setup.card.id); setup.cards.completeRecording('Recording_2');
  assert.equal(setup.manager.status(setup.card.id).phase, 'idle');
  await setup.manager.analyze(setup.card.id, 'zh-CN');
  await until(() => ['done', 'failed'].includes(setup.manager.status(setup.card.id).phase));
  const current = setup.manager.status(setup.card.id);
  assert.equal(current.phase, 'done', current.error);
  assert.equal(current.skillName, old.skillName);
  await assert.rejects(access(old.draftRoot), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(recording, 'capture.mp4'), 'utf8'), 'original-video');
});


test('重新生成写入失败保留旧 Skill 和草稿，重试只替换目录', async t => {
  let fail = true;
  const setup = await fixture(t, async () => {}, async () => {}, async options => {
    if (fail) throw new Error('目录被占用');
    await replaceRecordingDraft(options);
  });
  await setup.manager.analyze(setup.card.id, 'zh-CN');
  await until(() => setup.manager.status(setup.card.id).phase === 'done');
  const previous = setup.manager.status(setup.card.id);
  const original = await readFile(path.join(setup.skillsRoot, previous.skillName, 'task.yaml'), 'utf8');
  await setup.manager.analyze(setup.card.id, 'zh-CN');
  await until(() => setup.manager.status(setup.card.id).phase === 'failed');
  const failed = setup.manager.status(setup.card.id);
  assert.match(failed.error, /目录被占用/);
  assert.equal(await readFile(path.join(setup.skillsRoot, previous.skillName, 'task.yaml'), 'utf8'), original);
  await access(previous.draftRoot);
  await access(path.join(failed.draftRoot, failed.skillName));
  fail = false;
  await setup.manager.publish(setup.card.id);
  await until(() => setup.manager.status(setup.card.id).phase === 'done');
  assert.deepEqual(setup.calls, { prepare: 2, publish: 1 });
  await assert.rejects(access(previous.draftRoot), { code: 'ENOENT' });
});

test('宿主响应不确定但正式目录已存在，失败重试直接替换已安装内容', async t => {
  const setup = await fixture(t, async () => { throw new Error('导入结果不确定'); });
  await setup.manager.analyze(setup.card.id, 'zh-CN');
  await until(() => setup.manager.status(setup.card.id).phase === 'failed');
  const failed = setup.manager.status(setup.card.id);
  const formal = path.join(setup.skillsRoot, failed.skillName);
  await cp(path.join(failed.draftRoot, failed.skillName), formal, { recursive: true });
  await writeFile(path.join(formal, 'stale.txt'), 'old-host-result');
  await setup.manager.publish(setup.card.id);
  await until(() => setup.manager.status(setup.card.id).phase === 'done');
  assert.deepEqual(setup.calls, { prepare: 1, publish: 1 });
  await assert.rejects(access(path.join(formal, 'stale.txt')), { code: 'ENOENT' });
});


test('导入连接失败在界面保留操作建议，技术诊断只写入流程日志', async t => {
  const failure = networkImportError({ url: new URL('http://127.0.0.1:49123/import'), zipPath: '/draft/skill.zip' },
    new TypeError('fetch failed', { cause: Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }) }), false);
  const setup = await fixture(t, async () => { throw failure; });
  await setup.manager.analyze(setup.card.id, 'zh-CN');
  await until(() => setup.manager.status(setup.card.id).phase === 'failed');
  const status = setup.manager.status(setup.card.id);
  assert.ok(status.skillName);
  assert.equal(status.error, failure.userMessage);
  assert.doesNotMatch(status.error, /ZIP|ECONNREFUSED|49123|尚未确认/);
  assert.match(status.log, /ECONNREFUSED/);
  assert.match(status.log, /49123/);
  assert.match(status.log, /ZIP 产物：\/draft\/skill.zip/);
});

test('分析失败与目录写入失败分别保留原因和可重试草稿', async t => {
  let fails = true;
  const setup = await fixture(t, async () => { throw Object.assign(new Error('write /private/skill failed'), { code: 'EACCES' }); }, async () => {
    if (fails) throw new Error('模型服务不可用\n详细模型诊断');
  });
  await setup.manager.analyze(setup.card.id, 'zh-CN');
  await until(() => setup.manager.status(setup.card.id).phase === 'failed');
  const generation = setup.manager.status(setup.card.id);
  assert.equal(generation.skillName, '');
  assert.equal(generation.error, '模型服务不可用');
  assert.match(generation.log, /详细模型诊断/);
  fails = false;
  await setup.manager.analyze(setup.card.id, 'zh-CN');
  await until(() => setup.manager.status(setup.card.id).phase === 'failed');
  const syncing = setup.manager.status(setup.card.id);
  assert.ok(syncing.skillName);
  assert.match(syncing.error, /目录权限/);
  assert.doesNotMatch(syncing.error, /private/);
  await access(path.join(syncing.draftRoot, syncing.skillName));
});
