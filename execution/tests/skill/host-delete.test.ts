import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { deleteHostSkill, SkillDeleteError } from '../../cua/skills/host-delete.js';
import { deleteReviewSkill } from '../../review/service/review-skill.js';
import { createSkillFixture } from '../helpers/skill-fixture.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-delete-'));
  const previous = process.env.GDECLAW_API_BASE_URL;
  process.env.GDECLAW_API_BASE_URL = 'http://127.0.0.1:49123/base';
  t.after(async () => {
    if (previous === undefined) delete process.env.GDECLAW_API_BASE_URL;
    else process.env.GDECLAW_API_BASE_URL = previous;
    await rm(root, { recursive: true, force: true });
  });
  const options = { skillName: 'alarm-query', executionRoot: path.join(root, 'execution') };
  return { root, options };
}

test('删除请求使用配置的 GDE 地址与指定 DELETE 路径，没有本地接口转发或额外字段', async t => {
  const { options } = await fixture(t);
  let calls = 0;
  await deleteHostSkill(options, { fetch: async (input, init) => {
    calls++;
    assert.equal(String(input), 'http://127.0.0.1:49123/api/skills/alarm-query');
    assert.equal(init?.method, 'DELETE');
    assert.equal(init?.headers, undefined);
    assert.equal(init?.body, undefined);
    assert.equal(init?.redirect, 'error');
    return new Response(null, { status: 204 });
  } });
  assert.equal(calls, 1);
});

test('删除接受同步成功的 JSON、无内容响应以及空正文', async t => {
  const { options } = await fixture(t);
  for (const response of [Response.json({ deleted: true }), new Response(null, { status: 204 }), new Response('')]) {
    await deleteHostSkill(options, { fetch: async () => response });
  }
});

test('删除接口错误、格式异常、业务拒绝和异步受理都不会被报告为已删除', async t => {
  const { options } = await fixture(t);
  const responses = [Response.json({ success: false }), Response.json({ deleted: false }), Response.json([]),
    new Response('<html>login</html>'), Response.json({ status: 'pending' }), Response.json({ accepted: true }, { status: 202 })];
  for (const response of responses) {
    let calls = 0;
    await assert.rejects(deleteHostSkill(options, { fetch: async () => { calls++; return response; } }), error => {
      assert.ok(error instanceof SkillDeleteError);
      assert.match(error.userMessage, /记录已保留/);
      assert.doesNotMatch(error.userMessage, /ZIP|导入/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('仅明确的 Skill 不存在响应视为幂等结果，普通路由 404 仍然失败', async t => {
  const { options } = await fixture(t);
  await deleteHostSkill(options, { fetch: async () => Response.json({ detail: 'Skill alarm-query not found' }, { status: 404 }) });
  await deleteHostSkill(options, { fetch: async () => Response.json({ code: 'SKILL_NOT_FOUND' }, { status: 404 }) });
  await assert.rejects(deleteHostSkill(options, { fetch: async () => Response.json({ detail: 'Not Found' }, { status: 404 }) }), error => {
    assert.ok(error instanceof SkillDeleteError);
    assert.match(error.userMessage, /删除接口/);
    assert.equal(error.statusCode, 404);
    return true;
  });
});

test('删除的权限、占用和服务异常保留 HTTP 状态及上游诊断', async t => {
  const { options } = await fixture(t);
  for (const status of [400, 401, 403, 409, 500, 503]) {
    await assert.rejects(deleteHostSkill(options, { fetch: async () => Response.json({ detail: 'server diagnostic' }, { status }) }), error => {
      assert.ok(error instanceof SkillDeleteError);
      assert.equal(error.statusCode, status);
      assert.match(error.diagnostics, /server diagnostic/);
      assert.match(error.diagnostics, /DELETE http/);
      assert.doesNotMatch(error.userMessage, /server diagnostic/);
      return true;
    });
  }
});

test('删除服务未启动时提示启动服务，不执行任何本地目录删除', async t => {
  const { root, options } = await fixture(t);
  const skillsRoot = path.join(root, 'skills');
  await createSkillFixture(skillsRoot);
  const file = path.join(skillsRoot, options.skillName, 'task.yaml');
  const original = await readFile(file, 'utf8');
  await assert.rejects(deleteReviewSkill(skillsRoot, options.skillName, { deleteSkill: value => deleteHostSkill(value, { fetch: async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }) });
  } }) }), error => {
    assert.ok(error instanceof SkillDeleteError);
    assert.match(error.userMessage, /服务已启动/);
    assert.doesNotMatch(error.userMessage, /尚未确认/);
    assert.match(error.diagnostics, /ECONNREFUSED/);
    return true;
  });
  assert.equal(await readFile(file, 'utf8'), original);
});

test('删除请求超时保留结果不确定和原始原因，不自动重试', async t => {
  const { options } = await fixture(t);
  let calls = 0;
  await assert.rejects(deleteHostSkill(options, { timeoutMs: 5, fetch: async (_url, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('test deadline')), 1000);
      init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
    });
  } }), error => {
    assert.ok(error instanceof SkillDeleteError);
    assert.match(error.userMessage, /删除结果超时.*是否已删除尚未确认/);
    return true;
  });
  assert.equal(calls, 1);
});

test('GDE 返回成功但未删除目录时停止本地清理，真正删除仅发生在宿主请求处理内', async t => {
  const { root, options } = await fixture(t);
  const skillsRoot = path.join(root, 'skills');
  await createSkillFixture(skillsRoot);
  const directory = path.join(skillsRoot, options.skillName);
  await assert.rejects(deleteReviewSkill(skillsRoot, options.skillName, {
    deleteSkill: value => deleteHostSkill(value, { fetch: async () => Response.json({ success: true }) }),
  }), /目录仍存在/);
  await access(path.join(directory, 'task.yaml'));
  let calls = 0;
  await deleteReviewSkill(skillsRoot, options.skillName, { deleteSkill: value => deleteHostSkill(value, { fetch: async (_url, init) => {
    calls++;
    assert.equal(init?.method, 'DELETE');
    await rm(directory, { recursive: true });
    return new Response(null, { status: 204 });
  } }) });
  assert.equal(calls, 1);
  await assert.rejects(access(directory), { code: 'ENOENT' });
});

test('本地目录已缺失时仍请求 GDE 删除，清理可能遗留的宿主登记', async t => {
  const { root, options } = await fixture(t);
  let calls = 0;
  await deleteReviewSkill(path.join(root, 'absent-skills'), options.skillName, { allowMissing: true,
    deleteSkill: value => deleteHostSkill(value, { fetch: async () => { calls++; return Response.json({ detail: 'Skill not found' }, { status: 404 }); } }),
  });
  assert.equal(calls, 1);
});
