import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupPreviousGeneration, trackGenerationAssets } from '../../review/service/generation-assets.js';
import type { WorkflowStatus } from '../../review/shared/workflow.js';
import { occupiedSkillNames } from '../../cua/skills/names.js';

test('生成清理拒绝越界、当前草稿以及无法确认归属的普通 Skill', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'generation-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const next = path.join(root, 'workbench', 'drafts', 'next');
  const old = path.join(root, 'workbench', 'drafts', 'old');
  const outside = path.join(root, 'protected');
  const skillsRoot = path.join(root, 'skills');
  await Promise.all([mkdir(next, { recursive: true }), mkdir(old, { recursive: true }), mkdir(outside), mkdir(path.join(skillsRoot, 'ordinary'), { recursive: true })]);
  await writeFile(path.join(outside, 'keep.txt'), 'keep');
  await writeFile(path.join(skillsRoot, 'ordinary', 'SKILL.md'), 'ordinary');
  const manifest = path.join(next, '.previous-generations.json');
  const entry = { draftRoot: outside, recordingId: '', skillName: 'ordinary' };
  await writeFile(manifest, JSON.stringify([entry]));
  await assert.rejects(cleanupPreviousGeneration({ dataRoot: root, skillsRoot }, next), /越出/);
  await writeFile(manifest, JSON.stringify([{ ...entry, draftRoot: next }]));
  await assert.rejects(cleanupPreviousGeneration({ dataRoot: root, skillsRoot }, next), /当前生成资产/);
  await writeFile(manifest, JSON.stringify([{ ...entry, draftRoot: old }]));
  await assert.rejects(cleanupPreviousGeneration({ dataRoot: root, skillsRoot }, next));
  await access(old);
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(await readFile(path.join(skillsRoot, 'ordinary', 'SKILL.md'), 'utf8'), 'ordinary');
  await assert.rejects(trackGenerationAssets(root, { draftRoot: outside } as WorkflowStatus, next), /越出/);
});

test('允许替换本流程目录时，其他普通 Skill 声明的同名身份仍保持占用', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'generation-names-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'own-skill'));
  await mkdir(path.join(root, 'ordinary'));
  await writeFile(path.join(root, 'ordinary', 'SKILL.md'), '---\nname: own-skill\ndescription: ordinary\n---\n');
  const names = await occupiedSkillNames(root, new Set(['own-skill']));
  assert.ok(names.has('own-skill'));
  assert.ok(names.has('ordinary'));
});
