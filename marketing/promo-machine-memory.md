# TwoTired Promo Machine — Session Memory (checkpoint 2026-07-09)

**Read this first in any new marketing/promo session.** The full operating manual is
`TwoTired-Promo-Playbook.md` (canonical persistent copy sits NEXT TO this file in `marketing/`;
working copy should also live in the session outputs folder — restore it from here if missing).

## What exists (all built & verified)
- **Website:** twotired.net — landing at `/` (app moved to `/app` via `vercel-build` postbuild swap;
  Capacitor untouched). 6 route SEO pages (`scripts/generate-route-pages.mjs` + `route-pages.json`),
  sitemap, store badges (Play = "coming soon" until `playStoreUrl` set in route-pages.json).
- **Media library:** `/media-library` (internal, with ⏳ PENDING approval section + Approve/Reject
  buttons that open prefilled GitHub issues "APPROVE: <file>" / "REJECT: <file>") and `/gallery`
  (public best-of). Both generated at deploy by `scripts/vercel-postbuild.mjs` from
  `site-assets/publish-log.json` (classification DB: category final|test|pending|hidden, bestOf,
  platforms{id,url,date}). Media files in `site-assets/media/`, brand kit (outro-916/169.mp4,
  jingle, avatar, covers) in `site-assets/brand/`. Admin portal sidebar links to media library.
- **Channels (all live):** Instagram @ridetwotired (17841413936216841) · Facebook Page
  "TwoTired" (page id 1269627876223169 — NEVER 61591906523319, that's the profile id; FB dropdown
  broken, always pass page id directly) · YouTube "Two Tired" (UCrg9QZIgXf6Ieuo666-3ZcQ) ·
  TikTok @ridetwotired (Business).
- **Zapier MCP** (server 58599ad7-e4e3-4e50-9184-a3b0de089d1d): IG/FB/YT/GitHub apps + skill
  "post to twotired socials" (locked IDs, IG retry protocol: IG returns "Video is still
  processing (180)" — publish FB+YT first, verify via raw GET /{ig-id}/media, retry once).
- **Scheduled task `twotired-weekly-promo`:** DAILY 7:05am — check GitHub approval issues →
  publish approved video to all 4 channels → generate next video via Flow → pending entry →
  photo post. Prompt includes full TikTok procedure.

## The video pipeline (proven end-to-end 3×)
Script (≤20 words dialogue, MANDATORY real Northeast destination + stop, ONE differentiator) →
Google Flow via Chrome (Agent pill ON; budget ~15 credits/day replenishing; Omni Flash 15cr/10s;
approve only quotes ≤ budget; STATIC LOCKED-OFF SHOTS ONLY — pans made the bike morph, Ivan
rejected v1 for it) → download (temp-file/ZIP gotchas — always ffprobe) → ffmpeg concat with
site-assets/brand/outro-916.mp4 (720x1280/24fps/yuv420p, aac 44.1k) → commit via GitHub WEB
upload (wait for processing before Commit, VERIFY via directory listing after) → publish-log
entry category "pending" (Zapier create_file, needs fresh blob sha) → Ivan approves via
media-library buttons (GitHub issue) or chat → publish 4 channels → log ids/dates → close issue.
**Approval gate = Ivan's only manual touch. NEVER publish unapproved video.**

## TikTok (SOLVED 2026-07-09 — automated, was wrongly "manual-only")
Chrome → tiktok.com/tiktokstudio/upload → file_upload the mp4 → **WAIT ~2 min** (endless spinner
is NORMAL — earlier failures were impatience) → form appears → Description via triple_click+cmd+a+
type (3-5 hashtags incl #motorcycletok) → checks pass → Post. First post on new account shows
"Content under review" + "Only me" briefly, flips public automatically.

## State as of 2026-07-09
- "Forty Years, One Download" (diner v2) published to ALL FOUR channels. IG 18228892330318147
  (reel/DakmDsdCSxt), FB 1009717841969427, YT 0Ywzmr45vxo, TikTok pending review (permalink not
  yet recorded — grab from tiktokstudio/content Posts list once public, add to publish-log).
- publish-log.json HEAD commit 5bd44fb (has tiktok record, id null). Issue #2 closed (approval).
- Prior finals: gas-station-skeptic, hawks-nest-dad (posted 07-07); calimoto comparison PNG
  (final/bestOf, NOT yet posted to FB groups — Ivan's move).
- Flow project: labs.google/fx/tools/flow/project/4640c56e-64ca-4b9d-a547-e1fa53882ad3

## Open items
- Record TikTok permalink in publish-log once video passes review.
- Ivan: FB username @ridetwotired retry (Meta new-page gate) · Reddit account warm-up (~2 wks) ·
  post Calimoto PNG to FB groups · Play Store link when live (set `playStoreUrl` in
  scripts/route-pages.json, regenerate) · Google Play submission (AAB ready, mobile lane).
- Ivan's LOCAL repo clone is many commits behind (all work committed remotely) —
  `git pull --rebase` before any local work.
- Kanban: "[marketing] Re-cut 3 legacy YouTube videos to 9:16 Shorts with branded outro" (P2).
- Nice-to-have: approval buttons give no click feedback — add "what happens next" hint in
  vercel-postbuild.mjs generator next time it's touched.
- Zapier GitHub `comment` action can't target CLOSED issues (dynamic enum lists open only).

## Cross-session rules (from CLAUDE.md)
Marketing lane. Coordinate via Supabase `tasks` board (`[marketing]` prefix) + `agent_chat`
(author='marketing'). Git: rebase before start/push, lane-scoped commits. All repo writes this
session went through GitHub web upload / Zapier create_file (Ivan's terminal was bypassed).
