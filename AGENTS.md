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
- Explicit manual pause before a possible submit is cancellation, never a new
  mail incident. Preserve real incidents and all post-press uncertainty.
- Email alerts are optional. Disabled means no mail health requests or mail
  sends/retries; on-page pauses and unknown records remain in force. Retain old
  configured users' preference and honor an explicit opt-out with saved tokens.
- Reload recovery is bounded to two refreshes (three page attempts) per pending
  delivery before any sending input; challenge, account mismatch and ambiguity
  must not enter that retry branch. A possible send is never retried.
- Query budget exhaustion is a normal yield: persist completed queries and their
  queue, drain pending deliveries before resuming the next query. Respect rate
  limits, pause cancellation, configuration changes and no-send scan/queue modes.
- Local rate limits are waits, not pauses. Queue-only drains all pending work
  without searching; AUTO_LOOP repeats query/drain batches until pause or error.
  Persist wait plans, retain round counts, and never resume uncertain sends.
- Explicit unavailable-video evidence may skip matching pending recipients only
  before any possible submit; preserve sent/unknown/rate history and persist
  account/video tombstones. Missing UI or network errors are not deletion evidence.
- Reuse the same video document for remaining recipients; do not steal focus.
- Worker windows maximize in the background and worker tabs stay muted. New
  windows start blank and confirm muting before navigation. Repair reused
  workers without reloading the same video; never mute unrelated tabs.
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
