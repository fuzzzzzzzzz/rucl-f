# Local Signed Media POST Processor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this bounded task with spec and quality review. Steps use checkbox syntax. No cloud operations, deployments, commits, purchases or public routes in this task.

**Goal:** Complete an offline-testable POST processor which rejects unverified messages and acknowledges only a verified message accepted by an injected consumer.

**Architecture:** Reuse decodeSafeModeMediaCallback from media-safety.js. A new pure CommonJS factory accepts normalized HTTP inputs; it does not assume the CloudBase gateway event shape, implement the GET handshake, or persist/approve photos. The verified decoder object remains intact for the consumer so existing transitionMediaTask authentication cannot be bypassed by serialization.

**Tech Stack:** Node built-ins, existing CommonJS media safety helper, Vitest4.1.11; no new dependencies.

## Task 1: Local implementation and tests

**Files:**

- Create cloudfunctions/api/media-callback-post.js.
- Create tests/media-callback-post.test.js.
- Read-only cloudfunctions/api/media-safety.js and tests/media-safety.test.js.
- Do not modify index.js, handler.js, package files, cloud resource contracts, environment credentials or other tests.

- [x] Write a failing assertion before the module exists, then verify failure is the missing bounded component rather than a syntax or dependency failure:

```js
import fs from 'node:fs'
import { expect, it } from 'vitest'
it('has the isolated signed POST processor', () => {
  expect(fs.existsSync(new URL('../cloudfunctions/api/media-callback-post.js', import.meta.url))).toBe(true)
})
```

Run with `C:/Program Files/nodejs/node.exe node_modules/vitest/vitest.mjs run tests/media-callback-post.test.js`.

- [x] Implement export createSignedMediaPostProcessor({config, now, accept, timeoutMs=5000}), returning async process(request).

Complete contract:

1. Factory checks config.token (3..32 alphanumeric), config.encodingAESKey (canonical43-char base64 decoding to32 bytes), config.appId (wx +16 lowercase hex), now and accept functions, integer timeoutMs in1..5000. Copy and freeze the three key strings. Invalid setup throws a fixed error without including supplied values. No real credentials in fixtures.
2. request is a normalized plain object: {method:'POST', rawQueryString:string, body:string, isBase64Encoded?:boolean}. It is NOT a deployable gateway binding. Other methods return405 without touching accept. Catch hostile inputs/accessors without exposing their error text.
3. Limit raw query to2048 UTF-8 bytes. Parse with URLSearchParams and reject duplicate keys. Require unique, nonempty msg_signature, timestamp, nonce strings; the existing decoder validates their final contract. Other query fields may be ignored and never become authentication or consumer input.
4. body must be a string. A raw body is capped at65536 UTF-8 bytes. With isBase64Encoded=true, require canonical standard base64, cap its encoded size before allocating, cap decoded bytes to65536, and decode strict UTF-8. The encoding marker can only be boolean or absent; do not guess body encoding.
5. Call decodeSafeModeMediaCallback({body, msg_signature, timestamp, nonce}, frozenConfig, {now:now()}). An invalid request or unsuccessful decode returns400/403 with a fixed, non-reflective body; must never call accept. Cryptographic parsing and5-minute freshness remain in the existing helper, not duplicated or weakened.
6. Pass the original successful decoder object to accept, not only event, a copy, JSON clone, or raw incoming fields. Invoke it once per process invocation. A consumer can call transitionMediaTask with this capability; this processor does not do so itself.
7. Acknowledge only exact boolean true from accept. false, undefined, arbitrary truthy values, thrown/rejected errors and timeouts return503 with fixed text. Bound accept by timeoutMs using a timer cleared in finally; there are no automatic retries. A timed-out consumer may still finish, so a future persistent consumer must be idempotent. Do not claim cancellation or cross-request deduplication.
8. Responses are {statusCode, headers:{'Content-Type':'text/plain; charset=utf-8'}, body}; successful acceptance returns200/'success'. Never include config, signature, ciphertext, task ID or provider error text in responses or logs. No console logging, SDK calls, file operations, business writes, new cloud functions or route registration.

- [x] Use real signed/encrypted synthetic messages in tests by reusing the existing fixture construction pattern; mock only injected consumer/time at the external boundary.
- [x] Cover valid raw and base64POST, consumer using original capability in transitionMediaTask, signed rejected/error outcomes not becoming passed, forged plaintext, signature/ciphertext tampering, expired timestamp, wrong app, duplicate query keys, missing fields, query/body size caps including multibyte UTF-8, bad/noncanonical base64, invalidUTF-8, encoding flag confusion, non-POST methods, invalid factory settings, mutation of caller-owned config, synchronous throw, rejection, false/truthy consumer result, timeout and timer cleanup. Invalid messages cause zero consumer calls. Assert no secret/provider text is reflected.
- [x] Run the new test and existing122 helper cases, fixing only the owned two files.
- [x] Format the owned files; run focused ESLint, cloud TypeScript check, cloud syntax check and the complete offline test suite. Preserve and report unrelated failures instead of silently broadening edits.

## Task 2: Independent verification and documentation

- [x] Dispatch read-only spec review against the complete contract above. Fix omissions in the two owned files, then re-review.
- [x] After spec approval, dispatch read-only quality review for parsing ambiguities, body allocation bounds, error leakage, callback capability preservation, bounded consumer behavior and maintainability.
- [x] Root independently reruns tests/checks and records exact counts and limits. Update the design with a clearly marked localPOST-only status.
- [x] Do not mark GET handshake, gateway mapping, public URL, database task/file binding, legacy files or production approval complete. No real HTTP endpoint or new live image test was authorized by this plan.

Final evidence:267 focused tests(145 new+122 existing),52 files/912 complete offline tests,cloud typecheck,focusedlint/format,and26-file cloud syntax all passed. Independentquality review approved after two clock-rejection findings were regression-tested and corrected. See docs/LOCAL-MEDIA-CALLBACK-2026-10-14.md. No commit,merge,push,cloud change or deployment.

## External boundary

User reports probably having no domain. Treat that as no usable production domain for now. Earlier service list returned noHTTP route; creation capability and costs are unverified. Local work proceeds without purchasing or changing current access rules. A public receiver, key provisioning, gateway configuration, message push mode changes and live tests need separate explicit scoped authorization and verified protocol/configuration.
