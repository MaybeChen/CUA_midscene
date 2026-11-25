import assert from 'node:assert/strict';
import { access, cp, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { RecordingWorkflow } from '../../review/service/recording-workflow.js';
import { RecordingCardStore } from '../../review/service/recording-cards.js';
import { loadReviewSkill, saveReviewSkill } from '../../review/service/review-skill.js';
import { recordingSkillFixture } from '../helpers/skill-import-fixture.js';
import { workflowHostFixture } from '../helpers/workflow-host-fixture.js';
import { readWorkflowMetadata } from '../helpers/workflow-metadata-fixture.js';

async function fixture(t: TestContext, beforePrepare: (recording: string) => Promise<void> = async () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'automatic-skill-'));
  const assets = await recordingSkillFixture(root);
  await mkdir(assets.skillsRoot);
  await writeFile(path.join(assets.recording, 'inputs', 'capture.mp4'), 'original-video');
  const cards = new RecordingCardStore(path.join(root, 'workbench', 'console.sqlite'));
  const card = cards.create({ name: '自动生成任务', description: '' });
  cards.beginRecording(card.id); cards.completeRecording('Recording_1');
  const host = await workflowHostFixture(assets, beforePrepare);
  const options = { dataRoot: root, cards, skillsRoot: assets.skillsRoot, recordingsRoot: root };
  const manager = new RecordingWorkflow(options, host.dependencies);
  const setup = { ...assets, ...host, root, cards, card, manager, options };
  t.after(async () => { await setup.manager.close(); cards.close(); await rm(root, { recursive: true, force: true }); });
  return setup;
}

async function finish(setup: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!['done', 'failed', 'stopped'].includes(setup.manager.status(setup.card.id).phase)) {
    if (Date.now() > deadline) throw new Error('等待工作流状态超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function generate(setup: Awaited<ReturnType<typeof fixture>>) {
  await setup.manager.analyze(setup.card.id, 'zh-CN');
  await finish(setup);
  return setup.manager.status(setup.card.id);
}

test('首次生成经 ZIP 导入及正式资源确认后更新关联，编辑只保存正式资产', async t => {
  const setup = await fixture(t);
  const status = await generate(setup);
  assert.equal(status.phase, 'done', status.error);
  assert.deepEqual(setup.calls.requests, [{ method: 'POST', name: status.skillName }]);
  const draftPath = path.join(status.draftRoot, status.skillName, 'task.yaml');
  const original = await readFile(draftPath, 'utf8');
  const formal = await loadReviewSkill(setup.skillsRoot, status.skillName);
  (formal.document.tasks as { flow: Record<string, unknown>[] }[])[0].flow = [{ aiTap: '点击修改后的按钮' }];
  await saveReviewSkill(setup.skillsRoot, status.skillName, { ...formal, expectedRevision: formal.revision });
  assert.match(await readFile(path.join(setup.skillsRoot, status.skillName, 'task.yaml'), 'utf8'), /修改后的按钮/);
  assert.equal(await readFile(draftPath, 'utf8'), original);
  assert.equal((await setup.manager.result(setup.card.id)).name, status.skillName);
});

test('同名重新生成先备份正式编辑内容，DELETE 旧名后 POST 新包，确认后清理旧资产', async t => {
  const setup = await fixture(t);
  const old = await generate(setup);
  const formal = await loadReviewSkill(setup.skillsRoot, old.skillName);
  (formal.document.tasks as { flow: Record<string, unknown>[] }[])[0].flow = [{ aiTap: '需要备份的人工修改' }];
  await saveReviewSkill(setup.skillsRoot, old.skillName, { ...formal, expectedRevision: formal.revision });
  setup.controls.beforePublish = async () => {
    const current = setup.manager.status(setup.card.id);
    assert.equal(current.skillName, old.skillName);
    await access(old.draftRoot);
    await assert.rejects(access(path.join(setup.skillsRoot, old.skillName)), { code: 'ENOENT' });
    assert.match(await readFile(path.join(current.draftRoot, '.skill-backups', old.skillName, 'task.yaml'), 'utf8'), /需要备份的人工修改/);
  };
  const current = await generate(setup);
  assert.equal(current.phase, 'done', current.error);
  assert.equal(current.skillName, old.skillName);
  assert.deepEqual(setup.calls.requests.map(item => item.method), ['POST', 'DELETE', 'POST']);
  await assert.rejects(access(old.draftRoot), { code: 'ENOENT' });
  await assert.rejects(access(path.join(current.draftRoot, '.skill-backups')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(setup.recording, 'inputs', 'capture.mp4'), 'utf8'), 'original-video');
  assert.equal(await readFile(path.join(setup.recording, 'inputs', 'events.txt'), 'utf8'), 'original events');
});

test('模型返回不同名称时使用旧 name 删除、新 name 导入，成功前保留旧关联', async t => {
  let renamed = false;
  const setup = await fixture(t, async recording => {
    if (!renamed) return;
    const file = path.join(recording, 'Recording_1_trace.json');
    const trace = JSON.parse(await readFile(file, 'utf8')); trace.skill.name = 'new-model-name';
    await writeFile(file, JSON.stringify(trace));
  });
  const old = await generate(setup); renamed = true;
  setup.controls.beforePublish = async () => {
    const status = setup.manager.status(setup.card.id);
    assert.equal(status.skillName, old.skillName);
    assert.equal(status.pendingSkillName, 'new-model-name');
  };
  const current = await generate(setup);
  assert.equal(current.phase, 'done', current.error);
  assert.equal(current.skillName, 'new-model-name');
  const persisted = readWorkflowMetadata(setup.root);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].skillName, current.skillName);
  assert.equal(persisted[0].recordingId, 'Recording_1');
  assert.equal(persisted[0].pendingSkillName, '');
  assert.deepEqual(setup.calls.requests.slice(1), [{ method: 'DELETE', name: old.skillName }, { method: 'POST', name: current.skillName }]);
  await assert.rejects(access(path.join(setup.skillsRoot, old.skillName)), { code: 'ENOENT' });
});

test('新名称被其他技能占用时追加后缀且保留其他技能', async t => {
  let renamed = false;
  const setup = await fixture(t, async recording => {
    if (!renamed) return;
    const file = path.join(recording, 'Recording_1_trace.json'); const trace = JSON.parse(await readFile(file, 'utf8'));
    trace.skill.name = 'other-skill'; await writeFile(file, JSON.stringify(trace));
  });
  const old = await generate(setup);
  await cp(path.join(setup.skillsRoot, old.skillName), path.join(setup.root, 'sentinel'), { recursive: true });
  const { assembleSkillFixture } = await import('../helpers/skill-fixture.js');
  await assembleSkillFixture(path.join(setup.skillsRoot, 'other-skill'), 'other-skill');
  const original = await readFile(path.join(setup.skillsRoot, 'other-skill', 'task.yaml'), 'utf8');
  renamed = true; const current = await generate(setup);
  assert.equal(current.phase, 'done', current.error);
  assert.match(current.skillName, /^other-skill-[a-f0-9]{6}$/);
  assert.equal(await readFile(path.join(setup.skillsRoot, 'other-skill', 'task.yaml'), 'utf8'), original);
  assert.ok(!setup.calls.requests.some(item => item.method === 'DELETE' && item.name === 'other-skill'));
});

test('重新分析失败不删除旧 Skill，之后重新录制生成仍可清理旧关联', async t => {
  let fails = false;
  const setup = await fixture(t, async () => { if (fails) throw new Error('模型分析失败'); });
  const old = await generate(setup); fails = true;
  const failed = await generate(setup);
  assert.equal(failed.skillName, old.skillName);
  assert.equal(failed.pendingSkillName, '');
  assert.equal(setup.calls.requests.length, 1);
  await access(path.join(setup.skillsRoot, old.skillName));
  const recording = path.join(setup.root, 'Recording_2', 'inputs'); await mkdir(recording, { recursive: true });
  for (const file of ['capture.mp4', 'events.txt']) await copyFile(path.join(setup.recording, 'inputs', file), path.join(recording, file));
  setup.cards.beginRecording(setup.card.id); setup.cards.completeRecording('Recording_2'); fails = false;
  const current = await generate(setup);
  assert.equal(current.phase, 'done', current.error);
  await assert.rejects(access(old.draftRoot), { code: 'ENOENT' });
  await assert.rejects(access(failed.draftRoot), { code: 'ENOENT' });
});

test('DELETE 失败保留旧 Skill、新草稿和备份，手动重试仍走 API', async t => {
  const setup = await fixture(t); const old = await generate(setup);
  setup.controls.failDelete = true; const failed = await generate(setup);
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.skillName, old.skillName);
  assert.equal(setup.calls.publish, 1);
  await access(path.join(setup.skillsRoot, old.skillName));
  await access(path.join(failed.draftRoot, '.skill-backups', `${old.skillName}.zip`));
  setup.controls.failDelete = false;
  await setup.manager.publish(setup.card.id); await finish(setup);
  assert.equal(setup.manager.status(setup.card.id).phase, 'done');
  assert.equal(setup.calls.prepare, 2);
  assert.deepEqual(setup.calls.requests.map(item => item.method), ['POST', 'DELETE', 'DELETE', 'POST']);
});

test('删除成功而导入失败时保留旧关联和备份，重试复用 ZIP 并重新调用导入接口', async t => {
  const setup = await fixture(t); const old = await generate(setup);
  setup.controls.importFailure = 'before'; const failed = await generate(setup);
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.skillName, old.skillName);
  const archive = path.join(failed.draftRoot, `${failed.pendingSkillName}.zip`);
  const bytes = await readFile(archive);
  await access(old.draftRoot);
  await access(path.join(failed.draftRoot, '.skill-backups', old.skillName, 'task.yaml'));
  await assert.rejects(access(path.join(setup.skillsRoot, old.skillName)), { code: 'ENOENT' });
  setup.controls.importFailure = '';
  await setup.manager.publish(setup.card.id); await finish(setup);
  const current = setup.manager.status(setup.card.id);
  assert.equal(current.phase, 'done', current.error);
  assert.deepEqual(await readFile(archive), bytes);
  assert.deepEqual(setup.calls.requests.map(item => item.method), ['POST', 'DELETE', 'POST', 'POST']);
});

test('导入已落盘但响应中断，主动重试校验并通过 DELETE 清理该次目标后重新导入', async t => {
  const setup = await fixture(t); setup.controls.importFailure = 'after';
  const failed = await generate(setup);
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.skillName, '');
  assert.ok(failed.pendingSkillName);
  assert.match(failed.log, /UND_ERR_SOCKET/);
  assert.doesNotMatch(failed.error, /ZIP 产物/);
  setup.controls.importFailure = '';
  await setup.manager.publish(setup.card.id); await finish(setup);
  assert.equal(setup.manager.status(setup.card.id).phase, 'done');
  assert.deepEqual(setup.calls.requests.map(item => item.method), ['POST', 'DELETE', 'POST']);
  assert.equal(setup.calls.prepare, 1);
});

test('失败后其他技能占用新名称时，手动重试不会删除或覆盖该技能', async t => {
  const setup = await fixture(t); setup.controls.importFailure = 'before';
  const failed = await generate(setup);
  const { assembleSkillFixture } = await import('../helpers/skill-fixture.js');
  await assembleSkillFixture(path.join(setup.skillsRoot, failed.pendingSkillName!), failed.pendingSkillName!);
  const original = await readFile(path.join(setup.skillsRoot, failed.pendingSkillName!, 'SKILL.md'), 'utf8');
  setup.controls.importFailure = '';
  await setup.manager.publish(setup.card.id); await finish(setup);
  assert.equal(setup.manager.status(setup.card.id).phase, 'failed');
  assert.equal(setup.calls.requests.length, 1);
  assert.equal(await readFile(path.join(setup.skillsRoot, failed.pendingSkillName!, 'SKILL.md'), 'utf8'), original);
});

test('服务重启后从同步记录恢复，复用草稿与备份且不重新分析', async t => {
  const setup = await fixture(t); const old = await generate(setup);
  setup.controls.importFailure = 'before'; const failed = await generate(setup);
  await setup.manager.close(); setup.controls.importFailure = '';
  const restored = new RecordingWorkflow(setup.options, setup.dependencies);
  setup.manager = restored;
  await restored.publish(setup.card.id); await finish(setup);
  assert.equal(restored.status(setup.card.id).phase, 'done');
  assert.equal(setup.calls.prepare, 2);
  assert.equal(setup.calls.requests.filter(item => item.method === 'DELETE').length, 1);
  await assert.rejects(access(old.draftRoot), { code: 'ENOENT' });
  assert.notEqual(failed.draftRoot, old.draftRoot);
});


test('导入确认后旧资产清理失败，重试只继续清理而不重复删除或导入已确认版本', async t => {
  const setup = await fixture(t); const old = await generate(setup);
  let ownership = '';
  setup.controls.beforePublish = async () => {
    const current = setup.manager.status(setup.card.id);
    const file = path.join(current.draftRoot, '.previous-generations.json');
    ownership = await readFile(file, 'utf8'); await writeFile(file, 'invalid-json');
  };
  const failed = await generate(setup);
  assert.equal(failed.phase, 'failed');
  await access(path.join(setup.skillsRoot, failed.pendingSkillName!, 'task.yaml'));
  await access(old.draftRoot);
  await writeFile(path.join(failed.draftRoot, '.previous-generations.json'), ownership);
  setup.controls.beforePublish = async () => {};
  await setup.manager.publish(setup.card.id); await finish(setup);
  assert.equal(setup.manager.status(setup.card.id).phase, 'done');
  assert.deepEqual(setup.calls.requests.map(item => item.method), ['POST', 'DELETE', 'POST']);
});

test('默认导入地址未配置时，在删除旧版本前失败并保留资产', async t => {
  const setup = await fixture(t); const old = await generate(setup);
  await setup.manager.close();
  const previous = process.env.GDECLAW_API_BASE_URL; process.env.GDECLAW_API_BASE_URL = '';
  t.after(() => { if (previous === undefined) delete process.env.GDECLAW_API_BASE_URL; else process.env.GDECLAW_API_BASE_URL = previous; });
  setup.manager = new RecordingWorkflow(setup.options, { prepare: setup.dependencies.prepare, deleteSkill: setup.dependencies.deleteSkill });
  const failed = await generate(setup);
  assert.equal(failed.phase, 'failed');
  assert.match(failed.error, /GDECLAW_API_BASE_URL/);
  assert.equal(setup.calls.requests.length, 1);
  await access(path.join(setup.skillsRoot, old.skillName));
  await access(old.draftRoot);
});

test('已生成 ZIP 与草稿不一致时拒绝重传，保留资产与同步诊断', async t => {
  const setup = await fixture(t); setup.controls.importFailure = 'before';
  const failed = await generate(setup);
  const markdown = path.join(failed.draftRoot, failed.pendingSkillName!, 'SKILL.md');
  await writeFile(markdown, (await readFile(markdown, 'utf8')) + '\n外部新增说明\n');
  setup.controls.importFailure = '';
  await setup.manager.publish(setup.card.id); await finish(setup);
  const current = setup.manager.status(setup.card.id);
  assert.equal(current.phase, 'failed');
  assert.match(current.error, /ZIP 与草稿不一致/);
  assert.equal(setup.calls.requests.length, 1);
});


test('宿主确认导入并补充合法说明后按正式资产校验完成，不要求文件逐字一致', async t => {
  const setup = await fixture(t);
  setup.controls.afterInstall = async name => {
    const file = path.join(setup.skillsRoot, name, 'SKILL.md');
    await writeFile(file, (await readFile(file, 'utf8')) + '\n宿主补充说明\n');
  };
  const status = await generate(setup);
  assert.equal(status.phase, 'done', status.error);
  assert.match((await setup.manager.result(setup.card.id)).content, /宿主补充说明/);
});
