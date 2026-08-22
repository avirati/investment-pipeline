# TICKET-0030 — Walkthrough video, one startup end-to-end

Status: Blocked · 0029 · Depends on: 0029 · Blocks: —
Reads: [STATE](../STATE.md) submission checklist

## Why

The brief asks for a repo **plus** a ~5 minute walkthrough showing one startup
end-to-end. It is a listed deliverable, so it is a ticket rather than an
afterthought.

## Scope

- Pick one company from the committed sample run whose memo is interesting —
  ideally not a clean Take-a-meeting. A Watch with an honest coverage gap shows
  more of what the pipeline actually does.
- Trace it: seed → `query_plan.json` → candidate → evidence records → analysis
  JSON → memo. Open a real evidence file and read the text the model saw.
- Recompute one dimension's score by hand against the SPEC §2 table, on camera.
  That is the claim the whole design rests on; demonstrating it takes 30 seconds.
- Say what was cut and why — the eval harness especially. Cutting it knowingly
  and saying so is the point (SCOPE).
- ~5 minutes. A written outline committed alongside is enough here; the recording
  is the author's.

## Out of scope

Editing, hosting, or anything that makes this a production. It is a screen
recording of a working thing.

## Acceptance

- Outline committed.
- Recording covers one company end-to-end including one hand-recomputed score.
