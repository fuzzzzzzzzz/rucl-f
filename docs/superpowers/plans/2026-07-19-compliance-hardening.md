# Personal Operator Compliance Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the personal-subject mini program clearly non-official, publish complete user rules and privacy information, execute data deletion requests, and provide usable complaint handling without collecting or verifying phone numbers.

**Architecture:** Keep all privileged operations in the existing `api` cloud function. Add one public notice page for operator identity and rules, expand the privacy page, and reuse the existing administrator console for deletion and complaint decisions. Publishing and claiming continue to use the existing profile and claim controls without phone-number verification.

**Tech Stack:** Native WeChat Mini Program, TypeScript, WXML/WXSS, WeChat Cloud Development, Vitest, ESLint, Prettier.

---

### Task 1: Compliance contract tests

**Files:**

- Modify: `tests/domain/deployment-contract.test.js`
- Create: `tests/domain/compliance.test.js`

- [ ] Add tests requiring a non-official notice, operator/contact/version text, absence of phone-number collection or gates, deletion execution, report feedback and report-based account restriction.
- [ ] Run `npx vitest run tests/domain/compliance.test.js tests/domain/deployment-contract.test.js` and verify the new assertions fail because the features do not exist.

### Task 2: Notice, privacy and user rules

**Files:**

- Create: `miniprogram/pages/notice/index.{json,ts,wxml,wxss}`
- Modify: `miniprogram/app.json`
- Modify: `miniprogram/pages/home/index.wxml`
- Modify: `miniprogram/pages/settings/index.{ts,wxml}`
- Modify: `miniprogram/pages/privacy/index.wxml`

- [ ] Add the personal operator notice using `张一凡（个人开发者）`, `fuz138886@gmail.com`, effective date `2026-07-19`, policy version `1.0` and a clear non-official statement.
- [ ] Document permitted use, prohibited conduct, complaint consequences, information categories, processors, retention, correction/deletion, minors and incident contact.
- [ ] Link the notice from Home and Settings and rerun the compliance tests.

### Task 3: Confirm no phone-number collection or gate

**Files:**

- Modify: `cloudfunctions/api/domain.js`
- Modify: `cloudfunctions/api/index.js`
- Modify: `miniprogram/shared/models.ts`
- Modify: `miniprogram/services/cloud-card-service.ts`
- Modify: `miniprogram/services/card-service.ts`
- Modify: `miniprogram/pages/settings/index.{ts,wxml}`

- [ ] Remove phone-number tests and collection copy left by the earlier proposal.
- [ ] Confirm there is no `getPhoneNumber` UI, verification action, or phone-based publish/claim gate.
- [ ] Document that this version does not collect phone numbers.

### Task 4: Real deletion and complaint handling

**Files:**

- Modify: `cloudfunctions/api/index.js`
- Modify: `cloudfunctions/scheduledCleanup/index.js`
- Modify: `miniprogram/services/cloud-card-service.ts`
- Modify: `miniprogram/services/card-service.ts`
- Modify: `miniprogram/pages/settings/index.{ts,wxml}`
- Modify: `miniprogram/pages/thanks-wall/index.{ts,wxml}`
- Modify: `miniprogram/pages/admin/index.{ts,wxml}`

- [ ] Validate reported records server-side, add general and thanks-wall reports, apply a daily limit, and notify reporters of the administrator decision.
- [ ] Let an administrator confirm a violation and block the responsible account; rejected reports must not block anyone.
- [ ] On an approved deletion request, refuse deletion while a claim is active, queue all retained photos, remove account/profile/content/message records, release the student-number binding, and retain only an anonymized deletion receipt.
- [ ] Add scheduled 60-day deletion for operation/security logs.

### Task 5: Verification and release handoff

**Files:**

- Modify mechanically formatted files selected by Prettier
- Modify: `docs/RELEASE-GATE.md`
- Modify: `docs/cloud-setup.md`

- [ ] Run `npm run format`, then `npm run verify` and `npm run security:check`.
- [ ] Confirm `git status` contains only intended changes and review the final diff.
- [ ] Open the WeChat mini-program filing page and provide the exact personal-subject filing steps without entering or exposing secrets.
