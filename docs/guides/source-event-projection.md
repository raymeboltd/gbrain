# Source-event projection

Source-event projection is the default-off bridge between acquired raw signals
and maintained brain knowledge. Autopilot dispatches it; do not add a second
cron.

For each approved source it evaluates material message, email, calendar,
meeting, conversation and Slack pages, plus pages explicitly marked
`source_event: true`. It resolves existing entity pages through the active
schema pack, writes one private canonical artifact, runs the facts backstop
inside the resolved-entity allowlist and stores review-only task/project
candidates. A durable receipt records applied, partial, skipped, review or
failed with explicit causes.

It deliberately does not create entities, rewrite compiled truth or write a
task file. Unknown and ambiguous identities stay skipped/review. Dream output
and source-event artifacts cannot recurse into intake.

## Prerequisites

- The target source is registered, active and filesystem-canonical.
- Write-through is enabled and resolves to that source's local path.
- The source has `autopilot_sync: true`.
- Every producer supplies an immutable provider identity such as
  `message_id`, `event_id`, `note_id`, `thread_id`, `capture_id`, or transcript
  `session_id` + part metadata.
- The active schema pack marks every safe target type `linkable: true`.
- Automatic facts require the normal facts extraction provider/config. Without
  it the relationship artifact still lands and the receipt is honestly
  partial.

## Enable one source

Set the allowlist before the switch:

```bash
gbrain config set source_events.source_ids personal
gbrain config set source_events.enabled true
```

Autopilot submits one source-scoped, single-flight job per enabled source after
producer dispatch. The source's own `autopilot_sync: false` breaker blocks both
sync and projection.

Unseen event revisions run before prior review/error retries. An unchanged
review or error receipt cools down for 24 hours before becoming eligible again;
a changed content hash or processor version is eligible immediately. This keeps
an unresolved review backlog from starving newly ingested signals while still
retrying ambiguity after entity/schema repair.

## Roll back scheduling

```bash
gbrain config set source_events.enabled false
```

This stops new projection. Existing private artifacts remain as audit evidence;
source-page deletion retracts their active relationships and facts. Production
activation should first run a bounded supervised canary, inspect receipts for
`silent_skips=0`, and prove remote reads cannot see the artifact or backlink.
