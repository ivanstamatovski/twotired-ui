#!/usr/bin/env node
/**
 * Runs ONLY on Vercel (via the `vercel-build` script).
 * 1) Swaps the web entry so the marketing landing owns "/" (app -> /app).
 * 2) Copies web-only asset folders (never shipped in Capacitor bundles):
 *      site-assets/media -> dist/media   (published videos + post graphics)
 *      site-assets/brand -> dist/brand   (logos, outro, jingle, banners)
 * 3) Generates dist/media-library.html — a private visual gallery of everything.
 */
import { renameSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";

if (!process.env.VERCEL) {
  console.log("Not on Vercel — skipping entry swap (Capacitor build keeps app at index.html).");
  process.exit(0);
}
if (!existsSync("dist/index.html") || !existsSync("dist/home.html")) {
  throw new Error("dist/index.html or dist/home.html missing — build order wrong?");
}
renameSync("dist/index.html", "dist/app.html");
copyFileSync("dist/home.html", "dist/index.html");
console.log("Vercel entry swap done: / = landing, /app = app.");

const SECTIONS = [
  { src: "site-assets/media", out: "media", title: "Post media (published & publishable)" },
  { src: "site-assets/brand", out: "brand", title: "Brand assets (logos, outro, banners)" },
];

const human = (b) => b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1e3) + " KB";
const cards = [];

for (const s of SECTIONS) {
  if (!existsSync(s.src)) continue;
  mkdirSync(`dist/${s.out}`, { recursive: true });
  const items = [];
  for (const f of readdirSync(s.src).sort().reverse()) {
    if (f.startsWith(".")) continue;
    copyFileSync(`${s.src}/${f}`, `dist/${s.out}/${f}`);
    const size = statSync(`${s.src}/${f}`).size;
    const url = `/${s.out}/${f}`;
    const ext = f.split(".").pop().toLowerCase();
    let preview;
    if (["mp4", "mov", "webm"].includes(ext)) preview = `<video src="${url}" controls preload="metadata"></video>`;
    else if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) preview = `<img src="${url}" loading="lazy">`;
    else if (["wav", "mp3", "m4a"].includes(ext)) preview = `<audio src="${url}" controls></audio>`;
    else preview = `<div class="noprev">${ext}</div>`;
    items.push(`<div class="card">${preview}<div class="meta"><span class="name">${f}</span><span class="size">${human(size)}</span><button onclick="navigator.clipboard.writeText(location.origin+'${url}');this.textContent='Copied!';setTimeout(()=>this.textContent='Copy URL',1500)">Copy URL</button></div></div>`);
  }
  if (items.length) cards.push(`<h2>${s.title} <small>(${items.length})</small></h2><div class="grid">${items.join("")}</div>`);
  console.log(`Copied ${s.src} -> dist/${s.out}`);
}

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>TwoTired — Media Library</title>
<style>
body{background:#141414;color:#eee;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;padding:24px}
h1{font-size:1.6rem}h1 em{color:#f97316;font-style:normal}
h2{font-size:1.1rem;margin:28px 0 12px;color:#ddd}h2 small{color:#888;font-weight:400}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}
.card{background:#1e1e1e;border:1px solid #333;border-radius:12px;overflow:hidden}
.card img,.card video{width:100%;height:260px;object-fit:contain;background:#000;display:block}
.card audio{width:100%;margin:14px 0}
.noprev{height:260px;display:flex;align-items:center;justify-content:center;color:#777;font-size:1.4rem;text-transform:uppercase}
.meta{padding:10px;display:flex;flex-direction:column;gap:6px}
.name{font-size:.78rem;word-break:break-all;color:#ccc}
.size{font-size:.72rem;color:#888}
button{background:#f97316;border:0;color:#fff;padding:7px 10px;border-radius:8px;font-weight:600;cursor:pointer;font-size:.8rem}
button:hover{background:#ea6c0a}
</style></head><body>
<h1>Two<em>Tired</em> media library</h1>
<p style="color:#888;font-size:.85rem">Auto-generated on every deploy from <code>site-assets/</code>. Unlisted &amp; noindexed.</p>
${cards.join("\n")}
</body></html>`;
writeFileSync("dist/media-library.html", html);
console.log("Generated dist/media-library.html");
