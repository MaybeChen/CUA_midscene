import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareRecordingSkill, publishRecordingDraft } from '../../cua/skills/create.js';
import { deleteHostSkill } from '../../cua/skills/host-delete.js';
import { installImportedFixture, type recordingSkillFixture } from './skill-import-fixture.js';

type Assets = Awaited<ReturnType<typeof recordingSkillFixture>>;
export async function workflowHostFixture(assets: Assets, beforePrepare: (recording: string) => Promise<void>) {
  const snapshots = await Promise.all(['_trace.json', '_processed_log.json', '_processed_log_sc.json'].map(async suffix =>
    [suffix, await readFile(path.join(assets.recording, `Recording_1${suffix}`))] as const));
  const controls = { failDelete: false, importFailure: '' as '' | 'before' | 'after', beforePublish: async () => {}, afterInstall: async (_name: string) => {} };
  const calls = { prepare: 0, publish: 0, requests: [] as { method: string; name: string }[] };
  const dependencies = {
    prepare: (options: Parameters<typeof prepareRecordingSkill>[0]) => prepareRecordingSkill({ ...options, pythonExecutable: process.execPath }, {
      runRecorder: async () => {
        calls.prepare++;
        for (const [suffix, bytes] of snapshots) await writeFile(path.join(options.recording, `${path.basename(options.recording)}${suffix}`), bytes);
        await beforePrepare(options.recording);
        options.progress.write('CUA_TRACE_PROGRESS {"completed":4,"total":4}\n');
      },
    }),
    deleteSkill: (options: Parameters<typeof deleteHostSkill>[0]) => deleteHostSkill({ ...options, executionRoot: assets.executionRoot }, { fetch: async (url, init) => {
      const name = path.basename(new URL(String(url)).pathname);
      calls.requests.push({ method: init!.method!, name });
      if (controls.failDelete) return Response.json({ detail: 'delete denied' }, { status: 500 });
      await rm(path.join(assets.skillsRoot, name), { recursive: true, force: true });
      return new Response(null, { status: 204 });
    } }),
    publish: async (options: Parameters<typeof publishRecordingDraft>[0]) => {
      calls.publish++;
      await controls.beforePublish();
      await publishRecordingDraft({ ...options, executionRoot: assets.executionRoot }, { fetch: async (url, init) => {
        const name = new URL(String(url)).searchParams.get('target_name')!;
        calls.requests.push({ method: init!.method!, name });
        if (controls.importFailure === 'before') return Response.json({ detail: 'import denied' }, { status: 500 });
        await installImportedFixture(init!.body as FormData, assets.skillsRoot);
        await controls.afterInstall(name);
        if (controls.importFailure === 'after') throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }) });
        return Response.json({ success: true });
      } });
    },
  };
  return { controls, calls, dependencies };
}
