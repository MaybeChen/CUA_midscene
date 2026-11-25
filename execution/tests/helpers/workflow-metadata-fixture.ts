import Database from 'better-sqlite3';
import path from 'node:path';
import type { WorkflowStatus } from '../../review/shared/workflow.js';

export function seedWorkflowMetadata(dataRoot: string, rows: WorkflowStatus[]): void {
  const db = new Database(path.join(dataRoot, 'workbench', 'console.sqlite'));
  try {
    // 恢复用例允许卡片丢失后仍保留来源映射。
    db.pragma('foreign_keys = OFF');
    for (const row of rows) {
      db.prepare('INSERT OR REPLACE INTO workflows (cardId,recordingId,phase,skillName,draftRoot,error,log,pendingSkillName) VALUES (@cardId,@recordingId,@phase,@skillName,@draftRoot,@error,@log,@pendingSkillName)')
        .run({ ...row, pendingSkillName: row.pendingSkillName ?? null });
    }
  } finally { db.close(); }
}

export function readWorkflowMetadata(dataRoot: string): WorkflowStatus[] {
  const db = new Database(path.join(dataRoot, 'workbench', 'console.sqlite'));
  try { return db.prepare('SELECT * FROM workflows').all() as WorkflowStatus[]; }
  finally { db.close(); }
}
