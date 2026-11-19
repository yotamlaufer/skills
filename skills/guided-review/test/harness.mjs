#!/usr/bin/env node
// Wraps a page render.mjs wrote in a stand-in for the Artifact viewer, so the
// page can be opened from disk in a browser and exercised without claude.ai:
// `window.claude.use` hands it fake `comments` and `db` capabilities.
//
// From the browser console (or a test driver):
//   __harness.sent        requests and comments the page sent, newest last
//   __harness.write(id, fields)   merges fields into explains/<id> and
//                         delivers the change, as the review session would
//   __harness.answer(id, {steps, paragraphs, ms})  plays a whole answer:
//                         opens it, adds each step, then each paragraph
//   __harness.set({can})  "no_session" etc. before a click; the page's URL
//                         takes ?can=…&comments=0&db=0 to set it before load
//
// Usage: node harness.mjs <guide.html> <out.html>

import { readFileSync, writeFileSync } from 'node:fs'

const [pagePath, outPath] = process.argv.slice(2)
if (!pagePath || !outPath) {
  console.error('Usage: node harness.mjs <guide.html> <out.html>')
  process.exit(2)
}

const page = readFileSync(pagePath, 'utf8')

const fake = String.raw`<script>
(() => {
  // ?can=no_session&comments=0&db=0 sets the view up before the page asks.
  const q = new URLSearchParams(location.search);
  const config = { can: q.get('can') || 'available', comments: q.get('comments') !== '0', db: q.get('db') !== '0' };
  const docs = new Map();
  const listeners = [];
  const sent = [];
  const deliver = (id, type) => {
    const body = docs.get(id);
    const snap = { id, exists: true, data: () => body };
    for (const next of listeners) next({ docChanges: () => [{ type, doc: snap }] });
  };
  const comments = {
    canSendToClaude: async () => config.can,
    anchorFor: async (el) => ({ path: el.className, x: 0, y: 0 }),
    sendToClaude: async ({ text }) => { sent.push({ kind: 'sendToClaude', text }); return { threadId: 't' + sent.length, commentId: 'c' + sent.length }; },
    create: async ({ text }) => { sent.push({ kind: 'create', text }); return { threadId: 't' + sent.length, commentId: 'c' + sent.length }; },
  };
  const db = {
    collection: (path) => ({
      onSnapshot: (next) => {
        if (path !== 'explains') throw new Error('unexpected collection ' + path);
        listeners.push(next);
        setTimeout(() => next({ docChanges: () => [...docs.keys()].map((id) => ({ type: 'added', doc: { id, exists: true, data: () => docs.get(id) } })) }), 50);
        return () => {};
      },
    }),
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__harness = {
    sent,
    docs,
    set: (patch) => Object.assign(config, patch),
    write: (id, fields) => {
      const had = docs.has(id);
      docs.set(id, Object.freeze({ ...(docs.get(id) || {}), ...fields }));
      deliver(id, had ? 'modified' : 'added');
    },
    async answer(id, { place, steps = [], paragraphs = [], ms = 700 }) {
      this.write(id, { ...place, state: 'working', steps: steps.slice(0, 1), text: '' });
      for (let i = 2; i <= steps.length; i++) { await sleep(ms); this.write(id, { steps: steps.slice(0, i) }); }
      for (let i = 1; i <= paragraphs.length; i++) { await sleep(ms); this.write(id, { text: paragraphs.slice(0, i).join('\n\n') }); }
      await sleep(ms);
      this.write(id, { state: 'done' });
    },
  };
  window.claude = {
    use: async (name) => {
      await sleep(20);
      if (name === 'comments') return config.comments ? comments : null;
      if (name === 'db') return config.db ? db : null;
      return null;
    },
  };
})();
</script>`

// The Artifact publish wraps a page in this skeleton; the harness does the same.
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${fake}${page}</body></html>`

writeFileSync(outPath, html)
console.log(`Wrote ${outPath}`)
