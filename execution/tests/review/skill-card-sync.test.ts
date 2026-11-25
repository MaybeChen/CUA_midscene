import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import Fastify from 'fastify';
import { RecordingCardStore } from '../../review/service/recording-cards.js';
import { RecordingWorkflow } from '../../review/service/recording-workflow.js';
import { registerRecordingCardRoutes } from '../../review/server/recording-card-routes.js';
import { registerWorkflowRoutes } from '../../review/server/workflow-routes.js';
import { loadReviewSkill, saveReviewSkill } from '../../review/service/review-skill.js';
import type { RecorderControl } from '../../review/service/windows-recorder.js';
import { createSkillFixture } from '../helpers/skill-fixture.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-card-sync-'));
  const skillsRoot = path.join(root, 'skills');
  const cards = new RecordingCardStore(path.join(root, 'workbench', 'console.sqlite'));
  const deleted: string[] = [];
  const options = { dataRoot: root, skillsRoot, cards };
  const workflow = new RecordingWorkflow(options, { deleteSkill: async ({ skillName }) => {
    deleted.push(skillName);
    await rm(path.join(skillsRoot, skillName), { recursive: true });
  } });
  const app = Fastify();
  registerRecordingCardRoutes(app, cards, { status: () => ({ phase: 'idle' }) } as RecorderControl,
    async () => ({ configured: false, envName: 'CUA_RECORDINGS_ROOT', recordings: [] }),
    () => workflow.isBusy(), id => workflow.remove(id), {
      synchronize: entries => workflow.synchronizeSkills(entries),
      skillName: id => workflow.status(id).skillName || undefined,
    });
  registerWorkflowRoutes(app, workflow);
  t.after(async () => { await app.close(); await workflow.close(); cards.close(); await rm(root, { recursive: true, force: true }); });
  return { root, skillsRoot, cards, workflow, app, options, deleted };
}

test('首页同步只为合法完整的 CUA Skill 建卡，普通技能忽略，损坏技能报告原因', async t => {
  const setup = await fixture(t);
  await createSkillFixture(setup.skillsRoot, 'external-task');
  await mkdir(path.join(setup.skillsRoot, 'ordinary'));
  await writeFile(path.join(setup.skillsRoot, 'ordinary', 'SKILL.md'), '# 普通技能');
  await mkdir(path.join(setup.skillsRoot, 'broken'));
  await writeFile(path.join(setup.skillsRoot, 'broken', 'cua-manifest.json'), '{}');
  const response = await setup.app.inject({ method: 'POST', url: '/api/recording-cards/sync' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().importedSkills, 1);
  assert.match(response.json().warnings.join('\n'), /broken/);
  const page = (await setup.app.inject('/api/recording-cards')).json();
  assert.equal(page.total, 1);
  assert.equal(page.cards[0].skillName, 'external-task');
  assert.equal(page.cards[0].recordingId, null);
  assert.match(page.cards[0].description, /查询网络告警/);
  const card = page.cards[0];
  assert.equal(setup.workflow.status(card.id).phase, 'done');
  assert.equal(setup.workflow.status(card.id).recordingId, '');
  assert.equal((await setup.workflow.result(card.id)).name, 'external-task');
  assert.equal((await setup.app.inject(`/api/recording-cards/${card.id}`)).json().skillName, 'external-task');
});

test('重复及并发扫描幂等，已改名卡片和最近访问不变，新的同名显示卡片仍按 Skill 身份区分', async t => {
  const setup = await fixture(t);
  await createSkillFixture(setup.skillsRoot, 'first-task');
  await setup.workflow.synchronizeSkills();
  const first = setup.cards.all()[0];
  const renamed = setup.cards.update(first.id, { name: '保留人工名称', description: '保留人工描述' }, first.version);
  setup.cards.visit(first.id);
  const recent = setup.cards.recent();
  setup.cards.create({ name: 'second-task', description: '同名的待录制任务' });
  await createSkillFixture(setup.skillsRoot, 'second-task');
  const results = await Promise.all([setup.workflow.synchronizeSkills(), setup.workflow.synchronizeSkills()]);
  assert.deepEqual(results.map(result => result.importedSkills), [1, 1]);
  assert.equal(setup.cards.all().length, 3);
  assert.deepEqual(setup.cards.get(first.id), renamed);
  assert.deepEqual(setup.cards.recent(), recent);
  const recentView = (await setup.app.inject('/api/recording-cards/recent')).json().cards[0];
  assert.equal(recentView.skillName, 'first-task');
  assert.equal((await setup.workflow.synchronizeSkills()).importedSkills, 0);
});

test('补齐关联持久化，已安装任务步骤直接读写正式资源，删除通过宿主接口使用 name', async t => {
  const setup = await fixture(t);
  const skillRoot = await createSkillFixture(setup.skillsRoot, 'editable-task');
  await setup.workflow.synchronizeSkills();
  const card = setup.cards.all()[0];
  const reopened = new RecordingWorkflow(setup.options);
  try {
    assert.equal(reopened.status(card.id).phase, 'done');
    assert.equal((await reopened.synchronizeSkills()).importedSkills, 0);
    assert.equal((await reopened.result(card.id)).installPath, skillRoot);
  } finally { await reopened.close(); }
  const formal = await loadReviewSkill(setup.skillsRoot, 'editable-task');
  (formal.document.tasks as { flow: object[] }[])[0].flow = [{ aiTap: '点击人工修改的按钮' }];
  await saveReviewSkill(setup.skillsRoot, 'editable-task', { ...formal, expectedRevision: formal.revision });
  assert.match(await readFile(path.join(skillRoot, 'task.yaml'), 'utf8'), /人工修改的按钮/);
  const deletion = await setup.app.inject({ method: 'DELETE', url: `/api/recording-cards/${card.id}` });
  assert.equal(deletion.statusCode, 200, deletion.body);
  assert.deepEqual(setup.deleted, ['editable-task']);
  assert.equal((await setup.workflow.synchronizeSkills()).importedSkills, 0);
  assert.equal(setup.cards.all().length, 0);
});

test('扫描失败显式返回错误并保留原有任务，未配置或目录不存在时可正常加载', async t => {
  const setup = await fixture(t);
  const existing = setup.cards.create({ name: '已有任务', description: '' });
  assert.equal((await setup.workflow.synchronizeSkills()).importedSkills, 0);
  await writeFile(setup.skillsRoot, '不是目录');
  const response = await setup.app.inject({ method: 'POST', url: '/api/recording-cards/sync' });
  assert.equal(response.statusCode, 500);
  assert.equal((await setup.app.inject('/api/recording-cards')).json().cards[0].id, existing.id);
  const unconfigured = new RecordingWorkflow({ ...setup.options, skillsRoot: undefined });
  try { assert.equal((await unconfigured.synchronizeSkills()).importedSkills, 0); }
  finally { await unconfigured.close(); }
});
