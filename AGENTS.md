# Repository guide for coding agents

Project: 司凤转发（dead-mom sharing), repository slug dead-mom-sharing.

Read README.md for installation and behavior, docs/AI_GUIDE.md for operator tasks,
docs/DEVELOPMENT.md for architecture and commands, and TESTING.md for evidence limits.

## Scope and local data

- Preserve existing .env, data/, browser profiles, logs and user delivery records.
- Never print credentials, cookies, raw chat content or the real .env file.
- Use synthetic fixtures. Offline tests do not require accounts or SMTP secrets.
- Real card sending, test emails, and resolving uncertain deliveries require the
  corresponding user authorization or an explicit user verification result.
- Do not stop an existing local mail service merely to free a test port.

## Behavior invariants

- Keep account/video/friend IDs as strings. Preserve strict recipient identity,
  deduplication, rate limits, queue order, mail readiness and pause cancellation.
- Persist sending reservation before submitting input. Arm a task-bound receipt
  observer before the actual press; validate the live control for the same UID.
- Post-press failures remain unknown. Never retry a possible send automatically.
- Reload recovery is bounded to one first-card preparation retry per cycle;
  challenge, account mismatch and ambiguity must not enter that retry branch.
- Reuse the same video document for remaining recipients; do not steal focus.
- Do not add CAPTCHA bypass, direct private-message APIs or credential export.

## Validation and distribution

Run npm test, Python unittest discovery and npm run docs:check as appropriate.
Use isolated Chromium fixtures for browser changes, never the daily profile.
Keep manifest.version_name, background BUILD and options UI_BUILD consistent.
After extension edits, explain the necessary extension reload and settings refresh.

Public distribution uses scripts/release-files.mjs. Update docs and screenshots
when the UI changes. Package with npm run package and npm run package:github;
verify with npm run release:verify. Keep personal handoffs and runtime files out
of the GitHub export. GitHub Actions passing is not real-platform acceptance.
