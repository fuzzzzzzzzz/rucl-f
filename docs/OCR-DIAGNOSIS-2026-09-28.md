# OCR timeout investigation — 2026-09-28

## Observed evidence

- Native cloud console, cloud1, cloud functions logs: processCardImage returned no records for the last 24 hours when queried at approximately 21:12.
- The api invocation at 13:39:44 returned an uploadToken successfully in approximately 198 ms. No token or personal data is copied here.
- This supports investigating the client-to-OCR invocation boundary after authorization. It does not prove a particular network or SDK defect, nor rule out log visibility issues.
- No paid service, access rule, cloud function deployment, or formal release was changed during this investigation.

## Diagnostic change

The client now reports cloud readiness, photo preparation, photo reading, authorization, request/recognition wait, and completion. Errors preserve the last stage. Late progress notifications are ignored after timeout or page departure. No image, token, identity, or file path is included in stage messages.

## Verification

- The new stage assertions failed before implementation.
- Targeted tests: 32 passed.
- Full tests: 43 files, 469 tests passed.
- TypeScript check and git diff whitespace check passed.
- OCR success on the actual device remains unverified. Stage diagnostics are not a root-cause fix.
