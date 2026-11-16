import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { replaceRecordingDraft } from '../../review/service/skill-replacement.js';
import { assembleSkillFixture } from '../helpers/skill-fixture.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-replacement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const draftRoot = path.join(root, 'drafts');
  const skillsRoot = path.join(root, 'skills');
  const skillName = 'replace-example';
  await assembleSkillFixture(path.join(draftRoot, skillName), skillName);
  await mkdir(skillsRoot);
  return { draftRoot, skillsRoot, skillName, source: path.join(draftRoot, skillName), target: path.join(skillsRoot, skillName) };
}

test('完整目录替换移除旧文件，草稿保留且无需宿主导入配置', async t => {
  const setup = await fixture(t);
  await cp(setup.source, setup.target, { recursive: true });
  await writeFile(path.join(setup.target, 'obsolete.txt'), 'old');
  await replaceRecordingDraft(setup);
  await assert.rejects(access(path.join(setup.target, 'obsolete.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(setup.target, 'task.yaml'), 'utf8'), await readFile(path.join(setup.source, 'task.yaml'), 'utf8'));
  assert.deepEqual(await readdir(path.join(setup.skillsRoot, '.cua-staging')), []);
});

test('新目录落盘后校验失败会恢复旧 Skill 并清理暂存文件', async t => {
  const setup = await fixture(t);
  await cp(setup.source, setup.target, { recursive: true });
  await writeFile(path.join(setup.target, 'keep.txt'), 'original');
  const original = await readFile(path.join(setup.target, 'task.yaml'), 'utf8');
  await assert.rejects(replaceRecordingDraft(setup, { rename: async (from, to) => {
    await rename(from, to);
    if (to === setup.target && from === path.join(path.dirname(String(from)), setup.skillName)) {
      await writeFile(path.join(setup.target, 'task.yaml'), 'invalid: [');
    }
  } }));
  assert.equal(await readFile(path.join(setup.target, 'keep.txt'), 'utf8'), 'original');
  assert.equal(await readFile(path.join(setup.target, 'task.yaml'), 'utf8'), original);
  assert.deepEqual(await readdir(path.join(setup.skillsRoot, '.cua-staging')), []);
});

test('目录移动和恢复均失败时保留备份以及诊断路径', async t => {
  const setup = await fixture(t);
  await cp(setup.source, setup.target, { recursive: true });
  await writeFile(path.join(setup.target, 'keep.txt'), 'original');
  const blockedMove = async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
    if (to === setup.target) throw new Error('Windows 文件占用');
    await rename(from, to);
  };
  await assert.rejects(replaceRecordingDraft(setup, { rename: blockedMove }), /恢复失败.*备份目录/);
  const staging = path.join(setup.skillsRoot, '.cua-staging');
  const entries = await readdir(staging);
  assert.equal(entries.length, 1);
  assert.equal(await readFile(path.join(staging, entries[0], 'previous', 'keep.txt'), 'utf8'), 'original');
});

test('替换拒绝普通 Skill、符号链接、非法草稿以及正式目录内的草稿', async t => {
  const setup = await fixture(t);
  await mkdir(setup.target);
  await writeFile(path.join(setup.target, 'SKILL.md'), 'ordinary-skill');
  await assert.rejects(replaceRecordingDraft(setup));
  assert.equal(await readFile(path.join(setup.target, 'SKILL.md'), 'utf8'), 'ordinary-skill');
  await rm(setup.target, { recursive: true });
  await symlink(setup.source, setup.target, 'dir');
  await assert.rejects(replaceRecordingDraft(setup), /符号链接/);
  await rm(setup.target);
  await cp(setup.source, setup.target, { recursive: true });
  await assert.rejects(replaceRecordingDraft({ ...setup, draftRoot: setup.skillsRoot }), /根目录之外/);
  await writeFile(path.join(setup.source, 'task.yaml'), 'invalid: [');
  await assert.rejects(replaceRecordingDraft(setup));
  await access(path.join(setup.target, 'task.yaml'));
});
