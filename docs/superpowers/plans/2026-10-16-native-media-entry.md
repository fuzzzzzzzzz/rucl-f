# Native Media Entry Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for this local continuation; tests before code. Keep existing isolation and all deployed resources unchanged.

**Goal:** Wire the existing native decoder and transactional service into a separate deployable entry and shared server configuration, without enabling a production switch.

**Architecture:** The callback uses its own handler in the existing self-contained API code directory. A separate opt-in deployment manifest selects that handler for a new function, without copying shared modules or routing callbacks through student actions. Both API and callback read the same explicit mode/application/integrity-key server variables. Default deployment and function rules remain unchanged.

**Tech Stack:** CommonJS, existing wx-server-sdk, Vitest, CloudBase function `dir`/`handler` configuration. Official reference: https://docs.cloudbase.net/cli-v1/functions/configs.

## Task 1: Shared environment mapping

Files: create `cloudfunctions/api/media-runtime-config.js` and `tests/media-runtime-config.test.js`; modify the configuration call site in `cloudfunctions/api/handler.js`.

- [x] Write a missing-export assertion, observe failure, then implement `mediaAuditConfigFromEnvironment(environment)`. Missing MEDIA_AUDIT_MODE preserves the existing signed shape; exact native selects only mode/appId/integrityKey. Explicit unknown, empty or accessor configuration yields null; no fallback from unknown mode. Use own data fields from a non-Proxy plain record, do not mutate environment or print values.

```js
const native = { mode: 'native', appId: values.MEDIA_CALLBACK_APP_ID, integrityKey: values.MEDIA_INTEGRITY_KEY }
const signed = {
  token: values.MEDIA_CALLBACK_TOKEN,
  encodingAESKey: values.MEDIA_CALLBACK_AES_KEY,
  appId: values.MEDIA_CALLBACK_APP_ID,
}
```

- [x] Preserve explicit dependency `mediaAuditConfig` overrides and old signed tests. Add tests for native mapping, default signed, explicit signed, wrong mode, getters/proxies, capture/mutation and no secret in errors. Environment routing ignores unused old-mode variables deliberately; the service still validates selected key fields.

## Task 2: Independent native handler

Files: create `cloudfunctions/api/media-native-handler.js`, `cloudfunctions/api/media-native-entry.js` and `tests/media-native-entry.test.js`.

- [x] Assert the factory exists before require and observe red. Implement `createNativeMediaCallbackHandler({cloud,database,config,expectedEnvironmentId,now})` using the real service and decoder; configured signed/invalid setups return a closed handler. The source getter comes from the initialized cloud SDK, and the handler receives the actual second argument, never event.context.
- [x] Decode before transactions. Invalid source/event returns only `{accepted:false}`. Authenticated persistence success returns only `{accepted:true}`. Persistence failure throws fixed `media_callback_failed` so a transient write failure is not acknowledged as successful; no raw provider data or secrets escape.
- [x] Entry initializes SDK in the deployment-selected environment, reads shared config and explicit MEDIA_CALLBACK_ENV_ID, then exports only main. It never imports API index/handler, exposes actions, creates secrets or calls mediaCheckAsync itself.
- [x] Test real decoder/service/database combinations: correct pass, early callback, duplicates, conflicts, review/risky/error, expiration, client/root/nested source forgery, wrong application/environment, missing runtime context, disabled/malformed config, and failed transaction/retry. Load the actual entry with only SDK transport replaced and assert its main persists a valid receipt while student actions do not execute.

## Task 3: Opt-in package/config contract

Files: create `cloudbaserc.native-callback.json`, `tests/media-native-package.test.js`; modify only coverage/tooling lists needed for the two new reusable runtime modules. Do not add the receiver to default `cloudbaserc.json` or live rules.

- [x] Before creating the manifest, assert it exists and observe red. Manifest targets the current environment and only api plus mediaSafetyCallback. Both use `dir: './cloudfunctions/api'`, Event/Nodejs20.19/installed dependencies. API keeps index.main and all existing non-media placeholders; receiver uses media-native-entry.main, no timer or student/OCR credentials. Native mode/application/environment are pinned strings; integrity key is only `{{env.MEDIA_INTEGRITY_KEY}}`. Do not include HTTP token/AES settings.
- [x] Add exact manifest contract tests, self-contained require/package checks and a subprocess loading actual entry without network. Keep default wildcard/receiver closed; manifest preparation is not authorization to create a function or open it.
- [x] Include shared config/native handler in critical coverage with existing90/90/90/85 requirements and update tooling coverage fixtures. Run focused and full verify, request independent review, record exact results. No deploy, rule change, push binding, image request, notification, workorder, purchase or publication.

Self-review: implements the already presented independent-entry/shared-mode design locally. Existing signed paths remain default. Optional native deployment requires explicit rollout authority, an independently provisioned common key, existing-proof inventory, exact rule/binding review, coordinated storage/client updates and fresh online evidence. None are implied by local green tests.

## Execution receipt

- Reused isolated codex/review-readiness workspace. Previous full baseline:61 files/1391 tests.
- Red checks observed before implementation: shared mapper13, handler24, optional manifest/entry3, coverage contract4 failures. Added genuine process.env compatibility and actual student API integration.
- Independent reviewer ran3 files/42 tests and inspected installed CLI dir resolution: no Critical/Important findings; no cloud calls or edits.
- Root full npm run verify exited0:64 files/1437 tests,14 critical modules, all remaining gates and dependency audits passed. Configured and unconfigured actual entry loading used an SDK transport substitute, not real cloud invocation.
- Optional template is not selected by default lifecycle tooling. No actual key, cloud function, permission, binding, database/storage, notification, workorder, purchase, review or publication change. Local work remains uncommitted. Rollout boundary: NATIVE-MEDIA-ROLLOUT.md.
