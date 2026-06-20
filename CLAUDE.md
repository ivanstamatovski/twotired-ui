# TwoTired — Project Context for Claude

## What this is
AI-powered motorcycle ride planning app. User types (or speaks) where they want to ride; the app plans a scenic route, avoids highways, hits stops, and renders it on a map. Native iOS app via Capacitor wrapping a React/Vite web app.

**Owner:** Ivan Stamatovski (ivan@easyaerial.com)  
**GitHub:** https://github.com/ivanstamatovski/twotired-ui  
**Web app:** https://twotired.net (Vercel, auto-deploys from main)  
**Admin portal:** https://admin.twotired.net (password: `TwoTired2026!`)  
**Supabase project ref:** `ujvfwzcjgxupvtiwllhw`

---

## Tech Stack (current — v2 architecture, May 2026)

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite, `src/App.jsx` + `src/App.css` |
| Maps | MapLibre GL JS (`maplibre-gl`), OpenFreeMap Liberty style |
| Routing | GraphHopper 11.0 self-hosted on **Molly** (home server) |
| AI — intent | Claude Sonnet 4.6 (`claude-sonnet-4-6`) — NL → RouteRequest JSON |
| AI — narrative | Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) |
| Geocoding | Google Places API (New) — `searchText` + haversine post-filter |
| Backend | Supabase Edge Functions (Deno) + Postgres |
| Native wrapper | Capacitor 7 (`net.twotired.app`) |
| Domain | `twotired.net` (Vercel DNS) |

---

## Repository Layout

```
twotired-ui/
  src/
    App.jsx          ← entire frontend (auth, map, sheet, routing, nav)
    App.css          ← all styles
    main.jsx
  supabase/
    functions/
      generate-route/index.ts   ← main edge function (v2.45+)
      analyze-bug-report/       ← auto-generates routing lessons from bug reports
  ios/
    App/App/Info.plist          ← iOS permissions (location keys added May 2026)
  admin/
    index.html                  ← self-contained admin portal
  capacitor.config.json
  vite.config.js
  .env                          ← VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (gitignored)
```

---

## Infrastructure — Molly (home server)

**Machine:** i7-1165G7, 30GB RAM, Ubuntu 24.04  
**GraphHopper:** Port 8989, motorcycle + car profiles (CH + LM flexible mode)  
**Score server:** `score_server.py` port 8765 — scores road segments by joy/transit/curvature  
**Road scoring DB:** PostgreSQL `twotired_roads` — 1.64M segments (CT/MA/NJ/NY/PA)

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
**Current version:** v2.45+ (Supabase function version ~45)

### Pipeline
1. Claude Sonnet 4.6 parses natural language → `RouteRequest` (origin, destination, stops, curviness 1–3, escape_waypoint, intermediate_waypoints)
2. Google Places API geocodes stops by name+region, haversine post-filter rejects results >radius_km away
3. **Two-phase GraphHopper routing:**
   - **Escape leg:** origin → escape_waypoint, curviness=1 (car profile, direct city exit)
   - **Scenic leg:** escape → intermediates → stops → destination, requested curviness
   - Legs merged via `mergeRoutes()`
4. Claude Haiku writes 2–3 paragraph ride narrative from turn-by-turn instructions
5. Save to Supabase `routes` table + `route_logs` table

### NYC Escape Corridors (in Claude system prompt)
- North/NW → GWB, Fort Lee NJ: `{ lat: 40.853310, lng: -73.960688 }` (6 decimal places — precision matters)
- West/SW (Philly, Delaware) → Goethals Bridge, Staten Island
- South (Jersey Shore) → Goethals Bridge
- East (Long Island) → no escape needed

### A/B Routing Variant Toggle
- `variant: 'classic'` (default) — two-phase routing with road-class priority weights
- `variant: 'scoring'` — single GH call, joy area weights only (`buildScoringModel()`)
- Sent from frontend as `body.variant`; toggled in mobile menu / desktop sidebar

### GraphHopper Custom Model / Curviness Tiers
| Curviness | Behavior |
|---|---|
| 1 (transit) | Direct/efficient, motorways OK |
| 2 (scenic) | Balanced — avoids motorways, prefers secondary/tertiary |
| 3 (backroads) | Max twisty — strong motorway penalty |

**Scoring pivot (May 2026, partially implemented):** Replacing class-based priority weights with joy/transit area polygons (`in_joy_tier_a` multiply_by 1.5, `in_joy_tier_c` multiply_by 0.4). GH config needs `custom_model_files` + graph rebuild on Molly.

### Known KNOWN_WAYPOINTS
```typescript
'gwb ny approach': { lat: 40.853310, lng: -73.960688 }
```
This is the Trans-Manhattan Expy GWB on-ramp. Forces Queens traffic via Triborough, not midtown. Precision is critical — do not round.

---

## Deploy Rules (UPDATED 2026-06-19 — Claude has push + deploy authority)

Claude can deploy directly. Three layers, three mechanisms:

| Layer | Mechanism | Trigger |
|---|---|---|
| Vercel (frontend + admin) | `git push origin main` from Bash | auto-deploys on push |
| Supabase Edge Functions | Management API via `~/.supabase_pat` | curl POST `/v1/projects/{ref}/functions/{slug}` |
| Supabase SQL migrations | Management API `/database/query` | curl POST with SQL body |

**Rules Claude must follow:**

1. **Narrate before pushing.** State in chat what's about to land BEFORE the push/deploy fires. Ivan can intercept.
2. **Ask before destructive ops.** `drop table`, `truncate`, `alter` losing data, force-push to main, deleting edge functions, anything irreversible.
3. **One-deploy-at-a-time.** Don't bundle unrelated changes into one push.
4. **Pause on red flags.** If `git status` shows files Ivan didn't expect (e.g. iOS, secrets, untracked things), ask before committing.
5. **Edge-fn rollback is one click** in the Supabase dashboard if a deploy breaks production. Mention this when relevant.

**What still requires Ivan's explicit action:**
- iOS / Xcode / TestFlight / App Store
- Apple Developer / billing / vendor accounts
- New Supabase secrets / env vars
- Domain / DNS changes
- Anything where Claude isn't sure → ask first

**Git remote:** `git@github.com:ivanstamatovski/twotired-ui.git` (SSH, not HTTPS — Ivan uses Google OAuth, no password)

**Historical context:**
- Pre-2026-06-19: Ivan deployed manually via Monaco + paste-into-SQL-editor. Restriction lifted after generating a Supabase Personal Access Token (stored at `~/.supabase_pat`).
- "Never run git from sandbox" was a sandbox-mode artifact (macOS mount unlink issue). Claude Code with direct Bash isn't affected.

---

## Frontend: App.jsx Architecture

### Key State
```javascript
const [sheetMode, setSheetMode] = useState('idle'); // 'idle' | 'collapsed' | 'expanded'
const [routeVariant, setRouteVariant] = useState('classic');
const [userLocation, setUserLocation] = useState(null); // always-on GPS watch
const [session, setSession] = useState(null); // Supabase auth
```

### Mobile Bottom Sheet
**Architecture:** `position: fixed; top: 0; bottom: var(--keyboard-height, 0px)` — full viewport height, slides via `translateY`.

**CRITICAL layout insight:** `translateY(calc(100% - Npx))` slides the sheet DOWN, making the **TOP Npx of the sheet element** visible at the bottom of the screen. Content must be at the TOP of the container (`justify-content: flex-start`), NOT the bottom. Placing content with `flex-end` puts it hundreds of pixels below the viewport — invisible.

| Mode | Transform | Visible area |
|---|---|---|
| idle | `translateY(calc(100% - 220px))` | top 220px of sheet |
| collapsed | `translateY(calc(100% - 110px))` | top 110px of sheet |
| expanded | `translateY(max(0px, env(safe-area-inset-top)))` | full screen |

**Idle state layout (top→down within visible 220px):**
- 18px padding-top
- 72px centered mic/send hero button (mic icon → arrow icon when text present)
- 10px gap
- 60px full-width input pill
- Handle row is hidden in idle (`display: none`)

**Collapsed state:** Handle row (~44px) + route title + Navigate button. `flex-shrink: 0` on collapsed-content (NOT `flex: 1` — that would center content vertically in a 700px container, invisible in 66px strip).

### GPS / Location
- Always-on `watchPosition` started on map load → `userLocation` state (maximumAge: 2000)
- `submitQuery` uses `userLocation` if available (instant), falls back to `getCurrentGPS({ timeout: 1500, maximumAge: 30000 })`
- **Do NOT use `maximumAge: 0`** — forces fresh GPS fix, hangs for seconds on device
- iOS requires `NSLocationWhenInUseUsageDescription` in Info.plist (added May 2026)

### Auth — OTP (no magic links)
- `signInWithOtp({ email, options: { shouldCreateUser: true } })` → sends 6-digit code
- `verifyOtp({ email, token, type: 'email' })` — minimum 6 digits (Supabase enforces)
- Magic links were abandoned — they open Safari instead of the native app
- Email sent via Resend SMTP (`smtp.resend.com:465`, user=`resend`, sender `support@twotired.net`)

### submitQuery flow
```
1. Clear query, add user message to messages[]
2. Don't expand sheet — stay in idle/loading state (hero shows spinner, input shows loadingMsg)
3. Get GPS (userLocation || 1.5s timeout fallback)
4. generateRoute() → on success: setSheetMode('collapsed')
5. On clarify response: setSheetMode('expanded') to show clarify options
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

### Info.plist Requirements
```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>TwoTired uses your location to plan motorcycle routes starting from where you are.</string>
<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>TwoTired uses your location to plan motorcycle routes starting from where you are.</string>
```

### capacitor.config.json (keep clean)
```json
{
  "appId": "net.twotired.app",
  "appName": "TwoTired",
  "webDir": "dist"
}
```
Do NOT add `server.url` (breaks HTTPS tile requests via ATS) or `scrollEnabled: false` (breaks MapLibre).

### Common Xcode Issues
- Open `.xcworkspace` not `.xcodeproj` (use `npx cap open ios`)
- Signing: Xcode → Target → Signing & Capabilities → Team = Ivan's Apple ID → Automatically manage signing
- Display Name: set in Xcode → General → Display Name (resets on iOS project regeneration)
- Physical device: trust cert at iPhone Settings → General → VPN & Device Management
- `CapApp-SPM already opened`: you opened `.xcodeproj` instead of `.xcworkspace`

### iOS-specific bugs fixed
- MapLibre broken by `scrollEnabled: false` in Capacitor config → removed
- Map blank: ATS blocks HTTPS tile requests from HTTP `server.url` → removed server block
- App renders larger than screen: added `maximum-scale=1.0, user-scalable=no` to viewport meta

---

## Supabase Tables

| Table | Purpose |
|---|---|
| `routes` | Saved routes |
| `bug_reports` | User bug reports — `comment`, `image_data` (JPEG base64), `route_context` JSONB, `proposed_lesson`, `lesson_approved`, `admin_notes` |
| `route_logs` | Full pipeline trace per generation |

### Bug Report → Routing Lesson Pipeline
1. User submits bug report (map screenshot + comment + full route_context)
2. Admin opens report → `analyze-bug-report` edge function auto-runs (Claude Haiku with vision)
3. Haiku extracts specific routing lesson or returns `INSUFFICIENT_DETAIL`
4. Admin approves/rejects with optional notes
5. `generate-route` fetches only `lesson_approved=true` lessons → injects into Claude's system prompt

---

## CSS Architecture — Critical Lessons

### Bottom Sheet
`translateY(positive)` slides element DOWN. The VISIBLE portion at screen bottom = the TOP of the element. Always place idle/collapsed content at the TOP of their flex containers.

### Safe Areas (iOS)
```css
/* Sheet itself gets bottom safe-area padding via @supports */
/* sheet-idle content is at TOP of visible strip — no bottom padding needed there */
/* Expanded sheet input area needs: padding-bottom: max(10px, env(safe-area-inset-bottom)) */
```

### Map Locate Button
Position above idle sheet: `bottom: 228px` (mobile). `bottom: 48px` (desktop via media query).

---

## Route Quality Standards

- Routes must be one smooth continuous line — no detached segments, no U-turns
- Waypoints must be on named paved roads, never in water, parking lots, or dead-ends
- Sterling Lake (April 2026): bad waypoint off-road → OSRM spur — example of what to avoid
- GWB routing from Queens: use Triborough approach (`40.853310, -73.960688`) — without this, routes go through midtown Manhattan

---

## Architecture History (how we got here)

### Phase 1 (April 2026) — Gemini + Google Maps
- Gemini 2.5 Flash generated waypoints → Google Directions API routed
- 18 versions of patches fighting coordinate hallucination (waypoints in rivers, parking lots)
- v18: Roads API snap + spur detection (ratio > 1.4 filter) — best v1 result
- Key lessons: `via:` prefix prevents U-turns but not spur routing; Embed API silently ignores `via:`

### Phase 2 (May 11, 2026) — v2 Architecture Pivot
**Root cause fix:** LLM never produces coordinates. Claude parses intent (text only) → Places API geocodes → GraphHopper routes.
- Claude Sonnet 4.6 for intent, Claude Haiku 4.5 for narrative
- GraphHopper self-hosted on Molly (home server), motorcycle + car profiles
- Two-phase routing: direct city escape leg (car) + scenic leg (motorcycle)
- haversine post-filter on Places results (rejects results > radius_km)

### Phase 3 (May 13–15, 2026) — Admin + Learning Loop
- Admin portal at `admin.twotired.net`
- Bug report flow: MapLibre canvas screenshot (preserveDrawingBuffer: true) → Supabase
- Supervised learning: bug → Haiku lesson extraction → human approval → injected into routing prompt
- SSH git push set up (Ivan uses Google OAuth, no password for HTTPS)

### Phase 4 (May 2026) — Scoring Architecture Pivot + iOS
- Scoring pivot planned: replace class-based GH weights with joy/transit area polygons
- A/B variant toggle (classic vs scoring) implemented
- Rebuilt frontend as chat UI (MapLibre, mobile-first bottom sheet)
- Capacitor iOS app working on device via TestFlight pipeline (in progress)
- OTP login replaces magic links (Resend SMTP for `support@twotired.net`)

---

## Open Issues / Next Steps (as of May 23, 2026)

- [ ] **TestFlight upload** — app builds on device; needs App Store Connect record, distribution build, TestFlight invite
- [ ] **Scoring variant testing** — `scoring` variant implemented but not thoroughly tested vs `classic`
- [ ] **Joy area polygons** — `generate_joy_areas.py` on Molly, GH config update, graph rebuild (~2h)
- [ ] **Score server geometry cap** — cap route to ~500 points before POST to avoid 20s timeouts
- [ ] **webkitSpeechRecognition** — browser API, won't work in native Capacitor shell; plan: Capacitor speech plugin or Whisper API
- [ ] **Recent rides → Supabase** — currently localStorage only, breaks cross-device

---

## Feedback Rules (behavioral guidelines for Claude)

- **Narrate before deploys** — state what's landing in chat before each `git push` or edge fn deploy so Ivan can intercept.
- **Ask before destructive SQL** — drop/truncate/alter losing data, force-push, deleting edge functions.
- **`finally` always runs** even after `return` in `try` — use a flag variable pattern, never assert otherwise.
- **Verify the right file before editing** — real App.jsx is `twotired-ui/src/App.jsx`. Confirm it's in the git repo before editing.
- **Google Maps Embed API** does not support `via:` waypoints. Silently shows world map. `buildMapSrc` must use `origin` + `destination` only.
- **6 decimal places on coordinates** — `40.853310, -73.960688` not `40.85, -73.96`. Precision matters for road-level snapping.
- **`translateY(positive)` shows TOP of element** at screen bottom, not the bottom. Don't use `justify-content: flex-end` in slide-up sheets.
