import assert from 'node:assert/strict';
import test from 'node:test';
import { recordingProgress } from '../../review/web/src/recording-progress.js';

test('流式日志从最后一条完整进度恢复，忽略半条输出和无效总数', () => {
  const log = 'Parsed 7 raw actions\r\nCUA_TRACE_PROGRESS {"completed":0,"total":4}\r\n';
  assert.deepEqual(recordingProgress(log), { completed: 0, total: 4 });
  assert.deepEqual(recordingProgress(log + 'CUA_TRACE_PROGRESS {"completed":2,"total":4}\nparsing Step 3\n'), { completed: 2, total: 4 });
  assert.deepEqual(recordingProgress(log + 'CUA_TRACE_PROGRESS {"completed":'), { completed: 0, total: 4 });
  assert.deepEqual(recordingProgress(log + 'CUA_TRACE_PROGRESS {"completed":5,"total":4}\n'), { completed: 0, total: 4 });
  assert.equal(recordingProgress('parsing Step 1'), undefined);
});
