# Administrator-only recognition preview implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Validate recent returns without replacing the shared production API or buying services.

**Architecture:** Deploy the existing API package under the separate name `recentReturnsPreview`, with a dedicated `preview.main` entry that permits only the three recognition actions and requires the existing server-side administrator authorization. Route only these actions from development builds to the preview function; trial/release and all other actions retain `api`. The preview shares existing data, so do not fabricate records or change real consent during automated checks.

**Tech Stack:** Existing Node.js CloudBase CLI 3.6.2, wx-server-sdk, TypeScript, Vitest.

## Task 1: Guarded preview entry and routing

Files: add `cloudfunctions/api/preview.js`, `miniprogram/shared/api-routing.ts`, and focused tests; update `cloudfunctions/api/handler.js` with a trusted constructor-only preview option and `miniprogram/services/cloud-card-service.ts` only at function-name selection.

- [x] Write failing tests for supported actions, unsupported action rejection, non-admin rejection, blocked/deleting administrator rejection, and develop-only routing. Use the real API test database harness for authorization, not event-supplied identity.
- [x] Implement preview entry using `createApiHandler(dependencies, { recognitionPreview: true })`. Inside the existing request runtime, reject actions outside the three-action allowlist and run existing `requireAdmin(openid)` before normal authorization/dispatch. Production construction omits this option and remains unchanged. Never accept `openid`, role or environment claims from event input as authorization.
- [x] Client route selection must fail closed to `api` if account-info lookup is unavailable or throws. Only `develop` plus one of `listRecentReturns`, `getReturnRecognitionPreference`, `updateReturnRecognitionPreference` selects `recentReturnsPreview`.
- [x] Run focused tests, TypeScript and lint; conduct independent specification and quality review.

## Task 2: Narrow deployment and readback

- [x] Read billing settings and current functions. Environment is prepaid personal; overrun and automatic renewal are disabled. Do not change billing or claim unlimited free use.
- [x] Create only the non-unique `handovers_recent_returns` index, with `valid` ascending and `completedAt` descending, after checking for an equivalent index. Use `UpdateTable` with `CreateIndexes` only; never use the full permissions deployment script.
- [x] Prepare a local ignored configuration containing only `recentReturnsPreview`, source directory `cloudfunctions/api`, handler `preview.main`, Nodejs20.19, timeout 15, memory 256, and no triggers or HTTP gateway. Preserve the existing API secret internally without printing it or writing it into tracked files.
- [x] Deploy only the new function. Preserve existing function access rules and add authenticated invocation for this function; its server entry additionally requires administrator status. Read back handler, runtime, state, rules and original four function modification times.
- [x] Reload the existing developer-tools project and inspect homepage/settings without authorizing publication or writing sample data. Record real success/empty/error states, not assumed success.
- [x] Run the full local verification suite and record remaining limits. Do not upload/release the mini-program or claim real-device acceptance.

2026-09-20 execution: full verification 462 tests passed; preview Active and old function timestamps unchanged; unauthenticated spoofed invocation rejected. Desktop DNS/TLS failure blocks positive simulator readback. No actual consent writes or synthetic production rows were made. See `docs/RECENT-RETURNS.md` for receipts and deployment boundaries.

2026-09-20 22:12 follow-up: after preserving the unsaved editor settings as a separate local backup, restarting the IDE and recompiling restored the simulator. The administrator homepage loaded the bound masked identity and a successful empty recent-return list; settings loaded the current anonymous recognition preference and reported cloud connected. This completes positive read-only preview acceptance, not real consent write/withdrawal, populated-record or formal-release acceptance. No privacy settings or production records were changed.

## Stop conditions and rollback

Stop before paid activation, overrun enablement, changing production code, unexpected access-rule drift, missing server configuration, or failed authorization tests. Do not weaken guards. To disable preview without touching production, remove only its invocation rule after fresh readback; keep all existing rules unchanged. Local develop routing can be reverted independently.
