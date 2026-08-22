# ADR-0003 — Evidence store and the citation contract

Status: Accepted · 2026-08-22

## Context

The brief's reviewer test is: "Spot-check one analysis and trust where its claims
came from." It also names "claims in memos with no traceable source" as an
anti-pattern. This has to be structural, not a prompt asking nicely for citations.

## Options

1. **Prompt the model to include URLs.** Zero infrastructure. Also zero
   guarantee — models produce plausible URLs that 404, and nothing catches it.
2. **Post-hoc verification.** Re-fetch each cited URL and check the claim. Slow,
   expensive, and "does this page support this claim" is itself an LLM call that
   can be wrong.
3. **Closed-world citation.** Retrieval writes numbered evidence records first.
   The model only ever sees those records and may only cite their ids. A
   validator fails the run on any unresolvable id.

## Decision

Option 3. `Evidence.id = sha256(url + retrieved_at)`, truncated. Facts without
evidence ids are dropped at parse time. `src/memo/validate.ts` hard-fails the run
if a rendered memo cites an id with no file behind it.

## Consequences

**Good.** A source cannot be invented — only misread. That is a much smaller and
much more checkable failure surface. Evidence records are committed, so a
reviewer opens the JSON and reads the exact text the model saw at the moment it
saw it. Retrieval timestamps make claims falsifiable later, when the page has
changed.

**Bad.** The model cannot use knowledge it already has, even when that knowledge
is correct — if a founder's prior exit is not in the fetched evidence, the fact
does not exist to this pipeline. This will lose real signal. It is the right
trade for a system whose output a partner is meant to trust without re-checking.

**Bad.** Evidence bundles get long, so extraction calls are token-heavy. Bounded
by truncating extracted text per record and by preferring targeted extraction
(team page, repo metadata) over whole-page dumps.

## Revisit if

Never, while the memos are meant to be trusted. If the pipeline became an
ideation tool rather than a triage tool, the constraint would be wrong.
