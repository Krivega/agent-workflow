---
name: architecture-decision-record
description: Create, revise, relate, or review architecture decision records in this repository. Use when a task proposes a durable technology, module boundary, storage or contract choice, changes a cross-cutting user flow, supersedes an accepted decision, asks whether an ADR is needed, or modifies docs/design/decisions. Do not create an ADR for a local implementation that follows an accepted decision.
---

# Architecture decision records

Follow the repository's canonical policy in
[`docs/design/decisions/README.md`](https://github.com/Krivega/agent-workflow/blob/main/docs/design/decisions/README.md). Treat that policy and
[`_template.md`](https://github.com/Krivega/agent-workflow/blob/main/docs/design/decisions/_template.md) as authoritative if this skill and the
documents diverge.

## Decide whether an ADR is needed

1. Identify the observable change, its owner, affected boundaries, and expected lifetime.
2. Search the ADR index and linked records before proposing a new decision.
3. Create an ADR only for a substantial durable choice, a new cross-cutting contract, or a change
   to the meaning of an accepted ADR.
4. Update tests, contracts, architecture documentation, or an ExecPlan instead when the task only
   implements an accepted choice or fixes code that deviates from it.

Ask the user before choosing between materially different behaviors, authorities, irreversible
effects, or historical interpretations. Continue independent work that does not depend on that
choice.

## Create or revise a proposal

1. Copy `_template.md` to the next unused `NNNN-short-name.md`; never reuse a number.
2. State the proposed decision as an action in the title.
3. Default `Status` to `proposed`. A new ADR may start as `accepted` only when the user has already
   explicitly accepted that decision. Record that acceptance, its author, date and exact scope in
   the Markdown-linked, verifiable `Decision basis`; no intermediate proposal commit or merge is
   required. Record the functional `Owner`; local targets and anchors must exist, while external
   targets use `https://`. A proposal or an agent recommendation is not acceptance.
4. Describe the problem and constraints before alternatives. Mark the proposed option with
   `**Выбрано:**`; do not invent alternatives or evidence.
5. Make the decision, rationale, positive and negative consequences, proof, and review trigger
   concrete enough for a later agent to act without guessing.
6. Add typed links for replacement or extension and the required backlink. Use identical scope text
   after `—` in both directions. Use `Related` only for an informational connection.
7. Add the record and its machine status to the ordered index and update affected canonical
   documents in the same change.

An agent may draft and refine `proposed`, but must not change it to `accepted` without an explicit,
verifiable user or team decision. Adding a new ADR directly as `accepted` requires explicit user
acceptance under the canonical policy. Link validation checks structure and local targets, not
the truth of human consent; inspect the decision source. Acceptance does not prove implementation
or deployment. Existing accepted and superseded records retain all immutability protections.

## Change an accepted decision

Do not rewrite the core meaning of an `accepted` or `superseded` ADR. Create a new `proposed` ADR,
state the exact relationship, and preserve the old rationale.

- Use `Supersedes` only for full replacement. Once the replacement is accepted, mark the old ADR
  `superseded` and link both directions. An old ADR has only one `Superseded by` target.
- Use `Partially supersedes` for an exact limited scope; keep the old ADR `accepted` and link both
  directions.
- Use `Extends` for an additive decision; keep the earlier ADR `accepted` and link both directions.
- Put implementation discoveries in the owning test, contract, runbook, traceability row,
  feedback record, or ExecPlan unless they change the decision itself.

## Verify

Run `yarn lint:adr`, then the applicable repository validation level. The check includes committed
changes against the target branch; use `ADR_BASE_REF=<ref> yarn lint:adr` for another
target. CI requires an explicit trusted target. The protected title and body remain unchanged, except for the canonical policy’s verified
local-link relocation to the identical primary bytes from the trusted Git base;
record typo or historical link corrections in the current owning document with a link to the ADR.
`ADR_MAINTENANCE_REASON` is only a log note and never permits an edit. Report separately what local
checks prove and what still requires a physical
device, user acceptance, external service, or publication.

The adaptation source and licensing notes are recorded in
[`references/upstream-attribution.md`](references/upstream-attribution.md).
