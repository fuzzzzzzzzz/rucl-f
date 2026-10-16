# Native Media Authentication Local Unit Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this single local unit task-by-task with tests before implementation. No cloud deployments, rule changes, push-binding updates, media calls, secrets or business writes.

**Goal:** Add a source-verifying native callback decoder that produces a mode-separated, in-process authenticated capability, without enabling native production processing.

**Architecture:** An isolated source verifier captures a trusted SDK getter and expected application/environment. It checks the real handler context separately from event data. The existing media-safety module retains its private capability ownership, with distinct signed and native registries; signed remains the default mode.

**Tech Stack:** CommonJS, Node built-ins, existing Vitest; no dependencies or new cloud functions.

## Task 1: Source verifier

Files: create cloudfunctions/api/media-native-source.js and tests/media-native-source.test.js. Do not modify index.js, handler.js, service configuration, deployment templates or security rules.

- [x] Write the first failing assertion and run it:

```js
const native = require('../cloudfunctions/api/media-native-source.js')
expect(typeof native.createNativeMediaSourceVerifier).toBe('function')
```

Use a presence assertion before require if the module is absent, so failure is an assertion rather than an unresolved import.

- [x] Implement createNativeMediaSourceVerifier(options), capturing own data fields getWXContext, expectedAppId and expectedEnvironmentId. Invalid configuration throws only invalid_native_source_config. Expected app is wx plus16 lowercase hex; environment is1–128 alphanumeric/underscore/hyphen characters. Do not evaluate getters or use mutable caller options after factory construction.
- [x] Returned verify(context) returns boolean synchronously. Obtain SDK data only through the captured server getter; require own SOURCE=wx_callback, APPID=expectedAppId and ENV=expectedEnvironmentId. Missing, inherited, accessor, thrown and non-record values deny. A rejected native Promise returned by a mistaken async getter must be observed and denied, not become an unhandled rejection.
- [x] Read only context.environment or context.environ from the actual handler argument. Prefer an own environment field when present; invalid/missing-value environment must not fall back to environ. Cap the encoded string at32768 UTF-8 bytes. JSON must decode to a plain record. For legacy environ, inspect semicolon-separated key=value entries only for TCB_SOURCE, WX_APPID, TCB_ENV and SCF_NAMESPACE; reject duplicate relevant keys, preserve exact values, and ignore unrelated entries without emitting them.
- [x] Require context TCB_SOURCE=wx_callback. If WX_APPID/TCB_ENV/SCF_NAMESPACE is supplied, require the matching expected value. Do not substitute context fields for missing SDK identity, read process.env as fallback, or call the SDK parser that mutates cached global context.
- [x] Cover success in both formats, each missing/wrong identity, client source, stale SDK source with current client context, inherited/accessor fields, malformed JSON and wrong prototypes, oversized UTF-8, duplicate relevant legacy keys, explicit invalid environment with a valid legacy fallback, configuration mutation, SDK throw/rejected Promise and no sensitive data in results/errors.

Run: node node_modules/vitest/vitest.mjs run tests/media-native-source.test.js. First fail must be observed; final exit0 required.

## Task 2: Mode-separated capability decoder

Files: modify cloudfunctions/api/media-safety.js; create tests/media-native-callback.test.js. Reuse Task1 verifier. Do not add an API action, receiver or persistence path.

- [x] Write a failing assertion before exporting the new factory:

```js
expect(typeof safety.createNativeMediaCallbackDecoder).toBe('function')
```

- [x] Add createNativeMediaCallbackDecoder(options), returning decode(event,context). Build the verifier at factory construction and capture expectedAppId. Source verification happens before inspecting event fields. Rejected source returns only {ok:false,reason:'invalid_source'}.
- [x] Safely copy selected own data properties from plain records. Top-level event has at most32 own keys; result/detail records at most8; detail has at most20 entries. Reject symbol keys and selected accessors without invoking them. Unknown fields are not copied, logged or used for authorization. Never serialize raw callback data to perform a size check.
- [x] Require MsgType=event, Event=wxa_media_check, numeric version2, appid matching expectedAppId and existing validTrace syntax/128-char limit. errcode must be a signed32 integer. Normalize optional result.suggest and detail entries using only own scalar fields; malformed nested records deny with invalid_event. Reuse existing classify so risky/review/error never become passed. Missing optional decision values produce error rather than approval.
- [x] Freeze {ok:true,event:{traceId,status}} and its event. Register only the original returned object in a new private authenticatedNativeCallbacks WeakMap; no raw register/mint function is exported.
- [x] Extend isAuthenticatedMediaCallbackForApp(decoded,appId,mode='signed'): signed checks the original registry, native checks the new registry, unknown modes return false. Existing calls remain signed by default. JSON clones and arbitrary matching plain objects remain unauthenticated in either mode.
- [x] transitionMediaTask may consume an original capability from either registry, preserving all existing trace/deadline/conflict checks. The existing service's default signed-mode app check must still reject native capabilities until an explicit future service-mode change.
- [x] Test genuine normalized pass/review/risky/error, correct application/mode separation, frozen minimal outputs, cloned/raw objects, wrong event/app/version/trace, oversized/nested malformed data, getters and source rejection before hostile event inspection. Retain the signed crypto tests unchanged and run the real native capability through transitionMediaTask, including mismatched trace and terminal conflict.

Run: node node_modules/vitest/vitest.mjs run tests/media-native-source.test.js tests/media-native-callback.test.js tests/media-safety.test.js tests/media-audit-service.test.js tests/media-audit-binding.test.js tests/media-callback-post.test.js.

## Task 3: Verify and record the exact boundary

- [x] Format only touched files; run focused ESLint, cloud TypeScript and syntax checks, then full existing offline verification for changed business modules. Do not lower coverage or change expectations merely to obtain green output.
- [x] Record red/green evidence and final counts. A local decoder is not a production receiver or proof of a complete native business workflow.
- [x] Current code remains signed by default and no deployed function imports the new factory. Subsequent work requires explicit service-mode/key configuration, isolated production entry, packaging, resource contracts and coordinated deployment. Do not mark the full goal complete or change permanent invoke rules in this unit.
- [x] Preserve the existing dirty documentation. No commit/push mixes in private evidence, actual callback IDs, student data or secrets; commit only after exact scope review and successful verification.

Self-review: this unit covers source verification and capability ownership from the proposal, deliberately leaving service/key/entry/deployment integration as named remaining work rather than pretending it is complete. Native source identity is not accepted from event, and no automatic fallback weakens signed mode.

## Local execution receipt

- Initial missing module/factory assertions failed before implementation. The hostile detail-array Proxy regression also failed before the decoder fix, then passed with zero Proxy reads.
- Independent reviewer rechecked the fix and direct configuration-mutation test:45/45 native tests passed; no remaining Critical/Important findings in this unit.
- Root full `npm run verify` after the fix exited0:60 test files/1363 tests; coverage and all remaining gates passed. Added native source to the12 critical runtime modules without lowering thresholds. Private diagnostic node:test files are excluded from Vitest, not business suites.
- Subsequent explicitly selected local service-mode work is tracked separately in2026-10-16-native-media-service.md. Default signed behavior and deployed entry points remain unchanged; neither unit is production rollout evidence. No commit, push, secrets or cloud changes were performed for these local units.
