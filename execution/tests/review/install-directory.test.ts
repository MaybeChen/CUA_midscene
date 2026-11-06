import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { createSkillFixture } from '../helpers/skill-fixture.js';
import { RecordingCardStore } from '../../review/service/recording-cards.js';
import { RecordingWorkflow } from '../../review/service/recording-workflow.js';
import { registerWorkflowRoutes } from '../../review/server/workflow-routes.js';

test('只能打开导入完成技能的正式目录，未知卡片和打开失败明确报错', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'install-directory-'));
  const filename = path.join(root, 'workbench', 'console.sqlite');
  const cards = new RecordingCardStore(filename);
  const skillsRoot = path.join(root, 'skills');
  const expected = await createSkillFixture(skillsRoot, 'installed-demo');
  const workflow = new RecordingWorkflow({ dataRoot: root, skillsRoot, cards });
  try {
    const card = cards.create({ name: '目录测试', description: '' });
    cards.beginRecording(card.id); cards.completeRecording('Recording_install');
    const opened: string[] = [];
    const receipt = { directory: expected, platform: process.platform, opener: 'windows-shell-foreground' as const, foregroundConfirmed: true };
    const opener = async (directory: string) => { opened.push(directory); return receipt; };
    await assert.rejects(workflow.openInstallDirectory(card.id, opener), /尚未完成导入/);
    await assert.rejects(workflow.openInstallDirectory('missing-card', opener), /不存在/);
    assert.equal(opened.length, 0);
    const db = new Database(filename);
    db.prepare('INSERT INTO workflows VALUES (?,?,?,?,?,?,?)')
      .run(card.id, 'Recording_install', 'done', 'installed-demo', '', '', '');
    db.close();
    assert.deepEqual(await workflow.openInstallDirectory(card.id, opener), { opened: true, ...receipt, serverPid: process.pid });
    assert.deepEqual(opened, [expected]);
    await assert.rejects(workflow.openInstallDirectory(card.id, async () => { throw new Error('文件管理器启动失败'); }), /启动失败/);
  } finally { await workflow.close(); cards.close(); await rm(root, { recursive: true, force: true }); }
});

test('打开安装目录接口拒绝跨站请求，只按卡片ID解析目录', async () => {
  const app = Fastify();
  const calls: string[] = [];
  const workflow = { openInstallDirectory: async (id: string) => { calls.push(id); return { opened: true }; } } as unknown as RecordingWorkflow;
  registerWorkflowRoutes(app, workflow);
  try {
    const url = '/api/recording-cards/card-1/result/open-folder';
    const denied = await app.inject({ method: 'POST', url, headers: { origin: 'https://other.example', 'sec-fetch-site': 'cross-site' } });
    assert.equal(denied.statusCode, 403);
    assert.equal(calls.length, 0);
    const opened = await app.inject({ method: 'POST', url, headers: { host: '127.0.0.1:47831', origin: 'http://127.0.0.1:47831' }, payload: { path: 'C:/untrusted' } });
    assert.equal(opened.statusCode, 200);
    assert.deepEqual(calls, ['card-1']);
  } finally { await app.close(); }
});
