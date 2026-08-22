# HN Algolia fixtures

Real responses from `https://hn.algolia.com/api/v1/search`, captured on
**2026-08-22** for TICKET-0009 and committed verbatim. They are what makes
`tests/hn.test.ts` offline, and they double as a record of what the API actually
returned on the day the adapter was written (TESTING §"Fixtures").

`hitsPerPage=5` throughout, so a whole page fits on a screen in review. The
capture script proper is TICKET-0014; these four were taken by hand with the
commands below and that script should reproduce them.

```bash
B=https://hn.algolia.com/api/v1/search

# search-page-0.json, search-page-1.json — pagination over one query
for p in 0 1; do
  curl -sG "$B" \
    --data-urlencode "query=llm observability" \
    --data-urlencode "tags=story" \
    --data-urlencode "hitsPerPage=5" \
    --data-urlencode "page=$p" \
    --data-urlencode "numericFilters=created_at_i>1740000000" \
    -o tests/fixtures/hn/search-page-$p.json
done

# search-empty.json — a seed nobody has posted about
curl -sG "$B" \
  --data-urlencode "query=qzxvnowaythisisareal term xyzzy" \
  --data-urlencode "tags=story" \
  -o tests/fixtures/hn/search-empty.json

# search-ask-hn.json — text posts, every hit with a null url
curl -sG "$B" \
  --data-urlencode "query=llm observability" \
  --data-urlencode "tags=ask_hn" \
  --data-urlencode "hitsPerPage=5" \
  -o tests/fixtures/hn/search-ask-hn.json
```

## `search-malformed.json` is hand-edited, and says so here

The API does not serve broken records on demand, so this one is
`search-page-0.json` with five deliberate defects — one per hit, in order:

| Hit | Defect | Expected behaviour |
|---|---|---|
| 0 | `created_at` is prose, `created_at_i` intact | dated from the unix field |
| 1 | `created_at` null, `created_at_i` absent | `created_at: null`, hit kept |
| 2 | `created_at_i` is a string, `created_at` intact | dated from the ISO field |
| 3 | `points` absent, `num_comments` null | both `null` — never `0` |
| 4 | `objectID` absent | dropped, with a reason |

The mix is the point: four of the five are *survivable*, and a parser that
treats malformed as fatal would throw away four usable posts to reject one.
