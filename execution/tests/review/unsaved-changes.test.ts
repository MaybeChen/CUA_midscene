import assert from 'node:assert/strict';
import test from 'node:test';
import { effectScope, ref } from 'vue';
import { useUnsavedChanges } from '../../review/web/src/unsaved-changes.js';

function tryUnload(target: EventTarget): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  Object.defineProperty(event, 'returnValue', { value: '', writable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function guard(target: EventTarget, dirty = ref(false)) {
  const scope = effectScope();
  scope.run(() => useUnsavedChanges(() => dirty.value, target as unknown as Window));
  return { dirty, stop: () => scope.stop() };
}

test('未修改时允许关闭，有未保存修改时同步阻止关闭，保存成功后解除', () => {
  const target = new EventTarget();
  const editor = guard(target);
  try {
    assert.equal(tryUnload(target), false);
    editor.dirty.value = true;
    assert.equal(tryUnload(target), true);
    editor.dirty.value = false;
    assert.equal(tryUnload(target), false);
    editor.dirty.value = true;
    assert.equal(tryUnload(target), true);
  } finally { editor.stop(); }
});

test('取消关闭或保存失败后继续拦截，销毁编辑组件时释放监听', () => {
  const target = new EventTarget();
  const editor = guard(target, ref(true));
  assert.equal(tryUnload(target), true);
  assert.equal(tryUnload(target), true);
  editor.stop();
  assert.equal(tryUnload(target), false);
});

test('普通浏览器不需要 Electron 接口，同时发送标准和传统关闭拦截信号', () => {
  const browser = new EventTarget();
  const editor = guard(browser, ref(true));
  try {
    const event = new Event('beforeunload', { cancelable: true });
    Object.defineProperty(event, 'returnValue', { value: '', writable: true });
    browser.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.ok((event as unknown as { returnValue: string }).returnValue.length > 0);
  } finally { editor.stop(); }
});

test('页面内多个编辑实例独立维护状态，保存其中一个不会丢失其他实例的保护', () => {
  const target = new EventTarget();
  const first = guard(target, ref(true));
  const second = guard(target, ref(true));
  try {
    first.dirty.value = false;
    assert.equal(tryUnload(target), true);
    second.stop();
    assert.equal(tryUnload(target), false);
  } finally { first.stop(); second.stop(); }
});
