/* Dashboard language. In English this file does nothing at all. In Telugu it watches the page and swaps each piece of text
   for its translation, labels and case data alike: numbers, plates and times become ⟦0⟧ tokens first and are put back
   afterwards, so a translation can never alter them. Translations come pre-built from the server; anything new is asked for
   in batches and stays in English until it arrives. Switching back restores the original text exactly. */
const KEY = "lang";
export type Lang = "en" | "te";
const TOKEN = /[A-Z0-9?•:.\/+\-±%,]*\d[A-Z0-9?•:.\/+\-±%,]*/g;
const LETTERS = /[A-Za-z]{2}/;
const CODE_LIKE = /^[a-z0-9_\-./:]+$|^https?:|^\/api\/|@/;
const SKIP = new Set(["SCRIPT", "STYLE", "CODE", "TEXTAREA", "INPUT", "NOSCRIPT"]);
const ATTRS = ["placeholder", "title", "aria-label"];

let lang: Lang = "en";
let table: Record<string, string> = {};
let observer: MutationObserver | null = null;
const nodes = new WeakMap<Text, { orig: string; shown: string }>();
const seen = new Set<Text>();   // to restore English without walking React's tree for stale values
const attrs = new WeakMap<Element, Record<string, { orig: string; shown: string }>>();
const missing = new Set<string>();
const tried = new Map<string, number>();
let timer: number | null = null;
let busy = false;
const listeners = new Set<() => void>();

export function getLang(): Lang { return lang; }
export function onLang(f: () => void) { listeners.add(f); return () => { listeners.delete(f); }; }

function render(text: string): string | null {
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!m) return null;
  const [, pre, body, post] = m;
  if (!LETTERS.test(body) || CODE_LIKE.test(body)) return null;
  const found: string[] = [];
  const template = body.replace(TOKEN, (x) => { found.push(x); return `⟦${found.length - 1}⟧`; });
  if (!LETTERS.test(template)) return null;
  const tr = table[template];
  if (tr == null) { want(template); return null; }
  return pre + tr.replace(/⟦(\d+)⟧/g, (_, i) => found[+i] ?? "") + post;
}

function want(t: string) {
  const last = tried.get(t);
  if (last && Date.now() - last < 60000) return;
  missing.add(t);
  if (timer == null) timer = window.setTimeout(flush, 350);
}

async function flush() {
  timer = null;
  if (busy || !missing.size) return;
  busy = true;
  const batch = [...missing].slice(0, 25);
  batch.forEach((t) => { missing.delete(t); tried.set(t, Date.now()); });
  try {
    const r = await fetch(`/api/i18n/${lang}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texts: batch }) });
    if (r.ok) { Object.assign(table, await r.json()); if (lang !== "en") walk(document.body); }
  } catch { /* stays in English */ }
  busy = false;
  if (missing.size && timer == null) timer = window.setTimeout(flush, 350);
}

function applyText(n: Text) {
  const p = n.parentElement;
  if (!p || SKIP.has(p.tagName) || p.closest("[data-notranslate],.leaflet-control-attribution")) return;
  const cur = n.nodeValue ?? "";
  const rec = nodes.get(n);
  if (rec && cur === rec.shown) return;
  const out = render(cur);
  if (out != null && out !== cur) {
    nodes.set(n, { orig: cur, shown: out });
    seen.add(n);
    n.nodeValue = out;
  } else if (rec) nodes.delete(n);
}

function applyAttrs(el: Element) {
  for (const a of ATTRS) {
    const cur = el.getAttribute(a);
    if (!cur) continue;
    const rec = attrs.get(el)?.[a];
    if (rec && cur === rec.shown) continue;
    const out = render(cur);
    if (out != null && out !== cur) {
      attrs.set(el, { ...(attrs.get(el) ?? {}), [a]: { orig: cur, shown: out } });
      el.setAttribute(a, out);
    }
  }
}

function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) { applyText(root as Text); return; }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  if (SKIP.has(el.tagName)) { applyAttrs(el); return; }
  applyAttrs(el);
  el.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(",")).forEach(applyAttrs);
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = w.nextNode())) applyText(n as Text);
}

function restore() {
  seen.forEach((n) => {
    const rec = nodes.get(n);
    if (rec && n.nodeValue === rec.shown) n.nodeValue = rec.orig;
    nodes.delete(n);
  });
  seen.clear();
  document.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(",")).forEach((el) => {
    const r = attrs.get(el);
    if (r) { for (const a of Object.keys(r)) if (el.getAttribute(a) === r[a].shown) el.setAttribute(a, r[a].orig); attrs.delete(el); }
  });
}

async function start() {
  document.documentElement.lang = lang;
  if (!Object.keys(table).length) {
    try { table = await (await fetch(`/api/i18n/${lang}`)).json(); } catch { table = {}; }
  }
  if (lang === "en") return;
  walk(document.body);
  observer?.disconnect();
  observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "characterData") applyText(m.target as Text);
      else if (m.type === "attributes") applyAttrs(m.target as Element);
      else m.addedNodes.forEach(walk);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

export function setLang(next: Lang) {
  if (next === lang) return;
  lang = next;
  try { localStorage.setItem(KEY, next); } catch { /* private window */ }
  if (next === "en") {
    observer?.disconnect();
    observer = null;
    missing.clear();
    restore();
    document.documentElement.lang = "en";
  } else {
    start();
  }
  listeners.forEach((f) => f());
}

export function initLang() {
  try { if (localStorage.getItem(KEY) === "te") { lang = "te"; start(); } } catch { /* English */ }
}
