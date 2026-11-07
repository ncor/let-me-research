import { Plugin } from "@opencode/plugin"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { extractPdf, parsePageSpec, searchPages, type PdfResult } from "./pdf.ts"

/**
 * pdf_text - read a PDF as text, by page, without rendering it as images.
 *
 * The built-in `read` tool passes PDF pages to the model as images: slow,
 * expensive, and it cannot tell you which characters are on which page.
 * Verifying `#page=N` and building a `#:~:text=` fragment both need exact page
 * text, which is what this provides.
 */

const MAX_BYTES = 80 * 1024 * 1024
const DEFAULT_MAX_CHARS = 60_000

interface Input {
  url?: string
  path?: string
  pages?: string
  search?: string
  context?: number
  maxChars?: number
}

const cacheRoot = () => join(tmpdir(), "opencode", "pdf-cache")

async function ensureCache(): Promise<string> {
  const dir = cacheRoot()
  await mkdir(dir, { recursive: true })
  return dir
}

function looksLikePdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 1024)).toString("latin1").includes("%PDF")
}

/** Load from a local path, or fetch a URL once and reuse the cached copy. */
async function loadBytes(
  input: Input,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; origin: string; cached: boolean }> {
  if (input.path) {
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await readFile(input.path))
    } catch (err) {
      throw new Error(`cannot read ${input.path}: ${(err as Error).message}`)
    }
    if (!looksLikePdf(bytes)) throw new Error(`${input.path} is not a PDF (no %PDF header)`)
    return { bytes, origin: input.path, cached: false }
  }

  const url = input.url!
  const file = join(await ensureCache(), `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.pdf`)

  try {
    const cached = new Uint8Array(await readFile(file))
    if (looksLikePdf(cached)) return { bytes: cached, origin: url, cached: true }
  } catch {
    // Not cached yet; download below.
  }

  const res = await fetch(url, { signal, redirect: "follow" })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${url}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.length > MAX_BYTES) {
    throw new Error(`${url} is ${(bytes.length / 1e6).toFixed(1)} MB, over the ${MAX_BYTES / 1e6} MB limit`)
  }
  if (!looksLikePdf(bytes)) {
    throw new Error(
      `${url} is not a PDF (content-type: ${res.headers.get("content-type") ?? "unknown"}). ` +
        `Fetch it with webfetch instead.`,
    )
  }
  await writeFile(file, bytes).catch(() => {})
  return { bytes, origin: url, cached: false }
}

function warnings(doc: PdfResult): string[] {
  const out: string[] = []
  if (doc.encrypted) {
    out.push("WARNING: this PDF is encrypted. Text was recovered by scanning visible strings and may be incomplete.")
  }
  if (doc.suspectFontEncoding) {
    out.push(
      "WARNING: text decoded with an unsupported font encoding and may be garbled. " +
        "Do not build text fragments from it; fall back to #page=N or to `read`.",
    )
  } else if (doc.lowYield) {
    out.push(
      "WARNING: almost no text was extracted. This is probably a scanned document with no text layer. " +
        "Use `read` on the downloaded file to view pages as images instead.",
    )
  }
  const { pagesDeclared, pageCount } = doc.stats
  if (pagesDeclared && pagesDeclared > pageCount) {
    out.push(`WARNING: the document declares ${pagesDeclared} pages but only ${pageCount} were reachable.`)
  }
  return out
}

function pageText(doc: PdfResult, wanted: number[], maxChars: number): string {
  const blocks: string[] = []
  let used = 0
  let omitted = 0

  for (const n of wanted) {
    const header = `=== page ${n} ===`
    // Always return something for a requested page: truncate to the remaining
    // budget rather than dropping it, and only skip pages once it is exhausted.
    const budget = maxChars - used - header.length - 2
    if (budget < 80) {
      omitted++
      continue
    }

    let body = (doc.pages[n - 1] ?? "").trim() || "[no text extracted from this page]"
    if (body.length > budget) body = `${body.slice(0, budget).trimEnd()} …[page truncated]`

    const block = `${header}\n${body}`
    blocks.push(block)
    used += block.length + 2
  }

  if (omitted) {
    blocks.push(
      `[${omitted} further page(s) omitted: over the ${maxChars} character limit. ` +
        `Request fewer pages or raise maxChars.]`,
    )
  }
  return blocks.join("\n\n")
}

function searchResults(doc: PdfResult, query: string, context: number, maxChars: number): string {
  const hits = searchPages(doc.pages, query, context)
  if (!hits.length) {
    return (
      `No page contains "${query}".\n` +
      `The document has ${doc.pageCount} page(s). Try a shorter phrase, a different spelling, ` +
      `or read a page range to see the actual wording.`
    )
  }

  const lines: string[] = [`${hits.length} hit(s) for "${query}"`]
  let used = lines[0].length
  for (const hit of hits) {
    const block = `\npage ${hit.page}\n  ${hit.snippet}\n  fragment: ${hit.fragment}`
    if (used + block.length > maxChars) {
      lines.push("\n[further hits omitted: over the character limit]")
      break
    }
    lines.push(block)
    used += block.length
  }
  return lines.join("\n")
}

export default Plugin.define({
  id: "boring-search.pdf",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "pdf_text",
        description:
          "Read a PDF as text instead of as page images. Returns exact text per page, so you can confirm which " +
          "page a passage is on and copy verbatim wording for a #:~:text= fragment. Give a local path or a URL " +
          "(downloaded once, then cached). Pass `search` to find the pages containing a phrase - it returns page " +
          "numbers, verbatim snippets, and a ready-to-use fragment. Prefer this over `read` for any PDF.",
        input: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "HTTP(S) URL of the PDF. Downloaded and cached between calls.",
            },
            path: {
              type: "string",
              description: "Local path to an already-downloaded PDF. Use either this or url.",
            },
            pages: {
              type: "string",
              description:
                "Page selection, 1-based physical page numbers as used by #page=N: \"7\", \"2-5\", \"1,4,10-12\". " +
                "Omit for every page. Ignored when search is set.",
            },
            search: {
              type: "string",
              description:
                "Phrase to locate. Whitespace-insensitive and case-insensitive, so it still matches text the " +
                "extractor split across lines. Returns page numbers plus verbatim context.",
            },
            context: {
              type: "integer",
              description: "Characters of context around each search hit. Default 180.",
            },
            maxChars: {
              type: "integer",
              description: `Cap on returned characters. Default ${DEFAULT_MAX_CHARS}.`,
            },
          },
          additionalProperties: false,
        },
        execute: async (raw, context) => {
          const input = raw as Input
          const maxChars = input.maxChars && input.maxChars > 0 ? input.maxChars : DEFAULT_MAX_CHARS

          if (!input.url && !input.path) {
            return { content: "error: provide either `url` or `path`." }
          }
          if (input.url && input.path) {
            return { content: "error: provide only one of `url` or `path`." }
          }

          try {
            await context.progress({ status: input.url ? "downloading pdf" : "reading pdf" })
            const { bytes, origin, cached } = await loadBytes(input, context.signal)

            await context.progress({ status: "extracting text" })
            const doc = extractPdf(bytes)
            if (!doc.pageCount) {
              return { content: `error: no pages found in ${origin}. The file may be corrupt.` }
            }

            const head = [
              `source: ${origin}${cached ? " (cached)" : ""}`,
              `pages: ${doc.pageCount}`,
              `size: ${(bytes.length / 1024).toFixed(0)} KB`,
            ]
            const notes = warnings(doc)
            const banner = [...head, ...notes].join("\n")

            let body: string
            if (input.search && input.search.trim()) {
              await context.progress({ status: `searching "${input.search.trim().slice(0, 40)}"` })
              body = searchResults(doc, input.search, input.context ?? 180, maxChars)
            } else {
              const wanted = parsePageSpec(input.pages, doc.pageCount)
              if (!wanted.length) {
                return {
                  content: `${banner}\n\nerror: page selection "${input.pages}" matches no page. ` +
                    `This document has ${doc.pageCount} page(s).`,
                }
              }
              body = pageText(doc, wanted, maxChars)
            }

            return { content: `${banner}\n\n${body}` }
          } catch (err) {
            return { content: `error: ${(err as Error).message}` }
          }
        },
      })
    })
  },
})
