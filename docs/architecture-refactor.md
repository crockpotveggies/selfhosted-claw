# Control Plane Refactor Note

## Current execution seam

The legacy runtime is still authoritative today. The old model-to-execution seam is:

- `processGroupMessages()` in `src/index.ts`
- `runContainerAgent()` in `src/container-runner.ts`
- `executeAgentDirective()` in `src/index.ts`
- IPC side effects in `src/ipc.ts`

That path currently:

1. Builds an ad hoc prompt from inbound messages and snapshots
2. Sends it straight to the container agent
3. Parses freeform-ish agent output into directives
4. Executes side effects from the control loop

This is the seam being wrapped and retired gradually.

## Migration approach

The repo stays in place. Connectors, admin UI, deployment shape, and useful storage/runtime pieces remain where practical. The new control-plane architecture is introduced beside the old code and activated behind feature flags.

### New module spine

- `src/core/state/`
  - durable entity types for principals, identities, tasks, actions, runs, artifacts, approvals, and audit logs
- `src/core/identity/`
  - canonical principal resolution and trust-tier mapping
- `src/core/policy/`
  - deterministic permission checks for runner lanes, skills, and approvals
- `src/core/skills/`
  - global skill registry plus permission-filtered agent exposure
- `src/core/context/`
  - planner/execution bundle contracts
- `src/protocol/`
  - typed planner, action, run, and result contracts with validation
- `src/planner/`
  - planner interface for semantic action proposal
- `src/dispatcher/`
  - control-plane compilation from action records to validated run specs
- `src/runner/common/`
  - runner contract that only accepts `RunSpec`
- `src/legacy/`
  - explicit markers for the legacy direct execution seam

## Current migration state

The repo now includes these working new-architecture pieces:

- Durable control-plane tables for principals, identities, tasks, actions, runs, artifacts, approvals, inbound dedupe, and leases
- Deterministic identity resolution and trust-lane mapping
- Deterministic skill metadata registry with permission-group filtering
- Structured planner vs execution context assembly
- `RunSpec` validation and a local template-based execution path
- Trusted and restricted runner pools
- Hot runner pool manager with reusable runner sessions, prewarm, idle reaping,
  and lane-specific ceilings
- Durable inbound-event dedupe, semantic dedupe lookup, and action lease semantics
- Approval gating for sensitive action finalization

## Active migration behavior

- The legacy loop still remains the default runtime behavior
- `ENABLE_NEW_ACTION_ENGINE` wraps inbound work in durable control-plane state
- `ENABLE_RUNSPEC_RUNNERS` enables one safe compute-only skill path:
  - `draft_reply_from_thread`
- `ENABLE_HOT_RUNNER_CONTAINERS` upgrades the new `RunSpec` lane from local
  warm sessions to real reusable runner containers
- Existing-conversation Signal sends can now finalize through the control plane
  when the new action engine is enabled

That path currently:

1. Resolves principal and trust lane
2. Records durable task/action/run state
3. Applies inbound dedupe and semantic dedupe
4. Claims an action lease
5. Compiles and dispatches a validated `RunSpec`
6. Reuses a warm trusted/restricted runner session from the shared pool
7. Writes outputs back into the artifact store
8. Returns the generated draft through the existing reply flow

When hot runner containers are enabled, the control plane:

1. Prewarms trusted and restricted pools at startup
2. Keeps reusable runner containers alive across jobs
3. Executes typed jobs via `docker exec` against those warm containers
4. Reaps excess idle sessions while preserving minimum warm capacity
5. Stops runner containers cleanly on shutdown

The side-effect boundary now also includes:

1. Approval-gated outbound finalization
2. Idempotent send recording in audit state
3. Control-plane-managed Signal sends for existing conversations

## Next slices

1. Expand more compute-only skills onto `RunSpec`
2. Centralize final outbound side effects behind approvals and control-plane finalization
3. Replace broad mounted skill exposure with per-principal visible-skill snapshots for the runtime
4. Move more connectors from legacy freeform prompt sessions onto typed action dispatch
