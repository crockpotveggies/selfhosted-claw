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
    kind: string;
    mediaType: string;
    content: string;
    createdByRunId?: string | null;
    extension?: string;
  }): ArtifactRecord {
    const artifactId = randomUUID();
    const sha256 = createHash('sha256').update(input.content).digest('hex');
    const taskDir = path.join(this.rootDir, input.taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    const filename = `${artifactId}${input.extension ?? '.txt'}`;
    const artifactPath = path.join(taskDir, filename);
    fs.writeFileSync(artifactPath, input.content, 'utf-8');

    const record: ArtifactRecord = {
      id: artifactId,
      task_id: input.taskId,
      kind: input.kind,
      path: artifactPath,
      media_type: input.mediaType,
      sha256,
      size_bytes: Buffer.byteLength(input.content),
      created_by_run_id: input.createdByRunId ?? null,
    };
    createArtifactRecord(record);
    return record;
  }

  readArtifact(artifact: Pick<ArtifactRecord, 'path'>): string {
    return fs.readFileSync(artifact.path, 'utf-8');
  }

  listTaskArtifacts(taskId: string): ArtifactRecord[] {
    return listArtifactsForTask(taskId);
  }
}
