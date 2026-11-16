import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { importSkillArchive, SkillImportError } from '../../cua/skills/host-import.js';
import { networkImportError } from '../../cua/skills/import-failure.js';

const context = { url: new URL('http://127.0.0.1:49123/api/gdeclaw/skills/import?enable=true&target_name=alarm-query'), zipPath: '/draft/alarm-query.zip' };
const caused = (code: string) => new TypeError('fetch failed', { cause: Object.assign(new Error('underlying failure'), { code }) });

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'import-errors-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const zipPath = path.join(root, 'alarm-query.zip');
  await writeFile(zipPath, 'isolated upload');
  return { ...context, zipPath, skillName: 'alarm-query' };
}

test('连接被拒绝识别嵌套聚合错误，提示启动服务并保留具体错误码', () => {
  const cause = new TypeError('fetch failed', { cause: new AggregateError([
    Object.assign(new Error('connect ::1'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('connect 127.0.0.1'), { code: 'ECONNREFUSED' }),
  ]) });
  const error = networkImportError(context, cause, false);
  assert.equal(error.code, 'GDE_CONNECTION_REFUSED');
  assert.match(error.userMessage, /GDE 服务已启动/);
  assert.doesNotMatch(error.userMessage, /尚未确认|ZIP|49123/);
  assert.match(error.diagnostics, /ECONNREFUSED/);
  assert.match(error.diagnostics, /127.0.0.1:49123/);
  assert.match(error.diagnostics, /ZIP 产物/);
  assert.equal(error.cause, cause);
});

test('地址解析、证书、连接超时和网络不可达提供各自操作建议', () => {
  const cases = [
    ['ENOTFOUND', 'GDE_DNS_FAILED', /无法解析/],
    ['EAI_AGAIN', 'GDE_DNS_FAILED', /服务地址/],
    ['CERT_HAS_EXPIRED', 'GDE_CERTIFICATE_FAILED', /证书/],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'GDE_CERTIFICATE_FAILED', /证书/],
    ['UND_ERR_CONNECT_TIMEOUT', 'GDE_CONNECT_TIMEOUT', /连接 GDE 服务超时/],
    ['ENETUNREACH', 'GDE_NETWORK_UNREACHABLE', /网络连接/],
  ] as const;
  for (const [code, expected, message] of cases) {
    const error = networkImportError(context, caused(code), false);
    assert.equal(error.code, expected);
    assert.match(error.userMessage, message);
    assert.doesNotMatch(error.userMessage, /尚未确认/);
  }
});

test('中断、未知异常和混合连接错误不误判为未发送请求', () => {
  for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE', 'UNKNOWN']) {
    assert.match(networkImportError(context, caused(code), false).userMessage, /是否已安装尚未确认/);
  }
  const mixed = new AggregateError([caused('ECONNREFUSED'), caused('ECONNRESET')]);
  assert.match(networkImportError(context, mixed, false).userMessage, /连接中断/);
  const unknown = new AggregateError([caused('ECONNREFUSED'), new Error('unknown')]);
  assert.match(networkImportError(context, unknown, false).userMessage, /是否已安装尚未确认/);
  assert.match(networkImportError(context, new Error('unexpected'), true).userMessage, /等待 GDE 导入结果超时/);
});

test('HTTP 错误按状态码提示，服务端长错误仅进入诊断', async t => {
  const options = await fixture(t);
  const cases = [[400, /技能包/], [401, /身份验证/], [403, /权限/], [404, /接口/], [409, /名称冲突/],
    [413, /技能包过大/], [422, /校验/], [429, /频繁/], [500, /发生异常/], [503, /不可用/], [504, /尚未确认/]] as const;
  for (const [status, message] of cases) {
    await assert.rejects(importSkillArchive(options, { fetch: async () => Response.json({ detail: 'upstream traceback details' }, { status }) }), error => {
      assert.ok(error instanceof SkillImportError);
      assert.equal(error.remoteStatus, status);
      assert.match(error.userMessage, message);
      assert.doesNotMatch(error.userMessage, /upstream traceback|ZIP/);
      assert.match(error.diagnostics, /upstream traceback details/);
      return true;
    });
  }
});

test('成功状态的异常响应区分格式错误与业务拒绝，记录实际状态码', async t => {
  const options = await fixture(t);
  const responses = [
    [new Response('<html>invalid</html>', { status: 201 }), 'GDE_RESPONSE_INVALID_JSON', /尚未确认/],
    [Response.json([], { status: 202 }), 'GDE_RESPONSE_INVALID_OBJECT', /尚未确认/],
    [Response.json({ success: false, message: 'rejected detail' }), 'GDE_IMPORT_REJECTED', /报告技能导入失败/],
  ] as const;
  for (const [response, code, message] of responses) {
    await assert.rejects(importSkillArchive(options, { fetch: async () => response }), error => {
      assert.ok(error instanceof SkillImportError);
      assert.equal(error.code, code);
      assert.equal(error.remoteStatus, response.status);
      assert.match(error.userMessage, message);
      return true;
    });
  }
});

test('非 JSON 的 HTTP 错误仍保留状态和原始响应', async t => {
  const options = await fixture(t);
  await assert.rejects(importSkillArchive(options, { fetch: async () => new Response('proxy unavailable', { status: 503 }) }), error => {
    assert.ok(error instanceof SkillImportError);
    assert.equal(error.code, 'GDE_HTTP_503');
    assert.match(error.diagnostics, /proxy unavailable/);
    return true;
  });
});

test('读取响应期间超时保留不确定状态，不误报 JSON 格式错误', async t => {
  const options = await fixture(t);
  await assert.rejects(importSkillArchive(options, { timeoutMs: 10, fetch: async (_url, init) => new Response(new ReadableStream({
    start(controller) { init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true }); },
  })) }), error => {
    assert.ok(error instanceof SkillImportError);
    assert.equal(error.code, 'GDE_IMPORT_TIMEOUT');
    assert.match(error.userMessage, /是否已安装尚未确认/);
    return true;
  });
});

test('真实 HTTP 重定向被明确提示，不跟随重定向或重传', async t => {
  const options = await fixture(t);
  let calls = 0;
  const server = createServer((request, response) => {
    calls++;
    request.resume();
    response.writeHead(307, { location: '/login' });
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await assert.rejects(importSkillArchive({ ...options, url: new URL(`http://127.0.0.1:${address.port}/import`) }), error => {
    assert.ok(error instanceof SkillImportError);
    assert.equal(error.code, 'GDE_UNEXPECTED_REDIRECT');
    assert.match(error.userMessage, /重定向/);
    assert.match(error.diagnostics, /unexpected redirect/);
    return true;
  });
  assert.equal(calls, 1);
});

test('诊断保留规范请求地址但不记录凭据和无关查询参数', () => {
  const url = new URL('https://user:password@example.test/import?token=secret&target_name=alarm-query#sensitive');
  const error = networkImportError({ ...context, url }, caused('ECONNREFUSED'), false);
  assert.match(error.diagnostics, /https:\/\/example.test\/import\?target_name=alarm-query/);
  assert.doesNotMatch(error.diagnostics, /password|secret|sensitive|user:/);
});
