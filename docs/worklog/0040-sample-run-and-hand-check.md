# Session 0040 — 2026-08-23 — The sample run, read by hand

[TICKET-0028](../tickets/0028-ticket-committed-sample-run.md), one commit
(`2adb8be`). The run is committed, `setup.sh` has six steps, and the
`<committed_sample>` placeholders are a real id. **The ticket is done.** The
hand-check found one wrong call and one dimension that discriminates nothing,
and both are written up here rather than quietly fixed.

## The run

```
./pipeline run --seed "AI agent infrastructure" --limit 12
```

D-5's topic, at its default. 12 candidates, 12 analyses, 12 memos, **42
citations, all resolved**. 45.5s wall clock (source 43ms and analyse 45.5s), 12 model
calls, **171 facts kept, 0 dropped**, 79,582 input / 11,341 output tokens on
`gpt-4.1-mini`, `cost_usd: null` because `PRICES` ships empty.

**Read the manifest's `budget.spent` carefully — it is 0 site, 0 GitHub, 12 HN,
and only one of those three numbers means what it looks like.** The committed
run was gathered against a warm `.cache/http/` from an earlier run the same
morning, so every site and GitHub read was answered from cache and cost no
request. HN was charged twelve times anyway, because `gatherCandidate` charges
the HN pool unconditionally — that is [inconsistency 87](../STATE.md), _"the HN
request pool charges for requests it did not make"_, and the committed manifest
is now the place a reader can see it. What a **cold** run of these twelve costs
is `planned`: 24 GitHub, 48 site, 12 HN, against an unauthenticated GitHub limit
of 60. GitHub ran unauthenticated throughout — `GITHUB_TOKEN` is not set — at 2
planned calls per candidate rather than the adapter's full five.

|               |                |        |      |
| ------------- | -------------- | ------ | ---- |
| klaus         | TAKE_A_MEETING | 81     | 80%  |
| runtime       | TAKE_A_MEETING | 80     | 100% |
| testerarmy    | TAKE_A_MEETING | 74     | 100% |
| **ardent**    | **PASS**       | **71** | 100% |
| intuned       | WATCH          | 66     | 100% |
| freestyle     | WATCH          | 64     | 100% |
| hoplite       | PASS           | 60     | 80%  |
| hypercubic-ai | PASS           | 60     | 80%  |
| agent-vault   | WATCH          | 59     | 100% |
| kampala       | PASS           | 59     | 100% |
| kontext-cli   | WATCH          | 59     | 100% |
| bitboard      | PASS           | 54     | 60%  |

**D-5's counter-argument did not materialise.** The prediction on the record was
that twelve launched, mostly YC-backed companies would come out uniformly
positive and demonstrate the thesis poorly. The set is 3 / 4 / 5 across the three
calls and spans 54–81. Whether the _ordering_ is right is a separate question,
and #1 below says it is not, for one of them.

## What TICKET-0028 asked me to record

### 1. Is any memo's call clear in 60 seconds?

Yes, and the format is doing the work. Every memo opens with
`# <Name> — <CALL> · score N/100 · coverage N%` and a "Why this call" paragraph
that names the arithmetic — the threshold cleared, or the disqualifier that
overrode it, and the largest shortfall. A reader who stops after two lines has
the call and the confidence in it.

Two format observations from reading all twelve:

- **A memo with an uncovered dimension has no section for it, and says so
  twice** — once under "What would change my mind" and once under "What we
  could not verify". `klaus.md` has no Team section at all because D1 is
  uncovered, and the absence reads as honest rather than as an omission.
- **"Market" is carrying traction.** `ardent.md` files three customer
  testimonials (Chevron, Openledger, Zennagents) under Market. Those are pull,
  not market. This is [inconsistency 90](../STATE.md), predicted from SPEC §4
  and now seen in the wild.

### 2. Did candidates cluster in the middle two bands of every dimension?

**Yes for three of five, and D4 is worse than clustering — it is degenerate.**
This is the predicted symptom of unvalidated rubric bands (ADR-0002,
TICKET-0021), and it is reported rather than re-tuned.

| Dim                      | Bands available         | Bands used | Distribution                                         |
| ------------------------ | ----------------------- | ---------- | ---------------------------------------------------- |
| D1 Founder–market fit    | 0–5, 6–12, 13–19, 20–25 | 3 of 4     | 3 / 6 / 1, plus 2 uncovered. **20–25 never reached** |
| D2 Wedge specificity     | 0–4, 5–10, 11–15, 16–20 | **2 of 4** | 7 / 5. **Nothing below 11**                          |
| D3 Evidence of pull      | 0–5, 6–12, 13–19, 20–25 | 3 of 4     | 2 / 5 / 2, plus 3 uncovered. **13–19 never reached** |
| D4 Why now               | 0–3, 4–8, 9–12, 13–15   | **2 of 4** | 1 / **11**. Eleven of twelve identical               |
| D5 Path to defensibility | 0–3, 4–8, 9–12, 13–15   | **2 of 4** | 9 / 3. **Nothing below 9**                           |

**D4 "Why now" contributes almost nothing to the ranking.** Eleven of twelve
score 15/15. Its top band asks for a stated launch date _or_ a repository
younger than 548 days — and every company sourced from a Show HN post in a
180-day window has a stated launch date by construction. The dimension is
measuring the sourcing, not the company. That is a rubric defect, not a data
one, and the fix is not a band tweak.

The consequence: **the spread across candidates comes almost entirely from D1
and D3**, which are the two dimensions that also have `uncovered` states. So a
company's rank is driven mostly by how much was _found_ about it, which is
uncomfortably close to ranking by GitHub presence. With GitHub unauthenticated
and planned at two calls per candidate rather than the adapter's five, that is
worth stating plainly.

I have not re-tuned anything. ADR-0002 and CLAUDE.md are explicit that there is
no eval harness and the rubric is not validated; moving bands to make this table
look better, with n=12 and no held-out set, would be fitting to one run.

### 3. Spot-check a sample of facts against their evidence records

Eight facts sampled at random across the twelve candidates; six checked verbatim
against the cited record's text.

| Candidate · key                        | Verdict                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| bitboard · `adoption.pricing_public`   | **Supported.** "Free for individuals, $49 per seat for teams, and custom plans for enterprises" |
| intuned · `founder.prior_role`         | **Supported.** "because of Faisal's background at UiPath"                                       |
| agent-vault · `traction.hn_engagement` | **Supported.** "156 points … 55 comments"                                                       |
| ardent · `traction.hn_engagement`      | **Supported.** "99 points … 52 comments"                                                        |
| kontext-cli · `traction.repo_activity` | **Supported.** "open issues: 22 … last pushed at: 2026-08-23"                                   |
| testerarmy · `adoption.sales_gate`     | **Supported.** "SSO / SAML, Custom integrations · Book a call"                                  |

Six of six supported, and none was a paraphrase that drifted. The two not
checked verbatim (`product.one_liner` for intuned and ardent) are summaries of a
whole page rather than a quotable line; both matched the page's own hero copy.

**No fabricated citation, and no fact citing a record that does not exist.** The
closed-world constraint (ADR-0003) is holding: 42 citations, 42 resolved, and
the memo validator would have exited 3 if one had not.

## The finding that matters: `ardent` is called wrongly

`ardent.md` reads **PASS at 71/100** — the highest-scoring Pass in the set, and
above two of the Watches. The reason given is disqualifier D-1:

> The team is named and **nothing any of them is stated to have built** appears
> in the evidence, and the company has no public repository.

Two sections above that, in the same memo, its own Team section says:

> Evan is a named founder of Ardent **with 12 years prior experience in data
> engineering**.

And the cited evidence record says more than the memo does:

> "I spent over a year building an AI Data Engineer that failed for this exact
> reason. Evan spent the last 12 years in data engineering and hit this wall
> building agents at his last company."

That is a prior artifact _and_ a prior role, stated on the record D-1 cites.
**The memo contradicts itself on the page.**

**The mechanism is the extractor's key choice, not the rubric's logic.** D-1
reads `founder.prior_role`, `founder.prior_exit` and `founder.prior_artifact`.
The model filed Evan's twelve years under `founder.name_role`
(`value: "Evan, founder with 12 years data engineering experience"`) and dropped
Vikram's "spent over a year building an AI Data Engineer" entirely. The rubric
then read, correctly, that no `founder.prior_role` fact existed. Given its
inputs it is right; its inputs were wrong.

This is [inconsistency 79](../STATE.md) — _the rubric reads presence, not
meaning_ — with a cost attached. It is the same class as
[inconsistency 85](../STATE.md), where an absence was filed as a fact: both are
the extraction prompt putting content in the wrong bucket, and both are a prompt
v2's problem (TICKET-0019's file), not a scoring one. It is logged as
inconsistency 97.

The one consolation is that the system showed its work: a reader has the
contradiction, the fact, the key and the evidence id in front of them and can
catch it in fifteen seconds. That is what "auditable" bought. It is not the same
as being right.

## The second finding: two live runs on the same evidence disagree

I ran the pipeline twice — once to produce the run, once more after a replay
overwrote the manifest (worklog 0039, what went wrong #3, fixed at
TICKET-0029). Same seed, same
evidence records, same prompt version, same model. **Six of twelve scores
moved, and two calls flipped.**

|                                                              | first                 | committed             |                   |
| ------------------------------------------------------------ | --------------------- | --------------------- | ----------------- |
| runtime                                                      | WATCH 59              | **TAKE_A_MEETING 80** | +21, call flipped |
| ardent                                                       | PASS 53               | PASS 71               | +18               |
| kontext-cli                                                  | **TAKE_A_MEETING 75** | WATCH 59              | −16, call flipped |
| intuned                                                      | 59                    | 66                    | +7                |
| agent-vault                                                  | 66                    | 59                    | −7                |
| freestyle                                                    | 59                    | 64                    | +5                |
| klaus, testerarmy, kampala, hoplite, hypercubic-ai, bitboard | —                     | —                     | unchanged         |

No temperature is set, deliberately — `src/llm/provider.ts` says so, and gives
the reason: providers disagree about which values their newer models accept, and
_"reproducibility comes from the response cache, not from a sampler setting."_
That decision is not wrong, and this is what it costs: **the rubric is
deterministic given facts; the facts are not deterministic given evidence.** The
committed cache makes the committed run reproducible, and it does not make the
pipeline reproducible.

A reader should take the calls in this sample run as one draw, not as the
pipeline's opinion. Logged as inconsistency 98.

## What was committed, and what was not

Committed: `runs/2026-08-23-ai-agent-infrastructure/` — manifest, query_plan,
candidates, **bundles**, evidence, analyses — `memos/<id>/`, and `.cache/llm/`
(12 entries, 408 KB). Not committed: `.cache/http/`, per ADR-0009. Total added
to the repo: about 1.1 MB.

**The replay was measured, not assumed.** With `.cache/http/` moved out of the
tree entirely, `./pipeline run --seed "AI agent infrastructure" --limit 12
--replay` produced **12 unchanged memos and byte-identical analyses in 54ms**,
zero requests, zero tokens. That is the line inconsistency 84 broke, closed.

This run **replaces** the three-candidate first live run of
[worklog 0034](./0034-first-live-run.md), which predates bundles and could not
have been replayed from a clone. Worklog 0034 stands as written.

## Two things TICKET-0028 asked for that are not done as written

1. **`grep -rn "committed_sample" . --exclude-dir=.git` does not return
   nothing.** It returns two hits, both in `docs/worklog/0006` and `0007`, which
   are historical entries. The worklog README says entries are left unedited
   except for explicit `Correction:` notes, and those two sentences were true
   when written. The acceptance criterion is met for the three live documents —
   README, ARCHITECTURE, `setup.sh` — and the ticket has been amended to say so
   rather than the worklogs being rewritten to make a grep pass.
2. **TICKET-0023 (missing-data path tests) is still Ready**, and 0028 lists it
   as a dependency. The author's call was to proceed and flag it. Flagged: the
   run exercised the missing-data paths for real — three candidates uncovered on
   D3, two on D1, one at 60% coverage — but "for real, once" is not the same as
   a pinned test, and 0023 stays open.

## Attribution

The run, the replay measurement, the band tabulation and the fact spot-check
were **executed by the assistant** at my instruction. The reading of the twelve
memos was the assistant's first pass and mine second; the `ardent` finding was
the assistant's, from reading the memo against its own evidence record. The
decision not to re-tune the bands was pre-committed in ADR-0002 and TICKET-0028
and was not reopened. `setup.sh` step 6 and the placeholder replacements are
assistant-written.

## Reflection

N/A
