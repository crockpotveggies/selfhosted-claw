# ADR: Deep Research Reuses ActionRecord and RunSpec

## Status

Accepted

## Context

Deep research needs longer runtimes, follow-up questions, workspace artifact storage, progress pings, spend tracking, and PDF delivery. A first draft considered a parallel research runner and queue.

That approach would have duplicated:

- action lifecycle state
- durability and restart behavior
- audit logging
- cancellation paths
- runner pool policy

The control plane already has durable primitives for long-running work: `ActionRecord`, `RunSpec`, runner pools, audit logs, approvals, and artifact metadata.

## Decision

Deep research runs on top of the existing control-plane action model.

- Research actions use `type=deep_research`
- Research-specific progress lives on the action record through `research_substate`, `progress_json`, `artifact_paths_json`, `followup_count`, and `spend_json`
- Follow-up routing is correlated through `Chat.pending_followup_action_id`
- Artifacts are stored on disk under `groups/<workspace>/research/<topic-slug>/`
- Binary PDFs are referenced by path in the database instead of being serialized inline across IPC

## Consequences

Benefits:

- one durable state machine instead of two
- existing audit, cancellation, and restart semantics continue to apply
- admin UI can inspect research jobs through the same data model as other actions

Tradeoffs:

- research orchestration still needs custom substate handling on top of the generic action lifecycle
- some runner-pool behavior is specialized by lane and settings rather than by a standalone subsystem

## Notes

This ADR is here mainly to prevent future contributors from reintroducing a parallel research queue unless the shared action model proves insufficient in practice.
