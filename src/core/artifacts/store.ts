import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { createArtifactRecord, listArtifactsForTask } from '../../db.js';
import type { ArtifactRecord } from '../state/types.js';

export interface MaterializedArtifact {
  artifact: ArtifactRecord;
  content: string;
}

export class ArtifactStore {
  constructor(private readonly rootDir = path.join(DATA_DIR, 'artifacts')) {}

  writeArtifact(input: {
    taskId: string;
    actionId?: string | null;
    kind: string;
    mediaType: string;
    content: string | Buffer;
    createdByRunId?: string | null;
    extension?: string;
  }): ArtifactRecord {
    const artifactId = randomUUID();
    const buffer =
      typeof input.content === 'string'
        ? Buffer.from(input.content, 'utf-8')
        : input.content;
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const taskDir = path.join(this.rootDir, input.taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    const filename = `${artifactId}${input.extension ?? '.txt'}`;
    const artifactPath = path.join(taskDir, filename);
    fs.writeFileSync(artifactPath, buffer);

    const record: ArtifactRecord = {
      id: artifactId,
      task_id: input.taskId,
      action_id: input.actionId ?? null,
      kind: input.kind,
      path: artifactPath,
      media_type: input.mediaType,
      sha256,
      size_bytes: buffer.byteLength,
      created_by_run_id: input.createdByRunId ?? null,
      created_at: new Date().toISOString(),
    };
    createArtifactRecord(record);
    return record;
  }

  readArtifact(artifact: Pick<ArtifactRecord, 'path'>): string {
    return fs.readFileSync(artifact.path, 'utf-8');
  }

  readArtifactBuffer(artifact: Pick<ArtifactRecord, 'path'>): Buffer {
    return fs.readFileSync(artifact.path);
  }

  readArtifactText(artifact: Pick<ArtifactRecord, 'path'>): string {
    return this.readArtifact(artifact);
  }

  listTaskArtifacts(taskId: string): ArtifactRecord[] {
    return listArtifactsForTask(taskId);
  }
}
