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
 * REAL ROAD GEOMETRY: on first run (or with --refresh-geometry) the script routes
 * each page's waypoints through GraphHopper on Molly (twotired profile) and caches
 * the simplified polyline in scripts/route-geometries/<slug>.json (commit these!).
 * Cached geometry is embedded into the static page — no runtime GH dependency.
 * If GH is unreachable and no cache exists, the page falls back to a straight
 * waypoint polyline.
 *
 * Run after editing route-pages.json:  node scripts/generate-route-pages.mjs
 * Refresh road geometry:               node scripts/generate-route-pages.mjs --refresh-geometry
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GEO_DIR = join(ROOT, "scripts/route-geometries");
const GH_URL = process.env.GH_URL || "https://molly.tail71232f.ts.net/gh";
const REFRESH = process.argv.includes("--refresh-geometry");

const cfg = JSON.parse(readFileSync(join(ROOT, "scripts/route-pages.json"), "utf8"));
const { url: SITE, appStoreUrl: APP_STORE, playStoreUrl: PLAY_STORE, appName: APP } = cfg.site;

const APPLE_BADGE = "https://tools.applemediaservices.com/api/badges/download-on-the-app-store/black/en-us";
const PLAY_BADGE = "https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png";

function badges(center = true) {
  const play = PLAY_STORE
    ? `<a class="badge badge-play" href="${PLAY_STORE}"><img src="${PLAY_BADGE}" alt="Get it on Google Play"></a>`
    : `<span class="badge badge-play badge-soon" title="Android version coming soon"><img src="${PLAY_BADGE}" alt="Google Play — coming soon"><em>Coming&nbsp;soon</em></span>`;
  return `<div class="badges${center ? "" : " badges-left"}">
<a class="badge" href="${APP_STORE}"><img src="${APPLE_BADGE}" alt="Download on the App Store"></a>
${play}
</div>`;
}

// --- pull routesDb out of src/data.js (it's a plain array literal) ---
const dataSrc = readFileSync(join(ROOT, "src/data.js"), "utf8");
const dbMatch = dataSrc.match(/export const routesDb = (\[[\s\S]*?\n\]);/);
if (!dbMatch) throw new Error("routesDb not found in src/data.js");
const routesDb = new Function(`return ${dbMatch[1]}`)();

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------------- geometry: GraphHopper fetch + cache ----------------

// Douglas-Peucker simplification (on [lat,lng] pairs, tolerance in degrees).
function simplify(points, tol = 0.0004) {
  if (points.length <= 2) return points;
  const sqTol = tol * tol;
  const sqSegDist = (p, a, b) => {
    let x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b[0]; y = b[1]; }
      else if (t > 0) { x += dx * t; y += dy * t; }
    }
    return (p[0] - x) ** 2 + (p[1] - y) ** 2;
  };
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0, idx = 0;
    for (let i = first + 1; i < last; i++) {
      const d = sqSegDist(points[i], points[first], points[last]);
      if (d > maxDist) { maxDist = d; idx = i; }
    }
    if (maxDist > sqTol) { keep[idx] = 1; stack.push([first, idx], [idx, last]); }
  }
  return points.filter((_, i) => keep[i]);
}

async function fetchGeometry(slug, waypoints) {
  const file = join(GEO_DIR, `${slug}.json`);
  if (existsSync(file) && !REFRESH) return JSON.parse(readFileSync(file, "utf8"));
  const points = waypoints.map((w) => w.split(",").map(Number)); // [lng,lat]
  try {
    const res = await fetch(`${GH_URL}/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points,
        profile: "twotired",
        "ch.disable": true,
        snap_prevention: ["motorway", "motorway_link"],
        points_encoded: false,
        instructions: false,
        locale: "en",
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`GH ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    const coords = json.paths?.[0]?.points?.coordinates;
    if (!coords?.length) throw new Error("GH returned no geometry");
    const latlng = simplify(coords.map(([lng, lat]) => [lat, lng]));
    const out = { slug, source: "graphhopper/twotired", fetched: new Date().toISOString().slice(0, 10), distance_m: Math.round(json.paths[0].distance), points: latlng.map(([a, b]) => [Number(a.toFixed(5)), Number(b.toFixed(5))]) };
    mkdirSync(GEO_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(out));
    console.log(`  ↳ geometry from GraphHopper: ${out.points.length} pts, ${(out.distance_m / 1609).toFixed(1)} mi`);
    return out;
  } catch (e) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    console.warn(`  ↳ GH unavailable for ${slug} (${e.message}) — falling back to waypoint line. Run again on a machine that can reach Molly.`);
    return null;
  }
}

// ---------------- SVG map thumbnails ----------------

function thumbSVG(pts) { // pts: [[lat,lng],...]
  const W = 400, H = 280, P = 20;
  const lats = pts.map((p) => p[0]), lngs = pts.map((p) => p[1]);
  const mnLa = Math.min(...lats), mxLa = Math.max(...lats);
  const mnLo = Math.min(...lngs), mxLo = Math.max(...lngs);
  const k = Math.cos(((mnLa + mxLa) / 2) * Math.PI / 180);
  const w = Math.max((mxLo - mnLo) * k, 1e-6), h = Math.max(mxLa - mnLa, 1e-6);
  const s = Math.min((W - 2 * P) / w, (H - 2 * P) / h);
  const ox = (W - w * s) / 2, oy = (H - h * s) / 2;
  const X = (lng) => ox + (lng - mnLo) * k * s;
  const Y = (lat) => H - (oy + (lat - mnLa) * s);
  const d = pts.map((p, i) => (i ? "L" : "M") + X(p[1]).toFixed(1) + " " + Y(p[0]).toFixed(1)).join("");
  const [sx, sy] = [X(pts[0][1]), Y(pts[0][0])];
  const [ex, ey] = [X(pts[pts.length - 1][1]), Y(pts[pts.length - 1][0])];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#f1f1ef"/>
<path d="${d}" fill="none" stroke="#e0d9cd" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
<path d="${d}" fill="none" stroke="#f97316" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="6" fill="#16a34a" stroke="#fff" stroke-width="2"/>
<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="6" fill="#1a1a1a" stroke="#fff" stroke-width="2"/>
</svg>\n`;
}

// ---------------- page templates ----------------

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
.badges{display:flex;gap:16px;justify-content:center;align-items:center;flex-wrap:wrap;margin:6px 0}
.badges-left{justify-content:flex-start}
.badge img{height:58px;display:block}
.badge-play img{height:86px;margin:-14px 0}
.badge-soon{position:relative;display:inline-block;filter:grayscale(1);opacity:.55}
.badge-soon em{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);font-style:normal;font-size:.68rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#fff;background:rgba(0,0,0,.75);padding:2px 8px;border-radius:6px;white-space:nowrap}
.card .thumb{width:100%;height:140px;object-fit:cover;border-radius:10px;margin-bottom:12px;background:var(--surface2);display:block}
@media(max-width:600px){h1{font-size:1.5rem}#map{height:280px}.badge img{height:48px}.badge-play img{height:72px;margin:-12px 0}}
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

function routePage(r, geo) {
  const d = routesDb.find((x) => x.id === r.routeId);
  if (!d) throw new Error(`routeId ${r.routeId} not in routesDb`);
  const waypointPts = d.waypoints.map((w) => { const [lng, lat] = w.split(",").map(Number); return [lat, lng]; });
  const pts = geo?.points?.length ? geo.points : waypointPts;
  const isReal = Boolean(geo?.points?.length);
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
    return rr && rd ? `<a class="card" href="/routes/${rr.slug}"><img class="thumb" src="/routes/thumbs/${rr.slug}.svg" alt="Map of ${esc(rr.h1)}" loading="lazy"><b>${esc(rr.h1)}</b><span class="meta">${rd.distance_mi} mi · ${esc(rd.duration_str)} · ${esc(rr.region)}</span></a>` : "";
  }).join("\n");
  const mapNote = isReal
    ? `The actual road-by-road line, routed by ${APP}'s own engine — every curve you see is pavement you'll ride.`
    : `Approximate path through the route's waypoints — open it in ${APP} for the full turn-by-turn line.`;

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
<div class="map-note">${mapNote}</div>
<h2>How the ride breaks down</h2>
${r.segments.map((s) => `<div class="seg"><b>${esc(s.label)}</b>${esc(s.text)}</div>`).join("\n")}
<h2>Local knowledge</h2>
<div class="tips">${esc(r.tips)}</div>
<div class="cta"><h2>Ride this route with ${APP}</h2>
<p>This route ships inside the app — voice-controlled planning, live group tracking, and turn-by-turn for every mile of it. Best for: ${esc(r.bestFor).toLowerCase()}.</p>
${badges()}</div>
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
    return `<a class="card" href="/routes/${r.slug}"><img class="thumb" src="/routes/thumbs/${r.slug}.svg" alt="Map of ${esc(r.h1)}" loading="lazy"><b>${esc(r.h1)}</b><span class="meta">${d.distance_mi} mi · ${esc(d.duration_str)} · ${esc(r.region)}</span><p>${esc(r.metaDescription.split(".")[0])}.</p></a>`;
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
<div class="cta"><h2>Or just ask for a route</h2><p>${APP} builds custom routes from plain English — "two hours of twisties, end at a diner." Voice-first, so it works with gloves on.</p>${badges()}</div>
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

// ---------------- main ----------------

mkdirSync(join(ROOT, "public/routes"), { recursive: true });
mkdirSync(join(ROOT, "public/routes/thumbs"), { recursive: true });
let realCount = 0;
for (const r of cfg.routes) {
  const d = routesDb.find((x) => x.id === r.routeId);
  console.log(`${r.slug}`);
  const geo = await fetchGeometry(r.slug, d.waypoints);
  if (geo?.points?.length) realCount++;
  const pts = geo?.points?.length ? geo.points : d.waypoints.map((w) => { const [lng, lat] = w.split(",").map(Number); return [lat, lng]; });
  writeFileSync(join(ROOT, `public/routes/thumbs/${r.slug}.svg`), thumbSVG(pts));
  writeFileSync(join(ROOT, `public/routes/${r.slug}.html`), routePage(r, geo));
}
writeFileSync(join(ROOT, "public/routes/index.html"), hubPage());
writeFileSync(join(ROOT, "public/sitemap.xml"), sitemap());
console.log(`\nDone. ${cfg.routes.length} pages — ${realCount} with real road geometry, ${cfg.routes.length - realCount} on waypoint fallback.`);
if (realCount < cfg.routes.length) console.log("Re-run on a machine that can reach Molly (or set GH_URL) to upgrade the fallbacks.");
