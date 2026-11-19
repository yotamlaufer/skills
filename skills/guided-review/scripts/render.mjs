#!/usr/bin/env node
// Renders a guided review: guide.json (chapters Claude wrote) + the patch it
// describes → one HTML page for the Artifact tool. The diff lines come from the
// patch alone, never from guide.json, so the page cannot show code that is not
// in the change. Validation fails (exit 1) unless every hunk of the patch sits
// in exactly one chapter. A guide.json with no chapters yet renders the first
// page: every file in patch order.
//
// The page marks lines (click a line number, drag or shift-click to extend) and,
// through the `comments` capability, posts a comment on the marked lines or
// sends them to the Claude Code session beside the page. Explain is such a send:
// the session answers with the whole checkout at hand, writing its steps and
// answer to explains/<id> in the page's `db` store, pinned to the file and lines
// (`to: "n12"`), which the page types out under those lines. Publish it with capabilities {comments: {}, db: {rules: [{path:
// "explains", read: "view", write: "owner"}]}}; without them the page still
// reads, with those buttons hidden.
//
// Usage: node render.mjs <guide.json> <patch.diff> <out.html>
//        node render.mjs --list <patch.diff>   (each file's hunks, numbered as guide.json's "hunks" counts them)

import { readFileSync, writeFileSync } from 'node:fs'

// ---------------------------------------------------------------- patch

function parsePatch(text) {
  const out = []
  let file = null
  let hunk = null
  let oldLeft = 0
  let newLeft = 0
  for (const line of text.split('\n')) {
    // Inside a hunk the header's counts say how many lines belong to it, so a
    // removed line that reads "--- x" is never taken for a file header.
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const sign = line[0]
      if (sign === '+') {
        hunk.lines.push({ kind: 'add', newNo: hunk.nextNew++, text: line.slice(1) })
        newLeft--
        file.additions++
        continue
      }
      if (sign === '-') {
        hunk.lines.push({ kind: 'del', oldNo: hunk.nextOld++, text: line.slice(1) })
        oldLeft--
        file.deletions++
        continue
      }
      if (sign === ' ' || line === '') {
        hunk.lines.push({ kind: 'ctx', oldNo: hunk.nextOld++, newNo: hunk.nextNew++, text: line.slice(1) })
        oldLeft--
        newLeft--
        continue
      }
    }
    if (line.startsWith('\\')) continue // "\ No newline at end of file"
    const git = line.match(/^diff --git a\/(.+) b\/(.+)$/)
    if (git) {
      file = { oldPath: git[1], newPath: git[2], status: 'modified', binary: false, hunks: [], additions: 0, deletions: 0 }
      out.push(file)
      hunk = null
      continue
    }
    if (!file) continue
    if (line.startsWith('new file mode')) file.status = 'added'
    else if (line.startsWith('deleted file mode')) file.status = 'deleted'
    else if (line.startsWith('rename from ')) { file.status = 'renamed'; file.oldPath = line.slice(12) }
    else if (line.startsWith('rename to ')) file.newPath = line.slice(10)
    else if (line.startsWith('Binary files')) file.binary = true
    else {
      const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/)
      if (h) {
        oldLeft = h[2] === undefined ? 1 : Number(h[2])
        newLeft = h[4] === undefined ? 1 : Number(h[4])
        hunk = { header: line, nextOld: Number(h[1]), nextNew: Number(h[3]), lines: [] }
        file.hunks.push(hunk)
      }
    }
  }
  for (const f of out) f.path = f.status === 'deleted' ? f.oldPath : f.newPath
  return out
}

// ----------------------------------------------------------- validation

function validate(guide, files) {
  const errors = []
  if (typeof guide.title !== 'string' || guide.title.trim() === '') errors.push('"title" is missing.')
  if (!Array.isArray(guide.chapters) || guide.chapters.length === 0) {
    errors.push('"chapters" must be a non-empty array.')
    return errors
  }
  if (guide.changes !== undefined) {
    if (!Array.isArray(guide.changes)) errors.push('"changes" must be a list of { text, chapter }.')
    else guide.changes.forEach((c, i) => {
      if (typeof c?.text !== 'string' || c.text.trim() === '') errors.push(`changes[${i}] has no "text".`)
      if (c?.chapter !== undefined && !(Number.isInteger(c.chapter) && c.chapter >= 1 && c.chapter <= guide.chapters.length)) errors.push(`changes[${i}].chapter must be a chapter number from 1 to ${guide.chapters.length}.`)
    })
  }
  if (guide.risks !== undefined && !(Array.isArray(guide.risks) && guide.risks.every((r) => typeof r === 'string'))) errors.push('"risks" must be a list of sentences.')
  const byPath = new Map(files.map((f) => [f.path, f]))
  const seen = new Map() // "path#hunk" → chapter title
  guide.chapters.forEach((chapter, ci) => {
    const where = `chapter ${ci + 1} ("${chapter.title ?? ''}")`
    if (typeof chapter.title !== 'string' || chapter.title.trim() === '') errors.push(`${where} has no "title".`)
    if (!Array.isArray(chapter.files) || chapter.files.length === 0) {
      errors.push(`${where} has no "files".`)
      return
    }
    for (const ref of chapter.files) {
      const file = byPath.get(ref.path)
      if (!file) {
        errors.push(`${where} names "${ref.path}", which is not in the patch. Paths in the patch: ${[...byPath.keys()].join(', ')}`)
        continue
      }
      if (ref.attention !== undefined && !ATTENTION[ref.attention]) errors.push(`${where}: "${ref.path}" has attention "${ref.attention}"; use ${Object.keys(ATTENTION).join(', ')}.`)
      if (ref.kind !== undefined && !KINDS[ref.kind]) errors.push(`${where}: "${ref.path}" has kind "${ref.kind}"; use ${Object.keys(KINDS).join(', ')}.`)
      const count = Math.max(file.hunks.length, 1)
      const hunks = ref.hunks ?? [...Array(count).keys()]
      for (const i of hunks) {
        if (!Number.isInteger(i) || i < 0 || i >= count) {
          errors.push(`${where}: "${ref.path}" has hunks 0..${count - 1}; ${JSON.stringify(i)} is not one of them.`)
          continue
        }
        const key = `${ref.path}#${i}`
        if (seen.has(key)) errors.push(`hunk ${i} of "${ref.path}" is in both "${seen.get(key)}" and "${chapter.title}". Each hunk goes in one chapter.`)
        else seen.set(key, chapter.title)
      }
    }
  })
  for (const f of files) {
    const count = Math.max(f.hunks.length, 1)
    const missing = [...Array(count).keys()].filter((i) => !seen.has(`${f.path}#${i}`))
    if (missing.length === count) errors.push(`"${f.path}" is in no chapter.`)
    else if (missing.length > 0) errors.push(`hunks ${missing.join(', ')} of "${f.path}" are in no chapter.`)
  }
  return errors
}

// ------------------------------------------------------------ rendering

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// One line of guide prose: \`code\` and **bold**.
function inlineText(s) {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

// Prose in guide.json: paragraphs split by a blank line, "- " bullet lists,
// `code` and **bold**. Nothing else.
function prose(text) {
  if (!text) return ''
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  return String(text)
    .trim()
    .split(/\n\s*\n/)
    .map((block) => {
      // A block may open with a line of text and go on with bullets: each run
      // of bullet lines is a list, each run of other lines a paragraph.
      const out = []
      let run = []
      let bullets = false
      const flush = () => {
        if (run.length === 0) return
        out.push(bullets ? `<ul>${run.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>` : `<p>${inline(run.join(' '))}</p>`)
        run = []
      }
      for (const line of block.split('\n')) {
        const isBullet = /^\s*[-*] /.test(line)
        if (isBullet !== bullets) { flush(); bullets = isBullet }
        run.push(line)
      }
      flush()
      return out.join('')
    })
    .join('')
}

// How closely to read a file, and what sort of change it is. Each word comes
// with its one-line meaning, shown when the pointer rests on it.
const ATTENTION = {
  high: { label: 'High', meaning: 'Changes behaviour or a contract other code relies on: read every line' },
  medium: { label: 'Medium', meaning: 'Logic with a contained reach: read it' },
  low: { label: 'Low', meaning: 'Mechanical or self-contained: skim it' },
}
const KINDS = {
  logic: { label: 'Logic', meaning: 'What the code does when it runs' },
  interface: { label: 'Interface', meaning: 'A signature, schema, type or API that callers depend on' },
  data: { label: 'Data', meaning: 'A stored format, a migration or seed data' },
  config: { label: 'Config', meaning: 'Settings, build or deployment configuration' },
  test: { label: 'Tests', meaning: 'Tests and test fixtures' },
  docs: { label: 'Docs', meaning: 'Documentation and comments' },
  refactor: { label: 'Refactor', meaning: 'Moves or renames with no change in behaviour' },
  generated: { label: 'Generated', meaning: 'Produced by a tool; review the tool, not the text' },
}
const ATTENTION_ORDER = ['high', 'medium', 'low']

function attentionTag(level, small) {
  const a = ATTENTION[level]
  return a ? `<span class="att att-${level}${small ? ' att-small' : ''}" title="${esc(a.label + ' attention. ' + a.meaning)}">${small ? a.label : a.label + ' attention'}</span>` : ''
}
function kindTag(kind) {
  const k = KINDS[kind]
  return k ? `<span class="kind" title="${esc(k.meaning)}">${k.label}</span>` : ''
}

// A file's name and the folder it sits in, shown apart the way an editor's tabs do.
function splitPath(path) {
  const i = path.lastIndexOf('/')
  return i === -1 ? { name: path, dir: '' } : { name: path.slice(i + 1), dir: path.slice(0, i) }
}

// The lines a chapter's reference to a file adds and removes: its hunks only.
function countsOf(ref, file) {
  const hunks = (ref.hunks ?? [...Array(file.hunks.length).keys()]).map((i) => file.hunks[i]).filter(Boolean)
  const count = (kind) => hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === kind).length, 0)
  return { adds: count('add'), dels: count('del') }
}

function countsHtml({ adds, dels }) {
  return `<span class="plus">+${adds}</span> <span class="minus">−${dels}</span>`
}

function fileListItem(ref, file, ci, fi, extra = '', target = null) {
  const { name, dir } = splitPath(file.path)
  return `<li data-file-key="${esc(file.path)}"><span class="fl-att">${attentionTag(ref.attention, true)}</span><a class="fl-link" href="#guide-${ci + 1}" data-goto="${target ?? `f-${ci}-${fi}`}"><span class="fl-name">${esc(name)}</span><span class="fl-dir">${esc(dir)}</span></a><span class="fl-counts">${extra}${countsHtml(countsOf(ref, file))}</span></li>`
}

function renderFile(ref, file, ci, fi, id = `f-${ci}-${fi}`) {
  const STATUS_LABEL = { added: 'New', deleted: 'Deleted', renamed: 'Renamed', modified: 'Changed' }
  const count = file.hunks.length
  const hunkIdx = ref.hunks ?? [...Array(count).keys()]
  const partial = count > 0 && hunkIdx.length < count
  const hunks = hunkIdx.map((i) => [i, file.hunks[i]]).filter(([, h]) => h)
  const { name, dir } = splitPath(file.path)
  const rename = file.status === 'renamed' ? `<span class="from">from ${esc(file.oldPath)}</span>` : ''
  const part = partial ? `<span class="part">${hunkIdx.length} of ${count} changes in this file</span>` : ''

  // Line numbers and signs are drawn from data attributes (CSS ::before), so
  // copying code from the page copies the code alone.
  let body
  if (file.binary) body = '<p class="note">Binary file: no lines to show.</p>'
  else if (hunks.length === 0) body = '<p class="note">No line changes (mode or rename only).</p>'
  else {
    const rows = hunks
      .map(([hi, h]) => {
        const head = `<div class="hunk" data-hunk="${hi}"><span class="hunk-text">${esc(h.header)}</span><button type="button" class="explain-hunk" data-needs="claude" hidden>Explain</button></div>`
        const lines = h.lines
          .map((l) => {
            const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''
            const label = l.newNo ? `line ${l.newNo}` : `removed line ${l.oldNo}`
            return `<div class="row ${l.kind}" data-hunk="${hi}" data-o="${l.oldNo ?? ''}" data-n="${l.newNo ?? ''}"><span class="no" data-v="${l.oldNo ?? ''}" role="button" tabindex="-1" aria-label="Mark ${label}"></span><span class="no" data-v="${l.newNo ?? ''}" role="button" tabindex="0" aria-label="Mark ${label}"></span><span class="sign" data-v="${sign}"></span><span class="code">${esc(l.text)}\n</span></div>`
          })
          .join('')
        return head + lines
      })
      .join('')
    body = `<div class="diff"><div class="rows">${rows}</div></div>`
  }

  return `<details class="file" id="${id}" data-chapter="${ci}" data-file="${fi}" data-path="${esc(file.path)}"${ref.collapsed ? '' : ' open'}>
  <summary>
    <span class="fname">${esc(name)}</span><span class="fdir">${esc(dir)}</span>
    <span class="chip chip-${file.status}">${STATUS_LABEL[file.status]}</span>
    ${attentionTag(ref.attention, false)}${kindTag(ref.kind)}
    <span class="counts">${countsHtml(countsOf(ref, file))}</span>
    ${rename}${part}
    <label class="reviewed"><input type="checkbox" data-file-key="${esc(file.path)}">Reviewed</label>
    ${ref.summary ? `<span class="summary">${esc(ref.summary)}</span>` : ''}
    ${ref.affects ? `<span class="affects"><strong>Affects</strong> ${esc(ref.affects)}</span>` : ''}
  </summary>
  ${body}
</details>`
}

function renderPage(guide, files) {
  const byPath = new Map(files.map((f) => [f.path, f]))
  const totalAdds = files.reduce((n, f) => n + f.additions, 0)
  const totalDels = files.reduce((n, f) => n + f.deletions, 0)
  const src = guide.source ?? {}
  const sourceHtml = src.url ? `<a href="${esc(src.url)}">${esc(src.label ?? src.url)}</a>` : src.label ? esc(src.label) : ''
  const refs = src.base && src.head ? `<span class="mono">${esc(src.base)} … ${esc(src.head)}</span>` : ''
  // The key keeps each viewer's ticks with this guide only.
  const storeKey = `guided-review:${guide.title}:${src.head ?? ''}`

  // What Explain sends Claude besides the code: the guide's own words.
  const context = {
    title: guide.title,
    intent: guide.intent ?? '',
    chapters: guide.chapters.map((c) => ({
      title: c.title,
      overview: c.overview ?? '',
      files: c.files.map((ref) => ({ path: ref.path, status: byPath.get(ref.path).status, summary: ref.summary ?? '' })),
    })),
  }

  // ---- Who reads which file where, and how closely
  const placesOf = new Map()
  guide.chapters.forEach((c, ci) => c.files.forEach((ref, fi) => {
    if (!placesOf.has(ref.path)) placesOf.set(ref.path, [])
    placesOf.get(ref.path).push([ci, fi])
  }))
  const rank = (level) => (ATTENTION_ORDER.includes(level) ? ATTENTION_ORDER.indexOf(level) : ATTENTION_ORDER.length)
  // A file read in several chapters takes the tags of its most demanding part.
  const leadRefOf = (path) =>
    (placesOf.get(path) ?? []).map(([ci, fi]) => guide.chapters[ci].files[fi]).sort((a, b) => rank(a.attention) - rank(b.attention))[0] ?? { path }
  const byAttention = files
    .map((file, i) => ({ file, i, lead: leadRefOf(file.path) }))
    .sort((a, b) => rank(a.lead.attention) - rank(b.lead.attention) || a.i - b.i)
  const tally = ATTENTION_ORDER.map((level) => [level, byAttention.filter((x) => x.lead.attention === level).length]).filter(([, n]) => n > 0)
  const tallyHtml = tally.map(([level, n]) => `<span class="tally">${attentionTag(level, true)} ${n}</span>`).join('')
  const kindTally = Object.keys(KINDS)
    .map((kind) => [kind, byAttention.filter((x) => x.lead.kind === kind).length])
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `<span class="tally">${kindTag(kind)} ${n}</span>`)
    .join('')
  const pad = (n) => String(n).padStart(2, '0')
  const howto = '<p class="howto">Click a line number to mark a line; drag across line numbers, or shift-click another, to mark several.</p>'

  // ---- Files: every file whole, in patch order, as the diff lists it.
  const filesView = `<section class="view" id="view-files" hidden>
  <div class="files-head"><span class="eyebrow">Files</span><span class="totals">${files.length} files · ${countsHtml({ adds: totalAdds, dels: totalDels })}</span>${tallyHtml}</div>
  ${guide.firstPage ? '<p class="pending-note">The reading order is still being written. Until it arrives, every file shows here in patch order.</p>' : ''}
  <div class="file-col">
${files
  .map((file, i) => {
    const lead = leadRefOf(file.path)
    const [ci, fi] = (placesOf.get(file.path) ?? [[0, 0]])[0]
    const whole = { path: file.path, attention: lead.attention, kind: lead.kind, affects: lead.affects, summary: lead.summary, collapsed: lead.collapsed }
    return renderFile(whole, file, ci, fi, `ff-${i}`)
  })
  .join('\n')}
  </div>
  ${howto}
</section>`

  // ---- Overview: the change as analysed from the code.
  const highFiles = byAttention.filter((x) => x.lead.attention === 'high')
  const changesList = (guide.changes ?? [])
    .map((c) => `<li><span>${inlineText(c.text)}</span>${c.chapter ? `<a class="ov-ch" href="#guide-${c.chapter}">Chapter ${c.chapter} →</a>` : ''}</li>`)
    .join('')
  const risksList = [
    ...highFiles.map(({ file, i, lead }) => {
      const { name } = splitPath(file.path)
      return `<li>${attentionTag('high', true)}<span><a class="ov-file" href="#files" data-goto="ff-${i}">${esc(name)}</a>${lead.affects ? ` ${esc(lead.affects)}` : ''}</span></li>`
    }),
    ...(guide.risks ?? []).map((r) => `<li><span class="ov-dot" aria-hidden="true">•</span><span>${inlineText(r)}</span></li>`),
  ].join('')
  const overviewView = guide.firstPage
    ? ''
    : `<section class="view" id="view-overview" hidden>
  <div class="ov">
    <section><h3 class="eyebrow">What it does</h3><div class="prose">${prose(guide.intent)}</div></section>
    ${changesList ? `<section><h3 class="eyebrow">What changed</h3><ol class="ov-changes">${changesList}</ol></section>` : ''}
    ${risksList ? `<section><h3 class="eyebrow">Risks</h3><ul class="ov-risks">${risksList}</ul></section>` : ''}
    <section><h3 class="eyebrow">At a glance</h3><div class="glance"><span>${files.length} files · ${countsHtml({ adds: totalAdds, dels: totalDels })}</span>${tallyHtml}${kindTally}</div></section>
    <section><h3 class="eyebrow">Files changed</h3><ul class="filelist">${byAttention
      .map(({ file, i, lead }) => {
        const chips = `<span class="fl-ch">${(placesOf.get(file.path) ?? []).map(([c]) => c + 1).join(', ')}</span>`
        return fileListItem({ path: file.path, attention: lead.attention }, file, 0, 0, chips, `ff-${i}`)
      })
      .join('')}</ul></section>
  </div>
</section>`

  // ---- Guide: one chapter at a time, its words beside its diffs.
  const n = guide.chapters.length
  const guideView = guide.firstPage
    ? ''
    : `<section class="view" id="view-guide" hidden>
  <nav class="chapter-strip" aria-label="Chapters">${guide.chapters
    .map((c, i) => `<a class="cs-item" href="#guide-${i + 1}" data-ch="${i + 1}"><span class="cs-num">${pad(i + 1)}</span><span class="cs-title">${esc(c.title)}</span></a>`)
    .join('')}<span class="progress" id="progress"></span></nav>
${guide.chapters
  .map(
    (c, i) => `<section class="chapter-page" data-ch="${i + 1}" aria-labelledby="h-${i + 1}" hidden>
  <aside class="ch-aside">
    <div class="ch-count"><span>${pad(i + 1)} / ${pad(n)}</span><label class="ch-done"><input type="checkbox" data-chapter="${i + 1}">Reviewed</label></div>
    <h2 id="h-${i + 1}">${esc(c.title)}</h2>
    <div class="overview">${prose(c.overview)}</div>
    <ul class="filelist">${c.files.map((ref, fi) => fileListItem(ref, byPath.get(ref.path), i, fi)).join('')}</ul>
    <div class="ch-nav">${i > 0 ? `<a class="btn" href="#guide-${i}">← Previous</a>` : ''}${i < n - 1 ? `<a class="btn" href="#guide-${i + 2}">Next →</a>` : ''}</div>
    ${howto}
  </aside>
  <div class="ch-files">
${c.files.map((ref, fi) => renderFile(ref, byPath.get(ref.path), i, fi)).join('\n')}
  </div>
</section>`,
  )
  .join('\n')}
</section>`
  const defaultView = guide.firstPage ? 'files' : 'overview'

  return `<title>${esc(guide.title)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
/* Layout: a header with Overview, Guide and Files tabs; the Guide sets each chapter's words beside its diffs. */
:root {
  --bg: #f5f6f8; --surface: #ffffff; --fg: #1a1e24; --muted: #5a636e; --line: #dde1e7;
  --accent: #2552c4; --accent-soft: #e8eefb; --accent-fg: #ffffff;
  --add-bg: #e7f4eb; --add-no: #d3ebdb; --add-fg: #17643a;
  --del-bg: #fbeaea; --del-no: #f3d6d6; --del-fg: #9d2329;
  --hunk-bg: #edf1f7; --hunk-fg: #4a5a78;
  --mark-bg: #fff3c4; --mark-no: #f5dc7a; --mark-edge: #c79a00;
  --syn-keyword: #7b36c4; --syn-string: #0a6b8c; --syn-number: #a35200; --syn-comment: #6b7480;
  --syn-title: #1f4fbf; --syn-type: #8a5a00; --syn-attr: #0e6e6e; --syn-meta: #5b4bc4;
  --att-high: #b42318; --att-high-bg: #fde8e4; --att-med: #8a5300; --att-med-bg: #fdf0d5; --att-low: #4f5966; --att-low-bg: #eceff3;
  --sans: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #111317; --surface: #181b20; --fg: #e4e7eb; --muted: #959eaa; --line: #2a2f37;
  --accent: #86a6ff; --accent-soft: #1d2640; --accent-fg: #0d1220;
  --add-bg: #12291b; --add-no: #183522; --add-fg: #7fd59a;
  --del-bg: #331618; --del-no: #401b1e; --del-fg: #ff9b9b;
  --hunk-bg: #1a2130; --hunk-fg: #9fb0d0;
  --mark-bg: #3a3214; --mark-no: #574a12; --mark-edge: #e5c04a;
  --syn-keyword: #c8a2ff; --syn-string: #7fcbe6; --syn-number: #f2aa66; --syn-comment: #8b95a1;
  --syn-title: #93b6ff; --syn-type: #e3be6e; --syn-attr: #74d4c8; --syn-meta: #b9adff;
  --att-high: #ff9d8f; --att-high-bg: #45201b; --att-med: #f1c26b; --att-med-bg: #3d2f12; --att-low: #a9b2bd; --att-low-bg: #262b33; color-scheme: dark;
} }
:root[data-theme="dark"] {
  --bg: #111317; --surface: #181b20; --fg: #e4e7eb; --muted: #959eaa; --line: #2a2f37;
  --accent: #86a6ff; --accent-soft: #1d2640; --accent-fg: #0d1220;
  --add-bg: #12291b; --add-no: #183522; --add-fg: #7fd59a;
  --del-bg: #331618; --del-no: #401b1e; --del-fg: #ff9b9b;
  --hunk-bg: #1a2130; --hunk-fg: #9fb0d0;
  --mark-bg: #3a3214; --mark-no: #574a12; --mark-edge: #e5c04a;
  --syn-keyword: #c8a2ff; --syn-string: #7fcbe6; --syn-number: #f2aa66; --syn-comment: #8b95a1;
  --syn-title: #93b6ff; --syn-type: #e3be6e; --syn-attr: #74d4c8; --syn-meta: #b9adff;
  --att-high: #ff9d8f; --att-high-bg: #45201b; --att-med: #f1c26b; --att-med-bg: #3d2f12; --att-low: #a9b2bd; --att-low-bg: #262b33; color-scheme: dark;
}
body { background: var(--bg); color: var(--fg); font: 15px/1.6 var(--sans); }
/* The page: a header with three tabs over one view at a time. */
.top { background: var(--surface); border-bottom: 1px solid var(--line); }
.top-inner, .view { max-width: 1440px; margin: 0 auto; box-sizing: border-box;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
.top-inner { padding-block: 24px 0; display: flex; flex-direction: column; gap: 10px; }
.view { padding-block: 28px 64px; }
.eyebrow { font: 500 12px/1 var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin: 0; }
h1 { font-size: 28px; line-height: 1.2; font-weight: 600; margin: 0; text-wrap: balance; }
h2 { font-size: 21px; line-height: 1.3; font-weight: 600; margin: 0; text-wrap: balance; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 16px; color: var(--muted); font-size: 13.5px; }
.meta a { color: var(--accent); }
.mono { font-family: var(--mono); font-size: 12.5px; }
.plus { color: var(--add-fg); font-family: var(--mono); }
.minus { color: var(--del-fg); font-family: var(--mono); }
.tabs { display: flex; gap: 4px; margin-top: 6px; }
.tabs a { padding: 9px 14px 10px; font-size: 14px; font-weight: 500; color: var(--muted); text-decoration: none; border-bottom: 2px solid transparent; }
.tabs a:hover { color: var(--fg); }
.tabs a.active { color: var(--fg); border-bottom-color: var(--fg); }
.prose p, .overview p { margin: 0 0 .7em; }
.prose ul, .overview ul { margin: 0 0 .7em; padding-left: 1.2em; }
code { font-family: var(--mono); font-size: .88em; background: var(--accent-soft); padding: 1px 5px; border-radius: 4px; }
.howto { font-size: 12.5px; color: var(--muted); margin: 0; line-height: 1.5; }
.tally { display: inline-flex; gap: 5px; align-items: center; font: 12px var(--mono); color: var(--muted); }
.totals { font-size: 13px; color: var(--muted); }

/* Overview */
.ov { max-width: 880px; display: flex; flex-direction: column; gap: 34px; }
.ov section { display: flex; flex-direction: column; gap: 12px; }
.ov .prose { font-size: 16px; }
.ov-changes { margin: 0; padding-left: 1.4em; display: flex; flex-direction: column; gap: 8px; }
.ov-changes li::marker { color: var(--muted); font: 500 13px var(--mono); }
.ov-ch { margin-left: 10px; font-size: 13px; color: var(--accent); white-space: nowrap; text-decoration: none; }
.ov-ch:hover { text-decoration: underline; }
.ov-risks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.ov-risks li { display: grid; grid-template-columns: 5.2em minmax(0, 1fr); gap: 10px; align-items: baseline; }
.ov-dot { color: var(--muted); text-align: center; }
.ov-file { font: 500 13px var(--mono); color: var(--accent); text-decoration: none; margin-right: 6px; }
.glance { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; font-size: 14px; color: var(--muted); }

/* Guide: the chapter's words in a column that stays in view, its diffs beside them. */
.chapter-strip { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 14px; border-bottom: 1px solid var(--line); }
.cs-item { display: flex; gap: 8px; align-items: baseline; padding: 6px 10px; border-radius: 6px; text-decoration: none; color: var(--muted); font-size: 13.5px; white-space: nowrap; max-width: 280px; }
.cs-item:hover { color: var(--fg); }
.cs-title { overflow: hidden; text-overflow: ellipsis; }
.cs-num { font: 500 12px var(--mono); }
.cs-item.active { background: var(--surface); color: var(--fg); box-shadow: inset 0 0 0 1px var(--line); }
.cs-item.done .cs-num::after { content: " ✓"; color: var(--add-fg); }
.progress { margin-left: auto; align-self: center; font: 12px var(--mono); color: var(--muted); white-space: nowrap; padding-left: 12px; }
.chapter-page { display: grid; grid-template-columns: minmax(260px, 360px) minmax(0, 1fr); gap: 32px; align-items: start; padding-top: 22px; }
.ch-aside { position: sticky; top: calc(env(safe-area-inset-top, 0px) + 16px); max-height: calc(100vh - 32px); overflow: auto; display: flex; flex-direction: column; gap: 14px; }
.ch-count { display: flex; gap: 14px; align-items: center; font: 500 13px var(--mono); color: var(--muted); }
.ch-done { display: flex; gap: 6px; align-items: center; font: 12.5px var(--sans); cursor: pointer; }
.ch-done input { accent-color: var(--accent); margin: 0; }
.ch-nav { display: flex; gap: 8px; }
.ch-nav .btn { text-decoration: none; }
.ch-files, .file-col { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.overview { font-size: 15px; }

/* Files */
.files-head { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin-bottom: 16px; }
.pending-note { margin: 0 0 16px; color: var(--muted); }
#view-files .howto { margin-top: 16px; }

details.file { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; min-width: 0; }
details.file > summary { cursor: pointer; padding: 10px 14px; display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; list-style: none; }
details.file > summary::-webkit-details-marker { display: none; }
details.file > summary::before { content: "▸"; color: var(--muted); font-size: 11px; transition: transform .15s; }
details.file[open] > summary::before { transform: rotate(90deg); }
details.file[open] > summary { border-bottom: 1px solid var(--line); }
.fname { font: 500 13.5px var(--mono); color: var(--accent); }
.fdir { font: 12.5px var(--mono); color: var(--muted); overflow-wrap: anywhere; }
.reviewed { margin-left: auto; display: flex; gap: 6px; align-items: center; font-size: 12.5px; color: var(--muted); cursor: pointer; }
.reviewed input { accent-color: var(--accent); margin: 0; }
details.file.is-reviewed > summary .fname { color: var(--muted); }
/* File lists: a chapter's files under its overview, every file at the top. */
.filelist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
.filelist li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: baseline; padding: 3px 8px; border-radius: 6px; }
.filelist li:hover { background: var(--surface); }
.fl-link { display: flex; gap: 8px; align-items: baseline; min-width: 0; overflow: hidden; text-decoration: none; }
/* A long name gives way after its folder does, and both end in an ellipsis. */
.fl-name { flex: 0 1 auto; min-width: 4ch; font: 500 13px var(--mono); color: var(--accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fl-dir { flex: 1 1 0; font: 12px var(--mono); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.fl-ch { font: 11px var(--mono); color: var(--muted); margin-right: 10px; }
.fl-ch::before { content: "ch "; }
.fl-counts { font: 12px var(--mono); white-space: nowrap; font-variant-numeric: tabular-nums; }
.filelist li.is-reviewed .fl-name { color: var(--muted); }
.filelist li.is-reviewed .fl-name::before { content: "✓ "; color: var(--add-fg); }
/* Attention and kind tags. */
.att { font: 600 10.5px/1 var(--sans); letter-spacing: .04em; text-transform: uppercase; padding: 3px 6px; border-radius: 4px; white-space: nowrap; cursor: help; }
.att-small { font-size: 9.5px; padding: 2px 5px; }
.att-high { background: var(--att-high-bg); color: var(--att-high); }
.att-medium { background: var(--att-med-bg); color: var(--att-med); }
.att-low { background: var(--att-low-bg); color: var(--att-low); }
.kind { font: 500 11px/1 var(--sans); padding: 3px 6px; border-radius: 4px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; cursor: help; }
.affects { flex-basis: 100%; padding-left: 18px; font-size: 13.5px; color: var(--fg); }
.affects strong { font-weight: 600; color: var(--muted); margin-right: 4px; }
.fl-att { display: inline-flex; min-width: 5.2em; }
.chip { font: 500 11px/1 var(--sans); letter-spacing: .04em; text-transform: uppercase; padding: 3px 6px; border-radius: 4px; background: var(--hunk-bg); color: var(--hunk-fg); }
.chip-added { background: var(--add-bg); color: var(--add-fg); }
.chip-deleted { background: var(--del-bg); color: var(--del-fg); }
.counts { font-size: 12.5px; }
.from, .part { font-size: 12.5px; color: var(--muted); }
.summary { flex-basis: 100%; color: var(--muted); font-size: 14px; padding-left: 18px; }
.note { margin: 0; padding: 12px 14px; color: var(--muted); font-size: 14px; }

/* The diff: one grid row per line, wider than the card when the code is. */
.diff { overflow-x: auto; }
.rows { min-width: 100%; width: max-content; font: 12.5px/1.55 var(--mono); }
.row { display: grid; grid-template-columns: 3.6em 3.6em 1.4em minmax(0, 1fr); }
.row > span::before { content: attr(data-v); }
.no { text-align: right; padding-right: 8px; color: var(--muted); user-select: none; font-variant-numeric: tabular-nums; cursor: pointer; touch-action: none; }
.no:hover { color: var(--fg); }
.sign { user-select: none; text-align: center; }
.code { white-space: pre; tab-size: 2; padding-right: 16px; }
/* Syntax colours (highlight.js classes), kept clear of the diff's own green and red. */
.code .hljs-keyword, .code .hljs-selector-tag, .code .hljs-literal, .code .hljs-doctag { color: var(--syn-keyword); }
.code .hljs-string, .code .hljs-regexp, .code .hljs-template-tag, .code .hljs-link { color: var(--syn-string); }
.code .hljs-number, .code .hljs-symbol, .code .hljs-bullet { color: var(--syn-number); }
.code .hljs-comment, .code .hljs-quote { color: var(--syn-comment); font-style: italic; }
.code .hljs-title, .code .hljs-section, .code .hljs-name { color: var(--syn-title); }
.code .hljs-type, .code .hljs-built_in, .code .hljs-class .hljs-title { color: var(--syn-type); }
.code .hljs-attr, .code .hljs-attribute, .code .hljs-property, .code .hljs-selector-class, .code .hljs-selector-id, .code .hljs-variable, .code .hljs-template-variable { color: var(--syn-attr); }
.code .hljs-meta, .code .hljs-subst { color: var(--syn-meta); }
.code .hljs-emphasis { font-style: italic; }
.code .hljs-strong { font-weight: 600; }
.row.add { background: var(--add-bg); } .row.add .no { background: var(--add-no); } .row.add .sign { color: var(--add-fg); }
.row.del { background: var(--del-bg); } .row.del .no { background: var(--del-no); } .row.del .sign { color: var(--del-fg); }
.row.marked { background: var(--mark-bg); box-shadow: inset 3px 0 0 var(--mark-edge); }
.row.marked .no { background: var(--mark-no); color: var(--fg); }
.hunk { display: flex; gap: 12px; align-items: center; background: var(--hunk-bg); color: var(--hunk-fg); padding: 3px 8px 3px calc(7.2em + 8px); min-height: 28px; }
.hunk-text { white-space: pre; }

/* Panels that open under lines: as wide as the visible card, pinned left while the code scrolls. */
.panel { position: sticky; left: 0; box-sizing: border-box; font: 14px/1.55 var(--sans); background: var(--surface); border-block: 1px solid var(--line); padding: 10px 14px 12px; display: flex; flex-direction: column; gap: 8px; white-space: normal; }
.panel-head { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; }
.panel-title { font: 500 12px var(--mono); color: var(--muted); margin-right: auto; overflow-wrap: anywhere; }
.explain-body { display: flex; flex-direction: column; gap: 8px; }
.steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; font: 12px/1.5 var(--mono); color: var(--muted); }
.steps:empty { display: none; }
.step::before { content: "✓ "; color: var(--add-fg); }
.step.live::before { content: "→ "; color: var(--accent); }
.step.live { color: var(--fg); }
.answer:empty { display: none; }
.answer p { margin: 0 0 .6em; white-space: pre-line; max-width: 75ch; }
.answer p:last-child { margin-bottom: 0; }
.caret { display: inline-block; width: .5em; height: 1.05em; margin-left: 1px; vertical-align: text-bottom; background: var(--accent); animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .caret { animation: none; } }
.status { font-size: 13px; color: var(--muted); }
.status.error { color: var(--del-fg); }
textarea { font: 14px/1.5 var(--sans); color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; min-height: 76px; resize: vertical; width: 100%; box-sizing: border-box; }
.btn { font: 500 13px/1 var(--sans); padding: 7px 11px; border-radius: 6px; border: 1px solid var(--line); background: var(--surface); color: var(--fg); cursor: pointer; }
.btn:hover { border-color: var(--accent); color: var(--accent); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.btn.primary:hover { color: var(--accent-fg); filter: brightness(1.08); }
.btn:disabled { opacity: .5; cursor: default; }
.explain-hunk { font: 500 11.5px/1 var(--sans); padding: 4px 8px; border-radius: 5px; border: 1px solid transparent; background: transparent; color: var(--hunk-fg); cursor: pointer; }
.explain-hunk:hover { border-color: var(--hunk-fg); }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }

a:focus-visible, summary:focus-visible, input:focus-visible, button:focus-visible, .no:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (max-width: 900px) {
  .chapter-page { grid-template-columns: minmax(0, 1fr); gap: 20px; }
  .ch-aside { position: static; max-height: none; }
}
@media (prefers-reduced-motion: reduce) { details.file > summary::before { transition: none; } }
</style>
<header class="top">
  <div class="top-inner">
    <span class="eyebrow">Guided review</span>
    <h1>${esc(guide.title)}</h1>
    <div class="meta">
      ${sourceHtml ? `<span>${sourceHtml}</span>` : ''}${refs}
      <span>${files.length} files</span>
      <span>${countsHtml({ adds: totalAdds, dels: totalDels })}</span>
    </div>
    <nav class="tabs" aria-label="Views">${guide.firstPage ? '' : '<a href="#overview" data-view="overview">Overview</a><a href="#guide" data-view="guide">Guide</a>'}<a href="#files" data-view="files">Files</a></nav>
  </div>
</header>
<main class="views">
${overviewView}
${guideView}
${filesView}
</main>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script type="application/json" id="guide-context">${JSON.stringify(context).replace(/</g, '\\u003c')}</script>
<script>
(() => {
  const CONTEXT = JSON.parse(document.getElementById('guide-context').textContent);

  // ---- Syntax colours. highlight.js comes from cdnjs; without it the diff
  // stays plain. Each hunk is coloured whole, once for its new side (context
  // and added lines) and once for its old side (removed lines), so a comment
  // or string that spans lines keeps its colour, then split back into rows.
  const LANGS = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', jsonl: 'json', md: 'markdown', mdx: 'markdown', yml: 'yaml', yaml: 'yaml',
    py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash', css: 'css', scss: 'scss', less: 'less',
    html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', sql: 'sql', go: 'go', rs: 'rust', java: 'java',
    kt: 'kotlin', rb: 'ruby', php: 'php', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp',
    cs: 'csharp', swift: 'swift', toml: 'ini', ini: 'ini', graphql: 'graphql', gql: 'graphql',
  };
  const langOf = (path) => {
    const name = path.split('/').pop().toLowerCase();
    if (name === 'dockerfile') return 'dockerfile';
    if (name === 'makefile') return 'makefile';
    const ext = name.includes('.') ? name.split('.').pop() : '';
    const lang = LANGS[ext];
    return lang && window.hljs && window.hljs.getLanguage(lang) ? lang : null;
  };
  // highlight.js returns spans and escaped text; a span may run across lines,
  // so each line closes the spans still open and the next reopens them.
  function splitLines(html) {
    const lines = [];
    const open = [];
    let cur = '';
    const re = /<span[^>]*>|<\\/span>|\\n|[^<\\n]+/g;
    let m;
    while ((m = re.exec(html))) {
      const t = m[0];
      if (t === '\\n') {
        lines.push(cur + '</span>'.repeat(open.length));
        cur = open.join('');
      } else if (t.startsWith('<span')) {
        open.push(t);
        cur += t;
      } else if (t === '</span>') {
        open.pop();
        cur += t;
      } else {
        cur += t;
      }
    }
    lines.push(cur + '</span>'.repeat(open.length));
    return lines;
  }
  function colourFile(fileEl) {
    const lang = langOf(fileEl.dataset.path || '');
    if (!lang) return;
    const hunks = new Map();
    for (const row of fileEl.querySelectorAll('.row')) {
      if (!hunks.has(row.dataset.hunk)) hunks.set(row.dataset.hunk, []);
      hunks.get(row.dataset.hunk).push(row);
    }
    for (const rows of hunks.values()) {
      for (const side of ['new', 'old']) {
        const sideRows = rows.filter((r) => (side === 'new' ? !r.classList.contains('del') : !r.classList.contains('add')));
        if (sideRows.length === 0) continue;
        const text = sideRows.map((r) => r.querySelector('.code').textContent.replace(/\\n$/, '')).join('\\n');
        let lines;
        try { lines = splitLines(window.hljs.highlight(text, { language: lang, ignoreIllegals: true }).value); } catch (e) { continue; }
        sideRows.forEach((r, i) => {
          // Context lines are coloured from the new side only.
          if (side === 'old' && !r.classList.contains('del')) return;
          r.querySelector('.code').innerHTML = (lines[i] || '') + '\\n';
        });
      }
    }
  }
  // One file per tick, so a long diff never holds the page.
  function colourAll() {
    if (!window.hljs) return;
    const queue = [...document.querySelectorAll('details.file')];
    const next = () => {
      const fileEl = queue.shift();
      if (!fileEl) return;
      colourFile(fileEl);
      setTimeout(next, 0);
    };
    next();
  }
  colourAll();

  // ---- Chapters read (this viewer's browser only)
  const KEY = ${JSON.stringify(storeKey)};
  let done = {};
  try { done = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { done = {}; }
  const boxes = [...document.querySelectorAll('.ch-done input[data-chapter]')];
  const progress = document.getElementById('progress');
  const paintDone = () => {
    let n = 0;
    for (const box of boxes) {
      box.checked = !!done[box.dataset.chapter];
      const item = document.querySelector('.cs-item[data-ch="' + box.dataset.chapter + '"]');
      if (item) item.classList.toggle('done', box.checked);
      if (box.checked) n++;
    }
    if (progress) progress.textContent = n + ' of ' + boxes.length + ' read';
  };
  for (const box of boxes) {
    box.addEventListener('change', () => {
      done[box.dataset.chapter] = box.checked;
      try { localStorage.setItem(KEY, JSON.stringify(done)); } catch (e) {}
      paintDone();
    });
  }
  paintDone();

  // ---- Files reviewed (this viewer's browser only). A tick folds the file and
  // marks it in every file list.
  let reviewed = {};
  try { reviewed = JSON.parse(localStorage.getItem(KEY + ':files') || '{}') || {}; } catch (e) { reviewed = {}; }
  const paintReviewed = () => {
    for (const box of document.querySelectorAll('.reviewed input')) {
      const on = !!reviewed[box.dataset.fileKey];
      box.checked = on;
      box.closest('details.file').classList.toggle('is-reviewed', on);
    }
    for (const li of document.querySelectorAll('.filelist li')) li.classList.toggle('is-reviewed', !!reviewed[li.dataset.fileKey]);
  };
  document.addEventListener('click', (ev) => {
    const label = ev.target.closest('.reviewed');
    if (label) {
      // The box sits in the file's header: tick it without also folding or opening the file.
      ev.preventDefault();
      const box = label.querySelector('input');
      const key = box.dataset.fileKey;
      reviewed[key] = !reviewed[key];
      try { localStorage.setItem(KEY + ':files', JSON.stringify(reviewed)); } catch (e) {}
      paintReviewed();
      if (reviewed[key]) box.closest('details.file').open = false;
    }
  });
  paintReviewed();

  // ---- Comments and the page's store light up later, or never
  let comments = null;
  let commentsOff = false;
  let db = null;
  const canExplain = () => !!(comments && db && !commentsOff);
  const showClaudeButtons = (on) => { for (const b of document.querySelectorAll('[data-needs="claude"]')) b.hidden = !on; };
  const lightUp = () => { showClaudeButtons(canExplain()); refreshBar(); };
  if (window.claude && typeof window.claude.use === 'function') {
    window.claude.use('comments').then((c) => { comments = c; lightUp(); }).catch(() => {});
    window.claude.use('db').then((d) => { db = d; if (d) watchExplains(); lightUp(); }).catch(() => {});
  }

  // ---- Where a row sits in the guide
  const fileOf = (el) => el.closest('details.file');
  const refOf = (fileEl) => {
    const chapter = CONTEXT.chapters[Number(fileEl.dataset.chapter)];
    return { chapter, file: chapter.files[Number(fileEl.dataset.file)] };
  };
  const rowsOf = (fileEl) => [...fileEl.querySelectorAll('.row')];
  const lineText = (row) => {
    const sign = row.classList.contains('add') ? '+' : row.classList.contains('del') ? '-' : ' ';
    return sign + row.querySelector('.code').textContent.replace(/\\n$/, '');
  };
  const rangeLabel = (rows) => {
    const news = rows.map((r) => r.dataset.n).filter(Boolean).map(Number);
    const olds = rows.map((r) => r.dataset.o).filter(Boolean).map(Number);
    const span = (ns) => (ns.length === 1 || ns[0] === ns[ns.length - 1] ? 'line ' + ns[0] : 'lines ' + ns[0] + '–' + ns[ns.length - 1]);
    if (news.length) return span(news);
    return 'removed ' + span(olds);
  };

  // ---- Marking lines
  let marked = [];   // rows, in page order, all in one file
  let anchorRow = null;
  let bar = null;    // the panel under the marked lines

  const clearMarks = () => {
    for (const r of marked) r.classList.remove('marked');
    marked = [];
    anchorRow = null;
    if (bar) { bar.remove(); bar = null; }
  };

  const markThrough = (row, extend) => {
    const fileEl = fileOf(row);
    if (extend && anchorRow && fileOf(anchorRow) === fileEl) {
      const all = rowsOf(fileEl);
      const a = all.indexOf(anchorRow);
      const b = all.indexOf(row);
      const next = all.slice(Math.min(a, b), Math.max(a, b) + 1);
      for (const r of marked) r.classList.remove('marked');
      marked = next;
    } else {
      if (marked.length === 1 && marked[0] === row) { clearMarks(); return; }
      for (const r of marked) r.classList.remove('marked');
      marked = [row];
      anchorRow = row;
    }
    for (const r of marked) r.classList.add('marked');
    showBar();
  };

  // Dragging from a line number marks every line between the press and the
  // pointer, over the numbers or the code; a press without a drag stays a click.
  let drag = null;
  let suppressClick = false;
  const rowAt = (x, y, fileEl) => {
    const hit = document.elementFromPoint(x, y);
    const row = hit && hit.closest ? hit.closest('.row') : null;
    return row && fileOf(row) === fileEl ? row : null;
  };
  document.addEventListener('pointerdown', (ev) => {
    const no = ev.target.closest('.no');
    if (!no || ev.button !== 0 || ev.shiftKey) return;
    ev.preventDefault(); // no text selection while dragging
    drag = { start: no.closest('.row'), moved: false };
  });
  document.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const row = rowAt(ev.clientX, ev.clientY, fileOf(drag.start));
    if (!row || (!drag.moved && row === drag.start)) return;
    if (!drag.moved) {
      drag.moved = true;
      if (bar) { bar.remove(); bar = null; }
    }
    const all = rowsOf(fileOf(drag.start));
    const a = all.indexOf(drag.start);
    const b = all.indexOf(row);
    for (const r of marked) r.classList.remove('marked');
    marked = all.slice(Math.min(a, b), Math.max(a, b) + 1);
    anchorRow = drag.start;
    for (const r of marked) r.classList.add('marked');
  });
  const endDrag = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) return;
    showBar();
    // The click that may follow this release is the drag's, not a new press.
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
  };
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  document.addEventListener('click', (ev) => {
    const no = ev.target.closest('.no');
    if (no) {
      ev.preventDefault();
      if (!suppressClick) markThrough(no.closest('.row'), ev.shiftKey);
      return;
    }
    const hunkBtn = ev.target.closest('.explain-hunk');
    if (hunkBtn) {
      const head = hunkBtn.closest('.hunk');
      const fileEl = fileOf(head);
      const rows = rowsOf(fileEl).filter((r) => r.dataset.hunk === head.dataset.hunk);
      explain(rows, rows[rows.length - 1]);
    }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && marked.length && !(bar && bar.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA')) clearMarks();
    const no = ev.target.closest && ev.target.closest('.no');
    if (no && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); markThrough(no.closest('.row'), ev.shiftKey); }
  });

  // A panel is as wide as the visible card and stays put while the code scrolls sideways.
  const sizePanel = (panel) => {
    const diff = panel.closest('.diff');
    if (diff) panel.style.width = diff.clientWidth + 'px';
  };
  window.addEventListener('resize', () => { for (const p of document.querySelectorAll('.panel')) sizePanel(p); });

  // ---- Views: #overview, #guide (#guide-N for a chapter) and #files.
  const DEFAULT_VIEW = ${JSON.stringify(defaultView)};
  let currentView = null;
  let currentChapter = 1;
  function showChapter(n) {
    const pages = [...document.querySelectorAll('.chapter-page')];
    if (pages.length === 0) return false;
    const next = Math.min(Math.max(1, n), pages.length);
    const changed = next !== currentChapter;
    currentChapter = next;
    for (const page of pages) page.hidden = Number(page.dataset.ch) !== next;
    for (const item of document.querySelectorAll('.cs-item')) item.classList.toggle('active', Number(item.dataset.ch) === next);
    return changed;
  }
  function route() {
    const h = location.hash.slice(1);
    let view = h.indexOf('guide') === 0 ? 'guide' : h === 'files' || h === 'overview' ? h : DEFAULT_VIEW;
    if (!document.getElementById('view-' + view)) view = DEFAULT_VIEW;
    const viewChanged = view !== currentView;
    currentView = view;
    for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== 'view-' + view;
    for (const t of document.querySelectorAll('.tabs a')) t.classList.toggle('active', t.dataset.view === view);
    let chapterChanged = false;
    if (view === 'guide') {
      const m = h.match(/^guide-(\\d+)$/);
      chapterChanged = showChapter(m ? Number(m[1]) : currentChapter);
    }
    if (viewChanged || chapterChanged) window.scrollTo(0, 0);
    // A panel drawn while its view was hidden measured no width.
    for (const p of document.querySelectorAll('.view:not([hidden]) .panel')) sizePanel(p);
  }
  // A link with data-goto names a file element: show its view (and chapter),
  // open the file and bring it into view.
  function goTo(id) {
    const target = document.getElementById(id);
    if (!target) return;
    const page = target.closest('.chapter-page');
    const view = target.closest('.view');
    const hash = page ? '#guide-' + page.dataset.ch : '#' + view.id.slice(5);
    if (location.hash !== hash) history.pushState(null, '', hash);
    route();
    if (target.tagName === 'DETAILS') target.open = true;
    target.scrollIntoView({ block: 'start' });
  }
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest('[data-goto]');
    if (!a) return;
    ev.preventDefault();
    goTo(a.dataset.goto);
  });
  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', route);


  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const button = (label, cls, onClick) => {
    const b = el('button', 'btn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };

  function showBar() {
    if (bar) bar.remove();
    const last = marked[marked.length - 1];
    const fileEl = fileOf(last);
    bar = el('div', 'panel marking');
    const head = el('div', 'panel-head');
    head.append(el('span', 'panel-title', refOf(fileEl).file.path + ' · ' + rangeLabel(marked)));
    const actions = el('div', 'actions');
    head.append(actions);
    bar.append(head);
    last.after(bar);
    sizePanel(bar);
    refreshBar();
  }

  // Draws the bar's buttons from what this view can do now.
  function refreshBar() {
    if (!bar) return;
    const actions = bar.querySelector('.actions');
    if (!actions) return;
    actions.replaceChildren();
    if (canExplain()) actions.append(button('Explain', '', () => explain(marked.slice(), bar)));
    if (comments && !commentsOff) actions.append(button('Comment', '', () => openComment()));
    actions.append(button('Clear', '', clearMarks));
  }

  // ---- Explain. A click posts a request to the Claude Code session that
  // published this page (a comment sent to Claude: the one way a page wakes
  // it). That session writes its steps and answer to explains/<id> in the
  // page's store, and every open view draws them under the lines, typing the
  // text out as it arrives.
  const explainCopy = {
    no_session: 'No Claude Code session is watching this page. Open the session that made it, then try again.',
    writers_only: 'Only editors of this page can ask Claude.',
    off: 'Asking Claude is not available in this view.',
    claude_unavailable: 'Not sent: no Claude Code session could take it. Open the session that made this page, then try again.',
    consent_required: 'Not sent: allow comments from this page, then try again.',
    rate_limited: 'Not sent: too many requests just now. Try again in a minute.',
  };
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const panels = new Map(); // explain id → a panel under each place its lines show (Guide, Files)
  const allPanels = () => [].concat(...panels.values());

  function notice(after, title, message, isError) {
    const panel = el('div', 'panel notice');
    const head = el('div', 'panel-head');
    head.append(el('span', 'panel-title', title), button('Close', '', () => panel.remove()));
    panel.append(head, el('div', isError ? 'status error' : 'status', message));
    after.after(panel);
    sizePanel(panel);
  }

  function makePanel(id, title, afterEl, open, row = afterEl) {
    const panel = el('div', 'panel explain');
    const head = el('div', 'panel-head');
    const body = el('div', 'explain-body');
    const toggle = button(open ? 'Hide' : 'Show', '', () => {
      body.hidden = !body.hidden;
      toggle.textContent = body.hidden ? 'Show' : 'Hide';
    });
    head.append(el('span', 'panel-title', title), toggle);
    const steps = el('ol', 'steps');
    const answer = el('div', 'answer');
    const status = el('div', 'status');
    status.hidden = true;
    body.append(steps, answer, status);
    body.hidden = !open;
    panel.append(head, body);
    afterEl.after(panel);
    sizePanel(panel);
    const p = { panel, row, steps, answer, status, state: 'pending', target: '', shown: 0, drawn: -1, drawnState: '', instant: false };
    if (!panels.has(id)) panels.set(id, []);
    panels.get(id).push(p);
    return p;
  }

  function setStatus(p, text, isError) {
    p.status.hidden = !text;
    p.status.className = isError ? 'status error' : 'status';
    p.status.textContent = text || '';
  }

  function applyDoc(p, d) {
    p.state = typeof d.state === 'string' ? d.state : 'working';
    const steps = Array.isArray(d.steps) ? d.steps : [];
    p.steps.replaceChildren(...steps.map((s, i) => el('li', i === steps.length - 1 && p.state === 'working' && !d.text ? 'step live' : 'step', String(s))));
    p.target = typeof d.text === 'string' ? d.text : '';
    if (p.shown > p.target.length) p.shown = 0;
    if (p.state === 'failed') setStatus(p, String(d.error || 'Claude Code could not answer this one.'), true);
    else setStatus(p, '');
    // Nothing to animate: draw now, without waiting for a frame (a page in a
    // tab or pane that is not painting gets none).
    if (reduceMotion || p.instant) {
      p.shown = p.target.length;
      draw(p);
      return;
    }
    kick();
  }

  // Paragraphs split by a blank line; \`code\` in backticks.
  function renderAnswer(box, text, caret) {
    box.replaceChildren();
    const paras = text.split(/\\n\\s*\\n/);
    paras.forEach((para, i) => {
      const p = el('p');
      para.split(/(\`[^\`]+\`)/).forEach((part) => {
        if (/^\`[^\`]+\`$/.test(part)) p.append(el('code', null, part.slice(1, -1)));
        else if (part) p.append(document.createTextNode(part));
      });
      if (caret && i === paras.length - 1) p.append(el('span', 'caret'));
      box.append(p);
    });
  }

  let ticking = false;
  function kick() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(tick);
  }
  // Types the text out at about 90 characters a second, faster when a long
  // piece lands, so each paragraph the session writes reads as it arrives.
  function tick() {
    let busy = false;
    for (const p of allPanels()) {
      if (p.shown < p.target.length) {
        const backlog = p.target.length - p.shown;
        p.shown = Math.min(p.target.length, p.shown + Math.max(1.5, backlog / 90));
        busy = true;
      }
      draw(p);
    }
    if (busy) requestAnimationFrame(tick);
    else ticking = false;
  }
  function draw(p) {
    const n = Math.floor(p.shown);
    if (n === p.drawn && p.state === p.drawnState) return;
    p.drawn = n;
    p.drawnState = p.state;
    const typing = n < p.target.length || p.state === 'working';
    renderAnswer(p.answer, p.target.slice(0, n), typing && n > 0);
  }

  // An answer is pinned to its file and lines (\`n12\` a line of the new file,
  // \`o10\` a removed one), so it stays put when the chapters are rewritten.
  // Answers written before carry a chapter, file and row position instead.
  const rowKey = (row) => (row.dataset.n ? 'n' + row.dataset.n : 'o' + row.dataset.o);
  // Every row the answer belongs under: a line shows in the Guide and in Files.
  function rowsFor(d) {
    if (typeof d.to === 'string' && typeof d.path === 'string') {
      const found = [];
      for (const fileEl of document.querySelectorAll('details.file')) {
        if (fileEl.dataset.path !== d.path) continue;
        const row = rowsOf(fileEl).find((r) => rowKey(r) === d.to);
        if (row) found.push(row);
      }
      return found;
    }
    const fileEl = document.querySelector('details.file[data-chapter="' + Number(d.chapter) + '"][data-file="' + Number(d.file) + '"]');
    if (!fileEl) return [];
    const rows = rowsOf(fileEl);
    const row = rows[Math.min(Number(d.last), rows.length - 1)];
    return row ? [row] : [];
  }

  // One subscription for the page: answers being written now, and those
  // written before this view opened (shown folded, typed out at once).
  function watchExplains() {
    db.collection('explains').onSnapshot((snap) => {
      for (const change of snap.docChanges()) {
        if (change.type === 'removed') continue;
        const d = change.doc.data();
        if (!d) continue;
        const live = d.state !== 'done' && d.state !== 'failed';
        const label = String(d.label || '');
        // A label written as file:lines stands alone; older answers carry a path and "lines …".
        const title = 'Explain · ' + (label.includes(':') ? label : String(d.path || '') + ' · ' + label);
        const have = panels.get(change.doc.id) || [];
        for (const row of rowsFor(d)) {
          if (have.some((p) => p.row === row)) continue;
          const p = makePanel(change.doc.id, title, row, live);
          p.instant = !live;
        }
        for (const p of panels.get(change.doc.id) || []) applyDoc(p, d);
      }
    }, () => {});
  }

  async function explain(rows, after) {
    if (!canExplain() || rows.length === 0) return;
    const fileEl = fileOf(rows[0]);
    const title = 'Explain · ' + headOf(rows);
    let can = 'off';
    try { can = await comments.canSendToClaude(); } catch (e) { can = 'off'; }
    if (can !== 'available') {
      notice(after && after.isConnected ? after : rows[rows.length - 1], title, explainCopy[can] || explainCopy.off, true);
      return;
    }
    const id = 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const request = '🔍 Explain ' + headOf(rows) + '\\n↳ ' + pathOf(rows) + ' · ' + keysOf(rows) + ' · ' + id;
    let anchor;
    try { anchor = await comments.anchorFor(rows[0]); } catch (e) { anchor = null; }
    if (after === bar) clearMarks();
    const p = makePanel(id, title, rows[rows.length - 1], true, rows[rows.length - 1]);
    setStatus(p, 'Waiting for Claude Code…');
    if (!anchor) { setStatus(p, 'Not sent: something went wrong. Try again.', true); return; }
    try {
      await comments.sendToClaude({ anchor, text: request });
    } catch (e) {
      if (e && (e.code === 'forbidden' || e.code === 'not_granted' || e.code === 'capability_disabled')) {
        commentsOff = true;
        lightUp();
        setStatus(p, 'Asking Claude from this page is off here.', true);
      } else {
        setStatus(p, explainCopy[e && e.code] || 'Not sent: something went wrong. Try again.', true);
      }
    }
  }

  // ---- Comment on the marked lines
  const commentCopy = {
    consent_required: 'Not posted: allow comments from this page, then post again.',
    rate_limited: 'Not posted: too many comments just now. Try again in a minute.',
    invalid: 'Not posted: the comment is empty or too long.',
    claude_unavailable: 'Not sent to Claude. Post it as a plain comment instead.',
  };

  // A request or comment names its file and lines and nothing more: the app
  // shows it as plain text, and the session reads the code itself.
  // Plain text (the app renders no markdown here): a line a person reads, then
  // the pointer itself on a line of its own.
  const pathOf = (rows) => refOf(fileOf(rows[0])).file.path;
  // file:line, or file:first–last, as an editor or a stack trace writes it.
  const lineRef = (rows) => {
    const news = rows.map((r) => r.dataset.n).filter(Boolean);
    const olds = rows.map((r) => r.dataset.o).filter(Boolean);
    const span = (ns) => (ns[0] === ns[ns.length - 1] ? ':' + ns[0] : ':' + ns[0] + '–' + ns[ns.length - 1]);
    return news.length ? span(news) : span(olds) + ' (removed)';
  };
  const headOf = (rows) => pathOf(rows).split('/').pop() + lineRef(rows);
  const keysOf = (rows) => {
    const a = rowKey(rows[0]);
    const b = rowKey(rows[rows.length - 1]);
    return a === b ? a : a + '–' + b;
  };
  function commentText(rows, words) {
    return '💬 ' + headOf(rows) + '\\n↳ ' + pathOf(rows) + '\\n\\n' + words;
  }

  async function openComment() {
    if (!bar || !comments) return;
    const rows = marked.slice();
    bar.querySelector('.comment-box')?.remove();
    const box = el('div', 'comment-box');
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '8px';
    const area = el('textarea');
    area.id = 'comment-draft';
    area.maxLength = 3000;
    area.placeholder = 'Your comment on these lines';
    const status = el('div', 'status');
    status.hidden = true;
    const actions = el('div', 'actions');
    const send = async (toClaude) => {
      const words = area.value.trim();
      if (!words) { status.hidden = false; status.className = 'status error'; status.textContent = 'Write a comment first.'; return; }
      for (const b of actions.querySelectorAll('button')) b.disabled = true;
      status.hidden = false;
      status.className = 'status';
      status.textContent = toClaude ? 'Sending to Claude…' : 'Posting…';
      try {
        const anchor = await comments.anchorFor(rows[0]);
        const text = commentText(rows, words);
        if (toClaude) await comments.sendToClaude({ anchor, text });
        else await comments.create({ anchor, text });
        clearMarks();
      } catch (e) {
        for (const b of actions.querySelectorAll('button')) b.disabled = false;
        status.className = 'status error';
        if (e && (e.code === 'forbidden' || e.code === 'not_granted' || e.code === 'capability_disabled')) {
          commentsOff = true;
          showClaudeButtons(false);
          status.textContent = 'Commenting from this page is off here. Select text and use the comment button instead.';
          refreshBar();
        } else {
          status.textContent = commentCopy[e && e.code] || 'Not posted: something went wrong. Try again.';
        }
      }
    };
    actions.append(button('Post comment', 'primary', () => send(false)));
    let canSend = 'off';
    try { canSend = await comments.canSendToClaude(); } catch (e) { canSend = 'off'; }
    if (canSend === 'available') actions.append(button('Send to Claude', '', () => send(true)));
    actions.append(button('Cancel', '', () => box.remove()));
    box.append(area, actions, status);
    bar.append(box);
    area.focus();
  }

  route();
})();
</script>
`
}

// ---------------------------------------------------------------- run
// Last in the file, so every constant above is defined before it runs.

if (process.argv[2] === '--list') {
  if (!process.argv[3]) {
    console.error('Usage: node render.mjs --list <patch.diff>')
    process.exit(2)
  }
  for (const f of parsePatch(readFileSync(process.argv[3], 'utf8'))) {
    console.log(`${f.path}  (${f.status}, +${f.additions} −${f.deletions}${f.binary ? ', binary' : ''})`)
    f.hunks.forEach((h, i) => {
      const adds = h.lines.filter((l) => l.kind === 'add').length
      const dels = h.lines.filter((l) => l.kind === 'del').length
      // The first changed line says what the hunk is about, so a summary can be written from this listing.
      const first = h.lines.find((l) => l.kind !== 'ctx' && l.text.trim() !== '')
      const glimpse = first ? `  ${first.kind === 'add' ? '+' : '-'} ${first.text.trim().slice(0, 100)}` : ''
      console.log(`  ${i}: ${h.header}  (+${adds} −${dels})${glimpse}`)
    })
  }
  process.exit(0)
}

const [guidePath, patchPath, outPath] = process.argv.slice(2)
if (!guidePath || !patchPath || !outPath) {
  console.error('Usage: node render.mjs <guide.json> <patch.diff> <out.html>\n       node render.mjs --list <patch.diff>')
  process.exit(2)
}

const guide = JSON.parse(readFileSync(guidePath, 'utf8'))
const files = parsePatch(readFileSync(patchPath, 'utf8'))

// A guide with no chapters yet is the first page: every file in patch order,
// so the review opens while its chapters are written.
if (!Array.isArray(guide.chapters) || guide.chapters.length === 0) {
  guide.chapters = [
    {
      title: 'All changes',
      overview: 'The reading order is still being written. Until it arrives, every file shows here in patch order.',
      files: files.map((f) => ({ path: f.path })),
    },
  ]
  guide.firstPage = true
}

const errors = validate(guide, files)
if (errors.length > 0) {
  console.error(`guide.json does not match the patch:\n${errors.map((e) => `- ${e}`).join('\n')}`)
  process.exit(1)
}

writeFileSync(outPath, renderPage(guide, files))
const hunkCount = files.reduce((n, f) => n + f.hunks.length, 0)
console.log(`Wrote ${outPath}: ${guide.chapters.length} chapters, ${files.length} files, ${hunkCount} hunks.`)
