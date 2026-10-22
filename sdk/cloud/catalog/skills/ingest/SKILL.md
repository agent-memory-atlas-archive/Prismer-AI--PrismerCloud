---
name: ingest
scope: common
description: Read web pages and search the web through the workspace Load lane. A query or URL returns document outlines with refs; pass refs back to read the original text of the sections you need, batch several refs in one call, and follow nextRef only while more evidence is needed. Use whenever the user gives a URL, asks you to read a webpage, or wants top-K pages on a topic. Hermes uses the `workspace_web_search` / `web_load` tools; other runtimes use the `cloud search` / `cloud load` CLI. For local document parsing (PDF text + OCR), use the `liteparse` skill instead.
---

# Ingest

Use this skill to **bring external web content into your context by navigating, not by dumping whole pages**: the first call returns each document's outline with refs, later calls read only the sections you choose, as original text.

> **Local documents (PDF text extraction + OCR) are handled by the `liteparse` skill**, not here — it's a local-first, zero-network tool with Tesseract + PDFium bundled. `ingest` covers web URLs only.

## When to use

- The user pastes a URL or asks "what does this page say".
- The user asks to research a topic ("AI agent frameworks 2025") — search, then read the relevant sections of the top pages.
- A task description contains URLs that need to be resolved into actual content before the assignee can act.

> Attached PDFs / images / scans → use the `liteparse` skill (local-first PDF text + OCR), not `ingest`.

## Tools

| Runtime | Discover (query or URL) | Read sections |
| --- | --- | --- |
| Hermes | `workspace_web_search(query, limit)` or `web_load(input="<URL>")` | `web_load(input=["<ref>", "<ref>"])` — up to 5 refs per call |
| Other runtimes | `cloud search "<query>"` / `cloud load <url>` | `cloud load '<ref>' '<ref>'` — quote refs in the shell |

All of them use the same workspace-billed cloud lane (`/api/context/load`). Never script HTTP via `execute_code`/subprocess/curl for web research.

## How navigation works

- **Discovery** searches (default top 5, max 10) or fetches the URL, caches the full text, and returns per document `status: "ok"`, `url`, `title`, `ref` and an `outline` of `{title, ref, hasChildren, estimatedTokens}`.
- **An outline is not evidence.** Titles only tell you where to look; only `content` is the source's text.
- **Reading a ref**: a section with children returns its sub-outline; a leaf returns `content` — the original extracted text (not a summary) with `source.url` and its character range. Use `contentRef` to read a whole section as text instead of its sub-outline.
- **`nextRef`** means the outline or text continues. Follow it only when you still need more of that section.
- **`next_calls`** are mechanical suggestions (continuations, or each document's first section), not a relevance ranking — choose sections from the outline titles and your question.
- **`status: "deferred"`** (`BUDGET_EXHAUSTED`): the response budget ran out before that item; call again with its `ref`.
- **`status: "error"`**: `FETCH_FAILED` / `CONTENT_UNAVAILABLE` — the page could not be read; `REF_UNAVAILABLE` — the ref expired (7 days) or is not yours, so load the URL again for a fresh one.
- Copy refs exactly as returned. Never build or edit a ref (including its `offset`).

## Workflow

1. Discover: topic → `workspace_web_search` / `cloud search`; known URL → `web_load` / `cloud load`.
2. Pick the sections whose titles match the question and read them in one batched call.
3. Drill into a sub-outline or follow `nextRef` only where the text you have does not answer yet.
4. Stop as soon as the text you read answers the question — don't read whole documents by default.
5. Answer from `content` only. Cite each source by URL (and section title); quote exact sentences when the user needs wording.
6. If a document failed, name the failed URL and don't claim you read it.

## CLI reference

```bash
cloud search "AI agent frameworks 2025"           # top-5 outlines + refs (JSON)
cloud search "topic" -k 10
cloud load https://example.com                     # outline + refs (JSON)
cloud load https://a.com https://b.com             # batch of URLs and/or refs (up to 20)
cloud load 'prismer://load/<id>/n3' 'prismer://load/<id>/n7'   # read the chosen sections
cloud load '<ref>' --max-tokens 8000               # bigger page (512–16000, default 4000)
cloud load https://example.com --format hqcc       # legacy: one compressed summary, no refs
```

## Operating Rules

- Discovery does the search/fetch work and is billed to the workspace. Reading refs only reads the cached snapshot (no new search or fetch), but every page you read lands in your context — read only the sections you need.
- `web_load` also reads workspace `prismer://asset/…` / `prismer://…/file/…` pointers (see the `memory` skill); those return the asset text directly, without refs.
- A cached URL keeps serving its snapshot for 7 days; there is no forced refresh.
- For a document / image / scan (not a web page), hand off to the `liteparse` skill — `ingest` does not do OCR or PDF extraction.

## Backing capabilities (D22 mapping)

Replaces the v1.x built-in skill `context-load`. Local document OCR /
extraction (formerly `parse-document`, backed by the now-retired
`parser.prismer.dev` service) moved to the local-first `liteparse` skill.
