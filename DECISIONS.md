# TwistyRoute — Architecture Decisions

## AI Stack: Gemini + Claude Hybrid
**Date:** April 15, 2026  
**Status:** Implemented, pending production test

### Decision
Move from a single Claude-only route generation call to a hybrid model:

| Layer | Model | Responsibility |
|---|---|---|
| Geospatial discovery | Gemini 2.0 Flash + Google Maps grounding | Real road names, accurate GPS waypoints anchored to live Google Maps data |
| Road geometry | OpenRouteService (unchanged) | Snapping waypoints to actual road surface → GeoJSON polyline |
| Narrative & UX | Claude Sonnet | Route titles, segment descriptions, difficulty, tags, rider voice |

### Rationale
- Gemini's native Google Maps grounding gives access to 250M+ places and the live road network — waypoints are grounded in real map data rather than training-data memory
- Claude produces significantly better natural language output for route descriptions and rider-focused narrative
- ORS handles the geometry work it was already doing well
- Frontend (`App.jsx`) is completely unchanged — same JSON contract in/out

### Flow
```
User input (start → destination)
     ↓
[Gemini + Maps grounding] → scenic road corridors, named waypoints
     ↓
[ORS] → snaps waypoints to road geometry → GeoJSON
     ↓
[Claude] → titles, descriptions, difficulty, tags
     ↓
[Supabase] → upsert → Leaflet renders
```

### Files Changed
- `supabase/functions/generate-route/index.ts` — split into Gemini + Claude pipeline
- `.env.example` — added `GEMINI_API_KEY` with setup instructions

### Required Secrets (set via Supabase CLI)
```bash
supabase secrets set ANTHROPIC_API_KEY=...   # Claude narrative layer
supabase secrets set GEMINI_API_KEY=...      # Gemini + Maps grounding
supabase secrets set ORS_API_KEY=...         # Road geometry (unchanged)
```

> ⚠️ **Note:** Rotate the Gemini API key — the test key was shared in plain text.
> Go to https://aistudio.google.com/app/apikey to revoke and regenerate.

### References
- [Gemini Maps Grounding docs](https://ai.google.dev/gemini-api/docs/maps-grounding)
- [Gemini API tooling updates – April 2026](https://blog.google/innovation-and-ai/technology/developers-tools/gemini-api-tooling-updates/)
