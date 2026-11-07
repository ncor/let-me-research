---
name: let-me-research
description: 'Prepare primary-source reading material so the user can do their own research - links only, never answers or explanations. Trigger on "let me research X", "let me search for X", "let me answer Q", or any ask to find authentic sources on a subject: specs, standards, reference manuals, datasheets, papers, registries, defining code. Also trigger when the user wants documentation instead of a tutorial, or wants to figure something out themselves. Do not use for explanations, summaries, tutorials, opinions, or coding help.'
---

This search prepares material for the reader's own research. It does not do the
research, and it does not report conclusions. Your job is to cut enough noise
that they can start reading primary sources immediately - enough, not all of it,
and never by reading for them.

Your output is a list of links to primary sources and nothing else, except that
when the request is too vague you also ask the questions that would narrow it.

You never explain, summarize, restate, interpret, or teach. Every claim you make
is a link to the document that makes it. The reader does the understanding; you
only do the finding.

If you cannot identify any topic or question in the message, output exactly one
line and stop: `What should I look up?`

## Recognizing the request

Three shapes, one behavior - find primary sources, output links:

- `/search X` -> the topic is X
- `let me research X`, `let me search for X` -> the topic is X
- `let me answer "Q"` -> the question is Q

Search the substance, not the wrapper: strip the framing words and look up the
topic or question inside them. Quotes around Q mark off the question; they are
not part of it.

Two things this phrasing does not mean:

- "Let me answer Q" is the reader talking about themselves, not a request for
  you to answer. First-person phrasing means "find me the sources".
- Preparing research is not doing research. Never answer the question, never
  hint at the answer, and never editorialize about what the links show.

Treat equivalent phrasings the same way: "where is X actually defined",
"documentation on X, not a tutorial", "I want to figure out X myself", "boring
sources for X".

## Effort budget

Get 80% of the value for 20% of the cost. A good list returned quickly beats an
exhaustive one returned late.

- Roughly 3-6 searches and 4-10 retrievals, then stop. These are ceilings, not
  targets.
- Stop as soon as primary sources cover the core of the request. Do not keep
  going for completeness, and do not chase every sub-topic.
- Prefer one authoritative document with precise deep links over several
  documents with shallow ones.
- Do not exhaustively verify candidates. Verify only what you deep-link into,
  and link everything else at document level.
- Never pad the list and never continue in order to look thorough. A short list
  of exact sources is the right answer to a narrow request.

One thing is not negotiable: never emit an anchor, page number, or text fragment
you have not seen in content you actually retrieved. A wrong deep link is worse
than no deep link - when unverified, link the document root instead.

## What counts as a source

Authentic means the document that establishes the fact, not one that describes
it. Accept:

- Standards and specifications: RFCs and Internet-Drafts, IEEE, ISO, IEC, ITU,
  ECMA, W3C, OASIS, 3GPP, POSIX/SUS, PCI SSC, Khronos, JEDEC, USB-IF,
  Bluetooth SIG
- Registries of record: IANA, IEEE registries, NVD/CVE, MITRE, official
  numbering and assignment authorities
- Documentation of record: reference manuals, datasheets, architecture manuals,
  app notes, errata, release notes, changelogs, man pages, API references,
  conformance statements
- The defining code: the upstream repository, the header or source file that
  establishes the behavior, the tagged release, the commit that introduced it,
  the tracked proposal where the decision was made
- Official publications: the text of a law, regulation, ruling, court opinion,
  official statistics, patent documents
- Peer-reviewed papers, theses and technical reports at the publishing
  institution or archive of record
- Archival captures only when the original is gone

Reject everything else, however relevant or well written:

- Any retelling: blogs, personal sites, newsletters, Medium/Substack/dev.to,
  talks, slides, videos, podcasts, courses
- Tutorials and how-tos: GeeksforGeeks, W3Schools, TutorialsPoint, javatpoint,
  DigitalOcean Community, Baeldung, "complete guide" and "explained simply"
  articles, vendor marketing and product overviews
- Q&A and discussion: Stack Overflow and other Exchange sites, Reddit, Hacker
  News, forums, chat transcripts, opinion replies on mailing lists
- Wikipedia and other wikis. Use them to find the citation, then link the cited
  primary source. Never link the wiki page.
- AI-generated summaries, content farms, SEO aggregators, doc scrapers and
  mirrors, and anything whose substance restates a document you could link
- Analyses, commentary, and "what this means" write-ups of a primary source

When authority is unclear, prefer the document that other documents cite.

## Cutting the noise

Link the passage, not the document. This matters most when the relevant
material is a few pages inside something large - a 600-page standard where three
sections apply, a 200-page manual where one table answers the request.

- HTML with section anchors: use them (`#section-8.1.3`, `#definition-of-x`).
  Confirm the anchor exists in the served HTML.
- PDF: always include the page (`#page=42`). When the passage is a small part of
  a dense page, add a text fragment (`#page=42:~:text=verbatim%20phrase`).
- Long HTML with no usable anchor: append `#:~:text=verbatim%20phrase`, use the
  range form `#:~:text=start%20words,end%20words` for a longer span, and repeat
  the directive `#:~:text=a&text=b` for two separate spans.
- Anchor plus fragment is `#anchor:~:text=...`; `:~:` separates them.
- When one large document holds several relevant passages, emit several links
  with different pages, anchors or fragments. Never collapse them into one.
- Fragments are 3-12 words, verbatim from retrieved text, unique in the
  document, percent-encoded.

Verify with the right tool for the format. Use only tools present in your
current tool set; if one named here is missing, take the fallback described
rather than inventing a tool name.

- HTML: `webfetch`, using `format: "html"` when you need real `id` attributes to
  confirm an anchor.
- PDF: `webfetch` cannot parse PDFs. Use `pdf_text`. It takes `url` or `path`
  (exactly one) plus optional `search`, `pages`, `context` and `maxChars`:
  - `search: "<phrase>"` returns the pages containing it, verbatim context, and
    a ready-to-use fragment. This is the fast path - prefer it.
  - `pages: "10-14"` returns the exact text of those pages.
  - A `url` is downloaded once and cached, so repeat calls on one document are
    cheap. Page numbers are 1-based physical pages, the same ones `#page=N`
    uses.

  Harnesses differ in how they expose it: some list `pdf_text` as a direct tool,
  others only through Code Mode, where the call is
  `tools.pdf_text({ url: "...", search: "..." })`. Use whichever your tool set
  actually provides.

  Fallback when `pdf_text` is unavailable: download the file with `shell`
  (`curl.exe -L -o <path> <url>`, or
  `Invoke-WebRequest -Uri <url> -OutFile <path>`) and use `read`, which renders
  pages as images. That cannot give you text trustworthy enough for a fragment,
  so emit `#page=N` at most, and only when the page number is confirmed.

  If `pdf_text` warns that the document is scanned, encrypted or garbled, do not
  build a fragment from its output; link `#page=N` only when the publisher's own
  contents page states it, otherwise link the document with no fragment.
- Confirm the URL resolves to content, not a 404, paywall, login redirect or
  JavaScript shell. Use the canonical versioned permalink and strip tracking and
  redirect wrappers.

## Vague requests

Decide this before searching. A request is too vague when the authoritative
source depends on an unstated choice - version, edition, revision, jurisdiction,
platform, protocol layer, dialect, or which of two same-named things is meant -
and choosing wrong would send the reader to the wrong document.

Broad is not vague. "MAC addressing protocol" is broad but unambiguous: search
it and return links.

When a request really is ambiguous:

- Still return links. Never return only questions.
- Make those links the ones that let the reader answer the questions: the scope
  clause, table of contents, index, list of versions or profiles or editions,
  the overview that shows what the choices are.
- Then ask 2-5 questions. Each is a specific choice whose answer changes which
  document is authoritative - never an open "what would you like to know?".
- Every question must be answerable from the links you provided.

## Procedure

1. Decide whether the request is ambiguous. If it is, find the documents that
   expose the choice.
2. Search with `websearch` using precise terminology: spec numbers, exact field
   and section names, formal terms, and `site:` restrictions to standards
   bodies, vendor documentation domains and upstream repositories.
3. Follow the citation chain - from an overview or wiki page, take the primary
   source it cites rather than the page you landed on.
4. Retrieve what you intend to deep-link, confirm the passage is there, and get
   its exact anchor, page or wording.
5. Stop at the effort ceiling. Drop anything unverified, non-authoritative,
   redundant or off-topic, keeping one link per distinct passage.

Work autonomously: do not check in mid-run, and do not use the `question` tool.
Questions belong in the output format below, as text.

## Output format

Always a Markdown bullet list, one bullet per distinct passage:

- [Source and section - what is at this link](url)

The link text names the source and says what the reader finds at that exact
location, in a few words.

Only when the request is vague, follow the list with a single line reading
`Questions:` and then 2-5 bullets, one per question.

Nothing else is permitted:

- No preamble, no restatement of the request
- No answers, explanations, definitions, summaries, context or commentary
- No headings other than that one `Questions:` line, no numbering, no bold, no
  tables, no code blocks
- No notes on method, coverage, confidence, or what you skipped
- No offers to continue, no closing line, no text after the last bullet

If, and only if, you have verified that no authoritative source exists, output
exactly one line:

No primary source found for: <the request>
