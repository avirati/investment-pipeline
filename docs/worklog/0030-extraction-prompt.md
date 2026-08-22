# Session 0030 — 2026-08-22 — The extraction prompt, and where prompts come from

[TICKET-0019](../tickets/0019-ticket-extraction-prompt.md), in one commit.
`prompts/extract.v1.md` is the stage 2b prompt — evidence bundle in, facts out —
and `src/llm/prompt.ts` is the loader that turns a prompt file into a rendered
string with its version attached. The `prompts/CHANGELOG.md` entry is the third
deliverable and, with no eval harness in v1, it is the only record of why the
prompt says what it says.

## What I asked for

Continue implementation, stop for review, small commits on a feature branch,
keep the worklogs going with reflection hints, update ticket statuses.

## What landed

| Commit    | Contents                                                      | Tests |
| --------- | ------------------------------------------------------------- | ----- |
| `d98efa0` | `prompts/extract.v1.md`, `src/llm/prompt.ts`, CHANGELOG entry | 22    |

**738 tests** (716 before this ticket: +22), typecheck and lint clean, offline
and with no `.env`.

## The prompt

Eight rules, three interpolations, and one thing that is deliberately not in it.

**Facts only, and the fields say so.** `key`, `statement`, `value`,
`evidence_ids`, `confidence` — the Zod contract from TICKET-0005, described in
the prompt in the terms a reader of the output would use. `statement` is the
sentence a partner reads; `value` is the same observation reduced to a scalar
where one exists, and `null` where one does not.

**The rules that carry weight are 1, 2, 6 and 8.**

- **1 — cite, and only from the listed ids.** Closed-world citation (ADR-0003)
  stated in the prompt as well as enforced at parse time in TICKET-0020. The
  enforcement is the mechanism; the sentence is what makes a compliant model
  produce facts that survive it rather than facts that get dropped.
- **2 — only what these records say.** The prompt names the failure directly:
  the model has probably seen these companies, and a recalled fact arrives
  wearing a citation and looks checked. That is worse than an uncited wrong
  fact, because the citation is what stops a reviewer from checking.
- **6 — omission is how you say unknown.** SPEC §3's missing-data rule, pushed
  one step upstream. A short answer has to be an available answer or the model
  fills the gap, and a filled gap is unrecoverable downstream.
- **8 — no scoring, ranking or recommending**, with the tell named: a ranking
  adjective (_strong_, _promising_, _thin_) means the sentence became a
  judgement.

**Confidence is about the evidence, not the company.** Said explicitly, because
a `high`/`medium`/`low` field next to a description of a startup invites the
model to grade the _opportunity_ — which would be a score arriving under
another name, through the one field the contract does not constrain.

**Three interpolations, no free text.** `{{company}}`, `{{evidence}}`,
`{{keys}}`. The bundle format is not described in prose and produced
separately: `bundleItems(bundle)` is the shape and TICKET-0020 renders it.
`{{keys}}` is filled from the extraction schema's vocabulary the same way
`{{thesis}}` is filled from the rubric in `clarify-query` — one source of truth,
and a prompt that cannot drift from the schema it is asked to fill.

**The rubric is not in it, and the check was reading it.** TICKET-0019 names
this as the subtle failure: a prompt that restates the thesis turns the model
back into the scorer through the back door (CLAUDE.md invariant 7). The file was
read against SPEC §1–2 looking for any of it. Absent: the thesis sentence and
its three clauses, the five dimension names, every band and threshold, the four
disqualifiers, the coverage gate, the three calls. Present and deliberate:
neutral observation prompts — who built it, what it does, who uses it, when
things happened, what the company owns — which is the widening half of
invariant 1. The model is told what to look at, never what counts as good.

`tests/prompt.test.ts` fails if any of a list of scoring terms appears in the
file. That is a tripwire, not the check. The check was reading it; the tripwire
is what stops the next revision from quietly undoing the reading.

## The loader

Four rules, and each one is a way a versioned-prompt convention normally rots.

**1 — the filename is the version, and the version is asked for.** No `latest`.
`loadPrompt({ id, version })` reads exactly `prompts/<id>.v<n>.md`. Cache keys
hash that number (invariant 6), so an implicit latest-wins rule is precisely how
a stale answer survives a prompt change.

**2 — the front matter is checked, not decoration.** `id:` and `version:` in the
header must match the file that was opened, and a declared `inputs:` list must
match the placeholders in the body exactly. The ordinary way this goes wrong is
a v2 copied from a v1 with the header left behind — a file whose text and whose
cache key disagree about which prompt it is.

**3 — interpolation is exact in both directions.** Every placeholder must be
supplied and every supplied value must be used. A renamed placeholder that drops
the evidence bundle out of an extraction prompt is a call that costs money and
returns nothing citable; it now throws before the call with the name in the
message.

**4 — values are inserted, never re-scanned.** Evidence text is fetched from the
internet. A page that writes `{{company}}` in its body must not be able to reach
into the prompt, so substitution is one pass and the output of a substitution is
never itself expanded.

**Not a YAML parser.** Three fields are read off the header with a regex and
everything else — the `purpose: >` block, `role:`, `output:` — is documentation
for a person and is left alone. A YAML dependency for three lines the repo
writes itself would need an ADR line (CLAUDE.md) it does not deserve.

## What one test caught

The `inputs:` check had a hole the test found rather than review. `inputs:`
written as a YAML block list —

```yaml
inputs:
  - company
```

— left the field's value empty, which read as _no inputs declared_, which turned
the header-versus-body check off silently. Present-but-unparseable is now an
error naming the form it wants; absent is still allowed. The general shape is
familiar and worth naming: a validation that is skipped when its input is
malformed is not a validation.

## Known gaps

1. **The prompt has never been sent to a provider.** The tests render it and
   assert what is in it; nothing asserts what a model does with it. This is the
   same position `clarify-query` v1 is in, and it is now **two** prompts written
   against no observed output. The first real signal is TICKET-0020's captured
   fixtures.
2. **`{{keys}}` names a vocabulary that does not exist yet.** The extraction
   schema in TICKET-0020 defines it. If that ticket decides fact keys are
   free-form rather than enumerated, this prompt needs a v2 — the CHANGELOG
   entry says so.
3. **Nothing in `src/` calls `loadPrompt` yet.** The acceptance grep passes
   because there are no prompt string literals to find, which is a weaker
   statement than the one the ticket wanted. It becomes the real check at 0020.
4. **The loader reads the file on every call.** Deliberate — a run makes tens of
   calls against a few kilobytes — but it means a prompt edited mid-run changes
   what later candidates are asked. The cache key would show it; nothing warns.

## What this ticket did not do

- **No extraction module.** `src/analyse/extract.ts`, the structured call, the
  retry-once-on-invalid-structure path and the id-outside-the-bundle rejection
  are all TICKET-0020.
- **No bundle rendering.** How `BundleItem[]` becomes the text of
  `{{evidence}}` is stage 2b's, not the loader's: `src/llm/` knows about files
  and braces, and importing `src/analyse/` from it would invert the layering.
- **No `clarify-query` v2.** TICKET-0011 stays reopened. It waits on the rubric
  for `{{thesis}}`, not on this.

## Attribution

`src/llm/prompt.ts`, `prompts/extract.v1.md`, the CHANGELOG entry, all 22 tests
and this worklog's factual sections are AI-written end to end. The by-hand
no-rubric check described above was performed by the assistant, not by the
author — worth knowing when deciding how much the tripwire test is carrying.

## Reflection

Versioned prompt is in place. We are relying on LLM to cite evidence ids which will be referenced from a list. This should work but there is a non zero chance of the model hallucinating. It would be better if this list was provided in the zod schema, as an enum.

## Next

**TICKET-0019 is Done.** [TICKET-0020](../tickets/0020-ticket-fact-extraction.md)
— fact extraction — is unblocked and is the next thing to pick up. It owns three
things this ticket deliberately left: the key vocabulary that fills `{{keys}}`,
the rendering of `bundleItems` into `{{evidence}}`, and the first captured model
output, which is the first evidence any of this prose works.
