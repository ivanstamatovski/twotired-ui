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

## The video pipeline (proven end-to-end 4×)
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
Chrome → tiktok.com/tiktokstudio/upload → file_upload the mp4 → **WAIT ~2 min, sometimes up to
~4min** (endless spinner is NORMAL — earlier failures were impatience). Seen once (2026-07-09 pm):
first upload attempt spun indefinitely and silently produced NOTHING (0 drafts in Posts list) —
had to be redone from scratch, second attempt succeeded in ~2min. If the spinner runs past ~3min,
consider checking tiktokstudio/content for a stray draft before just re-waiting; if nothing shows
up there either, re-upload fresh rather than waiting indefinitely on the same attempt. Once the
form appears: Description via triple_click+cmd+a+type (3-5 hashtags incl #motorcycletok) → checks
pass → Post. First post on new account shows "Content under review" + "Only me" briefly, flips
public automatically.

## State as of 2026-07-09 (end of day)
- "Order Another Coffee" (Nyack live-tracking, differentiator = group ride tracking) — this was
  the scheduled task's Step 2 video (generated 10:34am, project
  labs.google/fx/tools/flow/project/7b88f4c2-92b5-494d-b0fe-acace7b0dcbd), but the daily run did
  NOT finish committing/publishing it — found still sitting undownloaded in Flow. Ivan asked
  directly in chat to finish the pipeline and post it (chat approval = the gate). Downloaded (zip
  gotcha again, temp file `.com.google.Chrome.*`), ffmpeg+outro, committed
  `site-assets/media/2026-07-09-nyack-live-tracking-final-916.mp4` (commit f3a17c0), published
  ALL FOUR: IG 17964154407140119 (reel/DamCZvBleWd — first attempt hit the known "Video is still
  processing" error, retry recovered cleanly per playbook), FB 1523621285922438, YT
  RGj_T15cBQw, TikTok 7660711672469916958 (@ridetwotired/video/7660711672469916958 — spinner ran
  ~4min this time before the details form appeared, notably longer than the usual ~2min; first
  upload attempt silently produced nothing (0 drafts, had to redo from scratch) — worth flagging
  if it recurs). publish-log.json HEAD commit 3f9fab9 (TikTok permalink recorded same-day).
- "Forty Years, One Download" (diner v2) published to ALL FOUR channels earlier today. IG
  18228892330318147 (reel/DakmDsdCSxt), FB 1009717841969427, YT 0Ywzmr45vxo, TikTok permalink
  STILL not recorded (id null in publish-log).
- Prior finals: gas-station-skeptic, hawks-nest-dad (posted 07-07); calimoto comparison PNG
  (final/bestOf, NOT yet posted to FB groups — Ivan's move).
- Two Flow projects now in play: yesterday's diner project
  (4640c56e-64ca-4b9d-a547-e1fa53882ad3) and today's (7b88f4c2-92b5-494d-b0fe-acace7b0dcbd) —
  the daily task should open labs.google/fx/tools/flow (project list) and pick the card dated
  TODAY, not assume the last session's project id is still current.

## Open items
- Record TikTok permalink for diner v2 in publish-log (id still null).
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
