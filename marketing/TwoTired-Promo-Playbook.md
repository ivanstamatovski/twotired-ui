# TwoTired Promo Machine — Playbook

The single source of truth for all TwoTired promotional content. Every weekly package follows these rules.

## The product

**TwoTired** — AI-powered motorcycle route planning iOS app. Live on the App Store. Web: twotired-ui.vercel.app.

Three differentiators to lead with:
1. **Voice-first interface** — plan a route by talking, not tapping. Works with gloves on.
2. **Live group ride tracking** — see your whole group on the map, nobody gets dropped.
3. **Seeded routes** — the app ships with curated, rider-vetted Northeast routes ready to ride. No blank-map problem; open the app, pick a proven route, go.

Supporting features: curviness scoring, natural-language route requests ("find me 2 hours of twisties ending at a diner"), Northeast US coverage.

**Honest-claims rule (non-negotiable):** never claim capabilities the live system doesn't have. No "millions of roads analyzed." Describe what the app does today.

## Audience

Northeast US riders (NY/NJ/CT/PA/MA). Weekend sport-tourers, cruiser groups, ADV riders. They hate: boring highway routes, apps built for cars, group rides that fall apart at the second stoplight. They love: twisties, diner stops, riding season FOMO, ribbing each other.

## Voice

Rider-to-rider, not brand-to-consumer. Confident, a little irreverent, zero corporate polish. Short sentences. Never say "revolutionize," "seamless," or "game-changer." The proven FB group post tone: casual, "built this thing, my crew uses it, try it" energy.

## Content pillars (rotate weekly)

1. **AI biker testimonial video** — Veo-generated character riffing about the app (podcast garage set, gas station banter, helmet cam rant). The two existing clips prove this format.
2. **Route spotlight** — a real Northeast route with curviness angle ("Bear Mountain loop, 87% twisty, 2h10m"). Prefer routes actually seeded in the app so posts double as feature proof. Needs a screenshot/screen recording from Ivan OR describes the route in text.
3. **Feature demo** — voice command in action, group tracking view. Needs screen recording from Ivan.
4. **Community/group post** — conversational post for FB groups and Reddit. Not an ad. Asks a question, shares a route, mentions the app in passing.

At 1–2 pieces/week: **every week = 1 video package (pillar 1) + 1 text post (pillar 2 or 4, alternating).**

## Veo 3 prompt recipe

Structure every video prompt as:

```
[SHOT] Medium close-up, [setting], cinematic, shallow depth of field, 16:9
[CHARACTER] [Specific rider archetype — vary: grizzled Harley guy, young sportbike woman, ADV dad, Jersey squid, old-timer BMW rider]
[ACTION/SETTING DETAIL] [garage podcast set / gas station / diner parking lot / roadside overlook]
[DIALOGUE] "[15–20 seconds of natural, funny, skeptical-then-convinced speech mentioning TwoTired by name]"
[AUDIO] ambient [bikes idling / garage reverb / wind], no music
[STYLE] photorealistic, natural skin texture, documentary feel
```

**STATIC SHOTS BY DEFAULT (Ivan's reject, 2026-07-08).** On budget models (Omni Flash/Lite), camera pans/cuts let the model re-imagine objects between views — a motorcycle that morphs mid-clip got v1 rejected. Every prompt: "single static locked-off shot, camera does not move, pan, cut, or zoom" + describe the bike specifically and state it stays identical. Reserve camera movement for Veo Fast/Quality runs.

Dialogue rules: skeptic-converted arc works best ("Two Tired or some shit like that, it looks pretty cool"). Mention ONE feature per video. Never sound like an ad read. Include the app name pronounced naturally. End on a hook or laugh, not a CTA — the caption carries the CTA.

**LOCAL REFERENCES ARE MANDATORY (Ivan's rule, 2026-07-07).** Every dialogue quotes a plausible voice command anchored in real Northeast riding geography — destination + a stop, the way riders actually talk:
- "Take me to Hawk's Nest and find a great barbecue on the way"
- "Make a twisty route to Bear Mountain"
- "Route to the Poconos, great coffee stop two hours in"
Rotate destinations (Hawk's Nest/NY-97, Bear Mountain/Seven Lakes, Storm King, the Poconos, Delaware Water Gap, Cold Spring, Catskills/23A, High Point NJ, Greenwood Lake, Litchfield Hills) and stop types (barbecue, diner, coffee, fuel, overlook). The local name-drop is what makes riders in FB groups stop scrolling — it signals "this app knows MY roads."

**CREDIT BUDGET (check before every generation).** Model prices per clip: Veo 3.1 Quality = 100 · Fast = 20 · Lite / Omni Flash = cheaper. Default is Fast at 20 WHEN BALANCE ALLOWS; if the remaining balance is lower, drop to Lite or Omni Flash and keep the dialogue extra tight. NEVER approve a Flow credit confirmation that exceeds the remaining balance Ivan stated; when in doubt, ask.

### THE VIDEO PIPELINE — full procedure (verified end-to-end 2026-07-07)

Ivan's spec: fully automated except his approval of the video. The complete flow, every step executed and verified live:

1. **Script.** Claude writes the Veo prompt per the recipe below: VERTICAL 9:16, dialogue ≤20 words (fits Veo's 8-second cap), one differentiator, rotating archetype/setting (check past week logs).
2. **Generate (≤20 credits).** Claude drives Flow via the Chrome extension — see "driving Flow" below. Model MUST be Veo 3.1 – Fast (20 credits — Ivan's standing budget). Approve the credit confirmation when it quotes ~20; if it quotes 100, the model is wrongly on Quality.
3. **Download.** Flow → video card ⋮ → Download. Lands in ~/Downloads (Claude has folder access). GOTCHAS (both hit in practice): (a) Chrome sometimes leaves the finished file as a `.com.google.Chrome.XXXX` temp file that never renames — check it; (b) that temp file may be a ZIP (`PK` magic bytes) containing the mp4 — Flow bundles some downloads; unzip it. Always verify with ffprobe (expect 720x1280) before editing.
3b. **Composer gotchas in Flow UI:** the bottom composer has an **Agent** pill toggle — if it's OFF, prompts go to the raw IMAGE generator (Nano Banana) and produce images, not video; toggle Agent ON first. A first-visit "Your agent is active!" overlay can silently swallow clicks/typing — dismiss with "Got it". If a generation goes to the wrong model, trash the pending items immediately.
4. **Edit — attach branded outro.** ffmpeg-concat the clip with `site-assets/brand/outro-916.mp4` (Ivan's original outro design + jingle: logo, TwoTired, twotired.net, "Free on App and Play stores"; 16:9 version + raw jingle.wav also archived there). Normalize both to 720x1280/24fps/yuv420p, aac 44.1k stereo. Output → `site-assets/media/YYYY-MM-DD-<slug>-final-916.mp4` + a copy to outputs for preview.
5. **IVAN'S APPROVAL GATE (two doors, both count).** (a) Present the finished video via present_files in chat — a "yes" there is approval. (b) Commit the video with publish-log `category: "pending"` — after deploy it appears in the amber **⏳ PENDING YOUR APPROVAL** section at the top of twotired.net/media-library with ✓ Approve / ✕ Reject buttons that open prefilled GitHub issues ("APPROVE: <file>" / "REJECT: <file>"). Pipeline runs CHECK OPEN ISSUES FIRST (Zapier GitHub repo_issue by title), act on them, comment with post IDs, and close them. Nothing publishes without one of the two approvals. On REJECT: reclassify as test, regenerate with a different approach.
6. **Host (AUTOMATED — verified 2026-07-07).** Claude commits the video itself via **GitHub web upload in Chrome**: navigate to `https://github.com/ivanstamatovski/twotired-ui/upload/main/site-assets/media`, find the file input, use the browser file_upload tool with the file's host path (must be in a connected folder), commit message, "Commit directly to main". Vercel auto-deploys (~1 min); verify `https://www.twotired.net/media/<file>` returns video/mp4 before publishing. No Ivan push needed. CAVEAT: this leaves Ivan's local repo one commit behind with the identical file untracked — his next `git pull` may complain; fix is `git stash -u && git pull --rebase && git stash pop` or just delete the local copy first. (Zapier GitHub `create_file` works for TEXT commits; web upload is the binary path.)
7. **Publish everywhere.** Zapier skill "post to twotired socials": IG Reel + FB Page video + YouTube Short, per-platform captions. KNOWN ERROR: IG "Video is still processing" = timed-out transcode; verify via media list, then retry once — recovers cleanly.
8. **Log** post IDs in the weekly content file.

### Driving Flow via Chrome (sub-procedure)

Claude generates the video itself via the Chrome extension — Ivan does not need to paste prompts. The procedure ("the Flow flow"):

1. Navigate to https://labs.google/fx/tools/flow (Ivan's Google login persists in Chrome) → **New project**.
2. In the session panel's create box, paste the video prompt. IMPORTANT: prompt must say **vertical 9:16** and the dialogue must fit **8 seconds** (~20–25 words) — Veo 3.1 Quality's max duration. Longer dialogue triggers a model clarification detour.
3. Open the tune/settings icon next to send → **Agent settings**: Video generation default → **9:16**, model → **Veo 3.1 – Fast** (IVAN'S STANDING PREFERENCE: Fast is the default — ~15–20 credits/clip and proven good enough for talking-rider clips; Quality is 100 credits and reserved for hero content Ivan explicitly requests), outputs 1x → Save.
4. Send. Flow's agent asks to confirm credit spend → Approve (~15–20 credits expected; if it quotes ~100, the model is wrongly set to Quality — fix before approving).
5. Wait for render (a few minutes), then download the clip from the project's media panel; it can then be published via the Zapier skill "post to twotired socials" (needs a public URL — upload to the site or hand to Claude).

Failure mode seen: "You need more AI credits" — only Ivan can top up (payment). The project keeps the prompt; retry arrow regenerates after topping up.

## Platform formats

**Instagram Reel:** video + caption ≤125 chars before the fold, hook first line, 8–12 hashtags (#motorcycleroutes #twistyroads #nycriders #motorcyclesofinstagram #ridemore + regional tags), CTA "Link in bio."

**Facebook Page:** same video, longer caption ok, one link to App Store.

**Facebook Groups (manual paste):** NO link in first post (algorithm + group rules), personal framing ("been using this app my buddy built"), drop link in comments. Different wording per group — never identical cross-posts.

**Reddit (manual paste):** value-first. Lead with the route or question, app mention secondary or in comments when asked. Flair-appropriate. Target: r/MotoNYC, r/motorcycles, r/CalamariRaceTeam (irreverent, loves original content), regional subs. Max 1 Reddit post every 2 weeks per sub — Reddit burns astroturfers.

## Media library

**https://www.twotired.net/media-library** — internal visual gallery, classified into Finals (with platform badges + publish dates), Tests & variations, and Brand assets (unlisted, noindexed). **https://www.twotired.net/gallery** — PUBLIC "best of" page ("From the garage"), linked from the landing nav/footer with the social links.

Classification lives in **`site-assets/publish-log.json`**: per file → `category` (final/test/hidden), `title`, `caption`, `bestOf` (true = shows on public /gallery), `platforms` {instagram/facebook/youtube: {id, url, date}}. **AFTER EVERY PUBLISH, update this file** (Zapier GitHub create_file with sha) with the new post IDs/permalinks — that's what keeps the platform badges and dates accurate. Both pages regenerate on every deploy via scripts/vercel-postbuild.mjs.

To add an asset: commit to `site-assets/media/` (finals + tests) or `site-assets/brand/` (GitHub web upload for binaries, Zapier create_file for text) → public URL + gallery card automatically. Only finals/tests in the repo; raw footage stays local.

## Live channels

- Website: https://www.twotired.net (landing + route SEO pages at /routes)
- Facebook Page: "Two Tired" — https://www.facebook.com/61591906523319, Graph API Page ID `1269627876223169` (username @ridetwotired pending Meta's new-page gate)
- Instagram Business: @ridetwotired "TwoTired :: Motorcycle Routes", account ID `17841413936216841`
- Auto-posting: Zapier MCP skill "post to twotired socials" (IDs locked in; FB page dropdown is broken — always pass IDs directly). First posts published 2026-07-05 to both channels.
- TikTok: **@ridetwotired** Business account (added 2026-07-08). NO Zapier organic posting — publish via browser, WORKS (first success 2026-07-09): go to tiktok.com/tiktokstudio/upload → file_upload the mp4 into the file input → **WAIT ~2 MINUTES** (client-side processing shows an endless spinner — this is the trap; earlier "failures" were impatience) → details form appears → replace Description with caption (≤2200 chars, 3-5 hashtags incl #motorcycletok) → confirm Checks pass → Post. First posts on new accounts show "Content under review" + privacy "Only me" briefly — TikTok flips to Everyone automatically after review; VERIFY next day. Business = Commercial Music Library only (our clips carry their own audio, no loss).
- App Store: https://apps.apple.com/us/app/twotired/id6773547851 · Google Play: pending
- YouTube: TwoTired brand-account channel (Shorts of AI videos) · Reddit: personal account warming up
- **Cadence: DAILY (as of 2026-07-08)** — one video/day through the approval gate (Flow credits replenish daily, budget ~15/day), one auto photo post/day, community text pack Mondays only. Scheduled task `twotired-weekly-promo` runs 7am daily.

## Automation pipeline

1. **Weekly scheduled task** (Mondays) generates the full package → outputs folder.
2. **Ivan's only jobs:** paste the Veo prompt into Flow (1 click + wait), review output, and let Zapier post it — plus paste the group/Reddit text when scheduled.
3. **Zapier posting** (once connected): Zap 1: "New file/trigger → post Reel to Instagram Business." Zap 2: "→ post to Facebook Page." Set up at zapier.com with Instagram for Business + Facebook Pages apps, or expose them as Zapier MCP actions so Claude can trigger them directly.
4. **Content log:** each weekly package includes a `log.md` line; the schedule prompt rotates pillars and video archetypes so nothing repeats.

## Asset requests from Ivan (batch once, reuse forever)

- 5–10 screen recordings: voice command demo, route generation, group tracking view (30–60s each, portrait)
- 5–10 route map screenshots of the best Northeast routes
- Any real ride footage (helmet cam, group rides)

Drop them in a folder and connect it; the machine will pair them with captions for weeks.
