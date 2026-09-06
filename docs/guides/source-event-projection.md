# Source-event projection

Source-event projection is the default-off bridge between acquired raw signals
and maintained brain knowledge. Autopilot dispatches it; do not add a second
cron.

For each approved source it evaluates material message, email, calendar,
meeting, conversation and Slack pages, plus pages explicitly marked
`source_event: true`. It resolves existing entity pages through the active
schema pack, writes one private canonical artifact, runs the facts backstop
inside the resolved-entity allowlist and stores review-only task/project
candidates. Conversation extraction uses a deterministic role-aware view while
the source page and raw content hash remain unchanged. A durable receipt records
applied, partial, skipped, review or failed with explicit causes.

Automatic intake does not create entities, rewrite compiled truth or write a
task file. Compiled-truth changes use the separate explicit candidate-review
workflow; task candidates remain review-only until an authorized consumer acts.
Unknown and ambiguous identities stay skipped/review. Dream output and
source-event artifacts cannot recurse into intake. See the
[system-of-record contract](../architecture/system-of-record.md) and
[takes/facts distinction](../takes-vs-facts.md) for storage and attribution.

## Prerequisites

- The target source is registered, active and filesystem-canonical.
- Write-through is enabled and resolves to that source's local path.
- The source has `autopilot_sync: true`.
- Every producer supplies an immutable provider identity such as
  `message_id`, `event_id`, `note_id`, `thread_id`, `capture_id`, or transcript
  `session_id` + part metadata.
- For native conversations, a valid timezone-bearing ISO `started_at` can
  attest source time when immutable provider identity is present. Supported
  formats are `claude-code`, `codex`, `openclaw`, `hermes`, `grok`, `chatgpt`
  and `claude-export`. An explicit `event_date`, `date` or `published` date
  takes priority. Missing, invalid or unknown-provider start times fall back
  to the existing effective/update date; inferred dates are not attestations.
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

The conversation parser labels user, assistant-context and explicit tool
messages without a model call. Quoted or fenced examples stay literal. Observer
conversations contribute nested primary-session requests and tool evidence,
not outer prompts or observer summaries. If roles or primary evidence cannot be
established, extraction is withheld and the receipt reports review. Previously
active projections from that event are retracted through the canonical path;
raw source material and revision history remain available. A changed normalized
view or its time attestation creates a replacement conversation revision.

While projection is committing, `extract_facts` preserves pending rows even
when the new fence is on disk but the imported page body is still old. Pending
markers survive an interrupted projector. The reconciler defers on an active
source projection lock or changed page/fact snapshot; other sources can proceed.
Its short mutation lock does not include provider embedding calls. Inspect
`SOURCE_EVENT_FACT_COMMIT_PENDING` and `SOURCE_EVENT_FACT_RECONCILE_DRIFT`
warnings and the event receipt before retrying; do not delete markers to force
progress. An exact finalized/retracted canonical fence row permits clearing its
stale indexed marker.

Normal fence reconciliation preserves matching fact IDs and source provenance
so later correction/retraction still finds the same facts. Changed claims or
sources get new identities; ambiguous duplicate IDs produce
`FACT_RECONCILE_AMBIGUOUS_IDENTITY` and leave existing facts intact.

## Roll back scheduling

```bash
gbrain config set source_events.enabled false
```

This stops new projection. Existing private artifacts remain as audit evidence;
source-page deletion retracts their active relationships and facts. Production
activation should first run a bounded supervised canary, inspect receipts for
`silent_skips=0`, and prove remote reads cannot see the artifact or backlink.
