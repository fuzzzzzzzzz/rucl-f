# Recent Returns Implementation Plan

> Use subagent-driven-development with test-first implementation and independent specification/quality reviews. User has approved the design and requested continuous execution.

**Goal:** Implement the approved two-line recent-return feed with finder-controlled public identity.

**Architecture:** Read verified completed handovers through the existing authenticated API. Store consent only on the authenticated user's private record, project the minimum public fields at read time, and expose explicit consent controls in settings. Keep the home feed independent of account-summary errors.

**Tech Stack:** CloudBase Node.js functions, WeChat TypeScript/WXML/WXSS, Vitest.

## Task 1: Implementation and regression tests

- [x] Inspect current handover, user identity and deletion models and reuse their authorization and masking helpers.
- [x] Add failing tests in `tests/backend-api.test.js` for `listRecentReturns`, `getReturnRecognitionPreference`, `updateReturnRecognitionPreference`: anonymous default; masked/full consent; version and full-name acknowledgement; actor-scoped update; revoke; restricted/deleting/correcting accounts; no victim/ID leakage; only true completed records; descending date and at most five in thirty days. Run before implementing.
- [x] Implement a focused `cloudfunctions/api/recent-returns.js` projection/validation helper and narrow handler registrations. Add required index to the existing resource contract only if the actual query requires it. Do not create cloud resources.
- [x] Add types/service wrappers in `miniprogram/shared/models.ts` and `miniprogram/services/cloud-card-service.ts`; API preference contract uses `mode: 'anonymous' | 'masked' | 'full'`, `consentVersion: '2026-09-17-return-v1'`, and `fullNameConsent: true` only for full-name opt-in.
- [x] Add client tests before implementation for a China-time formatter, five fixed decorative captions, explicit modal confirmation, cancel/failure/no modal, old backend rejection and stale request clearing. Use `tests/recent-returns-client.test.ts` and a focused `miniprogram/shared/recent-returns.ts` helper.
- [x] Integrate two-line feed into `miniprogram/pages/home/index.ts`, `index.wxml`, `index.wxss` immediately before `brand-poster`, leaving `non-official-notice` last. Include loading, empty and unavailable/retry states; no production seed records.
- [x] Add default-anonymous setting and separate opt-in confirmation in `miniprogram/pages/settings/index.ts`, `index.wxml`, `index.wxss`; provide anonymous withdrawal without blocking behind new consent.
- [x] For full-name opt-in only, accept a freshly entered name after explicit consent and compare its server-generated HMAC against the current bound name. Store only the consented public name, remove it when changing to masked/anonymous, and test mismatch, cancellation and identity-change suppression. Existing binding is not official school verification.
- [x] Update user-visible privacy wording to describe optional public finder identity, prospective scope and withdrawal. Do not claim platform privacy settings were updated for this newly added feature.
- [x] Run targeted tests/typechecks and self-review, preserving all prior dirty changes. Commit only new feature files if safe; never stage unrelated docs.

## Task 2: Review and verification

- [x] Independent specification review; resolve discrepancies.
- [x] Independent quality/security review; resolve critical/important findings. Final focused rerun: 110/110 passed.
- [x] Run `npm run verify` and inspect actual exit status; see latest evidence in `docs/RECENT-RETURNS.md`.
- [x] Check simulator homepage module placement, old-backend unavailable state, removed slogan and final notice placement (2026-09-17).
- [ ] Check final settings UI and populated feed visually. On 2026-09-19 opening the developer tool twice failed with TLS connection error code 10; no real consent changed and no fake cloud records created. Handler and page-contract tests pass, but do not replace this visual check.
- [x] Record actual evidence and deployment limitations. No push, cloud deployment, paid-service activation or formal release without separate authorization.
