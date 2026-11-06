import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import test from 'node:test';
import { openWindowsDirectory, foregroundDirectoryScript } from '../../cua/foreground-directory.js';

function fixture(directory: string) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  let launch: { command: string; args: readonly string[]; options: Record<string, any> } | undefined;
  const fakeSpawn = ((command: string, args: readonly string[], options: Record<string, any>) => {
    launch = { command, args, options }; return child;
  }) as unknown as typeof spawn;
  const completion = openWindowsDirectory(directory, fakeSpawn);
  return { child, completion, launch: launch! };
}

test('打开目录等待前台激活确认，路径通过环境传递且不会拼入PowerShell代码', async () => {
  const directory = 'C:\\资料 & 测试\\$(not-a-command)';
  const { child, completion, launch } = fixture(directory);
  assert.equal(launch.command, 'powershell.exe');
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.windowsHide, true);
  assert.equal(launch.options.env.CUA_OPEN_DIRECTORY, directory);
  const script = Buffer.from(launch.args.at(-1)!, 'base64').toString('utf16le');
  assert.equal(script, foregroundDirectoryScript);
  assert.ok(!script.includes(directory));
  let completed = false;
  completion.then(() => { completed = true; });
  child.emit('spawn'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  child.stdout.write(JSON.stringify({ directory, foregroundConfirmed: true, windowVisible: true }));
  child.emit('close', 0);
  assert.deepEqual(await completion, { directory, foregroundConfirmed: true, windowVisible: true });
  assert.equal(completed, true);
});

test('进程退出成功但缺少确认或目标不匹配时不得报告打开成功', async () => {
  const missing = fixture('C:\\recordings\\demo');
  missing.child.emit('close', 0);
  await assert.rejects(missing.completion, /未返回窗口前置确认/);
  const wrong = fixture('C:\\recordings\\demo');
  wrong.child.stdout.write(JSON.stringify({ directory: 'C:\\other', foregroundConfirmed: true, windowVisible: true }));
  wrong.child.emit('close', 0);
  await assert.rejects(wrong.completion, /不匹配/);
});

test('仅有前台确认而缺少窗口可见确认时拒绝成功', async () => {
  for (const windowVisible of [undefined, false]) {
    const directory = 'C:\\recordings\\demo';
    const pending = fixture(directory);
    pending.child.stdout.write(JSON.stringify({ directory, foregroundConfirmed: true, windowVisible }));
    pending.child.emit('close', 0);
    await assert.rejects(pending.completion, /不匹配/);
  }
});

test('无法前置或启动文件管理器时保留失败原因', async () => {
  const failure = fixture('C:\\skills\\demo');
  failure.child.stderr.write('窗口未能置于前台');
  failure.child.emit('close', 1);
  await assert.rejects(failure.completion, /窗口未能置于前台/);
  const missing = fixture('C:\\skills\\demo');
  missing.child.emit('error', new Error('ENOENT'));
  await assert.rejects(missing.completion, /无法启动目录窗口.*ENOENT/);
});
