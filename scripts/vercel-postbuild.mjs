#!/usr/bin/env node
/**
 * Runs ONLY on Vercel (via `vercel-build`).
 * 1) Entry swap: landing owns "/", app -> /app.
 * 2) Copies site-assets/media -> dist/media, site-assets/brand -> dist/brand.
 * 3) Reads site-assets/publish-log.json (category final|test|pending|hidden, bestOf, platforms).
 * 4) Generates dist/media-library.html (internal: PENDING APPROVAL on top, then finals/tests/brand)
 *    and dist/gallery.html (public best-of). Approve/Reject buttons open prefilled GitHub issues
 *    (title "APPROVE: <file>" / "REJECT: <file>") which the pipeline reads via the GitHub connector.
 */
import { renameSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from "node:fs";

if (!process.env.VERCEL) {
  console.log("Not on Vercel — skipping.");
  process.exit(0);
}
if (!existsSync("dist/index.html") || !existsSync("dist/home.html")) {
  throw new Error("dist/index.html or dist/home.html missing — build order wrong?");
}
renameSync("dist/index.html", "dist/app.html");
copyFileSync("dist/home.html", "dist/index.html");
console.log("Entry swap done.");

const REPO = "ivanstamatovski/twotired-ui";
const log = existsSync("site-assets/publish-log.json") ? JSON.parse(readFileSync("site-assets/publish-log.json", "utf8")) : {};
const human = (b) => b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1e3) + " KB";
const PLABEL = { instagram: "IG", facebook: "FB", youtube: "YT", tiktok: "TT" };

function preview(url, ext, cls = "") {
  if (["mp4", "mov", "webm"].includes(ext)) return `<video class="${cls}" src="${url}" controls preload="metadata"></video>`;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return `<img class="${cls}" src="${url}" loading="lazy">`;
  if (["wav", "mp3", "m4a"].includes(ext)) return `<audio src="${url}" controls></audio>`;
  return `<div class="noprev">${ext}</div>`;
}

const buckets = { pending: [], final: [], test: [], brand: [] };

for (const [src, out, defCat] of [["site-assets/media", "media", "test"], ["site-assets/brand", "brand", "brand"]]) {
  if (!existsSync(src)) continue;
  mkdirSync(`dist/${out}`, { recursive: true });
  for (const f of readdirSync(src).sort().reverse()) {
    if (f.startsWith(".")) continue;
    copyFileSync(`${src}/${f}`, `dist/${out}/${f}`);
    const meta = log[f] || {};
    let cat = meta.category || (f.includes("-final") ? "final" : defCat);
    if (f.endsWith(".md") || cat === "hidden") continue;
    const ext = f.split(".").pop().toLowerCase();
    const url = `/${out}/${f}`;
    const badges = Object.entries(meta.platforms || {}).map(([p, v]) =>
      `<a class="badge" href="${v.url || "#"}" target="_blank">${PLABEL[p] || p}${v.date ? " · " + v.date.slice(5) : ""}</a>`).join("");
    const size = statSync(`${src}/${f}`).size;
    const approveBtns = cat === "pending" ? `<div class="appr"><a class="ok" href="https://github.com/${REPO}/issues/new?title=${encodeURIComponent("APPROVE: " + f)}&body=${encodeURIComponent("Approved from the media library. The pipeline may publish this asset.")}" target="_blank">✓ Approve</a><a class="no" href="https://github.com/${REPO}/issues/new?title=${encodeURIComponent("REJECT: " + f)}&body=${encodeURIComponent("Rejected from the media library. Do not publish; regenerate.")}" target="_blank">✕ Reject</a></div><p class="apphint">Tap → GitHub opens prefilled → Submit new issue. That's the approval.</p>` : "";
    buckets[cat]?.push(`<div class="card${cat === "pending" ? " pend" : ""}">${preview(url, ext)}<div class="meta">${meta.title ? `<span class=\"title\">${meta.title}</span>` : ""}<span class="name">${f}</span><span class="size">${human(size)}</span>${badges ? `<div class=\"badges\">${badges}</div>` : ""}${approveBtns}<button onclick="navigator.clipboard.writeText(location.origin+'${url}');this.textContent='Copied!';setTimeout(()=>this.textContent='Copy URL',1500)">Copy URL</button></div></div>`);
  }
}

const SEC = [
  ["⏳ PENDING YOUR APPROVAL", buckets.pending],
  ["Finals — submitted / ready for social", buckets.final],
  ["Tests & variations", buckets.test],
  ["Brand assets", buckets.brand],
];
const libHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>TwoTired — Media Library</title><style>
body{background:#141414;color:#eee;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;padding:24px}
h1{font-size:1.6rem}h1 em{color:#f97316;font-style:normal}
h2{font-size:1.1rem;margin:28px 0 12px;color:#ddd}h2 small{color:#888;font-weight:400}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}
.card{background:#1e1e1e;border:1px solid #333;border-radius:12px;overflow:hidden}
.card.pend{border:2px solid #f59e0b}
.card img,.card video{width:100%;height:250px;object-fit:contain;background:#000;display:block}
.card audio{width:100%;margin:14px 0}
.noprev{height:250px;display:flex;align-items:center;justify-content:center;color:#777;text-transform:uppercase}
.meta{padding:10px;display:flex;flex-direction:column;gap:5px}
.title{font-size:.85rem;font-weight:700;color:#fff}
.name{font-size:.72rem;word-break:break-all;color:#aaa}
.size{font-size:.7rem;color:#777}
.badges{display:flex;gap:6px;flex-wrap:wrap}
.badge{background:#2c2c2c;border:1px solid #444;color:#f97316;font-size:.7rem;font-weight:700;padding:3px 8px;border-radius:6px;text-decoration:none}
.appr{display:flex;gap:8px}
.appr a{flex:1;text-align:center;padding:10px 0;border-radius:8px;font-weight:800;text-decoration:none;font-size:.9rem}
.appr .ok{background:#16a34a;color:#fff}.appr .no{background:#3a3a3a;color:#f87171}
.apphint{font-size:.66rem;color:#888;margin:0}
button{background:#f97316;border:0;color:#fff;padding:7px 10px;border-radius:8px;font-weight:600;cursor:pointer;font-size:.8rem}
button:hover{background:#ea6c0a}
</style></head><body><h1>Two<em>Tired</em> media library</h1>
<p style="color:#888;font-size:.85rem">Auto-generated from <code>site-assets/</code> + <code>publish-log.json</code>. Unlisted. Public best-of: <a style="color:#f97316" href="/gallery">/gallery</a></p>
${SEC.filter(([, i]) => i.length).map(([t, i]) => `<h2>${t} <small>(${i.length})</small></h2><div class="grid">${i.join("")}</div>`).join("\n")}
</body></html>`;
writeFileSync("dist/media-library.html", libHtml);
console.log("media-library.html generated");

// ---------- public best-of gallery ----------
const SOCIAL = [
  ["Instagram", "https://www.instagram.com/ridetwotired/"],
  ["TikTok", "https://www.tiktok.com/@ridetwotired"],
  ["Facebook", "https://www.facebook.com/61591906523319"],
  ["YouTube", "https://www.youtube.com/channel/UCrg9QZIgXf6Ieuo666-3ZcQ"],
];
const best = Object.entries(log).filter(([, m]) => m.bestOf && m.category === "final").map(([f, m]) => {
  const ext = f.split(".").pop().toLowerCase();
  const links = Object.entries(m.platforms || {}).filter(([, v]) => v.url).map(([p, v]) => `<a href="${v.url}" target="_blank">${p[0].toUpperCase() + p.slice(1)}</a>`).join(" · ");
  return `<div class="gcard">${preview("/media/" + f, ext, "gmedia")}<div class="gmeta"><b>${m.title || f}</b><p>${m.caption || ""}</p>${links ? `<span class=\"glinks\">Watch on ${links}</span>` : ""}</div></div>`;
}).join("\n");

const socialFooter = SOCIAL.map(([n, u]) => `<a href="${u}" target="_blank" rel="noopener">${n}</a>`).join("");
const galleryHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gallery — TwoTired</title>
<meta name="description" content="The best of TwoTired — AI motorcycle route planning, told by riders. Videos and stories from the garage.">
<link rel="canonical" href="https://www.twotired.net/gallery">
<link rel="icon" type="image/svg+xml" href="/favicon.svg"><style>
:root{--bg:#f8f8f6;--surface:#fff;--accent:#f97316;--accent-hover:#ea6c0a;--text:#1a1a1a;--text-dim:#555;--text-muted:#999}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.6}
a{color:var(--accent);text-decoration:none}
.wrap{max-width:960px;margin:0 auto;padding:0 20px}
header.site{position:sticky;top:0;background:rgba(248,248,246,.92);backdrop-filter:blur(8px);border-bottom:1px solid #e5e5e2;z-index:50}
header.site .wrap{display:flex;align-items:center;justify-content:space-between;height:56px}
.logo{font-weight:800;font-size:1.15rem;color:var(--text)}.logo em{color:var(--accent);font-style:normal}
nav.top a{color:var(--text-dim);margin-left:18px;font-size:.92rem;font-weight:500}
.btn{display:inline-block;background:var(--accent);color:#fff!important;font-weight:600;padding:7px 14px;border-radius:8px;font-size:.88rem}
h1{font-size:2rem;margin:34px 0 6px;letter-spacing:-.02em}
p.sub{color:var(--text-dim);margin-bottom:26px}
.ggrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px;margin-bottom:50px}
.gcard{background:var(--surface);border:1px solid #e7e7e4;border-radius:16px;overflow:hidden}
.gmedia{width:100%;max-height:420px;object-fit:contain;background:#111;display:block}
.gmeta{padding:16px}.gmeta b{display:block;margin-bottom:6px}
.gmeta p{color:var(--text-dim);font-size:.92rem;margin-bottom:8px}
.glinks{font-size:.82rem;color:var(--text-muted)}
footer.site{border-top:1px solid #e5e5e2;padding:26px 0;color:var(--text-muted);font-size:.85rem}
footer.site .wrap{display:flex;flex-wrap:wrap;gap:16px;justify-content:space-between}
footer.site a{color:var(--text-dim);margin-right:14px}
</style></head><body>
<header class="site"><div class="wrap"><a class="logo" href="/">Two<em>Tired</em></a>
<nav class="top"><a href="/routes/">Routes</a><a href="/gallery">Gallery</a><a href="/support.html">Support</a><a class="btn" href="https://apps.apple.com/us/app/twotired/id6773547851">Get the app</a></nav></div></header>
<main class="wrap">
<h1>From the garage</h1>
<p class="sub">The best of TwoTired — riders, routes, and the occasional rack of ribs. Follow along: ${SOCIAL.map(([n, u]) => `<a href=\"${u}\" target=\"_blank\" rel=\"noopener\">${n}</a>`).join(" · ")}</p>
<div class="ggrid">${best}</div>
</main>
<footer class="site"><div class="wrap"><div>© ${new Date().getFullYear()} TwoTired — built by riders in NYC.</div><div>${socialFooter}<a href="/privacy.html">Privacy</a><a href="/support.html">Support</a></div></div></footer>
</body></html>`;
writeFileSync("dist/gallery.html", galleryHtml);
console.log("gallery.html generated");
