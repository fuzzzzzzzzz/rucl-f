# Campus Card Guardian Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an importable native WeChat mini program MVP with privacy-safe matching, claims, handover, admin review, and CloudBase integration boundaries.

**Architecture:** Shared TypeScript domain modules implement deterministic masking, matching, claim review, and state transitions. Mini-program pages consume those modules through services; CloudBase functions own secrets, OCR, persistence, and authorization.

**Tech Stack:** WeChat Mini Program, TypeScript, WXSS, CloudBase, Vitest, ESLint, Prettier.

---

### Task 1: Project foundation

- [ ] Create mini-program manifests, TypeScript configuration, linting, formatting, test configuration, privacy declarations, and setup documentation.
- [ ] Import the Stitch ZIP into `design-reference/` without using its CDN code at runtime.
- [ ] Verify the project can be opened by WeChat DevTools with a placeholder AppID.

### Task 2: Privacy and matching domain

- [ ] Write failing tests for name/student-number masking, match scoring, duplicate detection, review decisions, and state transitions.
- [ ] Run `npm test` and confirm failures are caused by missing domain modules.
- [ ] Implement focused modules under `miniprogram/shared/` and rerun tests until green.

### Task 3: Mini-program user flows

- [ ] Implement reusable neo-brutalist components and the Home, Found Card, Lost Card, Claims, Messages, Profile, and Admin pages.
- [ ] Connect forms to a typed service layer with local demo fallback while no CloudBase environment is configured.
- [ ] Add accessible loading, empty, error, privacy, and OCR fallback states.

### Task 4: Cloud functions and security boundaries

- [ ] Implement login, record creation, matching, claim review, handover, image processing contract, and scheduled cleanup functions.
- [ ] Enforce server-side roles, campus scope, HMAC identifiers, rate limits, minimal projections, and audit records.
- [ ] Keep OCR and optional AI credentials exclusively in cloud function environment variables.

### Task 5: Verification and handoff

- [ ] Run unit tests, TypeScript checking, ESLint, formatting checks, and the production build validation command.
- [ ] Inspect the final tree for secrets and full student-number fixtures.
- [ ] Document AppID, CloudBase, OCR, subscription-message, privacy, and experience-build steps for the user.
