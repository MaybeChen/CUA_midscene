<script setup lang="ts">
import { skillGenerationProgress } from '../recording-progress';
import folderIcon from '../assets/ucd/record-floder.svg';
import copyIcon from '../assets/ucd/record-copy.svg';
import importantIcon from '../assets/ucd/record-important.svg';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import App from '../App.vue';
import RecordingWorkspace from './RecordingWorkspace.vue';
import { api, request } from '../api';
import { useI18n } from '../i18n';
import type { RecordingCard } from '../../../shared/recording-cards';
import type { WorkflowStatus, WorkflowResult } from '../../../shared/workflow';
const props = defineProps<{ card: RecordingCard }>();
const { locale } = useI18n();
const status = ref<WorkflowStatus>();
const error = ref('');
const actionBusy = ref(false);
const recording = ref(false);
const result = ref<WorkflowResult>();
const resultTab = ref<'overview' | 'steps'>('overview');
const stepsVisited = ref(false);
function selectResultTab(tab: 'overview' | 'steps'): void {
  resultTab.value = tab;
  if (tab === 'steps') stepsVisited.value = true;
}
function moveResultTab(tab: 'overview' | 'steps'): void {
  selectResultTab(tab);
  document.getElementById(`skill-${tab}-tab`)?.focus();
}
async function savedSteps(): Promise<void> {
  showToast('任务步骤已保存并同步到 Skill');
  try { result.value = await request(`${root}/result`); }
  catch (cause) { showToast(cause instanceof Error ? cause.message : String(cause), true); }
}
const toast = ref<{ message: string; error: boolean }>();
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(message: string, error = false): void {
  if (disposed) return;
  if (toastTimer) clearTimeout(toastTimer);
  toast.value = { message, error };
  toastTimer = setTimeout(() => { toast.value = undefined; }, error ? 4000 : 2500);
}
const openingDirectory = ref(false);
const invocation = computed(() => result.value ? `[${result.value.name}](skill://${result.value.name}) 请执行该任务` : '');
const root = `/api/recording-cards/${encodeURIComponent(props.card.id)}`;
let poll: ReturnType<typeof setInterval> | undefined;
let fetching = false;
let disposed = false;
const renderedContent = computed(() =>
  DOMPurify.sanitize(marked.parse((result.value?.content ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''), { async: false }) as string),
);
const phase = computed(() => (recording.value ? 'idle' : (status.value?.phase ?? 'idle')));
const activeStep = computed(() => phase.value === 'idle' ? 1 : 2);
const displayLog = computed(() => (status.value?.log ?? '').replace(/^CUA_TRACE_PROGRESS .*\r?\n?/gm, ''));
const progress = computed(() => skillGenerationProgress(status.value?.log ?? '', phase.value));
const running = computed(() => ['analyzing', 'publishing'].includes(phase.value));
const progressHeading = computed(() => {
  if (phase.value === 'analyzing') return '正在生成任务';
  if (phase.value === 'publishing') return '正在打包并导入技能';
  if (phase.value === 'stopped') return '任务已停止';
  if (phase.value === 'editing') return '等待同步技能';
  return '任务失败';
});
async function refresh(): Promise<void> {
  if (fetching || disposed) return;
  fetching = true;
  try {
    const next = await request<WorkflowStatus>(`${root}/workflow`);
    if (disposed) return;
    status.value = next;
    if (next.phase === 'editing') status.value = await request<WorkflowStatus>(`${root}/publish`, { method: 'POST' });
    if (status.value?.phase === 'done' && !result.value) result.value = await request(`${root}/result`);
    error.value = '';
  } catch (cause) {
    error.value = String(cause instanceof Error ? cause.message : cause);
  } finally {
    fetching = false;
  }
}
async function action(name: 'analyze' | 'publish' | 'stop'): Promise<void> {
  actionBusy.value = true;
  error.value = '';
  recording.value = false;
  try {
    status.value = await request<WorkflowStatus>(`${root}/${name}`, {
      method: 'POST',
      ...(name === 'analyze' ? { body: JSON.stringify({ language: locale.value }) } : {}),
    });
    result.value = undefined;
    resultTab.value = 'overview';
    stepsVisited.value = false;
    await refresh();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    actionBusy.value = false;
  }
}
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(invocation.value);
    showToast('已复制运行指令');
  } catch { showToast('复制失败，请手动选择内容复制', true); }
}
async function openInstallDirectory(): Promise<void> {
  if (openingDirectory.value) return;
  openingDirectory.value = true;
  try {
    await request(`${root}/result/open-folder`, { method: 'POST' });
  } catch (cause) {
    showToast(cause instanceof Error ? cause.message : String(cause), true);
  } finally { openingDirectory.value = false; }
}
onMounted(async () => {
  await refresh();
  poll = setInterval(() => {
    if (running.value) void refresh();
  }, 1000);
});
onUnmounted(() => {
  disposed = true;
  if (poll) clearInterval(poll);
  if (toastTimer) clearTimeout(toastTimer);
});
</script>
<template>
  <section class="recording-workflow">
    <Teleport to="body"><Transition name="workflow-toast"><div v-if="toast" class="workflow-toast" :class="{ error: toast.error }" role="status" aria-live="polite">{{ toast.message }}</div></Transition></Teleport>
    <nav class="workflow-stepper" aria-label="创建技能阶段">
      <span
        v-for="(label, index) in ['流程录制', '技能生成']"
        :key="label"
        :class="{ current: activeStep === index + 1, complete: activeStep > index + 1 }"
        :aria-current="activeStep === index + 1 ? 'step' : undefined"
        ><i>{{ activeStep > index + 1 ? '✓' : index + 1 }}</i
        >{{ label }}</span
      >
    </nav>
    <p v-if="error" class="console-error" role="alert">{{ error }}</p>
    <p v-if="!status" class="catalog-feedback">正在加载流程…</p>
    <RecordingWorkspace
      v-else-if="phase === 'idle'"
      :key="card.id"
      :card-id="card.id"
      :recording-id="card.recordingId"
      :skills-configured="true"
      @analyze="action('analyze')"
      @folder-error="showToast($event, true)"
    />
    <template v-else-if="running || phase === 'failed' || phase === 'stopped' || phase === 'editing'">
      <section class="workflow-progress-panel">
        <h2>任务进度</h2>
        <div
          class="workflow-progress-message"
          :class="{ failed: phase === 'failed', stopped: phase === 'stopped' }"
          :role="running ? 'status' : 'alert'"
        >
          <div v-if="running" class="workflow-progress-bar" :class="{ indeterminate: !progress }" role="progressbar" aria-label="任务生成进度" :aria-valuemin="0" :aria-valuemax="progress?.total" :aria-valuenow="progress?.completed"><span :style="progress ? { width: `${progress.completed / progress.total * 100}%` } : undefined"></span></div>
          <h3>{{ progressHeading }}</h3>
          <p v-if="running">
            {{
              phase === 'analyzing'
                ? '正在处理录制并创建可运行任务，请勿关闭页面。'
                : '正在打包技能并同步到 GDE，请等待导入确认。'
            }}
          </p>
          <p v-if="status?.error">{{ status.error }}</p>
          <pre v-if="displayLog">{{ displayLog }}</pre>
        </div>
      </section>
      <div class="workflow-footer">
        <template v-if="!running"
          ><button class="secondary" @click="recording = true">返回录制</button
          ><button class="primary" :disabled="actionBusy" @click="action(status?.skillName ? 'publish' : 'analyze')">
            再次尝试
          </button></template
        ><button v-else-if="phase === 'analyzing'" class="secondary" :disabled="actionBusy" @click="action('stop')">
          停止任务
        </button>
      </div>
    </template>
    <template v-else-if="phase === 'done' && result">
      <div class="workflow-result-tabs" role="tablist" aria-label="技能生成结果">
        <button id="skill-overview-tab" role="tab" :aria-selected="resultTab === 'overview'" aria-controls="skill-overview-panel" :tabindex="resultTab === 'overview' ? 0 : -1" @click="selectResultTab('overview')" @keydown.right.prevent="moveResultTab('steps')">Skill概览</button>
        <button id="skill-steps-tab" role="tab" :aria-selected="resultTab === 'steps'" aria-controls="skill-steps-panel" :tabindex="resultTab === 'steps' ? 0 : -1" @click="selectResultTab('steps')" @keydown.left.prevent="moveResultTab('overview')">任务步骤</button>
      </div>
      <div v-show="resultTab === 'overview'" id="skill-overview-panel" role="tabpanel" aria-labelledby="skill-overview-tab">
      <div class="workflow-result-copy">
        <span>复制到对话即可运行</span>
        <div class="workflow-command"><code>{{ invocation }}</code><button class="workflow-copy-icon" aria-label="复制运行指令" title="复制运行指令" @click="copy()"><img :src="copyIcon" alt="" /></button></div>
      </div>
      <article class="workflow-result-card">
        <header class="workflow-skill-heading">
          <span class="card-avatar purple">S</span>
          <h2 :title="result.name">{{ result.name }}</h2>
          <span v-if="result.version" class="workflow-skill-version">{{ result.version.startsWith('v') ? result.version : `v${result.version}` }}</span>
          <span class="workflow-skill-origin">自定义</span>
        </header>
        <div class="workflow-skill-details">
          <p class="workflow-skill-description">{{ result.description }}</p>
          <div class="workflow-install-directory"><span>安装目录</span><span class="workflow-install-path" :title="result.installPath">{{ result.installPath }}</span><button class="workflow-copy-icon workflow-install-open" :disabled="openingDirectory" aria-label="打开安装目录" title="打开安装目录" @click="openInstallDirectory"><img :src="folderIcon" alt="" /></button></div>
        </div>
      </article>
      <h2 class="workflow-content-label"><img :src="importantIcon" alt="必填" />内容</h2>
      <article class="workflow-skill-content" v-html="renderedContent"></article>
      </div>
      <div v-show="resultTab === 'steps'" id="skill-steps-panel" role="tabpanel" aria-labelledby="skill-steps-tab">
        <App v-if="stepsVisited" :key="result.name" :installed-skill-name="result.name" :draft-task-title="card.name" @saved="savedSteps" />
      </div>
    </template>
    <div v-else-if="phase === 'done'" class="catalog-feedback">
      <button v-if="error" class="secondary" @click="refresh">重新加载技能结果</button>
      <span v-else>正在读取技能结果…</span>
    </div>
  </section>
</template>
