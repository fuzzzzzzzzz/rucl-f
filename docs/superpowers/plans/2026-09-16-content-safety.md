# Content Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Track verified results with checkboxes.

**Goal:** Close user-visible text moderation gaps and document remaining image/integration evidence without falsely declaring release readiness.

**Architecture:** Use the existing server-side WeChat `msgSecCheck` v2 transport through an isolated, fail-closed text helper. Normalize the exact values that will be stored, check before transactions and file-token consumption, and preserve private complaint/deletion channels. Images require a separately verified transport/result pipeline; do not deploy an assumed-success asynchronous submission or a new paid service.

**Tech Stack:** Node.js CommonJS cloud functions, wx-server-sdk 4.0.2, Vitest.

## Task 1: Text verdict and ingress guards

Files: create `cloudfunctions/api/content-safety.js`, `tests/content-safety.test.js`; modify `cloudfunctions/api/handler.js`, `tests/backend-api.test.js`.

- [x] Baseline: `npm test` — 36 files / 308 tests passed before changes.
- [x] Write and run failing tests for pass, risky/review, missing verdict/API, nonzero error code, exceptions, and timeout. Example contract:

```js
it('does not accept an absent verdict', async () => {
  await expect(
    requireSafeText({ openapi: { security: { msgSecCheck: async () => ({}) } } }, 'actor', ['library']),
  ).rejects.toThrow('内容')
})
```

- [x] Implement `requireSafeText(cloud, openid, values, scene = 3)`: omit empty values, bound combined input below 2500 characters, call the existing API with authenticated OpenID and version 2, require explicit `result.suggest === 'pass'` and numeric zero `errcode`/`errCode` with no conflicting code, reject missing API/errors/malformed results/timeout. Do not log raw content or provider exception payloads. Use a timeout below the API function's 15-second execution limit and clear its timer on settle.
- [x] Before any business write or upload-token consumption, check exact normalized fields in `saveUserProfile` (name, scene 1), `createFoundCard` (name, eight location strings, privateFeature), `createLostReport` (locationDescription/privateFeature), and `transferFoundCardToOfficial` (four location strings).
- [x] Refactor `screenThanks` onto the same verdict helper, scene 2. Preserve local validation and the established semantics: rejected thanks text is discarded, but a valid handover is not rolled back.
- [x] Keep server-defined enums and student IDs out of moderation payloads. Do not change 10-digit IDs, image quality/storage settings, private complaint/deletion submission, or admin review workflows.
- [x] Add integration cases proving rejected submissions do not change business records, consume uploadedFiles tokens, or send messages; approved submissions still work. Ensure forbidden actors never call moderation.
- [x] Run focused tests, lint/cloud typecheck, then independent specification and quality review; resolve findings. Commit `79f254a`; both independent reviews passed, each executing 85 targeted tests. Existing authentication bootstrap is outside the no-business-write claim.

## Task 2: Verify and record precise remaining gates

Files: modify `docs/NON-DEVICE-READINESS-2026-09-15.md`; add `docs/CONTENT-SAFETY-ACCEPTANCE.md`.

- [x] Run `npm run verify` and retain exact outcome, not extrapolated baseline results. Full gate passed on 2026-09-17; new moderation coverage correction then passed 398 tests, six critical modules.
- [x] Record covered text actions, private-rights-channel exclusions, existing legacy records, missing image moderation and real API success evidence. Never mark unchecked gates passed.
- [x] Establish the supported image API contract before image implementation/deployment. Current official v2 requires an asynchronous callback; callback configuration remains an external prerequisite. Do not mistake this documented contract for an implemented or deployed pipeline.
- [x] Record manual backend evidence still needed: privacy effective/UGC saved status, actual content API call evidence, search restriction notice, subscription template fields, credential rotation confirmation. Do not request credentials themselves.
- [x] Do not submit review, publish, buy a plan, switch PRIVATE storage, or upload a build claiming all gates complete while blockers remain. This pass retained all deployment/upload blocks.

## Task 3: Require content-safety evidence before review

Files: modify `scripts/review-evidence.mjs`, `tests/review-evidence.test.js`, `docs/RELEASE-GATE.md`.

- [x] Add a regression independent of the current `REVIEW_CHECKS` list:

```js
it('requires content safety evidence even when other evidence is complete', () => {
  const { evidence, expected } = fixture()
  delete evidence.checks.contentSafety
  expect(() => validateReviewEvidence(evidence, expected)).toThrow('contentSafety')
})
```

- [x] Run `npx vitest run tests/review-evidence.test.js` and observe this regression fail (1 failed / 24 passed).
- [x] Add `'contentSafety'` to `REVIEW_CHECKS`. Do not loosen any existing evidence requirement or create a fake evidence file.
- [x] Update release-gate documentation to require real text API evidence, image result/callback/authorization coverage and matching UGC declaration. Clarify that text-only local tests cannot pass this gate.
- [x] Rerun focused tests and perform specification and code-quality review: 26 passed; both independent reviews passed. Full verification is tracked in Task 2.

## Task 4: Explicit notice before the expanded text processing

Files: create `miniprogram/shared/content-safety-consent.ts` and `tests/content-safety-consent.test.ts`; modify `miniprogram/services/cloud-card-service.ts`, `miniprogram/pages/privacy/index.wxml`, `cloudfunctions/api/handler.js`, `tests/backend-api.test.js`.

- [x] Test first: the four newly moderated actions must not call `wx.cloud.callFunction` before explicit modal confirmation; cancellation, missing modal API or modal failure must reject without business transmission. Reads, complaints and deletion requests must not prompt. Caller-supplied version markers must not bypass the prompt.
- [x] Implement one request-scoped confirmation, without persistent consent caching: disclose name/location/private-feature text and OpenID sent to WeChat for content screening, no student number. Only explicit `confirm === true` returns `2026-09-16-text-v1`.
- [x] On each guarded `callCloudApi`, confirm before transmitting its input and attach `contentSafetyConsentVersion`. Do not let a forged input marker bypass the client prompt. Keep request errors distinct from a user declining.
- [x] Test first and enforce the same marker after normal backend authorization but before the four business handlers run. Missing/outdated markers are rejected without calling moderation or writing task records/consuming upload tokens. This version marker records protocol acknowledgment, not cryptographic evidence or a substitute for platform privacy settings. Existing authentication bootstrap remains allowed.
- [x] Update the user-visible privacy description from thanks-only to the actual expanded fields and processing purpose. Do not claim images are moderated. Document that old clients must update; no deployment into the shared environment before readiness and release coordination.
- [x] Tests must exercise the real service function and raw backend handler. Existing business fixtures may represent the current client, but missing-marker tests must bypass that fixture convenience and use raw input.
- [x] Run full tests and typechecks; independent review before handoff. Commits `80d1084`, `e9f7501`; specification and quality reviews passed, 92 targeted tests independently passed. Four-character button constraint added as regression.

## Coverage correction and unresolved integration

- [x] Observed new fixed-path regression fail before adding `content-safety.js` to V8 collection and the critical-module contract; no previous threshold or exclusion was weakened. The module is now actually collected with 100% coverage.
- [ ] Image submission/result receiver and guarded image lifecycle: blocked on existing message-push configuration and a supported, authorized receiving endpoint. No speculative implementation or paid resource was created.
- [ ] Real platform API evidence, privacy/UGC effective records and coordinated deployment/upload: still blocked; this checklist does not represent release approval.
- [ ] New Windows/Linux CI: requires publishing the local branch; user approval requested, old successful runs are not evidence for this patch.
