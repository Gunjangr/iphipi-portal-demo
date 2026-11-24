/* Decrypting service worker for the encrypted UI demo. Scope = the folder this file lives in. */
"use strict";
const BASE = new URL("./", self.registration.scope).pathname;
const DB = "iphipi-demo", STORE = "kv";
let mem = null;                       // {key, exp}
const audioCache = new Map();         // logical key -> {ct, body}; small LRU for seeking
let audioBytes = 0;
const AUDIO_MAX = 160 * 1024 * 1024;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) {
  const db = await idb();
  return new Promise((res, rej) => { const q = db.transaction(STORE).objectStore(STORE).get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
async function idbDel(k) {
  const db = await idb();
  return new Promise((res, rej) => { const t = db.transaction(STORE, "readwrite"); t.objectStore(STORE).delete(k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
}
async function getKey() {
  if (mem && mem.exp > Date.now()) return mem.key;
  mem = null;
  let rec = null;
  try { rec = await idbGet("k"); } catch (e) { rec = null; }
  if (!rec) return null;
  if (!(rec.exp > Date.now())) { await signOut(); return null; }
  mem = rec;
  return rec.key;
}
async function signOut() {
  mem = null; audioCache.clear(); audioBytes = 0;
  try { await idbDel("k"); } catch (e) { /* ignore */ }
}
async function loginPage() {
  const r = await fetch(BASE + "index.html", { cache: "no-cache" });
  return new Response(await r.arrayBuffer(), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
function notFound() {
  return new Response("<!doctype html><meta charset=utf-8><title>Not found</title><body style=\"font:16px system-ui;padding:2rem\"><h1>Not found</h1><p>This page is not part of the demo.</p><p><a href=\"" + BASE + "\">Back to the start</a></p>", { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
async function sha32(s) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  let h = ""; for (let i = 0; i < 16; i++) h += d[i].toString(16).padStart(2, "0");
  return h;
}
async function load(logical, key) {
  const hit = audioCache.get(logical);
  if (hit) { audioCache.delete(logical); audioCache.set(logical, hit); return hit; }
  const r = await fetch(BASE + "d/" + (await sha32(logical)) + ".bin");
  if (r.status === 404) return { missing: true };
  if (!r.ok) return { error: true };
  const buf = new Uint8Array(await r.arrayBuffer());
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, key, buf.slice(12)));
  const nl = plain.indexOf(10);
  const ct = new TextDecoder().decode(plain.subarray(0, nl));
  const out = { ct, body: plain.subarray(nl + 1) };
  if (/^(audio|video)\//.test(ct)) {
    audioCache.set(logical, out); audioBytes += out.body.length;
    while (audioBytes > AUDIO_MAX && audioCache.size > 1) {
      const first = audioCache.keys().next().value; audioBytes -= audioCache.get(first).body.length; audioCache.delete(first);
    }
  }
  return out;
}
async function handle(req, u, rel) {
  if (rel === "logout" || rel === "cdn-cgi/access/logout") { await signOut(); return loginPage(); }
  const key = await getKey();
  const nav = req.mode === "navigate" || req.destination === "document";
  if (!key) return nav ? loginPage() : new Response("Sign in required", { status: 401 });
  let item;
  try { item = await load("/" + rel + u.search, key); }
  catch (e) { await signOut(); return nav ? loginPage() : new Response("Sign in required", { status: 401 }); }
  if (item.missing) return notFound();
  if (item.error) return new Response("Temporarily unavailable", { status: 503 });
  const body = item.body, size = body.length;
  const headers = { "Content-Type": item.ct, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") || "");
  if (rg && (rg[1] !== "" || rg[2] !== "")) {
    let a, b;
    if (rg[1] === "") { a = Math.max(0, size - parseInt(rg[2], 10)); b = size - 1; }
    else { a = parseInt(rg[1], 10); b = rg[2] === "" ? size - 1 : Math.min(parseInt(rg[2], 10), size - 1); }
    if (a >= size || a > b) return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + size } });
    headers["Content-Range"] = "bytes " + a + "-" + b + "/" + size;
    headers["Content-Length"] = String(b - a + 1);
    return new Response(body.subarray(a, b + 1), { status: 206, headers });
  }
  headers["Content-Length"] = String(size);
  return new Response(body, { status: 200, headers });
}
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const u = new URL(req.url);
  if (u.origin !== self.location.origin || !u.pathname.startsWith(BASE)) return;
  const rel = u.pathname.slice(BASE.length);
  if (rel === "sw.js" || rel === "index.html" || rel === "404.html" || rel.startsWith("_demo/") || (rel.startsWith("d/") && rel.endsWith(".bin"))) return;
  e.respondWith(handle(req, u, rel));
});
