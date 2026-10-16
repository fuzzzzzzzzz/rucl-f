# Native Media Service Mode Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for this local-only continuation of the native callback proposal. Do not change deployed entry points, secrets, permissions, bindings or business records.

**Goal:** Let an explicitly configured local service consume native decoder capabilities using an independent integrity key, while preserving the existing signed default.

**Architecture:** Capture a validated mode, application and key once in the existing service factory. Separate native receipt/approval MAC domains from legacy signed domains; never accept the other decoder's capabilities. Reuse the existing transactional task/file binding and lifecycle without a new persistence path.

**Tech Stack:** CommonJS, Node crypto/util, Vitest and the existing transactional database test double.

## Task 1: Red tests

Files: create `tests/media-native-service.test.js`. Import the real service, native decoder and `MediaTransactionDatabase`; use only synthetic application, user and file identifiers. No provider network calls.

- [x] Create a native configuration with this exact public shape (the bytes below are a synthetic test fixture, not a deployed key):

```js
const config = {
  mode: 'native',
  appId: 'wx0123456789abcdef',
  integrityKey: Buffer.alloc(32, 17).toString('base64'),
}
```

- [x] Assert `configured === true`, begin a real in-memory task, decode a callback using the trusted-context test fixture, accept it and consume only the matching owner/file/purpose. Run the new test and observe failure because the existing service requires HTTP token/AES configuration.
- [x] Add native early-arrival, duplicate/conflict, rejected/review/error, expiry, raw/clone/wrong-application rejection tests. Invalid or mixed mode/key configurations must disable submission and database writes. Mutating the original configuration after construction must not change the captured settings.
- [x] Use the same synthetic 32 bytes for native integrity and signed AES fixtures to prove MAC domain separation rather than merely different keys. A signed service cannot consume native approval/receipt and a native service cannot consume signed approval/receipt. Keep the old signed tests unchanged.

## Task 2: Minimal implementation

File: modify `cloudfunctions/api/media-audit-service.js` only. No changes to API handler, cloud index, process environment, templates or resource rules.

- [x] Replace `configuredKey` with a captured-settings resolver. Plain own data properties only; reject Proxy/getters/non-records safely. Missing mode retains `signed`; only exact `signed` or `native` is accepted. Signed requires the existing token/canonical 43-character AES key and rejects an integrityKey field. Native requires a canonical base64 encoding of exactly32 bytes, and rejects token/encodingAESKey fields even if they look valid. Invalid settings return null and preserve `media_unconfigured` behavior.
- [x] Use the captured application/key/mode, never reread mutable caller configuration. Existing signed prefixes remain byte-for-byte unchanged. The only new MAC prefixes are:

```js
mode === 'native' ? 'media-approval-native-v1' : 'media-approval-v1'
mode === 'native' ? 'media-receipt-native-v1' : 'media-receipt-v1'
```

- [x] Require the captured mode before any callback transaction:

```js
isAuthenticatedMediaCallbackForApp(decoded, appId, mode)
```

- [x] Run new service tests plus existing native/signed/binding/API tests. Fix implementation rather than weakening assertions.

## Task 3: Verification and boundary

- [x] Request independent read-only review of mode/key validation, cross-mode rejection and transaction behavior. Reproduce any reported concrete issue with a failing regression before fixing it.
- [x] Format touched files and run `npm run verify`; retain the current coverage thresholds and all existing signed tests.
- [x] Record exact passing counts and the fact that native mode is still not selected by any production entry. No credentials are generated, no historical proofs are migrated, and no production rollout is claimed. Migration must inspect existing records before changing mode or key.

Self-review: this task implements proposal requirements4–6 locally. Production entry/configuration/packaging, key provisioning, migration evidence, resource rules, live binding, coordinated deployment and final physical-device acceptance remain outside this task. Ordinary callback objects do not become authenticated by choosing a mode.

## Local execution receipt

- Before implementation, the new suite failed12 cases, including configured=false for native settings; the synthetic file fixture was corrected to the existing JPG contract and the same12 behavior failures remained.
- Minimal implementation passed3 files/126 tests. Independent review passed4 files/149 tests with no Critical/Important findings. Added a pristine-service proof check after configuration mutation and both early cross-mode receipt rejection directions: final new suite28/28.
- First full run passed61 files/1389 tests but failed the final dependency audit response JSON. A separate valid v2 audit returned zero vulnerabilities. Final full npm run verify after all additions exited0:61 files/1391 tests,12 critical modules, all dependency audits zero, all remaining gates passed; no requirements were lowered.
- Service coverage: statements95.44%, branches94.63%, functions98.14%, lines96.77%. No actual secrets, deployed entry, environment configuration, live rules, binding, notification or media request changed. Work remains uncommitted in the existing isolated branch; no merge/push/publication.
