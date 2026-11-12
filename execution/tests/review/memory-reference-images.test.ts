import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryReferenceImages } from '../../review/web/src/memory-reference-images.js';
import type { ReviewTaskDraft } from '../../review/shared/types.js';
import type { SkillTaskManifest } from '../../cua/contracts/types.js';

test('选图和编辑仅保留内存预览，保存时只上传仍绑定的图片并替换引用', async () => {
  const memory = new MemoryReferenceImages();
  const file = Object.assign(new Blob(['image'], { type: 'image/png' }), { name: 'reference.png' }) as File;
  const image = memory.add(file);
  const unused = memory.add(file);
  assert.match(image.url, /^blob:/);
  const draft = { manifest: { inputs: {} }, document: { tasks: [{ flow: [{ aiTap: { prompt: '按钮', images: [image, image] } }] }] } } as unknown as ReviewTaskDraft<SkillTaskManifest>;
  const before = JSON.stringify(draft);
  let uploads = 0;
  const saved = await memory.materialize(draft, async current => {
    uploads++; assert.equal(current, file);
    return { image: { name: 'reference-image', url: 'source/reference-images/hash.png' } };
  });
  assert.equal(uploads, 1);
  assert.equal(JSON.stringify(draft), before);
  assert.doesNotMatch(JSON.stringify(saved), /blob:/);
  assert.match(JSON.stringify(saved), /source\/reference-images\/hash.png/);
  assert.match(JSON.stringify(saved), /reference\.png/);
  assert.ok(!JSON.stringify(saved).includes(unused.url));
  memory.clear();
});
