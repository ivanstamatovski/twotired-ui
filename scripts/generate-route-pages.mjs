#!/usr/bin/env node
/**
 * TwoTired — static route SEO page generator
 *
 * Reads scripts/route-pages.json (SEO copy) + src/data.js (routesDb: stats, waypoints)
 * and emits fully static, crawlable pages:
 *   public/routes/<slug>.html   — one per route
 *   public/routes/index.html    — routes hub
 *   public/sitemap.xml
 *
 * Run after editing route-pages.json:  node scripts/generate-route-pages.mjs
 * Pages are committed to the repo; Vercel serves them as static files (cleanUrls
 * in vercel.json maps /routes/<slug> -> /routes/<slug>.html).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(join(ROOT, "scripts/route-pages.json"), "utf8"));
const { url: SITE, appStoreUrl: APP_STORE, appName: APP } = cfg.site;

// --- pull routesDb out of src/data.js (it's a plain array literal) ---
const dataSrc = readFileSync(join(ROOT, "src/data.js"), "utf8");
const dbMatch = dataSrc.match(/export const routesDb = (\[[\s\S]*?\n\]);/);
if (!dbMatch) throw new Error("routesDb not found in src/data.js");
const routesDb = new Function(`return ${dbMatch[1]}`)();

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `
:root{--bg:#f8f8f6;--surface:#fff;--surface2:#f1f1ef;--accent:#f97316;--accent-hover:#ea6c0a;--text:#1a1a1a;--text-dim:#555;--text-muted:#999}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.6}
a{color:var(--accent);text-decoration:none}a:hover{color:var(--accent-hover)}
.wrap{max-width:840px;margin:0 auto;padding:0 20px}
header.site{position:sticky;top:0;background:rgba(248,248,246,.92);backdrop-filter:blur(8px);border-bottom:1px solid #e5e5e2;z-index:50}
header.site .wrap{display:flex;align-items:center;justify-content:space-between;height:56px}
.logo{font-weight:800;font-size:1.15rem;color:var(--text);letter-spacing:-.02em}.logo em{color:var(--accent);font-style:normal}
nav.top a{color:var(--text-dim);margin-left:18px;font-size:.92rem;font-weight:500}
.btn{display:inline-block;background:var(--accent);color:#fff !important;font-weight:600;padding:10px 20px;border-radius:10px}
.btn:hover{background:var(--accent-hover)}
.btn-sm{padding:7px 14px;font-size:.88rem;border-radius:8px}
.crumbs{font-size:.85rem;color:var(--text-muted);margin:22px 0 6px}.crumbs a{color:var(--text-muted)}
h1{font-size:2rem;line-height:1.2;letter-spacing:-.02em;margin:6px 0 4px}
.region{color:var(--text-dim);font-size:1rem;margin-bottom:18px}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}
.stat{background:var(--surface);border:1px solid #e7e7e4;border-radius:12px;padding:10px 16px;font-size:.9rem}
.stat b{display:block;font-size:1.05rem}
.stat span{color:var(--text-muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.05em}
#map{height:380px;border-radius:14px;border:1px solid #e7e7e4;margin:20px 0 6px;z-index:1}
.map-note{font-size:.8rem;color:var(--text-muted);margin-bottom:20px}
.seg{background:var(--surface);border:1px solid #e7e7e4;border-radius:12px;padding:16px 18px;margin:10px 0}
.seg b{color:var(--accent);display:block;margin-bottom:2px;font-size:.85rem;text-transform:uppercase;letter-spacing:.05em}
h2{font-size:1.3rem;margin:30px 0 10px;letter-spacing:-.01em}
p.body{margin:12px 0;color:var(--text);font-size:1.02rem}
.tips{background:var(--surface2);border-radius:12px;padding:16px 18px;margin:12px 0;font-size:.95rem;color:var(--text-dim)}
.cta{background:var(--text);color:#fff;border-radius:16px;padding:28px;margin:34px 0;text-align:center}
.cta h2{margin:0 0 6px;color:#fff}.cta p{color:#bbb;margin-bottom:16px;font-size:.95rem}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;margin:16px 0}
.card{background:var(--surface);border:1px solid #e7e7e4;border-radius:14px;padding:18px;display:block;color:var(--text)}
.card:hover{border-color:var(--accent);color:var(--text)}
.card b{display:block;margin-bottom:4px;line-height:1.3}
.card .meta{color:var(--text-muted);font-size:.82rem}
.card p{color:var(--text-dim);font-size:.88rem;margin-top:6px}
footer.site{border-top:1px solid #e5e5e2;margin-top:50px;padding:26px 0;color:var(--text-muted);font-size:.85rem}
footer.site .wrap{display:flex;flex-wrap:wrap;gap:16px;justify-content:space-between}
footer.site a{color:var(--text-dim);margin-right:14px}
@media(max-width:600px){h1{font-size:1.5rem}#map{height:280px}}
`;

const header = `<header class="site"><div class="wrap">
<a class="logo" href="/">Two<em>Tired</em></a>
<nav class="top"><a href="/routes/">Routes</a><a href="/support.html">Support</a><a class="btn btn-sm" href="${APP_STORE}">Get the app</a></nav>
</div></header>`;

const footer = `<footer class="site"><div class="wrap">
<div>© ${new Date().getFullYear()} ${APP} — AI-powered motorcycle route planning. Built by riders in NYC.</div>
<div><a href="/routes/">Routes</a><a href="/privacy.html">Privacy</a><a href="/support.html">Support</a><a href="${APP_STORE}">App Store</a></div>
</div></footer>`;

function head(title, desc, path, extra = "") {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${SITE}${path}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:url" content="${SITE}${path}">
<meta property="og:image" content="${SITE}/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>${CSS}</style>${extra}
</head><body>`;
}

function routePage(r) {
  const d = routesDb.find((x) => x.id === r.routeId);
  if (!d) throw new Error(`routeId ${r.routeId} not in routesDb`);
  const pts = d.waypoints.map((w) => { const [lng, lat] = w.split(",").map(Number); return [lat, lng]; });
  const path = `/routes/${r.slug}`;
  const jsonld = {
    "@context": "https://schema.org", "@type": "TouristTrip",
    name: r.h1, description: r.metaDescription,
    touristType: "Motorcycle riders",
    itinerary: { "@type": "ItemList", itemListElement: [
      { "@type": "ListItem", position: 1, name: r.start },
      { "@type": "ListItem", position: 2, name: r.end } ] },
    provider: { "@type": "Organization", name: APP, url: SITE },
  };
  const related = (r.related || []).map((slug) => {
    const rr = cfg.routes.find((x) => x.slug === slug);
    const rd = rr && routesDb.find((x) => x.id === rr.routeId);
    return rr && rd ? `<a class="card" href="/routes/${rr.slug}"><b>${esc(rr.h1)}</b><span class="meta">${rd.distance_mi} mi · ${esc(rd.duration_str)} · ${esc(rr.region)}</span></a>` : "";
  }).join("\n");

  return `${head(r.seoTitle, r.metaDescription, path,
    `<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script type="application/ld+json">${JSON.stringify(jsonld)}</script>`)}
${header}
<main class="wrap">
<div class="crumbs"><a href="/">Home</a> › <a href="/routes/">Routes</a> › ${esc(r.h1)}</div>
<h1>${esc(r.h1)}</h1>
<div class="region">${esc(r.region)}</div>
<div class="stats">
<div class="stat"><span>Distance</span><b>${d.distance_mi} mi</b></div>
<div class="stat"><span>Ride time</span><b>${esc(d.duration_str)}</b></div>
<div class="stat"><span>Start</span><b>${esc(r.start)}</b></div>
<div class="stat"><span>Character</span><b>${esc(r.character)}</b></div>
</div>
<p class="body">${esc(r.intro)}</p>
<div id="map"></div>
<div class="map-note">Approximate path through the route's waypoints — open it in ${APP} for the full turn-by-turn line.</div>
<h2>How the ride breaks down</h2>
${r.segments.map((s) => `<div class="seg"><b>${esc(s.label)}</b>${esc(s.text)}</div>`).join("\n")}
<h2>Local knowledge</h2>
<div class="tips">${esc(r.tips)}</div>
<div class="cta"><h2>Ride this route with ${APP}</h2>
<p>This route ships inside the app — voice-controlled planning, live group tracking, and turn-by-turn for every mile of it. Best for: ${esc(r.bestFor).toLowerCase()}.</p>
<a class="btn" href="${APP_STORE}">Download on the App Store</a></div>
<h2>More routes like this</h2>
<div class="cards">${related}</div>
</main>
${footer}
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var pts=${JSON.stringify(pts)};
var map=L.map('map',{scrollWheelZoom:false});
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',{attribution:'&copy; OpenStreetMap &copy; CARTO',maxZoom:18}).addTo(map);
var line=L.polyline(pts,{color:'#f97316',weight:4,opacity:.85}).addTo(map);
L.circleMarker(pts[0],{radius:6,color:'#16a34a',fillColor:'#16a34a',fillOpacity:1}).addTo(map).bindTooltip('Start');
L.circleMarker(pts[pts.length-1],{radius:6,color:'#1a1a1a',fillColor:'#1a1a1a',fillOpacity:1}).addTo(map).bindTooltip('Finish');
map.fitBounds(line.getBounds(),{padding:[24,24]});
</script>
</body></html>`;
}

function hubPage() {
  const cards = cfg.routes.map((r) => {
    const d = routesDb.find((x) => x.id === r.routeId);
    return `<a class="card" href="/routes/${r.slug}"><b>${esc(r.h1)}</b><span class="meta">${d.distance_mi} mi · ${esc(d.duration_str)} · ${esc(r.region)}</span><p>${esc(r.metaDescription.split(".")[0])}.</p></a>`;
  }).join("\n");
  return `${head(
    "The Best Motorcycle Routes Near NYC — Curated & Rider-Vetted | " + APP,
    "Hand-picked, rider-vetted motorcycle routes out of New York City: Bear Mountain, Harriman, Storm King Highway, Hawk's Nest and more. Every route ships inside the TwoTired app.",
    "/routes/")}
${header}
<main class="wrap">
<div class="crumbs"><a href="/">Home</a> › Routes</div>
<h1>The best motorcycle routes near NYC</h1>
<p class="body">Every route below is curated and rider-vetted — real roads locals actually ride, scored for how twisty they are, with the boring transit minimized. All of them ship inside ${APP}, so you can open one and ride it with turn-by-turn today.</p>
<div class="cards">${cards}</div>
<div class="cta"><h2>Or just ask for a route</h2><p>${APP} builds custom routes from plain English — "two hours of twisties, end at a diner." Voice-first, so it works with gloves on.</p><a class="btn" href="${APP_STORE}">Download on the App Store</a></div>
</main>
${footer}
</body></html>`;
}

function sitemap() {
  const urls = ["/", "/routes/", ...cfg.routes.map((r) => `/routes/${r.slug}`)];
  const today = new Date().toISOString().slice(0, 10);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `<url><loc>${SITE}${u}</loc><lastmod>${today}</lastmod></url>`).join("\n")}
</urlset>\n`;
}

mkdirSync(join(ROOT, "public/routes"), { recursive: true });
for (const r of cfg.routes) {
  writeFileSync(join(ROOT, `public/routes/${r.slug}.html`), routePage(r));
  console.log(`✓ public/routes/${r.slug}.html`);
}
writeFileSync(join(ROOT, "public/routes/index.html"), hubPage());
console.log("✓ public/routes/index.html");
writeFileSync(join(ROOT, "public/sitemap.xml"), sitemap());
console.log("✓ public/sitemap.xml");
console.log(`\nDone. ${cfg.routes.length} route pages for ${SITE}`);
