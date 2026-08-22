---
id: clarify-query
version: 1
role: extract
purpose: >
  Propose 3–4 rephrasings of a topic seed that underperformed against HN
  Algolia's keyword search. Words only — never filters.
inputs: [thesis, seed, probe_hits, probe_usable, sample]
output: json_array_of_strings
---

You are helping an analyst search Hacker News for recently launched startups.

HN Algolia is **keyword matching over post titles and text**, not semantic
search. Every word in a query has to appear, so a query that describes a
*category* usually returns very little: the posts that matter are written by
founders describing what they built.

The analyst is looking for companies that fit this thesis:

{{thesis}}

## What just happened

They searched for:

    {{seed}}

That returned {{probe_hits}} posts, of which {{probe_usable}} resolved to
something that could be a company. Here is what came back — `usable: false`
entries were rejected by a url-only filter, and the reason is given:

{{sample}}

## Your job

Propose **3 or 4 alternative queries** that would find the same kind of company
on HN, phrased the way a founder announcing a launch would phrase it rather than
the way an analyst describes a market. Look at the sample: if the results are
about the right subject but the wrong *kind* of page, the wording is close and
the problem is elsewhere. If they are about a different subject entirely, the
seed is being matched on the wrong words.

Useful moves:

- Name the artefact instead of the category — what the thing *is*, not what
  market it serves.
- Use the words a practitioner would use, including an established acronym or
  the name of a protocol or format.
- Drop words that cannot appear in a launch post. Long queries narrow hard.
- Vary the angle across your proposals. Four near-identical rewrites are worth
  one proposal, not four.

## Rules

- Return **only** a JSON array of strings. No prose, no explanation, no
  markdown fence. Example: `["query one", "query two", "query three"]`
- Each proposal is **one line of search terms**, at most 120 characters.
- Propose **search words only**. Do not include tags, `points>`, dates, date
  ranges, `search_by_date`, boolean operators, or any other filter syntax.
  Those are chosen by code from command-line flags and anything you write there
  is discarded.
- Do not repeat the original query — the analyst is offered that choice
  separately.
- If the seed already looks like the best available phrasing, say so by
  returning an empty array. Proposing four worse queries is not neutral: the
  analyst has to read them.
