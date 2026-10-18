# Lost registration and reminder implementation plan

> Execute inline using executing-plans and test-driven-development. The user confirmed the registration-first proposal on 2026-10-18; preserve voluntary registration and do not register merely on search or notification permission.

**Goal:** A student deliberately registers a lost card, then grants one-time WeChat permission; a later matching post uses the existing server match/outbox delivery path.

**Architecture:** Keep the existing registration API, bound-student-number matching and notification sender. The client persists the registration before requesting subscription. Denial or unsupported authorization must leave registration intact and offer an explicit retry. Restore the retry entry for an active report, never an ended report. Keep claim notification behavior separate from registration.

**Tech stack:** WeChat TypeScript/WXML, Vitest, in-memory real-handler backend harness.

## Task 1: Register before requesting subscription

Files: `miniprogram/pages/lost/index.ts`, `miniprogram/pages/lost/index.wxml`, `tests/lost-registration-reminder-client.test.ts`.

- [x] Add and run failing page tests for registration-before-subscription, failed registration, rejection/unavailable outcomes, active-report restoration, ended-report suppression, lifecycle cancellation and no automatic registration on subscription-only taps.
- [x] On successful registration set `registered` and `activeLostReportId`, then request one-time permission. Show distinct registered-and-authorized versus registered-but-not-authorized outcomes. Preserve retry entry when authorization fails.
- [x] Reset stale eligibility during page restoration. Restore it only for a real active report; refuse standalone permission without a report or active claim. Label the registration action `登记找卡并开启提醒` and explain one-time permission and station-message fallback.
- [x] Run `node node_modules/vitest/vitest.mjs run tests/lost-registration-reminder-client.test.ts tests/self-service-pickup-client.test.ts tests/subscription.test.ts tests/client-page-hardening.test.ts`.

## Task 2: Verify later posts reach the existing sender

File: `tests/lost-registration-reminder-backend.test.js`.

- [x] With the real backend harness and fake notification provider, register an owner with no matching post, publish from another account with the same student number, and assert exactly one owner match message plus one accepted WeChat send. Assert different numbers and closed reports do not trigger matching.
- [x] Run targeted tests plus `npm run typecheck`, formatting/lint and `git diff --check`.
- [x] Report code changes and verification separately from upload and real-phone delivery. Do not create real registrations or send student notifications during local tests; no cloud deployment or formal publication in this task.

Verification: the client regression suite initially failed 9 of 11 cases, then passed after implementation. `npm run verify` exited 0 with 70 test files and 1537 passing tests, including 18 new reminder cases and the separately requested contact-email update. No real notifications were sent and no cloud functions or mini-program packages were deployed in this task.
