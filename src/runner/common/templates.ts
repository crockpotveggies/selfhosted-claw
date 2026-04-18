import type { RunResult, RunSpec } from '../../protocol/types.js';

export interface TemplateExecutionContext {
  spec: RunSpec;
  inputArtifacts: Array<{ artifactId: string; content: string }>;
}

export interface TemplateExecutor {
  name: string;
  execute(context: TemplateExecutionContext): Promise<{
    status: RunResult['status'];
    stdoutTail: string;
    stderrTail: string;
    outputs: Array<{
      relativePath: string;
      mediaType: string;
      content: string;
    }>;
  }>;
}

class DraftReplyFromThreadTemplate implements TemplateExecutor {
  name = 'draft_reply_from_thread';

  async execute(context: TemplateExecutionContext) {
    const prompt = String(context.spec.template_args.prompt ?? '').trim();
    const threadSummary = String(
      context.spec.template_args.thread_summary ?? '',
    ).trim();
    const sourceMaterial = context.inputArtifacts
      .map((artifact) => artifact.content.trim())
      .filter(Boolean)
      .join('\n\n');

    const draft = [
      'Draft Reply',
      '',
      prompt ? `Request: ${prompt}` : 'Request: follow up',
      threadSummary ? `Thread Summary: ${threadSummary}` : null,
      sourceMaterial ? `Sources:\n${sourceMaterial}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    return {
      status: 'succeeded' as const,
      stdoutTail: 'draft generated',
      stderrTail: '',
      outputs: [
        {
          relativePath: 'draft-reply.md',
          mediaType: 'text/markdown',
          content: draft,
        },
      ],
    };
  }
}

class DeepResearchTemplate implements TemplateExecutor {
  name = 'deep_research';

  async execute(context: TemplateExecutionContext) {
    const prompt = String(context.spec.template_args.prompt ?? '').trim();
    const slug = String(context.spec.template_args.topic_slug ?? 'research-report').trim();
    const plan = JSON.stringify(
      {
        topic_slug: slug,
        objectives: [prompt],
        subqueries: [prompt],
        needs_followup: false,
        followup_questions: [],
      },
      null,
      2,
    );
    return {
      status: 'succeeded' as const,
      stdoutTail: 'deep research template staged',
      stderrTail: '',
      outputs: [
        {
          relativePath: `${slug}-plan.json`,
          mediaType: 'application/json',
          content: plan,
        },
      ],
    };
  }
}

const templates = new Map<string, TemplateExecutor>([
  ['draft_reply_from_thread', new DraftReplyFromThreadTemplate()],
  ['deep_research', new DeepResearchTemplate()],
]);

export function getKnownTemplateNames(): string[] {
  return [...templates.keys()].sort();
}

export function getTemplateExecutor(
  name: string,
): TemplateExecutor | undefined {
  return templates.get(name);
}
