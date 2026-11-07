/**
 * Dependency-free PDF text extractor.
 *
 * Why this exists: the `read` tool renders PDFs as page images, which is slow,
 * token-expensive, and cannot tell you exactly which characters are on a page -
 * the two things needed to build a verified `#page=N:~:text=` fragment.
 *
 * Scope: enough PDF parsing to get readable text out of real-world documents
 * (specs, RFCs, manuals). Handles classic and compressed xref layouts by
 * scanning for objects rather than trusting the xref table, object streams
 * (ObjStm), Flate/ASCIIHex/ASCII85 filters, page trees with inherited
 * resources, form XObjects, and ToUnicode CMaps for glyph-encoded fonts.
 *
 * Not handled: encryption, scanned/raster pages (no OCR), LZW and JBIG2 image
 * filters, and fonts that carry neither a ToUnicode map nor a standard
 * encoding. Those cases surface as low text yield rather than silent nonsense.
 */

import { inflateSync, constants as zlibConst } from "node:zlib"

/* ------------------------------------------------------------------ *
 * PDF value model
 * ------------------------------------------------------------------ */

export type PdfValue =
  | { t: "num"; v: number }
  | { t: "bool"; v: boolean }
  | { t: "null" }
  | { t: "name"; v: string }
  | { t: "str"; v: string }
  | { t: "ref"; n: number }
  | { t: "array"; v: PdfValue[] }
  | { t: "dict"; v: Map<string, PdfValue> }
  | { t: "op"; v: string }

const isWs = (c: number) =>
  c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00

const isDelim = (c: number) =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d ||
  c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25

const hex2str = (hex: string): string => {
  let out = ""
  for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16))
  return out
}

/** UTF-16BE hex payload -> JS string (ToUnicode destination format). */
const utf16be = (hex: string): string => {
  let out = ""
  for (let i = 0; i + 3 < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
  if (out === "" && hex.length === 2) out = String.fromCharCode(parseInt(hex, 16))
  return out
}

/* ------------------------------------------------------------------ *
 * Object parser
 * ------------------------------------------------------------------ */

class Reader {
  constructor(public s: string, public i = 0) {}

  skipWs() {
    while (this.i < this.s.length) {
      const c = this.s.charCodeAt(this.i)
      if (isWs(c)) {
        this.i++
      } else if (c === 0x25) {
        while (this.i < this.s.length && this.s.charCodeAt(this.i) !== 0x0a && this.s.charCodeAt(this.i) !== 0x0d) this.i++
      } else break
    }
  }

  /** Parse one value. Returns null on malformed input rather than throwing. */
  parse(): PdfValue | null {
    this.skipWs()
    if (this.i >= this.s.length) return null
    const c = this.s.charCodeAt(this.i)

    if (c === 0x2f) return this.parseName()
    if (c === 0x28) return this.parseLiteralString()
    if (c === 0x3c) {
      if (this.s[this.i + 1] === "<") return this.parseDict()
      return this.parseHexString()
    }
    if (c === 0x5b) return this.parseArray()

    if (c === 0x2b || c === 0x2d || c === 0x2e || (c >= 0x30 && c <= 0x39)) return this.parseNumberOrRef()

    if (this.s.startsWith("true", this.i)) {
      this.i += 4
      return { t: "bool", v: true }
    }
    if (this.s.startsWith("false", this.i)) {
      this.i += 5
      return { t: "bool", v: false }
    }
    if (this.s.startsWith("null", this.i)) {
      this.i += 4
      return { t: "null" }
    }

    // Bare keyword (content-stream operator or stray token).
    const start = this.i
    while (this.i < this.s.length) {
      const ch = this.s.charCodeAt(this.i)
      if (isWs(ch) || isDelim(ch)) break
      this.i++
    }
    if (this.i === start) this.i++
    return { t: "op", v: this.s.slice(start, this.i) }
  }

  private parseName(): PdfValue {
    this.i++ // '/'
    let out = ""
    while (this.i < this.s.length) {
      const ch = this.s.charCodeAt(this.i)
      if (isWs(ch) || isDelim(ch)) break
      if (ch === 0x23 && /[0-9a-fA-F]{2}/.test(this.s.slice(this.i + 1, this.i + 3))) {
        out += String.fromCharCode(parseInt(this.s.slice(this.i + 1, this.i + 3), 16))
        this.i += 3
      } else {
        out += this.s[this.i]
        this.i++
      }
    }
    return { t: "name", v: out }
  }

  private parseLiteralString(): PdfValue {
    this.i++ // '('
    let depth = 1
    let out = ""
    while (this.i < this.s.length) {
      const ch = this.s.charCodeAt(this.i)
      if (ch === 0x5c) {
        const nxt = this.s.charCodeAt(this.i + 1)
        const map: Record<number, string> = {
          0x6e: "\n", 0x72: "\r", 0x74: "\t", 0x62: "\b", 0x66: "\f",
          0x28: "(", 0x29: ")", 0x5c: "\\",
        }
        if (map[nxt] !== undefined) {
          out += map[nxt]
          this.i += 2
        } else if (nxt >= 0x30 && nxt <= 0x37) {
          let oct = ""
          let k = 0
          while (k < 3 && this.s.charCodeAt(this.i + 1 + k) >= 0x30 && this.s.charCodeAt(this.i + 1 + k) <= 0x37) {
            oct += this.s[this.i + 1 + k]
            k++
          }
          out += String.fromCharCode(parseInt(oct, 8) & 0xff)
          this.i += 1 + k
        } else if (nxt === 0x0a) {
          this.i += 2
        } else if (nxt === 0x0d) {
          this.i += this.s.charCodeAt(this.i + 2) === 0x0a ? 3 : 2
        } else {
          this.i += 1
        }
        continue
      }
      if (ch === 0x28) depth++
      else if (ch === 0x29) {
        depth--
        if (depth === 0) {
          this.i++
          break
        }
      }
      out += this.s[this.i]
      this.i++
    }
    return { t: "str", v: out }
  }

  private parseHexString(): PdfValue {
    this.i++ // '<'
    let hex = ""
    while (this.i < this.s.length && this.s[this.i] !== ">") {
      const ch = this.s[this.i]
      if (/[0-9a-fA-F]/.test(ch)) hex += ch
      this.i++
    }
    this.i++ // '>'
    if (hex.length % 2) hex += "0"
    return { t: "str", v: hex2str(hex) }
  }

  private parseArray(): PdfValue {
    this.i++ // '['
    const items: PdfValue[] = []
    for (;;) {
      this.skipWs()
      if (this.i >= this.s.length) break
      if (this.s[this.i] === "]") {
        this.i++
        break
      }
      const before = this.i
      const v = this.parse()
      if (!v) break
      if (v.t === "op" && v.v === "]" ) break
      items.push(v)
      if (this.i === before) this.i++
    }
    return { t: "array", v: items }
  }

  private parseDict(): PdfValue {
    this.i += 2 // '<<'
    const map = new Map<string, PdfValue>()
    for (;;) {
      this.skipWs()
      if (this.i >= this.s.length) break
      if (this.s[this.i] === ">" && this.s[this.i + 1] === ">") {
        this.i += 2
        break
      }
      if (this.s[this.i] !== "/") {
        // Malformed key: skip a token to avoid an infinite loop.
        const v = this.parse()
        if (!v || this.i >= this.s.length) break
        continue
      }
      const key = (this.parse() as { t: "name"; v: string }).v
      const val = this.parse()
      if (!val) break
      map.set(key, val)
    }
    return { t: "dict", v: map }
  }

  private parseNumberOrRef(): PdfValue {
    const start = this.i
    while (this.i < this.s.length) {
      const ch = this.s.charCodeAt(this.i)
      if ((ch >= 0x30 && ch <= 0x39) || ch === 0x2b || ch === 0x2d || ch === 0x2e) this.i++
      else break
    }
    const num = Number(this.s.slice(start, this.i))
    if (!Number.isFinite(num)) return { t: "num", v: 0 }

    // "N G R" indirect reference? Only integers can start one.
    if (/^\d+$/.test(this.s.slice(start, this.i))) {
      const save = this.i
      this.skipWs()
      const genStart = this.i
      while (this.i < this.s.length && /[0-9]/.test(this.s[this.i])) this.i++
      if (this.i > genStart) {
        this.skipWs()
        if (this.s[this.i] === "R" && (this.i + 1 >= this.s.length || isWs(this.s.charCodeAt(this.i + 1)) || isDelim(this.s.charCodeAt(this.i + 1)))) {
          this.i++
          return { t: "ref", n: num }
        }
      }
      this.i = save
    }
    return { t: "num", v: num }
  }
}

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

function ascii85(data: Uint8Array): Uint8Array | undefined {
  const text = Buffer.from(data).toString("latin1").replace(/^<~/, "").replace(/~>[\s\S]*$/, "")
  const out: number[] = []
  let tuple: number[] = []
  for (const ch of text) {
    if (ch === "z" && tuple.length === 0) {
      out.push(0, 0, 0, 0)
      continue
    }
    if (ch < "!" || ch > "u") continue
    tuple.push(ch.charCodeAt(0) - 33)
    if (tuple.length === 5) {
      let n = 0
      for (const d of tuple) n = n * 85 + d
      out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
      tuple = []
    }
  }
  if (tuple.length) {
    const pad = 5 - tuple.length
    for (let i = 0; i < pad; i++) tuple.push(84)
    let n = 0
    for (const d of tuple) n = n * 85 + d
    const bytes = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
    out.push(...bytes.slice(0, 4 - pad))
  }
  return Uint8Array.from(out)
}

function inflate(data: Uint8Array): Uint8Array | undefined {
  try {
    return inflateSync(data, { finishFlush: zlibConst.Z_SYNC_FLUSH })
  } catch {
    try {
      return inflateSync(data)
    } catch {
      return undefined
    }
  }
}

function decodeStream(dict: Map<string, PdfValue>, data: Uint8Array, doc?: PdfDoc): Uint8Array | undefined {
  const filter = dict.get("Filter")
  const filters: string[] = []
  const push = (v: PdfValue | undefined) => {
    if (!v) return
    if (v.t === "name") filters.push(v.v)
    else if (v.t === "array") for (const f of v.v) if (f.t === "name") filters.push(f.v)
  }
  push(filter)
  if (!filters.length) return data

  let cur: Uint8Array | undefined = data
  for (const f of filters) {
    if (!cur) return undefined
    switch (f) {
      case "FlateDecode":
      case "Fl": {
        const out = inflate(cur)
        if (!out && doc) doc.stats.inflateFailures++
        cur = out
        break
      }
      case "ASCIIHexDecode":
      case "AHx": {
        const hex = Buffer.from(cur).toString("latin1").replace(/[^0-9a-fA-F]/g, "")
        cur = Uint8Array.from(Buffer.from(hex.length % 2 ? hex + "0" : hex, "hex"))
        break
      }
      case "ASCII85Decode":
      case "A85":
        cur = ascii85(cur)
        break
      default:
        return undefined // image codecs (DCT, JPX, JBIG2, CCITT) or LZW: not text
    }
  }
  return cur
}

/* ------------------------------------------------------------------ *
 * Document index
 * ------------------------------------------------------------------ */

interface RawObject {
  num: number
  value: PdfValue | null
  stream?: Uint8Array
  dict?: Map<string, PdfValue>
}

export interface PdfStats {
  objectHeaders: number
  objects: number
  streams: number
  streamsDecoded: number
  objStmFound: number
  objStmDecoded: number
  objStmObjects: number
  inflateFailures: number
  catalogFound: boolean
  pagesViaTree: boolean
  pageCount: number
  pagesDeclared?: number
  fonts: number
  fontsWithToUnicode: number
  fontsWithDifferences: number
}

class PdfDoc {
  objects = new Map<number, PdfValue>()
  streams = new Map<number, Uint8Array>()
  encrypted = false
  stats: PdfStats = {
    objectHeaders: 0,
    objects: 0,
    streams: 0,
    streamsDecoded: 0,
    objStmFound: 0,
    objStmDecoded: 0,
    objStmObjects: 0,
    inflateFailures: 0,
    catalogFound: false,
    pagesViaTree: false,
    pageCount: 0,
    fonts: 0,
    fontsWithToUnicode: 0,
    fontsWithDifferences: 0,
  }

  /** Font decoding is expensive and repeated per page, so cache by object number. */
  fontCache = new Map<number, FontInfo>()

  get(v: PdfValue | undefined): PdfValue | undefined {
    let cur = v
    for (let hop = 0; hop < 32 && cur && cur.t === "ref"; hop++) cur = this.objects.get(cur.n)
    return cur
  }

  dict(v: PdfValue | undefined): Map<string, PdfValue> | undefined {
    const r = this.get(v)
    return r && r.t === "dict" ? r.v : undefined
  }

  num(v: PdfValue | undefined): number | undefined {
    const r = this.get(v)
    return r && r.t === "num" ? r.v : undefined
  }

  name(v: PdfValue | undefined): string | undefined {
    const r = this.get(v)
    return r && r.t === "name" ? r.v : undefined
  }

  streamOf(v: PdfValue | undefined): Uint8Array | undefined {
    const base = v && v.t === "ref" ? this.streams.get(v.n) : undefined
    return base
  }
}

function collectObjects(doc: PdfDoc, bytes: Uint8Array) {
  const text = Buffer.from(bytes).toString("latin1")
  const raw: RawObject[] = []
  const re = /(\d+)\s+(\d+)\s+obj\b/g
  let m: RegExpExecArray | null

  while ((m = re.exec(text))) {
    const num = Number(m[1])
    const r = new Reader(text, m.index + m[0].length)
    let value: PdfValue | null = null
    try {
      value = r.parse()
    } catch {
      continue
    }
    if (!value) continue

    let stream: Uint8Array | undefined
    r.skipWs()
    if (text.startsWith("stream", r.i)) {
      let start = r.i + 6
      if (text[start] === "\r") start++
      if (text[start] === "\n") start++
      let end = text.indexOf("endstream", start)
      if (end < 0) end = text.length

      const dict = value.t === "dict" ? value.v : undefined
      const declared = dict ? doc.num(dict.get("Length")) : undefined
      if (declared && declared > 0 && start + declared <= bytes.length) {
        stream = bytes.subarray(start, start + declared)
      } else {
        stream = bytes.subarray(start, end)
      }
    }

    raw.push({ num, value, stream, dict: value.t === "dict" ? value.v : undefined })
  }

  // First pass: plain objects plus decompressed streams.
  doc.stats.objectHeaders = raw.length
  const pendingObjStm: RawObject[] = []
  for (const o of raw) {
    if (!o.value) continue
    doc.objects.set(o.num, o.value)
    if (o.stream) {
      doc.stats.streams++
      const decoded = decodeStream(o.dict ?? new Map(), o.stream, doc)
      if (decoded) {
        doc.streams.set(o.num, decoded)
        doc.stats.streamsDecoded++
      }
      const typeVal = o.dict?.get("Type")
      if (typeVal?.t === "name" && typeVal.v === "ObjStm") {
        doc.stats.objStmFound++
        pendingObjStm.push(o)
      }
    }
  }

  // Second pass: objects packed inside object streams.
  for (const o of pendingObjStm) {
    const data = doc.streams.get(o.num)
    if (!data || !o.dict) continue
    const n = doc.num(o.dict.get("N"))
    const first = doc.num(o.dict.get("First"))
    if (!n || first === undefined) continue

    const inner = Buffer.from(data).toString("latin1")
    const header = new Reader(inner.slice(0, first))
    const pairs: { num: number; offset: number }[] = []
    for (let k = 0; k < n; k++) {
      const a = header.parse()
      const b = header.parse()
      if (!a || !b || a.t !== "num" || b.t !== "num") break
      pairs.push({ num: a.v, offset: b.v })
    }
    if (pairs.length) doc.stats.objStmDecoded++
    for (const p of pairs) {
      const rr = new Reader(inner, first + p.offset)
      const v = rr.parse()
      if (v && !doc.objects.has(p.num)) {
        doc.objects.set(p.num, v)
        doc.stats.objStmObjects++
      }
    }
  }

  doc.stats.objects = doc.objects.size

  if (doc.objects.size) return

  // Last resort: encrypted or badly damaged file. Scan for visible strings.
  const strings: string[] = []
  const sre = /\(((?:[^()\\]|\\.)*)\)\s*Tj/g
  let sm: RegExpExecArray | null
  while ((sm = sre.exec(text))) strings.push(sm[1].replace(/\\([()\\])/g, "$1"))
  if (strings.length) doc.objects.set(-1, { t: "str", v: strings.join("\n") })
}

/* ------------------------------------------------------------------ *
 * Page tree
 * ------------------------------------------------------------------ */

interface PageEntry {
  index: number
  dict: Map<string, PdfValue>
  resources?: PdfValue
}

function walkTree(doc: PdfDoc, node: Map<string, PdfValue>, resources: PdfValue | undefined, out: PageEntry[], seen: Set<number>) {
  const type = doc.name(node.get("Type"))
  const inherited = resources ?? node.get("Resources")

  if (type === "Page" || (!node.has("Kids") && node.has("Contents"))) {
    out.push({ index: out.length, dict: node, resources: inherited })
    return
  }

  const kids = doc.get(node.get("Kids"))
  if (!kids || kids.t !== "array") return
  for (const kid of kids.v) {
    if (kid.t === "ref" && seen.has(kid.n)) continue
    if (kid.t === "ref") seen.add(kid.n)
    const kd = doc.dict(kid)
    if (kd) walkTree(doc, kd, inherited, out, seen)
  }
}

function pageList(doc: PdfDoc): PageEntry[] {
  // Prefer the catalog -> Pages -> Kids path so order matches the document.
  for (const [, value] of doc.objects) {
    if (value.t !== "dict") continue
    if (doc.name(value.v.get("Type")) !== "Catalog") continue
    doc.stats.catalogFound = true
    const pagesRef = value.v.get("Pages")
    const pages = doc.dict(pagesRef)
    if (!pages) continue
    // The document's own page claim, so a truncated walk is visible.
    doc.stats.pagesDeclared = doc.num(pages.get("Count"))
    const out: PageEntry[] = []
    walkTree(doc, pages, pages.get("Resources"), out, new Set())
    if (out.length) {
      doc.stats.pagesViaTree = true
      return out
    }
  }

  // Fallback: every /Type /Page object in object-number order.
  const out: PageEntry[] = []
  const nums = [...doc.objects.keys()].sort((a, b) => a - b)
  for (const num of nums) {
    const value = doc.objects.get(num)
    if (value?.t !== "dict") continue
    if (doc.name(value.v.get("Type")) === "Page") {
      out.push({ index: out.length, dict: value.v, resources: value.v.get("Resources") })
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Fonts
 * ------------------------------------------------------------------ */

interface FontInfo {
  twoByte: boolean
  map?: Map<string, string>
}

const CP1252: Record<number, string> = {
  0x80: "\u20ac", 0x82: "\u201a", 0x83: "\u0192", 0x84: "\u201e", 0x85: "\u2026",
  0x86: "\u2020", 0x87: "\u2021", 0x88: "\u02c6", 0x89: "\u2030", 0x8a: "\u0160",
  0x8b: "\u2039", 0x8c: "\u0152", 0x8e: "\u017d", 0x91: "\u2018", 0x92: "\u2019",
  0x93: "\u201c", 0x94: "\u201d", 0x95: "\u2022", 0x96: "\u2013", 0x97: "\u2014",
  0x98: "\u02dc", 0x99: "\u2122", 0x9a: "\u0161", 0x9b: "\u203a", 0x9c: "\u0153",
  0x9e: "\u017e", 0x9f: "\u0178",
}

function parseToUnicode(cmap: string): Map<string, string> {
  const map = new Map<string, string>()

  /**
   * Canonical key: uppercase hex with leading zeros stripped. A simple font's
   * CMap writes 2-digit sources and a composite font writes 4, while lookups
   * are built from byte values, so both sides must collapse to one form.
   */
  const canon = (hex: string) => hex.toUpperCase().replace(/^0+(?=.)/, "")

  // Split on the block delimiters, keeping them, so bfchar and bfrange bodies
  // are parsed with the right arity. Guessing from the number of hex strings
  // present mis-pairs bfchar entries and shifts the whole map by one.
  const parts = cmap.split(/(beginbfchar|beginbfrange)/)

  for (let i = 1; i < parts.length; i += 2) {
    const kind = parts[i]
    const bodyRaw = parts[i + 1] ?? ""
    const stop = bodyRaw.search(/end(?:bfchar|bfrange)/)
    const body = stop >= 0 ? bodyRaw.slice(0, stop) : bodyRaw

    if (kind === "beginbfchar") {
      for (const m of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
        map.set(canon(m[1]), utf16be(m[2]))
      }
      continue
    }

    for (const m of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1], 16)
      const hi = parseInt(m[2], 16)
      const width = m[1].length
      if (hi < lo || hi - lo > 0xffff) continue

      if (m[3].startsWith("[")) {
        const list = [...m[3].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => utf16be(x[1]))
        for (let c = lo, k = 0; c <= hi && k < list.length; c++, k++) {
          map.set(canon(c.toString(16).padStart(width, "0")), list[k])
        }
      } else {
        const dst = m[3].slice(1, -1)
        const prefix = dst.length > 4 ? dst.slice(0, -4) : ""
        const base = parseInt(dst.slice(-4) || "0", 16)
        for (let c = lo; c <= hi; c++) {
          map.set(canon(c.toString(16).padStart(width, "0")), utf16be(prefix + (base + (c - lo)).toString(16).padStart(4, "0")))
        }
      }
    }
  }
  return map
}

/** Compact Adobe Glyph List subset: the names that actually appear in text PDFs. */
const GLYPH_NAMES: Record<string, string> = {
  space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%",
  ampersand: "&", quotesingle: "'", parenleft: "(", parenright: ")", asterisk: "*",
  plus: "+", comma: ",", hyphen: "-", period: ".", slash: "/", colon: ":", semicolon: ";",
  less: "<", equal: "=", greater: ">", question: "?", at: "@", bracketleft: "[",
  backslash: "\\", bracketright: "]", asciicircum: "^", underscore: "_", grave: "`",
  braceleft: "{", bar: "|", braceright: "}", asciitilde: "~", bullet: "\u2022",
  dagger: "\u2020", daggerdbl: "\u2021", ellipsis: "\u2026", emdash: "\u2014",
  endash: "\u2013", quotedblleft: "\u201c", quotedblright: "\u201d", quoteleft: "\u2018",
  quoteright: "\u2019", quotesinglbase: "\u201a", quotedblbase: "\u201e", guillemotleft: "\u00ab",
  guillemotright: "\u00bb", guilsinglleft: "\u2039", guilsinglright: "\u203a",
  Euro: "\u20ac", sterling: "\u00a3", yen: "\u00a5", currency: "\u00a4",
  copyright: "\u00a9", registered: "\u00ae", trademark: "\u2122", degree: "\u00b0",
  plusminus: "\u00b1", multiply: "\u00d7", divide: "\u00f7", fraction: "\u2044",
  percent_alt: "%", perthousand: "\u2030", section: "\u00a7", paragraph: "\u00b6",
  minus: "\u2212", logicalnot: "\u00ac", infinity: "\u221e", radical: "\u221a",
}
for (let c = 0x30; c <= 0x39; c++) GLYPH_NAMES[["zero","one","two","three","four","five","six","seven","eight","nine"][c - 0x30]] = String.fromCharCode(c)
for (let c = 0x41; c <= 0x5a; c++) GLYPH_NAMES[String.fromCharCode(c)] = String.fromCharCode(c)
for (let c = 0x61; c <= 0x7a; c++) GLYPH_NAMES[String.fromCharCode(c)] = String.fromCharCode(c)

/** Resolve a glyph name to a character, including `uniXXXX` / `uXXXX` forms. */
function glyphToChar(name: string): string {
  if (GLYPH_NAMES[name]) return GLYPH_NAMES[name]
  const uni = /^uni([0-9A-Fa-f]{4,6})$/.exec(name) ?? /^u([0-9A-Fa-f]{4})$/.exec(name)
  if (uni) {
    const code = parseInt(uni[1], 16)
    if (code >= 0x20 && code <= 0x10ffff) return String.fromCodePoint(code)
  }
  return ""
}

/** `/Encoding << /Differences [32 /space 65 /A ...] >>` -> code -> character. */
function parseDifferences(doc: PdfDoc, diffs: { t: "array"; v: PdfValue[] }): Map<string, string> {
  const map = new Map<string, string>()
  let code = 0
  for (const item of diffs.v) {
    const v = doc.get(item)
    if (!v) continue
    if (v.t === "num") code = v.v
    else if (v.t === "name") {
      const ch = glyphToChar(v.v)
      if (ch) map.set(code.toString(16).toUpperCase().padStart(2, "0"), ch)
      code++
    }
  }
  return map
}

function fontInfo(doc: PdfDoc, fontVal: PdfValue | undefined): FontInfo {
  const key = fontVal && fontVal.t === "ref" ? fontVal.n : -1
  if (key > 0) {
    const cached = doc.fontCache.get(key)
    if (cached) return cached
  }

  const dict = doc.dict(fontVal)
  if (!dict) return { twoByte: false }

  const twoByte = doc.name(dict.get("Subtype")) === "Type0"
  doc.stats.fonts++
  let info: FontInfo = { twoByte }

  const tuStream = doc.streamOf(dict.get("ToUnicode"))
  if (tuStream) {
    const map = parseToUnicode(Buffer.from(tuStream).toString("latin1"))
    if (map.size) {
      doc.stats.fontsWithToUnicode++
      info = { twoByte, map }
    }
  } else {
    const diffs = doc.dict(dict.get("Encoding"))?.get("Differences")
    if (diffs?.t === "array") {
      doc.stats.fontsWithDifferences++
      const map = parseDifferences(doc, diffs)
      if (map.size) info = { twoByte, map }
    }
  }

  if (key > 0) doc.fontCache.set(key, info)
  return info
}

function decodeText(raw: string, font: FontInfo): string {
  if (font.map) {
    // Must match the canonical form used when the CMap was parsed.
    const key = (code: number) => code.toString(16).toUpperCase().replace(/^0+(?=.)/, "")
    let out = ""
    if (font.twoByte) {
      for (let i = 0; i + 1 < raw.length; i += 2) {
        out += font.map.get(key((raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1))) ?? ""
      }
    } else {
      for (let i = 0; i < raw.length; i++) out += font.map.get(key(raw.charCodeAt(i) & 0xff)) ?? ""
    }
    return out
  }

  if (font.twoByte) {
    // No ToUnicode: only usable if codes look like plain BMP text.
    let out = ""
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const code = (raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1)
      if (code >= 0x20 && code < 0xfffd) out += String.fromCharCode(code)
    }
    return out
  }

  let out = ""
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i) & 0xff
    out += CP1252[code] ?? String.fromCharCode(code)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Content stream text extraction
 * ------------------------------------------------------------------ */

const normSpace = (s: string) =>
  s
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

function extractContent(
  doc: PdfDoc,
  content: string,
  resources: PdfValue | undefined,
  depth = 0,
): string {
  if (depth > 6) return ""
  const res = doc.dict(resources)
  const fontDict = res ? doc.dict(res.get("Font")) : undefined
  const xobjDict = res ? doc.dict(res.get("XObject")) : undefined

  const out: string[] = []
  let line = ""
  let font: FontInfo = { twoByte: false }
  const fontStack: FontInfo[] = []
  let fontSize = 10
  let leading = 0

  // Text line matrix, so line breaks are decided from real device-space
  // baselines rather than from raw Td offsets. Producers kern with tiny Td
  // values, and treating those as line breaks splits words mid-character.
  let tlm = [1, 0, 0, 1, 0, 0]
  let lastF: number | null = null

  const effSize = () => Math.max(0.1, fontSize * Math.hypot(tlm[2], tlm[3]))

  /**
   * Baseline distance that counts as a new line. Real leading is ~1.2em, while
   * generators that split one word across text runs introduce sub-em jitter, so
   * 0.6em keeps lines separate without tearing words apart.
   */
  const lineTol = () => Math.max(0.5, effSize() * 0.6)

  /** Apply a text-space translation and break the line on a real baseline move. */
  const move = (tx: number, ty: number) => {
    const e = tx * tlm[0] + ty * tlm[2] + tlm[4]
    const f = tx * tlm[1] + ty * tlm[3] + tlm[5]
    tlm = [tlm[0], tlm[1], tlm[2], tlm[3], e, f]
    if (lastF !== null && Math.abs(f - lastF) > lineTol()) pushLine()
    lastF = f
  }

  const pushLine = (force = false) => {
    if (line.trim() || force) {
      out.push(line)
      line = ""
    }
  }

  const append = (s: string) => {
    if (!s) return
    if (line && /[A-Za-z0-9,;:]$/.test(line) && /^[A-Za-z0-9(]/.test(s) && !/\s$/.test(line)) {
      // Conservative word break only when the producer gave us no other signal.
    }
    line += s
  }

  const operands: PdfValue[] = []
  const r = new Reader(content)

  const applyFont = (name: string) => {
    const ref = fontDict?.get(name)
    font = ref ? fontInfo(doc, ref) : { twoByte: false }
  }

  while (r.i < content.length) {
    const tok = r.parse()
    if (!tok) break

    if (tok.t !== "op") {
      operands.push(tok)
      continue
    }

    const op = tok.v
    switch (op) {
      case "q":
        fontStack.push(font)
        break
      case "Q":
        if (fontStack.length) font = fontStack.pop()!
        break
      case "Tf": {
        const size = operands.find((o) => o.t === "num")
        const nameObj = operands.find((o) => o.t === "name")
        if (size && size.t === "num") fontSize = Math.abs(size.v) || 10
        if (nameObj && nameObj.t === "name") applyFont(nameObj.v)
        break
      }
      case "BT":
        // Reset the matrix but keep the previous baseline, so a producer that
        // wraps one word in its own BT/ET block does not get a line break.
        tlm = [1, 0, 0, 1, 0, 0]
        break
      case "ET":
        break
      case "TL": {
        const nums = operands.filter((o) => o.t === "num") as { t: "num"; v: number }[]
        leading = nums[0]?.v ?? 0
        break
      }
      case "Td":
      case "TD": {
        const nums = operands.filter((o) => o.t === "num") as { t: "num"; v: number }[]
        const tx = nums[0]?.v ?? 0
        const ty = nums[1]?.v ?? 0
        if (op === "TD") leading = -ty
        move(tx, ty)
        break
      }
      case "Tm": {
        const nums = operands.filter((o) => o.t === "num") as { t: "num"; v: number }[]
        if (nums.length >= 6) {
          tlm = nums.slice(0, 6).map((n) => n.v)
          if (lastF !== null && Math.abs(tlm[5] - lastF) > lineTol()) pushLine()
          lastF = tlm[5]
        }
        break
      }
      case "T*":
        move(0, -leading)
        break
      case "Tj": {
        const s = operands.find((o) => o.t === "str")
        if (s && s.t === "str") append(decodeText(s.v, font))
        break
      }
      case "'": {
        pushLine()
        const s = operands.find((o) => o.t === "str")
        if (s && s.t === "str") append(decodeText(s.v, font))
        break
      }
      case '"': {
        pushLine()
        const s = operands.find((o) => o.t === "str")
        if (s && s.t === "str") append(decodeText(s.v, font))
        break
      }
      case "TJ": {
        const arr = operands.find((o) => o.t === "array")
        if (arr && arr.t === "array") {
          for (const item of arr.v) {
            if (item.t === "str") append(decodeText(item.v, font))
            else if (item.t === "num" && item.v < -180) append(" ")
          }
        }
        break
      }
      case "Do": {
        const nameObj = operands.find((o) => o.t === "name")
        if (nameObj && nameObj.t === "name" && xobjDict) {
          const xo = doc.dict(xobjDict.get(nameObj.v))
          if (xo && doc.name(xo.get("Subtype")) === "Form") {
            const data = doc.streamOf(xobjDict.get(nameObj.v))
            if (data) {
              const inner = extractContent(
                doc,
                Buffer.from(data).toString("latin1"),
                xo.get("Resources") ?? resources,
                depth + 1,
              )
              if (inner.trim()) {
                pushLine()
                out.push(inner)
              }
            }
          }
        }
        break
      }
      case "BI":
        // Inline image: skip to the EI operator.
        r.i = content.indexOf("EI", r.i) + 2 || content.length
        break
    }
    operands.length = 0
  }
  pushLine()
  return normSpace(out.join("\n"))
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export interface PdfResult {
  pageCount: number
  pages: string[]
  encrypted: boolean
  /** True when extraction produced suspiciously little text (scanned pages). */
  lowYield: boolean
  /** True when text decoded with a wrong font encoding table (unreadable). */
  suspectFontEncoding: boolean
  stats: PdfStats
}

export function extractPdf(bytes: Uint8Array): PdfResult {
  const doc = new PdfDoc()
  collectObjects(doc, bytes)

  if (doc.objects.has(-1)) {
    const fallback = doc.objects.get(-1)
    return {
      pageCount: 1,
      pages: [fallback?.t === "str" ? fallback.v : ""],
      encrypted: true,
      lowYield: false,
      suspectFontEncoding: false,
      stats: doc.stats,
    }
  }

  const pages = pageList(doc)
  const texts: string[] = []

  for (const page of pages) {
    const contents = page.dict.get("Contents")
    const parts: string[] = []

    const addStream = (v: PdfValue | undefined) => {
      const data = doc.streamOf(v)
      if (data) parts.push(Buffer.from(data).toString("latin1"))
      else {
        const resolved = doc.get(v)
        if (resolved && resolved.t === "op") parts.push(resolved.v)
      }
    }

    const resolved = doc.get(contents)
    if (resolved?.t === "array") for (const c of resolved.v) addStream(c)
    else addStream(contents)

    texts.push(parts.length ? extractContent(doc, parts.join("\n"), page.resources) : "")
  }

  // Average characters per page. Real text pages yield hundreds; a scanned or
  // glyph-encoded page yields almost nothing, so warn instead of lying.
  const totalChars = texts.reduce((n, t) => n + t.length, 0)
  const lowYield = texts.length > 0 && totalChars < texts.length * 40

  // Unmapped font codes usually land on bracket punctuation, so a high share of
  // them means the text was decoded with the wrong encoding table.
  let brackets = 0
  for (const t of texts) for (const ch of t) if ("()[]{}".includes(ch)) brackets++
  const suspectFontEncoding = totalChars > 0 && brackets / totalChars > 0.1

  doc.stats.pageCount = texts.length
  return {
    pageCount: texts.length,
    pages: texts,
    encrypted: false,
    lowYield,
    suspectFontEncoding,
    stats: doc.stats,
  }
}

/* ------------------------------------------------------------------ *
 * Page selection and search
 * ------------------------------------------------------------------ */

export function parsePageSpec(spec: string | undefined, pageCount: number): number[] {
  if (!spec || !spec.trim()) return Array.from({ length: pageCount }, (_, i) => i + 1)
  const picked = new Set<number>()
  for (const chunk of spec.split(",")) {
    const part = chunk.trim()
    if (!part) continue
    const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(part)
    if (range) {
      const lo = Math.max(1, Number(range[1]))
      const hi = Math.min(pageCount, Number(range[2]))
      for (let p = lo; p <= hi; p++) picked.add(p)
    } else if (/^\d+$/.test(part)) {
      const p = Number(part)
      if (p >= 1 && p <= pageCount) picked.add(p)
    }
  }
  return [...picked].sort((a, b) => a - b)
}

export interface SearchHit {
  page: number
  snippet: string
  fragment: string
}

/**
 * Whitespace-folded view of a page plus a map back to original offsets.
 *
 * Extraction cannot always tell a real line break from a generator that split
 * one word across two text runs, so a page may contain "N\national". Matching
 * against a whitespace-free copy finds the phrase anyway, and the offset map
 * keeps snippets pointing at the real text.
 */
function foldIndex(text: string) {
  const chars: string[] = []
  const offsets: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === "\f" || ch === "\u00a0") continue
    chars.push(ch.toLowerCase())
    offsets.push(i)
  }
  return { flat: chars.join(""), offsets }
}

export function searchPages(pages: string[], query: string, contextChars = 180, limit = 40): SearchHit[] {
  const needle = query
    .replace(/\s+/g, "")
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  if (!needle) return []

  // The phrase as a reader sees it rendered, which is what a text fragment must
  // contain - not the possibly word-split form found inside the page text.
  const fragment = query.trim().replace(/\s+/g, " ").split(" ").slice(0, 12).join(" ")
  const re = new RegExp(needle, "gi")
  const hits: SearchHit[] = []

  for (let p = 0; p < pages.length && hits.length < limit; p++) {
    const text = pages[p]
    const { flat, offsets } = foldIndex(text)
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(flat)) && hits.length < limit) {
      const start = offsets[m.index]
      const end = offsets[m.index + m[0].length - 1] + 1
      const from = Math.max(0, start - contextChars)
      const to = Math.min(text.length, end + contextChars)
      const snippet =
        (from > 0 ? "…" : "") +
        text.slice(from, to).replace(/\s+/g, " ").trim() +
        (to < text.length ? "…" : "")
      hits.push({ page: p + 1, snippet, fragment })
      re.lastIndex = m.index + Math.max(1, m[0].length)
    }
  }
  return hits
}
