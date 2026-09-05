# Research

Apollo distinguishes quick lookups from deep multi-source research.

## Quick search

`web_search` answers factual questions that need the open web without a long job. It runs on the Tavily API (`apps/agent/src/search/tavily.ts`, secret `TAVILY_API_KEY`, free tier ~1,000 searches/month) — results arrive with page content included, and `apps/agent/src/search/synthesize.ts` turns them into a short spoken answer with sources.

## Deep research

`start_research` enqueues a background workflow that uses Gemini to perform deep research (`apps/agent/src/search/deepresearch.ts`, model var `GEMINI_MODEL`, default `gemini-2.5-flash`). The model plans and runs its own multi-source searches using Apollo's web search tool and returns a cited markdown report; the workflow persists it to R2, emails the full report to `APOLLO_OWNER_EMAIL` (best-effort — see [Email](email.md)), and speaks a short summary as a `background_result`. Cost is pay-per-use via Gemini API; if runs ever time out, a faster model config is a fallback.

The old homemade pipeline (Cloudflare `WEBSEARCH` binding + fetch/extract/synthesize) was removed: the binding is `account_disabled` on the free plan.

## When to use which

- Use quick search for “what’s the capital / latest score / one fact”
- Use deep research when the user wants a brief assembled from multiple sources

## Navigation

Prev: [Threads](threads.md) · Next: [Weather](weather.md)
