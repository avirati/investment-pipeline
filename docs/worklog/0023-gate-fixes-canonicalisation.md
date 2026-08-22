# Session 0023 — 2026-08-22 — The gate's canonicalisation fixes (TICKET-0010)

Two of the three fixes the [gate](0022-gate-hand-check.md) scoped onto the
reopened TICKET-0010. The third turned out to belong in TICKET-0009 and was
moved rather than implemented.

## What I asked for

Do the 0010 fixes next.

## What landed

|        | Fix                                                                     | Where                                       |
| ------ | ----------------------------------------------------------------------- | ------------------------------------------- |
| **F3** | A url that points _inside_ a repository canonicalises to the repository | `canonicaliseUrl`, via a new `identityPath` |
| **F5** | A package registry keys on the package, not on the registry             | `siteKey`, via `REGISTRY_DEPTHS`            |
| **F4** | A `blog.` subdomain is a blog                                           | **Moved to TICKET-0009** — see below        |

`src/source/resolve.ts` and `tests/resolve.test.ts` only. 14 new tests, 376
passing, offline.

## F3 — and a correction to what the ticket said it was

The gate found three junk candidates whose urls pointed inside something:

```
github.com/alibaba/anolisa/blob/main/docs/user-guide/en/…/agentsight.md
github.com/xqlsystems/xarray-sql/blob/claude/…/benchmarks/nn.py
github.com/BetterDB-inc/monitor/tree/master/packages
```

The reopened ticket said the fix would "make two urls into one repo dedup".
**That was wrong, and finding out why made the fix more important rather than
less.** `siteKey` has always sliced a code-host path to `owner/repo`, so two
deep urls into one repo already deduped and the _key_ was never broken. What was
broken is `canonical_url` — the url a candidate is named after, and the url
stage 2 will fetch as that company's evidence. Unfixed, this pipeline would have
scored Alibaba's Anolis OS on the contents of one markdown file.

So `identityPath` truncates, and `canonicaliseUrl` takes the result as the url
the run carries forward. Three properties are deliberate:

**It truncates and never rejects.** `github.com/HelixDB/helix-db/tree/main` is a
real company and `/tree/main` is just how a repo link gets pasted into a
submission form. A rule that read "deep path ⇒ not a company" would have deleted
HelixDB, which is rule 2's unrecoverable direction.

**It only truncates at a segment it recognises.** `REPO_SUBPATHS` lists 30
prefixes (`blob`, `tree`, `issues`, `pull`, `releases`, …) and an unrecognised
third segment is left alone. GitLab nests groups — `gitlab.com/group/subgroup/repo`
— and cutting blindly to two segments would collapse every repo in a group into
one candidate. Guessing in the collapse direction is exactly what this file
argues against.

**Truncating drops the query.** `?plain=1` is a property of a file view and
means nothing at a repo root.

This is the one place canonicalisation changes _what the run fetches_ rather
than only how a url is spelled, which is a departure from the file's own rule 1
and is commented as one. The deep url is not lost: `posted_url` on the post
still carries the link exactly as submitted.

## F5 — registries, tested but never yet fired

`siteKey` keyed `pypi.org/project/logmera` on `pypi.org`, so a second PyPI
launch in the same run would have merged into the first and disappeared —
STATE inconsistency 36, and the wrong-collapse direction.

`REGISTRY_DEPTHS` gives eight registries the number of leading path segments
that name one package. The depths are read off each registry's url shape and are
exact rather than guessed, and the two variable shapes are handled explicitly:
an npm scope (`/package/@acme/cli`) is one segment more, and Hugging Face puts
datasets and spaces under a prefix while models sit at the root.

Keyed on the **host**, not the registrable domain — `hub.docker.com` reduces to
`docker.com`, and a registry's docs subdomain is not a package index.

**No registry url appeared in any of the gate's four topics**, so this fix is
covered by tests and has never fired against real data. That is the honest
status: inconsistency 36 was found in an earlier live run, not in the gate's.

## F4 — moved to TICKET-0009, and why

The gate scoped "a `blog.` subdomain is a blog" onto this ticket. Implementing
it here would have been wrong twice over.

"Is this an article" is `classifyUrl`'s question and `classifyUrl` lives in
`hn.ts`. `classifySite` in `resolve.ts` exists only to add the rejections the
url classifier _cannot_ reach — a link-in-bio host, a tilde directory, an
academic host — and a `blog.` subdomain is plainly one it can.

The consequence that settles it: the probe calls `classifyHits`, which calls
`classifyUrl`, and nothing else. A blog rule that lived only in `resolve.ts`
would leave D-6's usable count still counting blogs as companies — the number
the threshold is compared against would stay wrong while the candidate list got
right. And the codebase already keeps one definition of "unusable" in one file
precisely so the two layers cannot drift.

Moved, with the reasoning written into both tickets. It lands in the next
commit alongside F1 and F2.

## Measured, not estimated

The gate's four topics were re-run against the new code (HTTP cache warm, so
this cost nothing) and the candidate lists diffed:

- All four real deep urls collapsed: `alibaba/anolisa`, `xqlsystems/xarray-sql`,
  `HelixDB/helix-db`, `BetterDB-inc/monitor`.
- `AI agent infrastructure` and `LLM observability` were otherwise unchanged —
  no regression on the two clean lists.
- **No candidate was dropped.** F3 re-points a url; it does not reject.

**What that does to the gate's junk count, honestly.** Two of the five junk
candidates stop being junk under the gate's own definition — _not a company and
not a product surface either_ — because `github.com/alibaba/anolisa` and
`github.com/xqlsystems/xarray-sql` are product surfaces, they are repositories.
They do not vanish; they move from "junk" into the ten candidates that are
projects rather than companies (inconsistency 22), which is where a repo with no
company behind it honestly belongs. Junk is 5 → 3 after this commit, and 5 → 1
once F2 and F4 land in TICKET-0009. The survivor is `demo.coroot.com`, which
needs TICKET-0015's `homepage` field.

## Verification

- `pnpm test` — **376 passed** (362 before: +14). Offline, no key.
- `pnpm typecheck`, `pnpm lint` clean.
- Four live re-runs, outputs diffed by hand against the gate's, nothing
  committed.

## What the record should be honest about

**`REPO_SUBPATHS` is a hand-written list and the seventh unmeasured guess in
this codebase.** It leans towards _not_ truncating: an unrecognised segment is
left alone, so a code host with a path shape nobody listed keeps its deep url
and behaves exactly as it did before this commit. That is the safe failure.

**F5 has never run against real data.** Tests only.

**`identityPath` gives `canonicaliseUrl` a second job.** The file's rule 1 says
canonicalisation decides identity and not display; this changes the url the run
fetches. Argued in the code, and worth a reviewer's disagreement.

## Decisions taken

No open decision in STATE.md was answered. One scoping decision was reversed:
**F4 moves from TICKET-0010 to TICKET-0009**, because the probe reads `hn.ts`
and not `resolve.ts`.

**TICKET-0010 is Done again.**

## Attribution

`identityPath`, `REGISTRY_DEPTHS`, `REPO_SUBPATHS`, the `siteKey` and
`canonicaliseUrl` changes, all 14 tests and this worklog's factual sections are
AI-written end-to-end. The correction to F3's stated purpose, and the decision
to move F4, were the AI's.

## Reflection

N/A

## Next

The TICKET-0009 half: **F1** (prefer the repo owner over a generic repo slug —
7 of 48 candidates), **F2** (ACM's proceedings host), and **F4** as moved above.
Then [TICKET-0014](../tickets/0014-ticket-fixture-capture-script.md) captures
fixtures from the post-fix behaviour, or
[TICKET-0018](../tickets/0018-ticket-llm-provider-and-cache.md).
