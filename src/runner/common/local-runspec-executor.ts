import fs from 'fs';
import os from 'os';
import path from 'path';

import { parseRunSpec } from '../../protocol/schemas.js';
import type { RunResult, RunSpec } from '../../protocol/types.js';
import { getTemplateExecutor, getKnownTemplateNames } from './templates.js';

export class LocalRunSpecExecutor {
  async execute(runSpec: RunSpec): Promise<RunResult> {
    const parsed = parseRunSpec(runSpec, {
      knownTemplates: getKnownTemplateNames(),
    });
    const executor = getTemplateExecutor(parsed.template);
    if (!executor) {
      throw new Error(`Unknown template: ${parsed.template}`);
    }

    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), `nanoclaw-runspec-${parsed.runner_pool}-`),
    );
    const workspaceIn = path.join(workspaceRoot, 'workspace', 'in');
    const workspaceOut = path.join(workspaceRoot, 'workspace', 'out');
    const workspaceMeta = path.join(workspaceRoot, 'workspace', 'meta');
    fs.mkdirSync(workspaceIn, { recursive: true });
    fs.mkdirSync(workspaceOut, { recursive: true });
    fs.mkdirSync(workspaceMeta, { recursive: true });

    fs.writeFileSync(
      path.join(workspaceMeta, 'run-spec.json'),
      JSON.stringify(parsed, null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(workspaceMeta, 'metadata.json'),
      JSON.stringify(parsed.workspace.metadata, null, 2),
      'utf-8',
    );

    const inputArtifacts = parsed.workspace.input_artifact_ids.map(
      (artifactId) => {
        const content = parsed.env[`ARTIFACT_${artifactId}`] ?? '';
        fs.writeFileSync(
          path.join(workspaceIn, `${artifactId}.txt`),
          content,
          'utf-8',
        );
        const envKey = `ARTIFACT_${artifactId}`;
        return {
          artifactId,
          content,
        };
      },
    );

    const templateResult = await executor.execute({
      spec: parsed,
      inputArtifacts,
    });

    for (const output of templateResult.outputs) {
      fs.writeFileSync(
        path.join(workspaceOut, output.relativePath),
        output.content,
        'utf-8',
      );
    }

    return {
      run_id: parsed.run_id,
      status: templateResult.status,
      exit_code: templateResult.status === 'succeeded' ? 0 : 1,
      artifacts: templateResult.outputs.map((output) => ({
        artifact_id: output.relativePath,
        path: path.join(workspaceOut, output.relativePath),
        media_type: output.mediaType,
      })),
      stdout_tail: templateResult.stdoutTail,
      stderr_tail: templateResult.stderrTail,
    };
  }
}
