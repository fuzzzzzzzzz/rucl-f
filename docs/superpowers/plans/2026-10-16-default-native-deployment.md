# Default Native Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Align local default deployment and resource checks with the verified native callback without changing any live resource.

**Architecture:** Five deployment targets share four physical cloud packages. The API and native receiver use the same API package but distinct handlers, and only the fixed callback has a platform-event exception to the default invocation policy. A pure local validator prevents configuration drift; deployment and readback retain the same resource contract.

**Tech Stack:** Node.js ESM, CloudBase JSON configuration, Vitest, existing Windows/Linux CI.

---

## Task 1: Default native deployment contract and regression tests

**Files:**

- Modify: `cloudbaserc.json`, `security/cloud-resource-contract.json`, `scripts/check-cloud-resources.mjs`.
- Create: `scripts/native-deployment-contract.mjs`, `tests/native-deployment-contract.test.js`.
- Modify tests: `tests/media-native-package.test.js`, `tests/cloud-deployment-package.test.js`, `tests/engineering-tooling.test.js`, `tests/engineering-release-contract.test.js`, `tests/domain/deployment-contract.test.js`.
- Update affected default-deployment instructions in `docs/cloud-setup.md` and `docs/NATIVE-MEDIA-ROLLOUT.md` without overwriting historical evidence.

- [ ] Write failing default-configuration assertions first. Replace the old “receiver absent” assertion with exact equality to the already verified two-target native template:

```js
for (const target of nativeConfig.functions) {
  expect(config.functions.find((entry) => entry.name === target.name)).toEqual(target)
}
expect(contract.functions.mediaSafetyCallback).toEqual({
  invoke: true,
  clientCallable: false,
  callbackEvent: 'wxa_media_check',
})
expect(contract.functionDefaults).toEqual({ '*': { invoke: false } })
```

- [ ] Run `node node_modules/vitest/vitest.mjs run tests/media-native-package.test.js` and retain the expected missing-default-target failure before modifying configuration.
- [ ] In `cloudbaserc.json`, replace only the API entry with the native template API entry and append the template `mediaSafetyCallback` entry. Keep deletion, OCR, cleanup and their triggers/variables byte-equivalent as parsed objects. Add the exact callback contract shown above. Do not create another physical package.
- [ ] Add a pure validator with this interface:

```js
export function validateNativeDeployment({ cloudbaseConfig, contract, nativeConfig, appId }) {
  // Returns undefined only for a valid contract; throws Error on each violation.
}
```

Use `isDeepStrictEqual` from `node:util` for exact objects. Check both required targets exist exactly once, share `./cloudfunctions/api`, use Event/Nodejs20.19/256MB/15s/installDependency=false, and have handlers `index.main` / `media-native-entry.main`. Reject triggers, permissions and aclRule on these targets. Require literal native mode, the project AppID, the selected environment ID, and `{{env.MEDIA_INTEGRITY_KEY}}`. API also requires exactly the three existing business placeholders; receiver must have exactly the four native variables and no business secrets. Require two-target template environment/functionRoot consistency and exact equality of its targets to the default targets. Reject missing or duplicate targets and template drift.

The callback contract must exactly match the object above. Every other function must lack `callbackEvent`; client-callable entries must retain the authenticated/non-anonymous rule, and non-client-callable entries must remain invoke=false. Wildcard stays false. No arbitrary callback-marker exception is accepted.

- [ ] Before implementing the validator, add tests for valid deployment and each malformed variant: wrong handler, code directory, runtime, mode, AppID, environment, plaintext/missing key, receiver business secret, trigger, extra permissions, duplicate/missing callback, wrong callback event, ordinary task invoke=true, renamed callback, wildcard=true, and drift in the two-target template. Observe these tests fail for the absent validation behavior.
- [ ] Implement the validator and invoke it from `check-cloud-resources.mjs` with the current config, contract, two-target template and `project.config.json` AppID. Remove the obsolete signed TOKEN/AES placeholder requirement and replace the old blanket callback rejection with the explicit validator. Retain collection/index/storage/migration checks unchanged.
- [ ] Resolve deployment-package test paths from the explicit `dir`, or from `functionRoot/name` when absent:

```js
const relativeDirectory = target.dir || `${config.functionRoot}/${target.name}`
const base = pathToFileURL(resolve(root, relativeDirectory) + sep)
```

Keep real vendored archive and installed dependency checks for every target. Keep `release-manifest.json` and dependency-lock inventory at four physical cloud packages; do not invent a callback folder. Update the two old four-target assertions to five deployment targets.

- [ ] Run `node node_modules/vitest/vitest.mjs run tests/native-deployment-contract.test.js tests/media-native-package.test.js tests/cloud-deployment-package.test.js tests/engineering-tooling.test.js tests/engineering-release-contract.test.js tests/domain/deployment-contract.test.js` and `npm run resources:check`; require exit 0, now covering five functions.
- [ ] Update instructions: default configuration is native; HTTP implementation remains available but not the default. The two-target file is a narrow deployment view, not a separate mode. Explain that the callback's transport permission is open while its existing runtime source checks reject client-forged events. Do not describe any new live deployment as performed.
- [ ] Run formatter on changed files, `npm run verify`, independent specification review, then code-quality review. Fix Important/Critical findings before proceeding; retain real failure and success outputs.
- [ ] Commit only this task's files. Push the existing branch using the previously approved repository workflow and verify matching Windows/Linux CI. No merge, review submission or publication.

## Scope and self-review

This task contains no cloud mutation, new image request, notification delivery, timer change, key rotation or storage switch. The private privacy-render diagnostics are separate evidence, not part of this code change. Configuration, validation, positive/negative tests, shared-package resolution and deployment documentation are all covered above. Existing signed callback runtime code is preserved. No release gate is relaxed, and phone acceptance remains pending.
