# TwoTired — Project Context for Claude

## What this is
AI-powered motorcycle ride planning app. User types (or speaks) where they want to ride; the app plans a scenic route, avoids highways, hits stops, and renders it on a map. Native iOS app via Capacitor wrapping a React/Vite web app.

**Owner:** Ivan Stamatovski (ivan@easyaerial.com)  
**GitHub:** https://github.com/ivanstamatovski/twotired-ui  
**Web app:** https://twotired.net (Vercel, auto-deploys from main)  
**Admin portal:** https://admin.twotired.net (password: `TwoTired2026!`)  
**Supabase project ref:** `ujvfwzcjgxupvtiwllhw`

> **Doc currency:** Last refreshed 2026-07-04 against `main` (generate-route at **v2.98**). When you make a structural change, update this file in the same session.

> **Live work state:** `@.claude/current.md` (gitignored) holds the current task / next step / open decisions and auto-loads each session. Update it as work progresses; on "checkpoint" flush state there. The durable backlog is the Supabase `tasks` table / admin Kanban.

@.claude/current.md

> **⚠️ Parallel sessions — worktrees + task board.** Two Claude sessions run concurrently on this project (mobile lane + marketing lane). They MUST NOT share one working tree (they'd clobber each other's git index/build). Each lane works in its own **git worktree**, sharing one `.git`:
> - **Mobile lane** → `~/Documents/twotired-ui` on `main` (android/ios/native/publishing). Also the integration checkout.
> - **Marketing lane** → `~/Documents/twotired-marketing` on branch `marketing` (landing/SEO/admin/marketing components).
>
> **Cross-session sync = the Supabase `tasks` board**, NOT `current.md` (gitignored & per-worktree). Access it either way — Management API (`~/.supabase_pat`) or the **admin Kanban in Chrome** ([admin.twotired.net](https://admin.twotired.net)); both write the same `tasks` table, so the sessions stay in sync regardless. **Mark the lane with a `[mobile]`/`[marketing]` title prefix** (the `category` field is work-type: feature/infra/ops/paperwork/bug — don't overload it). Flip status to `in_progress` when you claim a task, `done` when finished — that's how each session sees what the other owns.
>
> **Session chat** — for free-form coordination between the two sessions (and Ivan), post to the **`agent_chat`** table (`author` = `mobile`/`marketing`/`ivan`, `body`). It renders as a live chat panel at the top of the admin **Tasks/Kanban** tab (polls every 8s). Sessions read/write via REST or Management API. Table: migration `2026-07-06_agent_chat.sql`.
>
> **React to Ivan's messages (event-driven, not polling).** Treat `author='ivan'` messages as priority/commands. Two mechanisms:
> 1. **Active work** → check `agent_chat` at the start of any action; you'll catch Ivan's messages for free while you're already running.
> 2. **Idle** → launch **`scripts/chat-watch.sh`** as a BACKGROUND task at session start. It blocks in cheap shell (no Claude turns) and exits the instant Ivan posts, which re-invokes you — near-instant wake-up with zero wasted turns. After handling the message and replying in `agent_chat`, **re-launch the watcher** to keep listening. (It only lives while the session runs.)
> Always reply in-thread so Ivan sees the answer in the Kanban panel.
>
> **Git rules for both:** `git pull --rebase` before starting AND before pushing · small, lane-scoped commits, never bundle lanes · stay in your lane's files. Only `src/App.jsx` and this `CLAUDE.md` are contended — for those, tiny immediately-committed edits + rebase first. Integrate the marketing lane with `git checkout main && git merge marketing` (or open a PR), then both rebase.

---

## Tech Stack (current — v2 architecture)

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite, `src/App.jsx` + `src/App.css` |
| Maps | MapLibre GL JS (`maplibre-gl`), OpenFreeMap Liberty style |
| Routing | GraphHopper 11.0 self-hosted on **Molly** (home server), `twotired` profile |
| AI — intent | Claude Sonnet 4.6 (`claude-sonnet-4-6`) — NL → RouteRequest JSON |
| AI — narrative & briefs | Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) |
| Geocoding | Google Places API (New) — `searchText` + haversine post-filter |
| Backend | Supabase Edge Functions (Deno) + Postgres |
| Native wrapper | Capacitor 8 (`net.twotired.app`) |
| Domain | `twotired.net` (Vercel DNS) |

---

## Platform Matrix — what's shared vs. forked

**Mental model: this is NOT "3 apps" — it's ONE web codebase (`src/App.jsx`) that Capacitor wraps into thin native shells.** Three published surfaces, one brain:
- **Web / PWA** → `twotired.net` (Vercel)
- **iOS** → `ios/` shell → App Store
- **Android** → `android/` shell → Play Store (scaffolded 2026-07-04; debug APK builds, not yet on a store)

~95% of all work is write-once, serves-all-three. Only the thin native shell + store logistics fork. Everything below the WebView is platform-agnostic — it doesn't know which surface the request came from.

### Mutual (one copy, serves every surface)
| Resource | Notes |
|---|---|
| **Molly — GraphHopper** (`/gh`, `twotired` profile) | Backend HTTP; edge fn calls it. Zero platform awareness. |
| **Molly — score server + `twotired_roads` DB** | Server-side road scoring. |
| **All Supabase tables + `known_roads` catalog** | One Postgres, one source of truth. |
| **All edge functions** (`generate-route` etc.) | A deploy hits every surface **instantly, no rebuild** — the superpower; prefer server-side fixes. |
| **Claude** (Sonnet intent, Haiku narrative) + **Google Places** | Called from edge fns. |
| **`src/App.jsx` + `App.css`** | The whole frontend — same `dist/` bundle loads in every shell. |
| **`capacitor.config.json`** | Shared file (appId/appName/webDir). Keep clean — no `server.url`. |
| **Admin portal, Vercel deploy, domain** | Server-side. |

### Forked (the thin ~5% — native shell + store logistics)
| Concern | iOS | Android |
|---|---|---|
| Shell dir | `ios/` | `android/` |
| Permissions | `Info.plist` (location keys) | `AndroidManifest.xml` |
| Signing / distribution | Apple Dev, Xcode, TestFlight, App Store Connect | Play Console, keystore, `.aab` |
| Version counter | `CFBundleVersion` | `versionCode`/`versionName` (`android/app/build.gradle`) |
| Icons / splash | Xcode assets | `res/` mipmaps |
| Known platform quirks | (see iOS section) | WebView geolocation, back button (see Android section) |

### Versioning model
The **real product version is the edge-fn/frontend semver** (`generate-route` vX.YZ) — it's shared and deploys live to all surfaces with no rebuild. The per-store native counters (`CFBundleVersion`, Android `versionCode`) are **dumb packaging numbers**: independent per store, monotonic, and do NOT need to match each other. "Which features does a user have" = (server version, always current) + (native shell build, only matters when a *native* capability changed).

---

## Repository Layout

```
twotired-ui/
  src/
    App.jsx          ← entire frontend (auth, map, sheet, routing, nav, friends, anchors, picker)
    App.css          ← all styles
    main.jsx
  supabase/
    functions/
      generate-route/        ← main edge function (v2.92)
      analyze-bug-report/    ← Haiku-with-vision lesson extraction from bug reports
      seed-known-roads/      ← Claude bulk-enumerates iconic roads → known_roads (pending)
      validate-known-road/   ← on approval: re-snap, route-verify, cache geometry
      find-rider/            ← email → user_id lookup for friend requests
      send-user-message/     ← admin → rider email via Resend
      notify-signup/         ← emails Ivan when a new user signs up
      delete-account/        ← App Store 5.1.1(v) account deletion
    migrations/              ← 21 dated .sql files (see Supabase section)
  ios/
    App/App/Info.plist       ← iOS permissions (location keys)
  admin/
    index.html               ← self-contained admin portal (9 tabs)
  capacitor.config.json
  vite.config.js
  .env                       ← VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (gitignored)
```

---

## Infrastructure — Molly (home server)

**Machine:** i7-1165G7, 30GB RAM, Ubuntu 24.04  
**GraphHopper:** Port 8989, single `twotired` profile (motorcycle base) + car-style fallback, CH + LM flexible mode  
**Score server:** `score_server.py` port 8765 — scores road segments by joy/transit/curvature  
**Road scoring DB:** PostgreSQL `twotired_roads` — 1.64M segments (CT/MA/NJ/NY/PA)  
**NYC polygon source of truth:** `/home/ivan/graphhopper/nyc.json` — the same `in_nyc` custom-model area the edge function mirrors verbatim.

**Tailscale Funnel URLs:**
```
https://molly.tail71232f.ts.net (port 443)
  /      → localhost:5000
  /gh    → localhost:8989  (GraphHopper)
  /hunter → localhost:5002

https://molly.tail71232f.ts.net:8443
  /      → localhost:8765  (score server)
```

**Supabase secret:** `ROAD_SCORE_URL = https://molly.tail71232f.ts.net:8443`

**Systemd note:** `tailscale funnel 8989` is a foreground process — use `Type=simple` in systemd, never `Type=oneshot` (hangs forever).

---

## Edge Function: generate-route

**File:** `supabase/functions/generate-route/index.ts`  
**Current version:** v2.97 (exit-number lookup cached in Supabase, off the Overpass hot path — see below)

**Exit numbers (v2.96, cached v2.97):** GraphHopper 11 emits destination refs (`street_destination`/`street_destination_ref`, e.g. "I-84 W / Danbury") but NEVER motorway exit numbers (verified on real I-84 exits — `exit_number` is roundabout-only). `enrichExitNumbers()` fills the gap from OSM: every real exit has a `highway=motorway_junction` node tagged `ref`=<exit #>. For each keep-right/left maneuver (GH sign ±7) it tags the instruction with the nearest such node's `exit_ref`/`exit_name` when within **100 m**. The proximity check self-filters — on-ramps/post-ramp turns have no junction within 100 m, so no false positives. Best-effort (never throws/blocks), runs in parallel with scores/narrative. Frontend: `shortDestinationLabel` renders the exit chip from `exit_ref`; the voice prompt leads with "Exit N".
- **v2.97 — cache, not Overpass on the hot path.** The ~11k junction nodes for the graph bbox are cached in the **`osm_junctions`** table; `enrichExitNumbers` does one indexed `lat/lng` bbox query against it (no network round-trip to public Overpass). Seed/refresh with **`scripts/seed_osm_junctions.py`** (fetches motorway_junction nodes in the bbox, chunk-upserts via the Management API). Because routes only run inside the graph bbox, the seed = full coverage; misses just skip tagging.
- **Gotchas (all bit me):** Supabase's Deno lacks `AbortSignal.timeout` (v2.96 silently returned 0 until switched to `AbortController`; moot now that it's a Supabase query). Overpass 406s AND the Supabase Management API 403s python-urllib's default `User-Agent` — the seed script sets one. Overpass `out tags;` omits node coords — use `out;`.

### Pipeline
1. Claude Sonnet 4.6 parses natural language → `RouteRequest` (origin, destination, stops, curviness 1–3, escape_waypoint, intermediate_waypoints, **road_corridor**, **scenic_anchors**, round_trip)
2. Google Places API geocodes stops by name+region, haversine post-filter rejects results >radius_km away
3. **Two-phase GraphHopper routing:**
   - **Escape leg:** origin → escape_waypoint, curviness=1 (direct city exit)
   - **Scenic leg:** escape → anchors → intermediates → stops → destination, requested curviness
   - Legs merged via `mergeRoutes()`; per-leg geometries preserved (`route_legs`) so admin colors them distinctly
4. Claude Haiku writes a **single-sentence** ride brief (anchor-card style). Falls back to this for every ride even when no anchors fired.
5. Save to Supabase `routes` + `route_logs` (the latter linked to a nav session via `nav_session_id`)

### Routing model — "classic" is the only model now
**v2.65 (June 10) removed the `scoring` A/B variant entirely.** `buildScoringModel()` and the `body.variant` branch are gone; `variant` is silently ignored for back-compat. The single baked-in custom model includes: road-class priority rules, named corridors, the NYC polygon, Palisades avoidance, two-phase NYC escape, learned corrections, and the joy_tier_c surface-street penalty. **Do not re-introduce a variant toggle** — the lesson was that the scoring-only model stripped out too much hard-won routing knowledge to be worth the cleaner joy bias.

### Curviness Tiers
| Curviness | Behavior |
|---|---|
| 1 (transit) | Direct/efficient, motorways OK |
| 2 (scenic) | Balanced — avoids motorways, prefers secondary/tertiary |
| 3 (backroads) | Max twisty — strong motorway penalty |

### NYC Escape Corridors (in Claude system prompt)
- North/NW → GWB, Fort Lee NJ: `{ lat: 40.853310, lng: -73.960688 }` (6 decimal places — precision matters)
- West/SW (Philly, Delaware) → Goethals Bridge, Staten Island
- South (Jersey Shore) → Goethals Bridge
- East (Long Island) → no escape needed

### NYC detection & intra-NYC handling (v2.66–v2.68)
- `isInNYC()` uses a **hand-drawn 5-borough polygon** (`NYC_POLYGON_COORDS`, ray-cast `pointInPolygon`) mirrored from Molly's `nyc.json` — NOT a bounding box. v2.66 fixed false-positives on east-NJ towns (Newark, Jersey City, Paterson).
- **Skip two-phase escape when destination is ALSO in NYC** (v2.67-hotfix) — the "Wegmans Brooklyn" fix: a 2mi intra-NYC trip was being routed 30mi via Staten Island because the escape leg preferred I-278.
- **Curviness autotune** (v2.68): trips <5mi with both endpoints in NYC are forced to curviness 1 — grid streets don't need scenic penalties. Logged as `curviness_autotune` in `routing_config`. **v2.91: skipped for `round_trip`** — a loop's destination IS its origin, so the straight-line is always ~0; the autotune was firing on every loop from inside NYC and forcing the whole 140-mi ride to curviness 1 (fast highway out-and-back instead of a scenic round loop). Combined with the phased return leg now using the scenic curviness (not transit-1), picker loops come back a different, rounder way (0% outbound/return overlap, vs the old same-highway retrace).

### Circular loops (v2.76, picker-loop fixes v2.85)
When `round_trip` is set AND origin≈destination (<1km) AND no stops/corridor/anchors, `getRoundTripRoute()` calls GraphHopper's `algorithm: 'round_trip'` with a target distance and a random seed for variety. Two-phase NYC escape is skipped (start≈end). Claude only sets `round_trip` on explicit "loop / round trip / there and back" language.

**Loop target distance (v2.85):** `resolveLoopTargetMeters(body)` is the single source of truth — uses explicit `loop_distance_km` if set, else defaults to 40 km, clamped 5–200 km. Claude maps duration phrases → `loop_distance_km` in the intent prompt ("30 min"→20, "1 hour"→40, "couple hours"→80, "half day"→120, "all day"→240; explicit mileage wins), emitted only when `round_trip`. The visual picker sends its estimated loop mileage (mi→km).

**Picker-loop degenerate fallback (v2.85):** the picker sends `round_trip=true` + origin≈destination + `scenic_anchors=[...]`. If every anchor fails to resolve server-side (admin rejected/deleted since the catalog loaded), `allWaypoints` collapses to `[origin, origin, origin]` and the old fallback `getRoute()` produced a 0-mi / 2-point route. Now, when it's a picker loop, it falls back to `getRoundTripRoute()` (logged as `anchor_loop_fallback`) so the rider still gets a real loop.

**Multi-seed overshoot tuning (v2.86):** GH's `round_trip.distance` is a *target*, not a constraint — it picks a heading + a via point and routes there and back on real roads. With the curviness custom model penalising motorways, a single unlucky seed could send the via point across a barrier (the Hudson, where non-motorway crossings are scarce) and balloon the loop to 4–5× the target (measured: 40 km target → 165–203 km on ~1/3 of random seeds). Fix: `getRoundTripRoute()` fans out `ROUND_TRIP_SEED_SAMPLES` (5) seeds in parallel and keeps the loop whose driven distance is closest to the target; outliers self-eliminate. Post-fix, 40 km loops land 0.93–1.04×. Cost: ~5× GH load + ~10–15s per loop request (parallel, behind a spinner). The per-seed ratios are logged in the edge-fn console for observability.

### Known KNOWN_WAYPOINTS
```typescript
'gwb ny approach': { lat: 40.853310, lng: -73.960688 }
```
Trans-Manhattan Expy GWB on-ramp. Forces Queens traffic via Triborough, not midtown. Precision is critical — do not round.

---

## Known Roads Catalog + Scenic Anchors (v2.78–v2.84 — the current routing frontier)

A curated catalog of iconic motorcycle roads (Hawk's Nest, 9W Palisades, Storm King, etc.) that Claude can route *through*, rather than relying purely on the scoring model to stumble onto good roads.

### `known_roads` table (`2026-06-18_known_roads.sql` + `2026-06-20_known_roads_geometry.sql`)
Key columns: `name`, `route_number`, `state`, `region`, `start_lat/lng` + `end_lat/lng` (oriented start→end), `length_km`, `vibe_tags text[]`, `difficulty` (1–5), `curviness_tier` (1–3), `best_for text[]`, `caveats`, `must_see`, `pairs_with uuid[]` (roads that chain), `source` (`claude_seed`/`manual`/`telemetry_inferred`), `approved` (null=pending / true / false), plus QA columns: `needs_coord_review`, `snap_distance_m_start/end`, `coord_review_reason`, `route_validated_km`, and a cached GeoJSON LineString geometry (from validate-known-road) for real-shape map rendering.

**RLS:** authenticated users read `approved=true`; pending/rejected are service-role only; all writes are service-role (admin portal).

### Seeding → approval pipeline
1. **Seed** (`seed-known-roads`): admin triggers Claude Sonnet to enumerate iconic roads for given states/regions. Each endpoint is **snapped** to GH's nearest routable edge (`/nearest`). `SNAP_OK_M=200` (use snap silently), `SNAP_REVIEW_M=500` (flag `needs_coord_review`, keep Claude's coord for admin comparison). GH `/route` validates the pair is actually routable. Optional `center_lat/lng/radius_mi` haversine filter. All rows land `approved=null`.
2. **Review** (admin Known Roads tab): list or map view, status/state filters, inline coord editor ("Save" / "Save & re-validate"), approve / reject / mark-pending / delete.
3. **Validate-on-approval** (`validate-known-road`): re-snaps both endpoints (reject if >500m), routes between them with `points_encoded:false` to get raw geometry (reject if GH can't route), length-ratio check against Claude's `length_km` (reject if <0.5× or >2×), then **caches the real GeoJSON geometry** and flips `approved=true`. `override=true` bypasses validation for regions GH lacks OSM coverage for.

### Phase 2A — inject catalog into Claude's intent (v2.79)
`fetchApprovedCatalog()` → `formatCatalogForPrompt()` injects approved roads (~80 tokens each) into Sonnet's system prompt as an "ICONIC ROADS CATALOG" with usage rules. Claude emits `scenic_anchors: [uuid, ...]` when a scenic request passes naturally near catalog roads. **Mutually exclusive with `road_corridor`** (corridor wins if both set). Phase 2A logs `scenic_anchors_chosen` + `scenic_anchors_offered_count` to `route_logs` (observability).

### Phase 2B — route through the anchors (v2.80–v2.83)
1. `fetchAnchorsByIds()` resolves Claude's UUIDs (re-orders to Claude's sequence; silently drops any admin rejected/deleted since).
2. `resolveAnchorSequence()` infers direction per anchor: endpoint **closest to the previous waypoint** = entry, other = exit. Produces `[origin, entry1, exit1, entry2, exit2, ..., stops, destination]`.
3. **Detour gate (v2.83)** — two checks, both exempt for round-trips:
   - *Pre-route haversine:* sum of great-circle through anchors vs direct; if >1.5×, drop anchors and route normally (`anchor_detour_dropped=true`).
   - *Post-route actual:* if driven distance >1.8× direct point-to-point, re-route without anchors (`anchor_detour_dropped_reason='actual_distance'`). Haversine can't see the Hudson, so a "nearby" anchor can still force a Staten Island detour — the actual check catches it.
4. **Per-anchor brief (v2.82):** Claude Haiku writes one <180-char sentence per anchor in parallel with routing (template fallback so the card always has content).
5. Response carries `scenic_anchors_resolved` JSONB (name, route#, direction, entry/exit, vibe_tags, must_see, caveats, region, brief).

### Anchor card UI (`src/App.jsx`)
Three states driven by `scenic_anchors_resolved` + nav mode: **peek** (small top-left card, first anchor name+brief), **expanded** (all anchors with tags/caveats/briefs), **nav-circle** (FAB with anchor count during navigation, auto-collapses off-route).

### Visual picker mode ("known bike routes", reworked June 24–26)
Rider taps the 🛣 FAB → **all approved** catalog roads render as tappable MapLibre polylines (orange unselected / green selected, wide invisible hit layer, real cached geometry). No distance radius — on open, an **adaptive peek-zoom** keeps the rider centered and zooms out only enough for the nearest ~3 routes to peek in at the edges (zoom-OUT only; fires once per open via `pickerPeekedRef`). Select up to `PICKER_MAX=4`. Two actions:
- **Make a loop** → `computeOrderedLoop()` greedy nearest-neighbor order → `generateRoute({ origin: here, destination: here, round_trip: true, scenic_anchors: [...], force_anchors: true, loop_distance_km })`.
- **Take me there** → one-way ride out through the road(s). For a **single road** a card asks **which end to enter from** (`roadEndInfo()` labels each end from the "A to B" name or compass + distance) → `generateRoute({ destination: oppositeEnd, scenic_anchors: [id], anchor_entries: ['start'|'end'], force_anchors: true })`. Multiple roads skip the prompt and use greedy order.

**`force_anchors` (v2.87):** picker requests set it so the edge fn never drops the rider's explicitly-picked roads via the detour gates (those gates only guard Claude's picks). Without it, "Take me there" silently routed to the endpoint without riding the road.

**De-spike (v2.92):** a transit leg routes to a road's *fixed* endpoint; approaching from the side the road continues toward, GH overshoots and the next leg doubles straight back over the same pavement — a blind 180° U-turn at the join (GH ignores a heading on a route's *final* point, so prevention via heading doesn't work with the per-leg split). `mergeRouteList` fixes it geometrically: at each leg join it walks the next leg's head while it sits on the prior leg's tail (closest-point within ~25 m, small index window so it's robust to which point is the shared join), and if ≥3 points retrace, splices both at the divergence point. Verified: Franklin entry 180°→89°, and ~12 mi of overshoot spurs removed from a 521+565 loop. (A genuine end-of-road turn-around toward home — not a retrace — is left alone.)

**Phased routing (v2.89, updated v2.94–v2.95):** picker rides send `phased: true`. `routePhased` routes alternating legs — **transit** (prev → road entry) at **curviness 1** (highways OK, "arrive fast"), **fun** (road entry → exit) at the **road's own `curviness_tier`** (backroad maxed, parkway ridden as a parkway — forcing 3 would make GH avoid the parkway). Legs route in parallel + merge (`mergeRouteList`), per-leg `leg_geometries` labels (`transit`/`fun`/`return`) for client coloring. Standard text routes never set `phased`.

- **v2.94 fast return:** the final leg (a loop's `return`, or a one-way's arrival transit) is **curviness 1 (fastest)**, NOT scenic. v2.91 had made loops return at scenic curviness for "a rounder way home", but on a 30+mi return that detoured loops the long way through dense areas (NYC side streets/Manhattan). The rider wants the curated road fast + home fast; a partial same-highway retrace is an acceptable trade (entry≠exit means the return differs from the outbound anyway).
- **v2.98 fun leg rides the WHOLE road:** the `fun` leg was routed between only the road's two endpoints (`getRoute([entry, exit])`), so GH chose its own path — a real Route 35 picker loop covered just **2%** of the actual road (the blue navigated leg diverged from the green cached-geometry preview). `routePhased` now threads the fun leg through **via-points sampled from the road's cached `geometry`** (`roadViaPoints`, ~1.5 km spacing, ≤24 vias, oriented entry→exit) → 99–100% coverage. `fetchAnchorsByIds` selects `geometry`; `resolveAnchorSequence` carries it on the anchor meta; it's `delete`d before `log.scenic_anchors_resolved` so the log/response stay small. Falls back to endpoints-only when a road has no cached geometry. NOTE: the non-phased anchored path (Claude-intent scenic_anchors, `getRoute(anchoredPoints)`) still pins endpoints only — same latent issue, not yet fixed (picker rides are always `phased`).
- **v2.95 instruction merge:** `mergeRouteList` REBUILDS the merged instruction list, it does not raw-concatenate. Each phased leg is a separate GH route, so its instruction `interval`s index its OWN points and every leg ends in a FINISH. Raw concat → legs 2+ pointed at wrong merged vertices (turn-by-turn wrong on fun/return → missed exits) AND "destination reached" fired at each road entry/exit. Now: each maneuver's interval is remapped by nearest-matching its coordinate within the leg's merged span (robust to the de-spike trim), intermediate FINISHes are dropped (only the true final arrival stays), and a transit→road FINISH is relabeled into a spoken **"Start of &lt;road&gt;" cue (sign 5)** so the rider is told the fun begins. `cleanRoadName` shortens the anchor name for the cue.

**Loop-aware reroute (v2.89):** frontend keeps `pickerRideRef = { roundTrip, finalDest, legs:[{road_id,entry,exit,entrySide}], doneCount }`. A road is marked done when the rider passes within ~0.2 mi of its exit. On off-route, `rerouteFromCurrentPosition` re-plans **current → entry of the next un-ridden road → … → finalDest** (phased, `force_anchors`, original `anchor_entries`) instead of beelining to the destination. Fixes the 2026-06-27 bug: missed a Turnpike exit → app went home via Staten Island instead of back onto the loop. Cleared on text query / route clear / cancel.

**No-blank-flash:** on action, the picked road(s) draw as a green `picker-preview` line that stays until the blue route renders (`showPickerPreview` / `clearPickerPreview`, cleared inside `drawRouteOnMap`). `pickerStatus` ('loading' → 'ready' | 'empty') drives the overlay so the rider never sees a bare map.

---

## Navigation & Auto-Reroute (`src/App.jsx`)

- **Off-route detection:** `OFF_ROUTE_THRESHOLD_M=40`, `OFF_ROUTE_GRACE_MS=3000`, `REROUTE_COOLDOWN_MS=10000`. Distance to the route polyline is checked each GPS tick; sustained >40m for 3s (respecting the 10s cooldown) triggers a reroute. (These are tuned-down from the original 60m/4s/30s.)
- **Reroute bypasses Claude:** `rerouteFromCurrentPosition()` sends a raw `RouteRequest` (current GPS → original destination, `event_origin:'reroute'`) straight to generate-route. Preserves intent without a second LLM round-trip.
- **Pre-snap GPS origin (v2.61):** snap the start point to the nearest road before routing — fixes reroutes starting from the wrong point.
- **Calibrated ETA:** raw GraphHopper time is scaled by a calibration ratio so nav ETA matches the pre-nav display (Drive→Ride rename).
- **Stop dwell survey:** `STOP_RADIUS_M=50`, `STOP_DWELL_MS=2min` continuous → fires `StopRatingSheet` (−1/0/+1) → `stop_ratings` table. One-shot timer, never blocks nav.
- **Session telemetry:** `nav_session_id` (one UUID per Navigate→Stop arc) spans planning + nav and groups all `nav_events` (nav_start, off_route, reroute_request/complete/failed, nav_arrive, nav_stop). `route_logs` links back via `nav_session_id`.
- **Background:** keep-awake during nav (`@capacitor-community/keep-awake`), audio background mode, redraw polyline on foreground (`visibilitychange` + Capacitor `appStateChange`).
- **Route polyline:** `drawRouteOnMap` draws the whole route (incl. a loop's return leg) as ONE uniform blue line (`route`/`route-line` + white `route-casing`). (A lighter-blue return leg was tried to distinguish the way-back but blended with water on the basemap — reverted to single blue.) **Nav crops the traveled part behind the rider** (the "ahead trim"): each tick `setData`s the `route` source to `rider → end` (`sliceRange`), so the whole rest of the loop stays visible but the part already ridden is dropped. **Self-heal:** if `route-line` is missing (iOS WebGL/style reload drops it), `drawRouteOnMap` re-runs that tick — fixes "line vanishes mid-ride, needs a refresh." `projectOntoRoute` uses the full geometry for map-match/bearing/off-route. (The edge fn still labels the loop's final leg `return` in `leg_geometries` — currently unused by rendering, available if we revisit distinguishing the way-back.)

---

## Friends / Social (May 24–27)

- **`profiles`** — one per auth user; `display_name` + unique 6-char `share_code` (base32, A–Z minus I/O/Q + 2–9) for friend discovery.
- **`friendships`** — pending/accepted pairs in canonical lexicographic form (`user_id_a < user_id_b`), `initiated_by`.
- **`mate_positions`** — DB-backed live position sharing (replaced Realtime Presence); rider's position broadcast to accepted friends, rendered as buddy markers (initials + avatar color) on the map.
- **`shared_routes`** — routes sent between mates; persistent "Shared with me" inbox.
- Friend requests via email (`find-rider` edge fn) or share-code. **Universal Link:** `https://twotired.net/?add=SHARE_CODE` opens the add-friend flow. Realtime channels on `friendships` and `shared_routes` keep both sides in sync; sharing state persists across restarts via localStorage.

---

## Announcements (June 2)

- **`announcements`** — `kind` (info/warning/maintenance/critical), title, body, url + url_label, `starts_at`/`ends_at` window, `dismissible`. **`announcement_dismissals`** — per-user, syncs dismissal across devices.
- In-app banner picks the highest-priority active, non-dismissed announcement (critical → maintenance → warning → info, then newest). Realtime subscription on both tables + 10-min poll + visibility-change refresh. Admin composes from the Announcements tab.

---

## Supabase Tables

| Table | Purpose |
|---|---|
| `routes` | Saved routes (legacy, pre-migration schema) |
| `bug_reports` | User bug reports — `comment`, `image_data` (JPEG base64), `route_context` JSONB, `proposed_lesson`, `lesson_approved`, `admin_notes` (legacy schema) |
| `route_logs` | Full pipeline trace per generation; `gh_request`, `route_legs`, `user_id`, `nav_session_id`, `scenic_anchors_chosen/offered/resolved`, `anchor_detour_*`, `title`/`phased`/`force_anchors` (v2.93 picker markers). **v2.93: `route_geometry`/`route_legs` store the FULL path (was sampled ≤100 pts) — the admin Rides/debug LIST queries omit them and lazy-load per-session on open (`RIDE_LOG_LIST_COLS`/`RIDE_LOG_GEOM_COLS`) so the list stays light.** |
| `profiles` / `friendships` | Friend identity + relationships |
| `mate_positions` | Live position sharing |
| `shared_routes` | Route inbox between mates |
| `corridors` | Named scenic corridor preferences (9W, NY-97, NY-28) |
| `learned_corrections` | Human-reviewed routing rules from the bug pipeline (typed, not polygon-only) |
| `learned_areas` | **Deprecated** — superseded by `learned_corrections` |
| `announcements` / `announcement_dismissals` | In-app banners + per-user dismissal |
| `nav_events` | Navigation telemetry, grouped by `session_id` |
| `tasks` | Admin backlog/Kanban (status, priority p0–p3, category, linked_files/memory) |
| `stop_ratings` | Rider stop feedback (−1/0/+1), keyed by session_id + stop_index |
| `sent_messages` | Admin → user email log (channel, status, Resend errors) |
| `known_roads` | Iconic-road catalog (see Known Roads section) |
| `service_costs` | Monthly burn tracker (seeded with ~14 services) |
| `osm_junctions` | Cached OSM motorway-junction nodes (ref = exit #) for exit-number tagging; seeded by `scripts/seed_osm_junctions.py` (see Exit numbers) |

### Bug Report → Routing Lesson Pipeline
1. User submits bug report (map screenshot + comment + full route_context)
2. Admin opens report → `analyze-bug-report` auto-runs (Claude Haiku with vision)
3. Haiku extracts a specific routing lesson or returns `INSUFFICIENT_DETAIL`
4. Admin approves/rejects with optional notes → `learned_corrections`
5. `generate-route` injects approved corrections into Claude's system prompt

---

## Edge Functions

| Function | Purpose |
|---|---|
| `generate-route` | Main routing pipeline (v2.92) |
| `analyze-bug-report` | Haiku-with-vision lesson extraction |
| `seed-known-roads` | Claude bulk-enumerate iconic roads → `known_roads` (pending) |
| `validate-known-road` | Re-snap + route-verify + cache geometry on approval |
| `find-rider` | Email → user_id lookup for friend requests |
| `send-user-message` | Admin → rider email via Resend → `sent_messages` |
| `notify-signup` | Email Ivan on new signup |
| `delete-account` | App Store 5.1.1(v) account deletion (cascades) |

---

## Admin Portal (`admin/index.html`, 9 tabs)

| Tab | Purpose |
|---|---|
| **Bug Reports** | Reports w/ MapLibre screenshots; lesson extraction + approval |
| **Users** | Account list (email, join date, provider, confirmation); Message action |
| **Rulebook** | Active routing rules (manual + approved bug lessons); add/revoke |
| **Rides** | Consolidated session list (merged old Routes/Route Debug/Ride Logs); filters All/Navigated/Planning/Errors/Reroutes; expandable per-ride trace. Ride-open lazy-loads full geometry so the map matches the app exactly (v2.93). Visual-picker rides show a 🛣 badge + seeded-road name instead of "no prompt". |
| **Tasks** | Kanban (inbox/todo/in_progress/blocked/done/wontdo), priority + category filters, drag-drop |
| **Stop ratings** | Recent ratings + aggregated top-rated places (3+ ratings) |
| **Announcements** | Compose form + active/scheduled list |
| **Known Roads** | Seeder card + list/map views, status/state filters, approve/reject/edit |
| **Costs** | Monthly burn tracker per service |

Hidden (no nav button, still in HTML): `panel-debug`, `panel-routes`.

---

## Deploy Rules (Claude has push + deploy authority — 2026-06-19)

| Layer | Mechanism | Trigger |
|---|---|---|
| Vercel (frontend + admin) | `git push origin main` from Bash | auto-deploys on push |
| Supabase Edge Functions | Management API via `~/.supabase_pat` | curl POST `/v1/projects/{ref}/functions/{slug}` |
| Supabase SQL migrations | Management API `/database/query` | curl POST with SQL body |

**Rules Claude must follow:**
1. **Narrate before pushing.** State what's about to land BEFORE the push/deploy fires.
2. **Ask before destructive ops.** `drop table`, `truncate`, `alter` losing data, force-push, deleting edge functions — anything irreversible.
3. **One-deploy-at-a-time.** Don't bundle unrelated changes.
4. **Pause on red flags.** Unexpected files in `git status` (iOS, secrets, untracked) → ask before committing.
5. **Edge-fn rollback is one click** in the Supabase dashboard if a deploy breaks prod.

**Still requires Ivan:** iOS/Xcode/TestFlight/App Store, Apple Developer/billing, new Supabase secrets/env vars, DNS, anything uncertain.

**Git remote:** `git@github.com:ivanstamatovski/twotired-ui.git` (SSH — Ivan uses Google OAuth, no HTTPS password). "Never run git from sandbox" was a sandbox-mode artifact; direct Bash is unaffected.

---

## Frontend: App.jsx Architecture

### Key State
```javascript
const [sheetMode, setSheetMode] = useState('idle'); // 'idle' | 'collapsed' | 'expanded'
const [userLocation, setUserLocation] = useState(null); // always-on GPS watch
const [session, setSession] = useState(null); // Supabase auth
const [pickerMode, setPickerMode] = useState(false); // visual road picker
const [anchorCardExpanded, setAnchorCardExpanded] = useState(false);
```
(The old `routeVariant` state is gone — see v2.65 scoring removal.)

### Mobile Bottom Sheet
**Architecture:** `position: fixed; top: 0; bottom: var(--keyboard-height, 0px)` — full viewport height, slides via `translateY`.

**CRITICAL layout insight:** `translateY(calc(100% - Npx))` slides the sheet DOWN, making the **TOP Npx of the sheet element** visible at the bottom of the screen. Content must be at the TOP of the container (`justify-content: flex-start`), NOT the bottom. Placing content with `flex-end` puts it hundreds of pixels below the viewport — invisible.

| Mode | Transform | Visible area |
|---|---|---|
| idle | `translateY(calc(100% - 220px))` | top 220px of sheet |
| collapsed | `translateY(calc(100% - 110px))` | top 110px of sheet |
| expanded | `translateY(max(0px, env(safe-area-inset-top)))` | full screen |

**Idle state layout (top→down within visible 220px):** 18px padding-top → 72px centered mic/send hero (mic→arrow when text present) → 10px gap → 60px full-width input pill. Handle row hidden in idle.

**Collapsed state:** Handle row (~44px) + route title + Navigate button. `flex-shrink: 0` on collapsed-content (NOT `flex: 1`).

### GPS / Location
- Always-on `watchPosition` started on map load → `userLocation` (maximumAge: 2000)
- `submitQuery` uses `userLocation` if available, falls back to `getCurrentGPS({ timeout: 1500, maximumAge: 30000 })`
- **Do NOT use `maximumAge: 0`** — forces a fresh fix, hangs for seconds on device
- iOS requires `NSLocationWhenInUseUsageDescription` in Info.plist

### Auth — OTP (no magic links)
- `signInWithOtp({ email, options: { shouldCreateUser: true } })` → 6-digit code
- `verifyOtp({ email, token, type: 'email' })` — min 6 digits (Supabase enforces)
- Magic links abandoned (open Safari instead of the native app)
- Email via Resend SMTP (`smtp.resend.com:465`, user=`resend`, sender `support@twotired.net`)
- App-review login bypass exists for App Store review.

### submitQuery flow
```
1. Clear query, add user message to messages[]
2. Stay in idle/loading (hero spinner, input shows loadingMsg) — don't expand
3. Get GPS (userLocation || 1.5s fallback)
4. generateRoute() → success: setSheetMode('collapsed')
5. clarify response: setSheetMode('expanded')
```

---

## iOS / Capacitor

### Build Workflow
```bash
# On Ivan's Mac (NOT in Claude's sandbox — npm build fails there)
cd ~/Documents/twotired-ui
npm run build && npx cap sync
# Then rebuild in Xcode: ⌘R
```

### Testing nav on-device without driving (GPX simulation)
Turn-by-turn features (exit chip, off-route reroute, voice) only fire during a live nav session — you can't see them from a static map. To test in the Simulator without driving:
1. **Static render check:** Simulator → **Features → Location → Custom Location** → a lat/lng just before the maneuver. Plan a route through it, Navigate — the banner shows the *next* turn from that spot (enough to confirm a chip/label renders).
2. **Moving test (advance + voice):** feed Xcode a **GPX** that traces a real approach. Generate one from a GH route through a numbered exit, with a **~60s stationary dwell of duplicated start waypoints** up front so there's time to plan + Navigate before it moves, then timed waypoints (~22 m/s). Add the GPX to the Xcode project, then **Edit Scheme → Run → Options → Default Location = <gpx>** (auto-plays on launch — more reliable than Debug → Simulate Location, which is greyed unless the app is already running). Plan with **"fastest route to …"** so the app routes onto the highway the GPX follows. Verified 2026-07-04: exit chip appears on approach to I-84 Exit 8 this way.

### Info.plist Requirements
```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>TwoTired uses your location to plan motorcycle routes starting from where you are.</string>
<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>TwoTired uses your location to plan motorcycle routes starting from where you are.</string>
```

### capacitor.config.json (keep clean)
```json
{ "appId": "net.twotired.app", "appName": "TwoTired", "webDir": "dist" }
```
Do NOT add `server.url` (breaks HTTPS tile requests via ATS) or `scrollEnabled: false` (breaks MapLibre).

### Common Xcode Issues
- Open `.xcworkspace` not `.xcodeproj` (`npx cap open ios`)
- Signing: Target → Signing & Capabilities → Team = Ivan's Apple ID → Automatically manage
- Display Name: Xcode → General (resets on iOS project regeneration)
- Physical device: trust cert at iPhone Settings → General → VPN & Device Management
- `CapApp-SPM already opened`: you opened `.xcodeproj` instead of `.xcworkspace`

### iOS-specific bugs fixed
- MapLibre broken by `scrollEnabled: false` → removed
- Map blank: ATS blocks HTTPS tiles from HTTP `server.url` → removed server block
- App renders larger than screen: added `maximum-scale=1.0, user-scalable=no` to viewport meta
- Idle textarea auto-grow on iOS WKWebView fixed

---

## Android / Capacitor (scaffolded 2026-07-04)

Second native shell around the same web app. `android/` Capacitor project builds a clean debug APK; not yet on Play Store or run on a device. `@capacitor/android` pinned to `8.3.4` (matches the other `@capacitor/*`). appId `net.twotired.app` (same as iOS).

### Build Workflow
```bash
# On Ivan's Mac (NOT Claude's sandbox — npm build fails there; direct Bash is fine)
cd ~/Documents/twotired-ui
npm run build && npx cap sync android      # sync web bundle → android/ (do this before ANY native build)
cd android && ./gradlew assembleDebug      # → app/build/outputs/apk/debug/app-debug.apk
npx cap open android                        # open in Android Studio → run on emulator / device
```
Same stale-bundle trap as iOS: **`npm run build && npx cap sync` before every native rebuild**, or the shell ships an old `dist/`.

### Toolchain (this Mac, Apple Silicon arm64)
JDK 21 (Temurin), Android Studio + SDK at `~/Library/Android/sdk` (platform-tools, build-tools 36+37, platforms/android-36.1, licenses accepted). Env vars in `~/.zshrc` (`JAVA_HOME`, `ANDROID_HOME`, PATH). **`cmdline-tools`/`sdkmanager` NOT installed** — not needed to build; add via Android Studio → Settings → Languages & Frameworks → Android SDK → SDK Tools → "Android SDK Command-line Tools" if you ever need package management.

### AndroidManifest permissions (`android/app/src/main/AndroidManifest.xml`)
Mirror the iOS Info.plist capabilities:
- `ACCESS_FINE_LOCATION` + `ACCESS_COARSE_LOCATION` — WebView geolocation (mirrors iOS location keys).
- `RECORD_AUDIO` — voice input. The `@capacitor-community/speech-recognition` plugin ships its OWN manifest with `RECORD_AUDIO` + a `<queries>`/`RecognitionService` block; the manifest merger pulls those into the final app manifest (verified). Declared explicitly too for self-documentation.
- **No `ACCESS_BACKGROUND_LOCATION`** — Play Store review liability; nav keeps the screen awake (keep-awake) so location use stays foreground. keep-awake itself needs no permission (window `FLAG_KEEP_SCREEN_ON`).

### Android-specific watch-outs
- **WebView geolocation WORKS (verified on emulator + real device 2026-07-04/05).** The app uses browser `navigator.geolocation.watchPosition`, NOT `@capacitor/geolocation`, and the earlier worry that Capacitor's Android bridge wouldn't grant it was unfounded. On an API-35 emulator the rider got a real fix with `ACCESS_FINE/COARSE_LOCATION granted=true`. **Confirmed end-to-end on a physical Galaxy S20 (Android 13, sideloaded debug APK over USB):** fresh install starts at OTP login (no restored session), and after login the standard Android location permission *prompt* fires — Allow → map centers on real GPS. Capacitor 8's `BridgeWebChromeClient` auto-grants WebView geolocation once the app holds the native permission. Mic permission prompts on first voice-button tap. No remaining Android geolocation unknowns.
- **Keystore signing is Ivan's manual step** (like Xcode signing on iOS) — release `.aab` needs a keystore + Play Console.
- Hardware **back button** behavior (Capacitor `App` plugin `backButton` listener) — verify it doesn't exit mid-nav.
- Build artifacts are gitignored via Capacitor's `android/.gitignore` (APK, `.gradle/`, `build/`, `local.properties`, copied web assets) — only source is committed.

### Icons & splash
Generated by **`@capacitor/assets`** from `assets/icon.png` (1024², reused from the iOS `AppIcon.appiconset/Twotired - 2.png`) + `assets/splash.png` (2732², from the iOS splash). Regenerate after an icon change: `npx @capacitor/assets generate --android`. Produces legacy + adaptive (`mipmap-anydpi-v26`) launcher icons and all splash densities. **Heads-up:** the tool reformats `AndroidManifest.xml` XML style (self-closing tags) — harmless, permissions are preserved, but it shows up as a diff.

### Emulator (dev/testing)
AVD **`twotired_pixel`** (Pixel 7, `system-images;android-35;google_apis;arm64-v8a`, Apple Silicon). cmdline-tools were installed post-hoc (`~/Library/Android/sdk/cmdline-tools/latest`) to get `sdkmanager`/`avdmanager`. Drive it from the CLI:
```bash
ADB=~/Library/Android/sdk/platform-tools/adb
~/Library/Android/sdk/emulator/emulator @twotired_pixel -no-snapshot-save -gpu auto -no-boot-anim &
$ADB install -r android/app/build/outputs/apk/debug/app-debug.apk
$ADB shell am start -n net.twotired.app/.MainActivity
$ADB emu geo fix <LON> <LAT>          # set location — LONGITUDE FIRST, then latitude
$ADB -s emulator-5554 emu kill        # stop
```
- **Fake a location** (order is lon,lat!): Manhattan `-74.0060 40.7128` · Nyack/9W `-73.9182 41.0908` · Bear Mtn `-73.9887 41.3120` · Port Jervis/Hawk's Nest `-74.6907 41.3751`. Or use the emulator's `⋮` → Location (search + Set; Routes tab plays a GPX for moving/nav tests). Tap the in-app locate FAB to recenter.
- **Physical-keyboard typing gotcha:** AVDs default to `hw.keyboard=no`, which forces the on-screen keyboard and ignores the Mac keyboard. Fix: `sed -i '' 's/^hw.keyboard=no/hw.keyboard=yes/' ~/.android/avd/<name>.avd/config.ini` then cold-restart the emulator (or Studio → Device Manager → edit device → Enable keyboard input).
- **Verified 2026-07-04:** full app runs — map/tiles, geolocation, speech, Supabase, and a live NYC→Bear Mountain route generated end-to-end through Molly GraphHopper.

### Release signing (`android/app/build.gradle`)
`signingConfigs.release` reads from a **gitignored `keystore.properties`** (path/passwords/alias); guarded by `keystorePropertiesFile.exists()` so debug builds and fresh clones are unaffected. Template committed as `keystore.properties.example`. `*.jks`/`*.keystore`/`keystore.properties` are gitignored — **never commit signing keys or passwords.** `versionCode`/`versionName` live here too (currently `1` / `1.0.1`; the frontend `ver.` string is separate). **The keystore + its password are Ivan's to own and back up** (like Xcode signing).

### Publishing to Google Play
**Prereq (Ivan, one-time):** Google Play Developer account ($25, [play.google.com/console](https://play.google.com/console), ~1–2d verification). Enroll in **Play App Signing** (default) — Google holds the real signing key, the keystore below is just a recoverable *upload* key.

**Generate the upload keystore (Ivan owns the password):**
```bash
keytool -genkey -v -keystore ~/twotired-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias twotired
```
Then `cp android/keystore.properties.example android/keystore.properties` and fill in the real path/passwords/alias.

**Build the release bundle (Play requires an AAB, not APK):**
```bash
npm run build && npx cap sync android
cd android && ./gradlew bundleRelease     # → app/build/outputs/bundle/release/app-release.aab
```

**Play Console (Ivan, web):** create app → store listing (description, screenshots — grab from the emulator, feature graphic) → **content rating** questionnaire → **Data safety** form (declare *location* + *email* collection accurately) → privacy policy URL (twotired.net privacy page) → target audience. Upload the `.aab` to **Internal testing** first, verify, then promote to Production. Google review = hours–days.

**Per-release loop:** bump `versionCode` (must increment every upload) + `versionName` → `npm run build && npx cap sync android` → `./gradlew bundleRelease` → upload.

**In our favor:** no `ACCESS_BACKGROUND_LOCATION` → avoids Play's heavy background-location review (special form + demo video). Foreground-only = the simple path.

---

## CSS Architecture — Critical Lessons

### Bottom Sheet
`translateY(positive)` slides element DOWN. The VISIBLE portion at screen bottom = the TOP of the element. Always place idle/collapsed content at the TOP of their flex containers.

### Safe Areas (iOS)
```css
/* Sheet gets bottom safe-area padding via @supports */
/* sheet-idle content is at TOP of visible strip — no bottom padding there */
/* Expanded input area needs: padding-bottom: max(10px, env(safe-area-inset-bottom)) */
```

### Map Locate Button
`bottom: 228px` (mobile, above idle sheet). `bottom: 48px` (desktop via media query).

---

## Route Quality Standards

- Routes must be one smooth continuous line — no detached segments, no U-turns
- Waypoints must be on named paved roads, never in water, parking lots, or dead-ends
- Sterling Lake (April 2026): bad waypoint off-road → OSRM spur — what to avoid
- GWB from Queens: use Triborough approach (`40.853310, -73.960688`) — else routes go through midtown
- Wegmans Brooklyn (June 2026): intra-NYC trips must skip the two-phase escape (else 30mi via Staten Island)

---

## Architecture History (how we got here)

### Phase 1 (April 2026) — Gemini + Google Maps
Gemini 2.5 Flash generated waypoints → Google Directions routed. 18 versions fighting coordinate hallucination (waypoints in rivers/parking lots). v18: Roads API snap + spur detection. Lessons: `via:` prevents U-turns but not spur routing; Embed API silently ignores `via:`.

### Phase 2 (May 11, 2026) — v2 Architecture Pivot
Root-cause fix: the LLM never produces coordinates. Claude parses intent (text only) → Places API geocodes → GraphHopper routes. Sonnet 4.6 for intent, Haiku 4.5 for narrative. Two-phase routing (car escape + motorcycle scenic). Haversine post-filter on Places.

### Phase 3 (May 13–15, 2026) — Admin + Learning Loop
Admin portal. Bug-report flow (MapLibre canvas screenshot, `preserveDrawingBuffer:true`). Supervised learning: bug → Haiku lesson → human approval → injected into prompt. SSH git push.

### Phase 4 (late May 2026) — Social + App Store + iOS
Friends/profiles/share-codes, live position sharing, route sharing, Universal Links. Privacy + support pages, account deletion, app icon, app-review bypass — App Store readiness. Chat UI with mobile bottom sheet. OTP login (Resend SMTP). Auto-reroute + nav UX.

### Phase 5 (June 2026) — Telemetry, Loops, NYC Polygon, Known Roads
Removed scoring variant (v2.65); NYC polygon + intra-NYC escape skip (v2.66–68); circular loops (v2.76); nav_events telemetry + session linkage; announcements; stop ratings; admin Tasks/Costs/consolidated Rides. **Known Roads catalog + scenic anchors (v2.78–v2.84)** — the current frontier: Claude routes through a human-curated catalog of iconic roads, with a visual map picker for riders.

---

## Open Issues / Next Steps (as of 2026-06-22)

- [ ] **TestFlight / App Store submission** — still Ivan's manual step (distribution build, App Store Connect, invites)
- [ ] **Known Roads coverage** — catalog is the active build-out; seed + approve more states/regions; tune the detour-gate thresholds (1.5× haversine / 1.8× actual) against real rides
- [ ] **Scenic-anchor quality** — validate that anchor direction inference (haversine entry/exit) picks the right end on real geometry
- [ ] **Joy area polygons** — `generate_joy_areas.py` on Molly, GH config update, graph rebuild (~2h)
- [ ] **Score server geometry cap** — cap route to ~500 points before POST to avoid 20s timeouts
- [ ] **Native speech input** — `webkitSpeechRecognition` won't work in the Capacitor shell; plan Capacitor speech plugin or Whisper API
- [ ] **Recent rides → Supabase** — confirm rides are off localStorage (live sharing already DB-backed)

---

## Feedback Rules (behavioral guidelines for Claude)

- **Narrate before deploys** — state what's landing before each `git push` or edge-fn deploy so Ivan can intercept.
- **Ask before destructive SQL** — drop/truncate/alter losing data, force-push, deleting edge functions.
- **`finally` always runs** even after `return` in `try` — use a flag-variable pattern, never assert otherwise.
- **Verify the right file before editing** — real App.jsx is `twotired-ui/src/App.jsx`. Confirm it's in the git repo first.
- **Google Maps Embed API** does not support `via:` waypoints (silently shows world map). `buildMapSrc` must use `origin` + `destination` only.
- **6 decimal places on coordinates** — `40.853310, -73.960688` not `40.85, -73.96`. Precision matters for road-level snapping.
- **`translateY(positive)` shows TOP of element** at screen bottom. Don't use `justify-content: flex-end` in slide-up sheets.
- **No routing variant toggle** — v2.65 baked in the one model deliberately; don't reintroduce A/B scoring.
- **Anchors and corridors are mutually exclusive** — if Claude emits both, corridor wins.
- **Native parity — one capability, two manifests.** Adding a native capability (a new permission, plugin, or entitlement) means updating BOTH `ios/App/App/Info.plist` AND `android/app/src/main/AndroidManifest.xml`. Updating one and forgetting the other is the main maintenance tax of two shells — check both every time.
- **Sync before any native rebuild.** `npm run build && npx cap sync` before rebuilding iOS OR Android, or the shell ships a stale `dist/` (already bit us: TestFlight build 31).
- **Picker rides must ride the FULL seeded road** — the fun leg is the point; transit-out and return-home are just fast (curviness 1) connectors around it. Keep the fun leg threaded through the road's cached geometry via-points (v2.98) so it covers the whole road, and keep the return fast (v2.94, NOT scenic like v2.91). Don't regress either — the rider chose that road to ride all of it, then get home quick.
