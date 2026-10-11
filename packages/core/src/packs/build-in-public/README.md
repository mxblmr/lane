# Build in Public pack (U16)

R3 counts a real build-log post on each day of the window. The agent sends the post URL, the
platform and the post text. Lane re-fetches the post where a public endpoint allows it (R16,
KTD14), re-fetches every counted post again at the final check (R27), and stops counting a post
the platform says is gone (AE3).

## Public re-fetch without app tokens (U16 approach step 1)

Probed on 2026-10-11 with plain `curl` GET requests, no token, no cookies. These probes ran from
a developer machine, not from Vercel. The same requests still need one run from a Vercel
function before the demo (see "Still to confirm" below).

| Platform | Endpoint | Post exists | Post deleted or wrong id | Returns text | Returns author |
|---|---|---|---|---|---|
| X | `https://publish.x.com/oembed?url=...` (`publish.twitter.com` answers 301 to it) | 200 JSON, `html` is a blockquote whose first `<p>` is the post text | 404 | yes | yes, `author_url` |
| Instagram | `https://graph.facebook.com/v25.0/instagram_oembed?url=...` (v24.0 and unversioned also answered 200) | 200 JSON, `html` is a placeholder ("View this post on Instagram") | 400, Graph error code 24 "Media Not Found" | no | no |
| Threads | `https://graph.threads.net/v1.0/oembed?url=...` | 200 JSON, `html` is a placeholder ("View on Threads") | 400, Graph error code 24 "Media Not Found" | no | no |
| LinkedIn | none: `https://www.linkedin.com/oembed` is a 404 HTML page | not applicable | not applicable | no | no |

What the pack does with this:

- **X:** the re-check returns the re-fetched text, the author and the post time (decoded from the
  snowflake id). It is `rechecked` when the author is the player's bound X handle, `failed` when
  it is someone else, and `agent_attested` with the fetched text when the player's bound handle
  is on another platform.
- **Instagram and Threads:** a 200 confirms the post exists, so the re-check is `agent_attested`
  (Lane has neither the text nor the author) and features read the agent's text. Error code 24
  means the post does not exist: the re-check is `failed` and `post_missing` is true. At the
  final check, code 24 marks the post not counted.
- **LinkedIn:** no call. The re-check is `agent_attested`, and the final check opens a `refetch`
  inbox request for the player's Muse instead of a failure.
- **Any other answer** (an endpoint that starts asking for a token, an unexpected status or body)
  is treated as "Lane cannot confirm": `agent_attested` at verdict time and a Muse `refetch`
  request at the final check. Timeouts, 429 and 5xx are `pending` at verdict time, and are
  retried once at the final check before falling back to a `refetch` request. Nothing throws.

No request carries a token or cookie, and Lane never stores or renders oEmbed HTML (KTD16): it
keeps only the extracted text.

## Handle verification (KTD21)

KTD21 verifies a handle by reading the bind code from the platform's public profile bio. None of
the four platforms serves a profile bio without an app token: X profile data needs the paid API,
Instagram and Threads profile fields need a Meta app token, and LinkedIn profiles need a login.
No unofficial profile scraping was attempted. `verifyHandle` therefore makes no call and returns
`verified: false` with an honest reason, so proofs from a real Build in Public player's
unverified handle stay held. Scripted players are seeded as verified, so the demo path does not
depend on it.

Options for Max and Antoine to decide:

1. Verify an X handle from a post that carries the bind code. Unlike a commit, an X post's author
   is authenticated by X, and the oEmbed returns both the author and the text. This needs the
   pack interface's `verifyHandle` to receive a post URL.
2. Let the operator verify a handle from the dashboard.
3. Add a Meta app token for Instagram and Threads, or a paid X API token.

## Features

| Feature | Meaning |
|---|---|
| `word_count` | Words in the post, not counting hashtags and mentions. |
| `has_concrete_detail` | Names a link, a file, code, a number or a named product feature. Day counters ("Day 3", "day 3/30", "#100DaysOfCode") and hashtags do not count. |
| `filler` | Fewer than 8 words and no concrete detail (AE3). |
| `near_duplicate` | Dice similarity of at least 0.85 over character bigrams with one of the player's earlier posts in the challenge, after dropping links and tags and collapsing digits. |
| `post_missing` | The platform said the post does not exist when Lane re-fetched it. |
| `platform` | `x`, `instagram`, `linkedin` or `threads`. |

The source key is `platform:post_id`, so `twitter.com` and `x.com` links, share links with
tracking parameters, `threads.net` and `threads.com`, and a LinkedIn `posts/` slug and its
`feed/update` URN all key the same post. The proof parse stores Lane's canonical URL, without
tracking parameters.

The seed rule rejects `post_missing`. Filler and near-duplicates are left to the learning loop,
as Ship Week leaves rename-only commits (R24).

## Labelled examples

`examples.json` is written by `examples.gen.ts`, which runs each synthetic post through
`recheckPost` (with a local fetch double that answers like each platform) and the real feature
extractor. Regenerate after changing either:

```
pnpm exec tsx packages/core/src/packs/build-in-public/examples.gen.ts
```

The pack test fails while the file is stale.

## Still to confirm

- Run the four probes above from a Vercel function on the deployed project. Meta and X may
  answer data-center addresses differently from a home network.
- Graph API `v25.0` will eventually be retired; the Instagram endpoint version needs a bump then.
