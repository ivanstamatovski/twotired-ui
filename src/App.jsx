import { useState, useEffect, useRef, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './App.css';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const EDGE_URL = `${SUPABASE_URL}/functions/v1/generate-route`;
const RECENT_KEY = 'twistyroute_recent';
const LAST_ROUTE_KEY = 'twistyroute_last';
// Per-mate sharing sessions persist across app restarts. Each entry expires
// after SHARING_TTL_MS unless the user re-toggles Share to refresh it.
const SHARING_KEY = 'twotired_sharing_sessions';
const SHARING_TTL_MS = 12 * 60 * 60 * 1000;   // 12 hours

function loadSharingSessions() {
  try {
    const raw = JSON.parse(localStorage.getItem(SHARING_KEY) || '{}');
    const now = Date.now();
    const valid = {};
    for (const [id, entry] of Object.entries(raw)) {
      if (entry?.expiresAt && entry.expiresAt > now) valid[id] = entry;
    }
    // Prune stale entries so storage doesn't accumulate forever.
    if (Object.keys(raw).length !== Object.keys(valid).length) {
      try { localStorage.setItem(SHARING_KEY, JSON.stringify(valid)); } catch {}
    }
    return valid;
  } catch { return {}; }
}
function saveSharingSessions(sessions) {
  try { localStorage.setItem(SHARING_KEY, JSON.stringify(sessions)); } catch {}
}
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const DEFAULT_CENTER = [-74.3, 41.4];
const DEFAULT_ZOOM = 9;

// Google API key used client-side ONLY for Place Photos media fetches. The
// existing VITE_GOOGLE_MAPS_EMBED_KEY env var is reused — restrict it in
// Google Cloud Console to (Maps Embed API + Places API) and HTTP referrers
// for twotired.net and capacitor://localhost.
const PLACES_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_EMBED_KEY || '';
function placePhotoUrl(photoName, maxPx = 600) {
  if (!photoName || !PLACES_API_KEY) return null;
  return `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=${maxPx}&maxWidthPx=${maxPx}&key=${PLACES_API_KEY}`;
}

// Convert Places API price level enum to a clean $-string. Free, no API
// involvement — pure rendering of the value already returned by the Pro-tier
// findPOI call.
function formatPriceLevel(level) {
  switch (level) {
    case 'PRICE_LEVEL_FREE':           return 'Free';
    case 'PRICE_LEVEL_INEXPENSIVE':    return '$';
    case 'PRICE_LEVEL_MODERATE':       return '$$';
    case 'PRICE_LEVEL_EXPENSIVE':      return '$$$';
    case 'PRICE_LEVEL_VERY_EXPENSIVE': return '$$$$';
    default: return null;
  }
}

function PlaceModal({ place, onClose }) {
  const [hoursOpen, setHoursOpen] = useState(false);
  // null = no photo expanded; number = the index of the photo shown full-screen
  const [expandedIdx, setExpandedIdx] = useState(null);
  const photos = place.photos || [];

  // Keyboard navigation when a photo is expanded: ←/→ to navigate, Esc closes
  // the photo (not the whole modal).
  useEffect(() => {
    if (expandedIdx === null) return;
    const onKey = (e) => {
      if (e.key === 'Escape')       { e.stopPropagation(); setExpandedIdx(null); }
      else if (e.key === 'ArrowRight') setExpandedIdx(i => (i + 1) % photos.length);
      else if (e.key === 'ArrowLeft')  setExpandedIdx(i => (i - 1 + photos.length) % photos.length);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [expandedIdx, photos.length]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Today's hours line — pick the right weekdayDescriptions entry. Google's
  // array is Monday-indexed; JS Date.getDay() returns Sunday=0, so we shift.
  const todaysHours = (() => {
    if (!place.hours || !place.hours.length) return null;
    const jsDay = new Date().getDay();           // 0=Sun, 1=Mon, …
    const idx = (jsDay + 6) % 7;                  // 0=Mon, …, 6=Sun
    return place.hours[idx] || null;
  })();

  const priceStr = formatPriceLevel(place.priceLevel);
  // Phone link for tel: scheme. Strip everything but +digits.
  const telHref = place.phone ? `tel:${place.phone.replace(/[^+\d]/g, '')}` : null;
  const gmapsUrl = place.googleMapsUri || place.fallbackGmapsUrl;

  return (
    <div className="place-modal-overlay" onClick={onClose}>
      <div className="place-modal" onClick={e => e.stopPropagation()}>
        <div className="place-modal-header">
          <div>
            <div className="place-modal-title">{place.name}</div>
            {place.primaryType && (
              <div className="place-modal-subtitle">{place.primaryType}</div>
            )}
          </div>
          <button className="place-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="place-modal-body place-modal-body--scroll">
          {/* Photo carousel — horizontal scroll with snap. Tap any photo to
              expand it into a lightbox with prev/next navigation. */}
          {photos.length > 0 && PLACES_API_KEY && (
            <div className="place-photo-carousel">
              {photos.map((photoName, i) => (
                <button key={i}
                  type="button"
                  className="place-photo-btn"
                  onClick={() => setExpandedIdx(i)}
                  aria-label={`Open photo ${i + 1} of ${photos.length}`}
                >
                  <img
                    className="place-photo"
                    src={placePhotoUrl(photoName, 600)}
                    alt={`${place.name} ${i + 1}`}
                    loading="lazy"
                    onError={e => { e.currentTarget.parentElement.style.display = 'none'; }}
                  />
                </button>
              ))}
            </div>
          )}

          {/* Rating + price + open-now bar */}
          {(place.rating || priceStr || place.openNow != null) && (
            <div className="place-meta-row">
              {place.rating != null && (
                <span className="place-meta-rating">
                  ⭐ {place.rating.toFixed(1)}
                  {place.ratingCount ? <span className="place-meta-count"> ({place.ratingCount.toLocaleString()})</span> : null}
                </span>
              )}
              {priceStr && <span className="place-meta-price">{priceStr}</span>}
              {place.openNow != null && (
                <span className={`place-meta-open ${place.openNow ? 'open' : 'closed'}`}>
                  {place.openNow ? 'Open now' : 'Closed'}
                </span>
              )}
            </div>
          )}

          {/* Address */}
          {place.address && (
            <div className="place-section">
              <div className="place-section-label">Address</div>
              <div className="place-section-value">{place.address}</div>
            </div>
          )}

          {/* Phone */}
          {place.phone && (
            <div className="place-section">
              <div className="place-section-label">Phone</div>
              <a className="place-section-value place-link" href={telHref}>{place.phone}</a>
            </div>
          )}

          {/* Hours — today's line by default, tap to expand the week */}
          {todaysHours && (
            <div className="place-section">
              <div className="place-section-label">Hours</div>
              <button className="place-hours-toggle" onClick={() => setHoursOpen(o => !o)}>
                <span>{todaysHours}</span>
                {place.hours?.length > 1 && <span className="place-hours-chev">{hoursOpen ? '▾' : '▸'}</span>}
              </button>
              {hoursOpen && place.hours.length > 1 && (
                <ul className="place-hours-week">
                  {place.hours.map((line, i) => <li key={i}>{line}</li>)}
                </ul>
              )}
            </div>
          )}

          {/* Website */}
          {place.website && (
            <div className="place-section">
              <div className="place-section-label">Website</div>
              <a className="place-section-value place-link"
                 href={place.website}
                 target="_blank" rel="noreferrer">
                {place.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}
              </a>
            </div>
          )}
        </div>
        <div className="place-modal-footer">
          <a className="stop-card-link stop-card-link--primary"
             href={gmapsUrl}
             target="_blank" rel="noreferrer">
            Open in Google Maps ↗
          </a>
        </div>
      </div>

      {/* Lightbox overlay — fullscreen single photo with prev/next + close.
          Renders OVER the modal so the rider can swipe through stop photos
          full-bleed. Tap-anywhere-outside-photo closes; ←/→ navigate. */}
      {expandedIdx !== null && (
        <div className="place-lightbox" onClick={() => setExpandedIdx(null)}>
          <img
            className="place-lightbox-img"
            src={placePhotoUrl(photos[expandedIdx], 1600)}
            alt={`${place.name} ${expandedIdx + 1}`}
            onClick={e => e.stopPropagation()}
          />
          <button
            className="place-lightbox-close"
            onClick={(e) => { e.stopPropagation(); setExpandedIdx(null); }}
            aria-label="Close photo">✕</button>
          {photos.length > 1 && (
            <>
              <button
                className="place-lightbox-nav place-lightbox-nav--prev"
                onClick={(e) => { e.stopPropagation(); setExpandedIdx((expandedIdx - 1 + photos.length) % photos.length); }}
                aria-label="Previous photo">‹</button>
              <button
                className="place-lightbox-nav place-lightbox-nav--next"
                onClick={(e) => { e.stopPropagation(); setExpandedIdx((expandedIdx + 1) % photos.length); }}
                aria-label="Next photo">›</button>
              <div className="place-lightbox-counter" onClick={e => e.stopPropagation()}>
                {expandedIdx + 1} / {photos.length}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Bounding box of states the GraphHopper instance on Molly has road data for:
// NY, NJ, CT, MA, PA. Slightly generous on the edges so border riders don't
// get cut off by GPS noise. Riders outside this box get a "not supported in
// your area yet" message instead of a failed route request.
const SERVICE_AREA_BBOX = { south: 38.8, north: 45.1, west: -80.6, east: -69.8 };
function isInServiceArea(lat, lng) {
  return lat >= SERVICE_AREA_BBOX.south && lat <= SERVICE_AREA_BBOX.north
      && lng >= SERVICE_AREA_BBOX.west  && lng <= SERVICE_AREA_BBOX.east;
}
const OUT_OF_AREA_MSG = 'TwoTired currently supports rides in NY, NJ, CT, MA, and PA. More regions coming soon.';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const APPROVAL_WORDS = ['looks good','perfect','great','love it','approve',
  "let's go",'nice','send it','go for it','awesome','nailed it','lets go','do it'];

const REFINE_CHIPS = ['More twisty','Less highway','Add a coffee stop','Different road','Make it shorter'];

// ── Helpers ───────────────────────────────────────────────────────────────────
function isApproval(t) {
  return APPROVAL_WORDS.some(w => t.toLowerCase().trim().includes(w));
}

function buildNavUrl(waypoints) {
  if (!waypoints || waypoints.length < 2) return null;
  const o = `${waypoints[0].lat},${waypoints[0].lng}`;
  const d = `${waypoints[waypoints.length-1].lat},${waypoints[waypoints.length-1].lng}`;
  const wps = waypoints.slice(1,-1).map(w=>`${w.lat},${w.lng}`).join('|');
  return `https://www.google.com/maps/dir/?api=1&origin=${o}&destination=${d}${wps?`&waypoints=${wps}`:''}&travelmode=driving`;
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6_371_000;
  const toR = (d) => d * Math.PI / 180;
  const dLat = toR(lat2 - lat1), dLng = toR(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distSq(lat1, lng1, lat2, lng2) {
  const dlat = lat1 - lat2;
  const dlng = (lng1 - lng2) * Math.cos(lat1 * Math.PI / 180);
  return dlat*dlat + dlng*dlng;
}

function formatDist(m) {
  if (m === null || m === undefined) return '';
  const ft = m * 3.28084;
  // Under ~1000 ft (≈ 300 m) report in feet, rounded to the nearest 50 ft so
  // the banner reads cleanly (e.g. "350 ft" not "347 ft"). 1000 ft and above
  // switch to miles with one decimal — same scheme Google Maps uses in the US.
  if (ft < 1000) return `${Math.max(50, Math.round(ft / 50) * 50)} ft`;
  return `${(m / 1609.34).toFixed(1)} mi`;
}

function formatMilesShort(m) {
  const mi = m / 1609.34;
  return mi >= 10 ? `${Math.round(mi)} mi` : `${mi.toFixed(1)} mi`;
}

function formatRemainingTime(ms) {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return `${h}h ${m}min`;
}

function formatETA(ms) {
  const eta = new Date(Date.now() + ms);
  return eta.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Deterministic avatar: initials + colour derived from the display name so
// the same rider always gets the same chip across sessions.
function avatarColorForName(name) {
  let h = 0;
  for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const palette = ['#f97316','#0ea5e9','#10b981','#a855f7','#ef4444','#eab308','#06b6d4','#ec4899','#6366f1'];
  return palette[h % palette.length];
}

function initialsForName(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function Avatar({ name, size = 32 }) {
  return (
    <span className="avatar"
      style={{
        width: size, height: size,
        background: avatarColorForName(name),
        fontSize: Math.round(size * 0.42),
      }}>
      {initialsForName(name)}
    </span>
  );
}

// ── Dev convenience: simulator GPS override ──────────────────────────────
// iOS Simulator has no real GPS; it falls back to a hard-coded Apple/SF
// location. For specific developer accounts, when the first GPS fix looks
// like one of those defaults, we re-anchor to a real-world spot near where
// Ivan actually tests. Never triggers on real-device coordinates because
// the bounding boxes are 0.1° wide around known simulator defaults.
const SIM_OVERRIDE_ACCOUNTS = {
  'ivan@easyaerial.com': { lat: 40.762340, lng: -73.918442, label: 'Balancero Cafe, Astoria' },
};
const SIM_DEFAULT_LOCATIONS = [
  { lat: 37.3349, lng: -122.0090 }, // Apple HQ (Cupertino) — default static sim location
  { lat: 37.7838, lng: -122.4090 }, // City Bicycle Ride (San Francisco)
  { lat: 37.7749, lng: -122.4194 }, // Generic SF
  { lat: 37.3318, lng: -122.0312 }, // Other Apple-area
];
function isSimulatorDefaultCoord(lat, lng) {
  return SIM_DEFAULT_LOCATIONS.some(d => Math.abs(d.lat - lat) < 0.1 && Math.abs(d.lng - lng) < 0.1);
}

// Map marker for a riding mate — coloured initials chip with a white ring.
function makeMateMarkerEl(name) {
  const el = document.createElement('div');
  el.className = 'mate-marker';
  Object.assign(el.style, {
    width: '42px', height: '42px',
    background: avatarColorForName(name),
    border: '3px solid #fff',
    borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: '#fff', fontWeight: '700', fontSize: '14px',
    boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
    userSelect: 'none',
  });
  el.textContent = initialsForName(name);
  return el;
}

// "1.2 mi NE" or "650 ft SW" — compact compass + distance for the mate badge.
function formatMateDistance(matePos, userPos) {
  if (!userPos) return 'sharing';
  const distM = haversineM(userPos.lat, userPos.lng, matePos.lat, matePos.lng);
  const mi = distM / 1609.34;
  const distStr = mi < 0.1
    ? `${Math.max(50, Math.round((distM * 3.28084) / 50) * 50)} ft`
    : `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
  const b = bearingBetween(userPos.lat, userPos.lng, matePos.lat, matePos.lng);
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return `${distStr} ${dirs[Math.round(b / 45) % 8]}`;
}

function turnArrow(sign, text) {
  // GraphHopper Instruction sign codes. Negative = left, positive = right.
  // Added missing values (7=keep right, -7=keep left, 8/-8=U-turn) that
  // previously fell through to the default arrow and showed as straight-ahead
  // when the actual turn was left/right.
  const map = {
    '-98': '⤴',   // U-turn unknown direction
    '-8':  '⤴',   // U-turn left
    '-7':  '↖',   // Keep left
    '-6':  '↺',   // Leave roundabout
    '-3':  '↰',   // Sharp left
    '-2':  '←',   // Turn left
    '-1':  '↖',   // Slight left
    '0':   '↑',   // Continue
    '1':   '↗',   // Slight right
    '2':   '→',   // Turn right
    '3':   '↱',   // Sharp right
    '4':   '🏁',  // Finish
    '5':   '⤴',   // Reached via point
    '6':   '⟳',   // Use roundabout
    '7':   '↗',   // Keep right
    '8':   '⤴',   // U-turn right
  };
  if (map[String(sign)]) return map[String(sign)];

  // Fallback for unknown signs: parse direction out of the instruction text
  // so we never show a left arrow on a right turn (or vice-versa) just
  // because GH emitted a sign we didn't recognise.
  if (typeof text === 'string') {
    if (/\bright\b/i.test(text))  return '→';
    if (/\bleft\b/i.test(text))   return '←';
    if (/u-?turn/i.test(text))    return '⤴';
    if (/roundabout/i.test(text)) return '⟳';
  }
  return '↑';
}

// Find the index along route.geometry.coordinates closest to (lat,lng).
function nearestRouteIdx(coords, lat, lng) {
  let nearIdx = 0, bestSq = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const sq = distSq(lat, lng, coords[i][1], coords[i][0]);
    if (sq < bestSq) { bestSq = sq; nearIdx = i; }
  }
  return nearIdx;
}

// Pull two pieces out of a GraphHopper instruction so the nav banner can
// surface them on separate lines:
//   exit   — the exit identifier ("Exit 17B") when the upcoming maneuver is
//            a highway exit; null for regular street turns. Short by design
//            so it fits on the top row next to the arrow + distance.
//   street — the larger, more readable name of the road the rider is being
//            led ONTO (the highway they're exiting onto, or the street the
//            turn drops them on). Goes on the second, larger row.
//
// The exit pattern matches "exit 17", "Exit 17B", "Take exit 220A onto I-95
// N toward Foo Bar", etc. `toward …` tail is trimmed because it's noisy.
function shortDestinationLabel(instruction) {
  if (!instruction) return { exit: null, street: '' };
  const text = String(instruction.text || '');
  const streetName = String(instruction.street_name || '').trim();

  const ontoMatch = text.match(/onto\s+(.+?)(?:\s*toward.*)?$/i);
  const parsedOnto = ontoMatch ? ontoMatch[1].trim() : '';

  // Highway exit
  const exitMatch = text.match(/exit\s+([\w-]+)/i);
  if (exitMatch) {
    return {
      exit: `Exit ${exitMatch[1]}`,
      street: streetName || parsedOnto,
    };
  }

  // Regular turn / continue
  if (streetName) return { exit: null, street: streetName };
  if (parsedOnto)  return { exit: null, street: parsedOnto };

  // No street info at all — fall back to the verb (e.g., "Continue",
  // "Keep right", "Arrive at destination").
  return { exit: null, street: text.replace(/^(Take exit|onto.*)/i, '').trim() || text };
}

// Great-circle distance from a point to a line segment, returned in metres.
// Equirectangular projection at the local latitude — accurate enough for the
// short segments in a turn-by-turn polyline (<200m typical).
function distanceToSegmentM(lat, lng, lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const cosLat = Math.cos(((lat + lat1 + lat2) / 3) * rad);
  const x  = (lng  - lng1) * cosLat * R * rad;
  const y  = (lat  - lat1)           * R * rad;
  const dx = (lng2 - lng1) * cosLat * R * rad;
  const dy = (lat2 - lat1)           * R * rad;
  const segLenSq = dx * dx + dy * dy;
  if (segLenSq < 1e-6) return Math.hypot(x, y);
  let t = (x * dx + y * dy) / segLenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(x - t * dx, y - t * dy);
}

// Minimum distance from a point to any segment of the route polyline, in metres.
// Used for off-route detection: if this exceeds the threshold for a sustained
// time, the rider has probably missed a turn and we trigger a reroute.
function distanceToRouteM(lat, lng, route) {
  const coords = route?.geometry?.coordinates;
  if (!coords || coords.length < 2) return Infinity;
  let best = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const [lng1, lat1] = coords[i];
    const [lng2, lat2] = coords[i + 1];
    const d = distanceToSegmentM(lat, lng, lat1, lng1, lat2, lng2);
    if (d < best) best = d;
  }
  return best;
}

// Map-matching: project a raw GPS fix onto the route polyline.
// Returns the closest point on the route polyline AND the segment that
// owns that closest point AND the bearing of that segment AND the
// perpendicular distance from the raw GPS to the snapped point. Used to
// stabilise the marker position, the map bearing, and the "off-route"
// distance during navigation — the standard pattern in production nav apps
// (Google, Apple). Raw GPS jitters bounce the rider's position between
// adjacent polyline vertices and wreck everything downstream; the snapped
// position moves smoothly along the road.
//
// Returns null when the route is empty / too short to project onto.
function projectOntoRoute(lat, lng, route) {
  const coords = route?.geometry?.coordinates;
  if (!coords || coords.length < 2) return null;

  const R = 6371000;
  const rad = Math.PI / 180;

  let bestDist  = Infinity;
  let bestIdx   = 0;
  let bestT     = 0;
  let bestLat   = lat;
  let bestLng   = lng;

  for (let i = 0; i < coords.length - 1; i++) {
    const [lng1, lat1] = coords[i];
    const [lng2, lat2] = coords[i + 1];
    const cosLat = Math.cos(((lat + lat1 + lat2) / 3) * rad);
    const x  = (lng  - lng1) * cosLat * R * rad;
    const y  = (lat  - lat1)           * R * rad;
    const dx = (lng2 - lng1) * cosLat * R * rad;
    const dy = (lat2 - lat1)           * R * rad;
    const segLenSq = dx * dx + dy * dy;

    let t = 0;
    let d;
    if (segLenSq < 1e-6) {
      d = Math.hypot(x, y);
    } else {
      t = (x * dx + y * dy) / segLenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      d = Math.hypot(x - t * dx, y - t * dy);
    }

    if (d < bestDist) {
      bestDist = d;
      bestIdx  = i;
      bestT    = t;
      bestLat  = lat1 + (lat2 - lat1) * t;
      bestLng  = lng1 + (lng2 - lng1) * t;
    }
  }

  // Tangent of the segment under the rider's projection. This IS the direction
  // of the road they're on (or, if off-route, the closest road in the polyline).
  // Used as the bearing target — the map rotates so this segment points up.
  const [slng, slat] = coords[bestIdx];
  const [elng, elat] = coords[bestIdx + 1];
  const segmentBearing = bearingBetween(slat, slng, elat, elng);

  return {
    snappedLat:     bestLat,
    snappedLng:     bestLng,
    segmentIdx:     bestIdx,
    segmentT:       bestT,
    segmentBearing,
    distFromRoute:  bestDist,
  };
}

// Build the geometry of the route from a given point onward — used during
// navigation so the blue polyline only shows the road AHEAD of the rider.
// The completed portion behind them gets dropped; they don't need to see
// where they've already been. Returns a LineString geometry that starts at
// the snapped point on segment[segmentIdx] and continues to the destination.
function sliceRouteAhead(route, segmentIdx, snappedLat, snappedLng) {
  const coords = route?.geometry?.coordinates;
  if (!coords || segmentIdx < 0 || segmentIdx >= coords.length - 1) {
    return route?.geometry || null;
  }
  const ahead = [[snappedLng, snappedLat]];
  for (let i = segmentIdx + 1; i < coords.length; i++) {
    ahead.push(coords[i]);
  }
  return { type: 'LineString', coordinates: ahead };
}

// Bearing of the route AT the user's nearest point, sampled ~30m ahead so the
// map orients to the upcoming road segment rather than wobbling on tight
// vertices. Used when GPS heading is unreliable (stopped, walking, indoors).
function routeBearingAt(route, lat, lng) {
  const coords = route?.geometry?.coordinates;
  if (!coords || coords.length < 2) return null;
  const nearIdx = nearestRouteIdx(coords, lat, lng);
  let aheadIdx = nearIdx;
  for (let i = nearIdx + 1; i < coords.length; i++) {
    if (haversineM(coords[nearIdx][1], coords[nearIdx][0], coords[i][1], coords[i][0]) >= 30) {
      aheadIdx = i; break;
    }
  }
  if (aheadIdx === nearIdx) aheadIdx = Math.min(nearIdx + 1, coords.length - 1);
  if (aheadIdx === nearIdx) return null;
  return bearingBetween(
    coords[nearIdx][1],  coords[nearIdx][0],
    coords[aheadIdx][1], coords[aheadIdx][0]
  );
}

// Remaining time + distance from (lat,lng) to the end of the route.
//   distM:   sum of haversine segment lengths from user → next vertex → end
//   timeMs:  sum of GraphHopper instruction times whose interval lies ahead,
//            with the in-progress instruction prorated by how far along it the user is,
//            then scaled by the route's calibration ratio so nav ETA matches the
//            pre-nav calibrated drive time (instruction times are GH-raw — uncalibrated)
function routeProgress(route, lat, lng) {
  const coords = route?.geometry?.coordinates;
  const instructions = route?.instructions;
  if (!coords || coords.length < 2 || !instructions?.length) return null;

  const nearIdx = nearestRouteIdx(coords, lat, lng);

  let distM = haversineM(lat, lng, coords[nearIdx][1], coords[nearIdx][0]);
  for (let i = nearIdx; i < coords.length - 1; i++) {
    distM += haversineM(coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0]);
  }

  let timeMs = 0;
  for (const inst of instructions) {
    const [start, end] = inst.interval || [0, 0];
    if (end < nearIdx) continue;                           // already passed
    if (start <= nearIdx && end >= nearIdx) {              // currently traversing
      const total = Math.max(1, end - start);
      const passed = Math.max(0, nearIdx - start);
      const remaining = (total - passed) / total;
      timeMs += (inst.time || 0) * Math.max(0, Math.min(1, remaining));
    } else {
      timeMs += inst.time || 0;
    }
  }

  // Scale up to match the calibrated drive time. Instruction times are GH-raw —
  // without this, nav ETA shows the un-calibrated (optimistic) total even
  // though the pre-nav display already used the calibrated value.
  const driveMin = route?.drive_minutes ?? route?.time_minutes;
  const rawMin = route?.raw_time_minutes;
  if (driveMin && rawMin && rawMin > 0) {
    timeMs *= driveMin / rawMin;
  }

  return { distM, timeMs };
}

function findNextTurn(route, lat, lng) {
  const coords = route.geometry?.coordinates;
  const instructions = route.instructions;
  if (!coords?.length || !instructions?.length) return null;
  const nearIdx = nearestRouteIdx(coords, lat, lng);
  for (let i = 0; i < instructions.length; i++) {
    const [start, end] = instructions[i].interval;
    if (nearIdx >= start && nearIdx <= end) {
      // ── Pick the announcement target ─────────────────────────────────
      // TEXT: look ahead to instructions[i+1] (the maneuver about to happen
      // at the boundary). instructions[i] is what the rider already DID to
      // get on this segment — announcing it is late.
      //
      // Skip past Continue-only instructions (sign=0). GraphHopper emits these
      // for mid-route name changes ("Continue onto Main Avenue" while you're
      // already on Main Street, same physical road). They're not maneuvers,
      // they're noise, and they confuse the rider with a phantom callout
      // right before the real turn. Keep walking until we find a real sign
      // or hit the end of the route.
      let targetIdx = i + 1;
      while (targetIdx < instructions.length - 1 && instructions[targetIdx].sign === 0) {
        targetIdx++;
      }
      if (targetIdx >= instructions.length) targetIdx = instructions.length - 1;
      const target = instructions[targetIdx];

      // DIST: distance to the maneuver point of `target`. The maneuver happens
      // at the START of `target.interval` (= end of the previous interval).
      // This is the actual point on the polyline where the rider needs to act,
      // whether `target` is i+1 or further along (after skipping Continues).
      const turnVertex = Math.min(target.interval[0], coords.length - 1);
      const turnCoord = coords[turnVertex];
      const dist = haversineM(lat, lng, turnCoord[1], turnCoord[0]);
      return {
        instruction: target,
        dist,
        turnLat: turnCoord[1],
        turnLng: turnCoord[0],
      };
    }
  }
  return null;
}

// Find the polyline vertex closest to the rider where the route makes a
// significant bend (heading change > minHeadingChangeDeg).
function findNearestPolylineCorner(coords, riderLat, riderLng, minHeadingChangeDeg = 25) {
  if (!coords || coords.length < 3) return null;
  let bestDist = Infinity;
  let bestCorner = null;
  let prevBearing = null;
  for (let i = 0; i < coords.length - 1; i++) {
    const [aLng, aLat] = coords[i];
    const [bLng, bLat] = coords[i + 1];
    const segBearing = bearingBetween(aLat, aLng, bLat, bLng);
    if (prevBearing != null) {
      let diff = Math.abs(segBearing - prevBearing);
      if (diff > 180) diff = 360 - diff;
      if (diff > minHeadingChangeDeg) {
        const d = haversineM(riderLat, riderLng, aLat, aLng);
        if (d < bestDist) {
          bestDist = d;
          bestCorner = { lat: aLat, lng: aLng, idx: i, distM: d };
        }
      }
    }
    prevBearing = segBearing;
  }
  return bestCorner;
}

// Walk the polyline forward from fromSegmentIdx and return the first vertex
// where the heading changes by more than minHeadingChangeDeg — the NEXT
// corner ahead of the rider in route order. This is the correct heuristic
// when the rider is actually on the route.
function findNextPolylineCornerAhead(coords, fromSegmentIdx, minHeadingChangeDeg = 25) {
  if (!coords || coords.length < 3) return null;
  if (fromSegmentIdx >= coords.length - 1) return null;
  const [s1lng, s1lat] = coords[fromSegmentIdx];
  const [s2lng, s2lat] = coords[fromSegmentIdx + 1];
  let prevBearing = bearingBetween(s1lat, s1lng, s2lat, s2lng);
  for (let i = fromSegmentIdx + 1; i < coords.length - 1; i++) {
    const [aLng, aLat] = coords[i];
    const [bLng, bLat] = coords[i + 1];
    const segBearing = bearingBetween(aLat, aLng, bLat, bLng);
    let diff = Math.abs(segBearing - prevBearing);
    if (diff > 180) diff = 360 - diff;
    if (diff > minHeadingChangeDeg) {
      return { lat: aLat, lng: aLng, idx: i };
    }
    prevBearing = segBearing;
  }
  return null;
}

// Motorcycle front-view SVG for user location marker
// Initial-bearing helper — degrees from north (0–360) along great-circle path.
function bearingBetween(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const dλ = toRad(lng2 - lng1);
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Pick the highest-quality available SpeechSynthesis voice. iOS exposes premium /
// enhanced / neural variants when the user has downloaded them via Accessibility.
let _pickedVoice = null;
function pickBestVoice() {
  if (_pickedVoice) return _pickedVoice;
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  if (!synth) return null;
  const all = synth.getVoices();
  if (!all.length) return null;
  const en = all.filter(v => /^en/i.test(v.lang));
  const pool = en.length ? en : all;
  const score = v => {
    const n = v.name || '';
    let s = 0;
    if (/premium/i.test(n))  s += 12;
    if (/enhanced/i.test(n)) s += 8;
    if (/neural/i.test(n))   s += 8;
    if (/siri/i.test(n))     s += 6;
    const bare = n.replace(/\s*\(.*\)/, '').trim();
    if (/^(samantha|ava|allison|joelle|nicky|karen|moira|evan|aaron)$/i.test(bare)) s += 2;
    if (/^en-US/i.test(v.lang)) s += 1;
    if (v.localService) s += 1;
    return s;
  };
  pool.sort((a, b) => score(b) - score(a));
  _pickedVoice = pool[0];
  return _pickedVoice;
}

function makeMotoMarkerEl() {
  const el = document.createElement('div');
  el.className = 'user-moto-marker';
  el.innerHTML = `<svg width="44" height="44" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">
    <!-- Pulse ring -->
    <circle cx="22" cy="22" r="20" fill="rgba(249,115,22,0.12)" stroke="rgba(249,115,22,0.35)" stroke-width="1.5"/>
    <!-- Handlebars -->
    <line x1="4" y1="18" x2="16" y2="18" stroke="#1f2937" stroke-width="3" stroke-linecap="round"/>
    <line x1="28" y1="18" x2="40" y2="18" stroke="#1f2937" stroke-width="3" stroke-linecap="round"/>
    <!-- Grips -->
    <rect x="3" y="15.5" width="5" height="5" rx="2.5" fill="#374151"/>
    <rect x="36" y="15.5" width="5" height="5" rx="2.5" fill="#374151"/>
    <!-- Handlebar risers -->
    <line x1="16" y1="18" x2="16" y2="21" stroke="#1f2937" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="28" y1="18" x2="28" y2="21" stroke="#1f2937" stroke-width="2.5" stroke-linecap="round"/>
    <!-- Fairing body -->
    <path d="M15 21 Q15 13 22 12 Q29 13 29 21 L28 26 Q22 28 16 26 Z" fill="#f97316"/>
    <!-- Headlight -->
    <ellipse cx="22" cy="17" rx="4.5" ry="3.5" fill="#fef9c3" opacity="0.95"/>
    <ellipse cx="22" cy="17" rx="2.5" ry="2" fill="#fef08a"/>
    <!-- Front forks -->
    <line x1="17" y1="26" x2="16" y2="34" stroke="#6b7280" stroke-width="2" stroke-linecap="round"/>
    <line x1="27" y1="26" x2="28" y2="34" stroke="#6b7280" stroke-width="2" stroke-linecap="round"/>
    <!-- Front wheel -->
    <ellipse cx="22" cy="35" rx="8" ry="5" fill="#1f2937"/>
    <ellipse cx="22" cy="35" rx="4.5" ry="2.5" fill="#374151"/>
    <circle cx="22" cy="35" r="1.5" fill="#6b7280"/>
  </svg>`;
  return el;
}

// ── Get current GPS position (Promise wrapper — always resolves, never throws) ─
function getCurrentGPS({ timeout = 6000, maximumAge = 30000 } = {}) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge }
    );
  });
}

// ── Voice hook ────────────────────────────────────────────────────────────────
// Two paths:
//   • Native (Capacitor iOS): @capacitor-community/speech-recognition plugin.
//     Loaded via dynamic import + try/catch so this file still compiles before
//     the plugin is npm-installed; native path just stays disabled until then.
//   • Web: window.(webkit)SpeechRecognition with interim results + error logging.
function useVoice(onResult) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const [error, setError]         = useState(null);
  const [transcript, setTranscript] = useState('');

  const isNative = Capacitor.isNativePlatform();
  const pluginRef    = useRef(null);   // native plugin module (when loaded)
  const recogRef     = useRef(null);   // web SpeechRecognition instance
  const latestRef    = useRef('');     // last transcript heard (native)
  const firedRef     = useRef(false);  // dedupe onResult per session (native)
  const onResultRef  = useRef(onResult);
  useEffect(() => { onResultRef.current = onResult; }, [onResult]);

  useEffect(() => {
    let cancelled = false;
    const cleanups = [];

    async function setupNative() {
      try {
        const mod = await import('@capacitor-community/speech-recognition');
        const SR = mod.SpeechRecognition;
        const avail = await SR.available();
        if (cancelled) return;
        if (!avail?.available) { setSupported(false); return; }
        pluginRef.current = SR;
        setSupported(true);

        const partialL = await SR.addListener('partialResults', (data) => {
          const text = data?.matches?.[0];
          if (text) { latestRef.current = text; setTranscript(text); }
        });
        const stateL = await SR.addListener('listeningState', (data) => {
          if (data?.status === 'stopped') {
            setListening(false);
            const final = latestRef.current.trim();
            if (final && !firedRef.current) {
              firedRef.current = true;
              onResultRef.current?.(final);
            }
          }
        });
        cleanups.push(() => partialL?.remove?.(), () => stateL?.remove?.());
      } catch (e) {
        console.warn('[voice] native plugin unavailable:', e?.message || e);
        setSupported(false);
      }
    }

    function setupWeb() {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { setSupported(false); return; }
      const r = new SR();
      r.continuous = false;
      r.interimResults = true;
      r.lang = 'en-US';
      r.onstart  = () => { setError(null); };
      r.onresult = (e) => {
        let finalText = '', interimText = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          if (res.isFinal) finalText += res[0].transcript;
          else interimText += res[0].transcript;
        }
        if (finalText) {
          setTranscript(finalText);
          setListening(false);
          onResultRef.current?.(finalText.trim());
        } else if (interimText) {
          setTranscript(interimText);
        }
      };
      r.onerror = (e) => {
        const code = e?.error || 'unknown';
        console.warn('[voice] recognition error:', code, e);
        setError(code === 'not-allowed' ? 'Microphone permission denied'
              : code === 'no-speech'    ? 'Didn’t catch that — try again'
              : code === 'network'      ? 'Network error — voice needs internet'
              : `Voice error: ${code}`);
        setListening(false);
      };
      r.onend = () => setListening(false);
      recogRef.current = r;
      setSupported(true);
    }

    if (isNative) setupNative(); else setupWeb();

    return () => {
      cancelled = true;
      cleanups.forEach(fn => { try { fn(); } catch {} });
      try { recogRef.current?.abort?.(); } catch {}
      try { pluginRef.current?.stop?.(); } catch {}
    };
  }, [isNative]);

  const start = useCallback(async () => {
    setError(null);
    setTranscript('');
    latestRef.current = '';
    firedRef.current  = false;
    if (isNative) {
      const SR = pluginRef.current;
      if (!SR) { setError('Voice plugin not installed'); return; }
      try {
        const perm = await SR.requestPermissions();
        const state = perm?.speechRecognition || perm?.permission;
        if (state && state !== 'granted') {
          setError('Microphone permission denied');
          return;
        }
        await SR.start({ language: 'en-US', partialResults: true, popup: false });
        setListening(true);
      } catch (e) {
        console.warn('[voice] native start failed:', e);
        setError(e?.message || 'Could not start voice');
        setListening(false);
      }
    } else {
      try {
        recogRef.current?.start();
        setListening(true);
      } catch (e) {
        // Calling start() while already started throws InvalidStateError
        console.warn('[voice] web start failed:', e);
        setError(e?.message || 'Could not start voice');
      }
    }
  }, [isNative]);

  const stop = useCallback(async () => {
    // Update listening flag *before* awaiting the plugin so any late
    // partialResults events that arrive during the plugin's shutdown window
    // can be filtered by callers (the mirror effect in App() checks
    // voice.listening before writing transcript → query).
    setListening(false);
    setTranscript('');
    if (isNative) {
      try { await pluginRef.current?.stop(); }
      catch (e) { console.warn('[voice] native stop failed:', e); }
      // Fallback: fire onResult here in case listeningState event doesn't arrive
      const final = latestRef.current.trim();
      if (final && !firedRef.current) {
        firedRef.current = true;
        onResultRef.current?.(final);
      }
    } else {
      try { recogRef.current?.stop(); } catch {}
    }
  }, [isNative]);

  // Cancel: stop recognition WITHOUT firing onResult. For when the rider sees
  // the transcript captured something wrong and wants to start over.
  const cancel = useCallback(async () => {
    setListening(false);
    setTranscript('');
    latestRef.current = '';
    firedRef.current  = true; // suppress the post-stop onResult fallback in stop()
    if (isNative) {
      try { await pluginRef.current?.stop(); } catch {}
    } else {
      // Web SpeechRecognition: abort() discards results; stop() finalises them.
      try { recogRef.current?.abort?.(); } catch {}
    }
  }, [isNative]);

  return { listening, supported, error, transcript, start, stop, cancel };
}

// ── Mobile detect ─────────────────────────────────────────────────────────────
function useIsMobile() {
  const [mobile, setMobile] = useState(window.innerWidth <= 700);
  useEffect(() => {
    const h = () => setMobile(window.innerWidth <= 700);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  return mobile;
}

// ── App Review demo bypass ────────────────────────────────────────────────────
// The app uses email-OTP auth which can't be tested by Apple's reviewers (they
// have no way to receive our OTP emails). For the single review-account email
// below, we skip the OTP send entirely and accept a fixed magic "code" that
// signs the user in with a known password we control. The real Supabase user
// for this email must exist; password is created from the Supabase dashboard.
//
// What we hand to Apple in the "Sign-In Information" field on App Store Connect:
//   User Name: apple-review@twotired.net
//   Password:  999999
//
// The "password" Apple sees is actually our magic OTP code; the real Supabase
// password is internal to the client. This means anyone reading the JS bundle
// can also sign in as this account, but the account is just a regular user
// with no special privileges, so the worst they can do is browse around as
// that user. Acceptable for a review bypass.
const REVIEW_EMAIL = 'apple-review@twotired.net';
const REVIEW_CODE  = '999999';
const REVIEW_PASSWORD = 'rev-bypass-7K4ZpqV2nmW9aY3B';   // matches the password set in Supabase dashboard

// ── Login screen ──────────────────────────────────────────────────────────────
function LoginScreen() {
  const [email, setEmail]   = useState('');
  const [code, setCode]     = useState('');
  const [step, setStep]     = useState('email'); // 'email' | 'code'
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState(null);

  async function sendOtp() {
    if (!email.includes('@')) return;
    setLoading(true); setError(null);
    // Review bypass: skip the actual OTP send for the review account.
    if (email.trim().toLowerCase() === REVIEW_EMAIL) {
      setStep('code'); setLoading(false); return;
    }
    const { error: err } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    if (err) { setError(err.message); setLoading(false); return; }
    setStep('code'); setLoading(false);
  }

  async function verifyOtp() {
    const token = code.trim();
    if (token.length !== 6) return;
    setLoading(true); setError(null);
    // Review bypass: if the magic code is entered for the review email, log in
    // via the pre-known Supabase password instead of validating an OTP token.
    if (email.trim().toLowerCase() === REVIEW_EMAIL && token === REVIEW_CODE) {
      const { error: err } = await supabase.auth.signInWithPassword({
        email: REVIEW_EMAIL, password: REVIEW_PASSWORD,
      });
      if (err) { setError(err.message); setLoading(false); return; }
      setLoading(false);
      return;
    }
    const { error: err } = await supabase.auth.verifyOtp({
      email, token, type: 'email',
    });
    if (err) { setError(err.message); setLoading(false); return; }
    // Session is set automatically — auth state listener in App will pick it up
    setLoading(false);
  }

  if (step === 'code') return (
    <div className="login-shell">
      <div className="login-card">
        <div className="login-logo">🏍</div>
        <h2 className="login-title">Enter your code</h2>
        <p className="login-sub">We sent a 6-digit code to <strong>{email}</strong>.</p>
        <input className="login-input login-input--code"
          type="number" inputMode="numeric" placeholder="000000"
          value={code} onChange={e => setCode(e.target.value.slice(0, 6))}
          onKeyDown={e => e.key === 'Enter' && verifyOtp()} autoFocus/>
        {error && <p className="login-error">{error}</p>}
        <button className="login-btn" onClick={verifyOtp}
          disabled={loading || code.trim().length !== 6}>
          {loading ? 'Verifying…' : 'Sign in →'}
        </button>
        <button className="login-btn-secondary" onClick={() => { setStep('email'); setCode(''); setError(null); }}>
          Use a different email
        </button>
      </div>
    </div>
  );

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="login-logo">🏍</div>
        <h1 className="login-brand">TwoTired</h1>
        <p className="login-tagline">Your AI motorcycle ride planner</p>
        <input className="login-input" type="email" placeholder="Enter your email"
          value={email} onChange={e => setEmail(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && sendOtp()} autoFocus/>
        {error && <p className="login-error">{error}</p>}
        <button className="login-btn" onClick={sendOtp}
          disabled={loading || !email.includes('@')}>
          {loading ? 'Sending…' : 'Continue →'}
        </button>
        <p className="login-hint">No password needed — we'll send you a code.</p>
      </div>
    </div>
  );
}

// ── ConversationThread ────────────────────────────────────────────────────────
function ConversationThread({ messages, loading, loadingMsg, messagesEndRef, currentRoute, onSelectRoute }) {
  return (
    <div className="messages-scroll">
      {messages.map((msg, i) => {
        if (msg.role === 'user')
          return <div key={i} className="bubble bubble-user">{msg.content}</div>;

        if (msg.role === 'clarify')
          return (
            <div key={i} className="bubble bubble-clarify">
              <p className="clarify-q">{msg.question}</p>
              {msg.options.map(o => (
                <button key={o} className="clarify-opt" onClick={() => msg.onSelect(o)}>{o}</button>
              ))}
            </div>
          );

        if (msg.role === 'route') {
          const r = msg.route;
          const isActive = r === currentRoute;
          // Whole card is tappable so the rider can switch back to a previous
          // route after refining ("more curvy" / "shorter"). Active route
          // shows a check + accent border; non-active hint at "tap to use".
          return (
            <button
              key={i}
              type="button"
              className={`bubble bubble-route${isActive ? ' bubble-route--active' : ' bubble-route--tap'}`}
              onClick={() => { if (!isActive) onSelectRoute?.(r); }}
              aria-pressed={isActive}
              aria-label={isActive ? `Current route: ${r.title}` : `Switch back to: ${r.title}`}
            >
              <div className="route-title-row">
                <span className="route-title">{r.title}</span>
                {isActive ? (
                  <span className="route-badge route-badge--active">on map</span>
                ) : (
                  <span className="route-badge route-badge--tap">tap to use</span>
                )}
              </div>
              <div className="route-meta">
                <span>🕐 {r.duration_str}</span>
                <span>🛣 {r.distance_mi?.toFixed(1)} mi</span>
              </div>
              {r.stops?.map((s,si) => (
                <div key={si} className="stop-pill">
                  📍 {s.name}
                  {s.rating && <span className="stop-rating">{s.rating}★</span>}
                </div>
              ))}
              {r.waypoints && (
                <a className="nav-link" href={buildNavUrl(r.waypoints)} target="_blank" rel="noreferrer"
                   onClick={e => e.stopPropagation()}>
                  Open in Google Maps →
                </a>
              )}
            </button>
          );
        }
        return null;
      })}

      {loading && (
        <div className="bubble bubble-loading">
          <span className="dot-spin"/> {loadingMsg}
        </div>
      )}
      <div ref={messagesEndRef}/>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  // Auth
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);

  // Core
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('Planning your ride…');
  const [error, setError] = useState(null);
  const [messages, setMessages] = useState([]);
  const [outOfAreaToast, setOutOfAreaToast] = useState(false);
  const [selectedPlace, setSelectedPlace] = useState(null);   // { name, placeId, address, website, lat, lng }
  const selectedPlaceRef = useRef(null);
  useEffect(() => { selectedPlaceRef.current = setSelectedPlace; }, []);
  const prevSelectedPlaceRef = useRef(null);
  const [currentIntent, setCurrentIntent] = useState(null);
  const [followUpInput, setFollowUpInput] = useState('');
  const [routeData, setRouteData] = useState(null);
  const [routeApproved, setRouteApproved] = useState(false);
  // When the place-details modal closes, MapLibre occasionally drops the route
  // source/layers (suspect: body-overflow swap during modal mount/unmount
  // triggers a WebGL invalidation). Defensively re-draw so the rider's planned
  // route stays on the map after they close the place card. NOTE: this effect
  // must come AFTER routeData is declared above — referencing it in deps before
  // its useState line would throw "Cannot access 'routeData' before init".
  useEffect(() => {
    if (prevSelectedPlaceRef.current !== null && selectedPlace === null) {
      const map = mapRef.current;
      if (map && mapLoadedRef.current && routeData?.geometry && !map.getSource('route')) {
        try { drawRouteOnMap(routeData); }
        catch (e) { console.warn('[place-modal] route redraw failed:', e?.message || e); }
      }
    }
    prevSelectedPlaceRef.current = selectedPlace;
  }, [selectedPlace, routeData]);

  // Mobile sheet
  const [sheetMode, setSheetMode] = useState('idle');
  const [refineOpen, setRefineOpen] = useState(false);
  const [idleSheetHeight, setIdleSheetHeight] = useState(170); // grows with multi-line input and the recents drawer
  const [menuSheetHeight, setMenuSheetHeight] = useState(460); // grows with the menu content while open
  const menuContentRef = useRef(null);
  const [recentsOpen, setRecentsOpen] = useState(false);
  const idleInputRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // Navigation
  const [navMode, setNavMode] = useState(false);
  const [nextTurn, setNextTurn] = useState(null);
  const [navProgress, setNavProgress] = useState(null);   // { distM, timeMs }
  const [appVersion, setAppVersion] = useState(null);     // { version, build } for footer
  const [userLocation, setUserLocation] = useState(null);
  const [voiceMuted, setVoiceMuted] = useState(() => {
    try { return localStorage.getItem('voice_muted') === '1'; } catch { return false; }
  });
  const voiceMutedRef = useRef(false);
  const lastNavPosRef = useRef(null);   // previous lat/lng during nav, for bearing delta
  const navBearingRef = useRef(0);      // smoothed bearing currently applied to the map

  // Manual map interaction during navigation.
  //   followingUserRef = true  → onGeoPosition is free to re-centre on every GPS fix
  //   followingUserRef = false → the rider has panned/pinched, leave the map alone
  // navMapPannedReturnRef holds the auto-return timer for pinch-to-look-ahead;
  // a subsequent drag clears it so a "looking around" pan isn't snapped back.
  const followingUserRef        = useRef(true);
  const navMapPannedReturnRef   = useRef(null);
  const [needsRecenter, setNeedsRecenter] = useState(false);


  // Bug report
  const [bugComment, setBugComment] = useState('');
  const [bugSubmitting, setBugSubmitting] = useState(false);
  const [bugReportOpen, setBugReportOpen] = useState(false);          // dedicated report sheet
  const [bugScreenshot, setBugScreenshot] = useState(null);           // base64 captured at tap-time
  const [bugScreenshotZoom, setBugScreenshotZoom] = useState(false);  // tap-to-enlarge preview

  // Friends & profile (Phase 1 plumbing; Phase 2 live sharing)
  const [profile, setProfile] = useState(null);                  // { user_id, display_name, share_code }
  const [friendships, setFriendships] = useState([]);            // [{ id, status, initiated_by, friend: { user_id, display_name, share_code } }]
  const [friendshipsLoaded, setFriendshipsLoaded] = useState(false); // true after the first successful load (vs default empty)
  const [addFriendInput, setAddFriendInput] = useState('');
  const [addFriendStatus, setAddFriendStatus] = useState(null);  // { kind: 'success' | 'error', msg }
  const [addingFriend, setAddingFriend] = useState(false);
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [draftDisplayName, setDraftDisplayName] = useState('');
  // Live position sharing — hydrated from storage so 12h sessions survive
  // app restarts (and don't reset just because the user backgrounded the app).
  const [sharingFriendIds, setSharingFriendIds] = useState(
    () => new Set(Object.keys(loadSharingSessions()))
  );
  const [matePositions, setMatePositions] = useState({});      // { [friendshipId]: { user_id, lat, lng, name, ts } }
  // (channelsRef removed — old Realtime Presence approach. Live tracking is
  //  now DB-backed via the mate_positions table.)
  const mateMarkersRef   = useRef({});                          // { [friendshipId]: maplibregl.Marker }
  // Synced ref so the WebGL-recovery reconciler can read fresh positions
  // without React closure staleness.
  const matePositionsRef = useRef({});
  useEffect(() => { matePositionsRef.current = matePositions; }, [matePositions]);
  // Toast for friendship state changes (e.g. someone accepted my request)
  const [friendToast, setFriendToast] = useState(null);          // { msg, kind }
  const prevFriendshipsRef = useRef([]);                         // snapshot for diffing
  // Routes that mates have shared with me (inbox).
  const [sharedRoutes, setSharedRoutes] = useState([]);          // [{ id, sharer_id, sharer_name, title, distance_mi, duration_str, geometry, shared_at, viewed_at }]
  const prevSharedRouteIdsRef = useRef(new Set());                // diff seen to fire toasts only on new arrivals
  const sharedRoutesHydratedRef = useRef(false);                  // true after first load — distinguishes initial hydration from later arrivals
  const [shareModalOpen, setShareModalOpen] = useState(false);    // mate-picker modal for "Share this route"
  const [sharingRoute, setSharingRoute] = useState(false);        // in-flight write
  const [sharedWithOpen, setSharedWithOpen] = useState(false);    // "Shared with me" list section in menu
  const [matesPanelOpen, setMatesPanelOpen] = useState(false);    // desktop sidebar's Riding mates collapsible panel
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);  // dropdown anchored to the account chip in the desktop header
  const accountMenuRef = useRef(null);

  // In-app announcement banners (maintenance / service status / feature news).
  // Source: public.announcements table. Dismissal is local (per-device).
  const [announcements, setAnnouncements] = useState([]);
  const [dismissedAnnouncements, setDismissedAnnouncements] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('tt_dismissed_anns') || '[]')); }
    catch { return new Set(); }
  });
  const [bugDone, setBugDone] = useState(false);

  // Delete-account modal (Apple Guideline 5.1.1(v))
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  // Recent
  const [recent, setRecent] = useState(() => {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY)||'[]'); } catch { return []; }
  });

  // Refs
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const mapLoadedRef = useRef(false);
  const pendingRoute = useRef(null);
  const markersRef = useRef([]);
  const messagesEnd = useRef(null);
  const userMarkerRef = useRef(null);
  const locationWatchRef = useRef(null); // always-on position watch
  const wakeLockRef = useRef(null);
  // Stored brightness before nav started so we can restore it on stop. Null
  // means we haven't pinned brightness this session.
  const prevBrightnessRef = useRef(null);
  const lastAnnouncedRef = useRef(null);
  // Off-route + reroute bookkeeping. Tracked as refs so the geolocation
  // callback (which is called outside React render flow) can read/update
  // them without triggering re-renders on every GPS tick.
  const offRouteSinceRef  = useRef(null); // ms timestamp when rider first went off-route; null when on-route
  const lastOffRoutePosRef= useRef(null); // last known {lat,lng} while off-route — used by the timer-based trigger
  const offRouteTimerRef  = useRef(null); // setTimeout handle for the grace-window check
  const lastRerouteAtRef  = useRef(0);    // ms timestamp of last reroute attempt; cooldown gate
  const reroutingRef      = useRef(false);// guard against overlapping reroute calls
  const [rerouting, setRerouting] = useState(false); // UI banner during reroute
  const routeDataRef = useRef(null);
  const navModeRef = useRef(false); // mirror of navMode for geolocation callback
  const sessionEmailRef = useRef(null); // mirror of current account email for dev sim override
  const routeAbortRef = useRef(null);   // AbortController for the in-flight generate-route fetch
  const routeGenRef   = useRef(0);      // monotonically-increasing id of the latest generation request
  // Nav telemetry: one session_id per Navigate→Stop arc, groups events for replay.
  // Generated on startNavigation, cleared on stopNavigation.
  const navSessionIdRef = useRef(null);
  // Mirrors of state needed inside logNavEvent (a useCallback with empty deps).
  const sessionRef = useRef(null);
  // Most recent GPS fix — used to enrich nav events that fire from timers
  // (e.g. off-route trigger) where pos isn't in scope.
  const lastGpsFixRef = useRef(null);

  // logNavEvent — fire-and-forget insert to public.nav_events. Never throws,
  // never blocks. Skips when there's no session_id (i.e. not navigating).
  const logNavEvent = useCallback(async (eventType, opts = {}) => {
    const sessionId = navSessionIdRef.current;
    if (!sessionId) return;
    const pos = opts.pos ?? lastGpsFixRef.current;
    try {
      await supabase.from('nav_events').insert({
        session_id: sessionId,
        user_id: sessionRef.current?.user?.id ?? null,
        route_id: routeDataRef.current?.id ?? null,
        event_type: eventType,
        lat: opts.lat ?? pos?.lat ?? null,
        lng: opts.lng ?? pos?.lng ?? null,
        speed_mps: opts.speed_mps ?? pos?.speed_mps ?? null,
        heading: opts.heading ?? pos?.heading ?? null,
        metadata: opts.metadata ?? null,
      });
    } catch (e) {
      // Swallow — telemetry must never break the ride
      console.warn('[logNavEvent] insert failed:', e?.message);
    }
  }, []);

  const isMobile = useIsMobile();

  useEffect(() => { routeDataRef.current = routeData; }, [routeData]);
  useEffect(() => { navModeRef.current = navMode; }, [navMode]);
  useEffect(() => { sessionRef.current = session; }, [session]);

  // Fetch the native app version + build number once on mount. On web we
  // skip the call (Capacitor.App.getInfo throws on non-native) and just
  // render the package.json version with no build number.
  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      CapacitorApp.getInfo()
        .then(info => setAppVersion({ version: info.version, build: info.build }))
        .catch(() => {});
    }
  }, []);

  // Keep the screen on while navigating, release as soon as nav stops.
  // Combined with the `audio` UIBackgroundMode (Info.plist), this lets voice
  // direction announcements keep playing for a few minutes when the rider
  // briefly checks another app or notifications. The native plugin is loaded
  // dynamically so this file still runs on web (where there's no screen lock).
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let released = false;
    (async () => {
      try {
        const { KeepAwake } = await import('@capacitor-community/keep-awake');
        if (navMode) {
          await KeepAwake.keepAwake();
        } else {
          await KeepAwake.allowSleep();
          released = true;
        }
      } catch (e) {
        console.warn('[keep-awake] plugin error:', e?.message || e);
      }
    })();
    return () => {
      if (released) return;
      (async () => {
        try {
          const { KeepAwake } = await import('@capacitor-community/keep-awake');
          await KeepAwake.allowSleep();
        } catch {}
      })();
    };
  }, [navMode]);
  useEffect(() => { voiceMutedRef.current = voiceMuted; }, [voiceMuted]);
  useEffect(() => { sessionEmailRef.current = session?.user?.email || null; }, [session?.user?.email]);

  // Prime the SpeechSynthesis voice list — many browsers load voices async and
  // return [] from the first getVoices() call. We listen so the picker can
  // upgrade from the default voice to a premium one as soon as it's available.
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const onVoices = () => { _pickedVoice = null; pickBestVoice(); };
    synth.addEventListener?.('voiceschanged', onVoices);
    onVoices();
    return () => synth.removeEventListener?.('voiceschanged', onVoices);
  }, []);

  const toggleVoiceMute = useCallback(() => {
    setVoiceMuted(m => {
      const next = !m;
      try { localStorage.setItem('voice_muted', next ? '1' : '0'); } catch {}
      if (next && window.speechSynthesis) window.speechSynthesis.cancel();
      return next;
    });
  }, []);

  const handleVoiceResult = useCallback((transcript) => {
    setQuery(transcript);
    submitQuery(transcript);
  }, []);
  const voice = useVoice(handleVoiceResult);

  // Close the desktop account dropdown when clicking anywhere outside it.
  useEffect(() => {
    if (!accountMenuOpen) return;
    const onDown = (e) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target)) {
        setAccountMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [accountMenuOpen]);

  // Live mirror of interim voice transcript into the input box, so the user
  // sees their words appear as they speak. Guarded against `loading` so that
  // any late partialResults that arrive after submit (during the iOS plugin's
  // shutdown window) can't overwrite the cleared input mid-request.
  useEffect(() => {
    if (voice.listening && voice.transcript && !loading) setQuery(voice.transcript);
  }, [voice.listening, voice.transcript, loading]);

  // When recents are open, the sheet covers the map (buttons + input stay at the
  // top, recents list fills the rest). Otherwise: compact base — two-button
  // hero row + single-line input pill, sized to leave most of the map visible.
  const computeIdleHeight = useCallback((textH) => {
    if (recentsOpen) {
      // Near full screen, leaving room for the status bar/notch.
      const vh = (typeof window !== 'undefined' ? window.innerHeight : 800);
      return Math.min(900, vh - 40);
    }
    const errH = voice.error ? 40 : 0;
    // Handle row no longer lives inside the sheet (it's floating above), so the
    // base shrinks by ~38px. Base now: 10px top + 56px buttons + 10px gap +
    // textarea + 22px safe-area ≈ 100 + textH.
    return Math.max(160, Math.min(100 + textH + errH, 460));
  }, [voice.error, recentsOpen]);

  // Auto-resize the idle textarea; grow the sheet so the whole prompt stays
  // visible. Uses RAF so iOS WKWebView has time to lay out before scrollHeight
  // is read, and a ResizeObserver so we also react when the browser changes the
  // textarea height itself (e.g. via `field-sizing: content` in supporting browsers).
  useEffect(() => {
    const ta = idleInputRef.current;
    if (!ta) return;
    const TEXT_MAX = 220;
    const recalc = () => {
      ta.style.height = 'auto';
      const textH = Math.min(ta.scrollHeight, TEXT_MAX);
      ta.style.height = textH + 'px';
      setIdleSheetHeight(computeIdleHeight(textH));
    };
    const raf = requestAnimationFrame(recalc);
    return () => cancelAnimationFrame(raf);
  }, [query, sheetMode, computeIdleHeight]);

  // Continuously observe textarea size changes (covers voice partial updates
  // and the browser growing the field via field-sizing).
  useEffect(() => {
    const ta = idleInputRef.current;
    if (!ta || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      setIdleSheetHeight(computeIdleHeight(ta.offsetHeight));
    });
    ro.observe(ta);
    return () => ro.disconnect();
  }, [sheetMode, computeIdleHeight]);

  // Close the recents drawer whenever we leave idle mode.
  useEffect(() => { if (sheetMode !== 'idle') setRecentsOpen(false); }, [sheetMode]);

  // Measure menu content height so the sheet sizes itself to the menu instead
  // of expanding to fill the whole screen (which leaves a sea of empty white
  // below the actual buttons).
  useEffect(() => {
    if (!menuOpen) return;
    const el = menuContentRef.current;
    if (!el) return;
    const HANDLE_ROW = 52;       // sheet-handle-row height (⋯ button + padding)
    const MAX_VH = 0.85;
    const measure = () => {
      const cap = Math.floor((window.innerHeight || 800) * MAX_VH);
      setMenuSheetHeight(Math.min(HANDLE_ROW + el.scrollHeight + 16, cap));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [menuOpen]);

  // ── Friends data layer ────────────────────────────────────────────────────
  const loadProfile = useCallback(async () => {
    if (!session?.user) return;
    const { data, error: err } = await supabase
      .from('profiles')
      .select('user_id, display_name, share_code')
      .eq('user_id', session.user.id)
      .single();
    if (!err && data) setProfile(data);
  }, [session?.user]);

  const loadFriendships = useCallback(async () => {
    if (!session?.user) return;
    const uid = session.user.id;
    const { data: rows, error: err } = await supabase
      .from('friendships')
      .select('id, status, initiated_by, user_id_a, user_id_b, created_at');
    if (err || !rows) return;
    const otherIds = rows.map(r => r.user_id_a === uid ? r.user_id_b : r.user_id_a);
    if (otherIds.length === 0) {
      setFriendships([]);
      setFriendshipsLoaded(true);
      return;
    }
    const { data: profs } = await supabase
      .from('profiles')
      .select('user_id, display_name, share_code')
      .in('user_id', otherIds);
    const profById = Object.fromEntries((profs || []).map(p => [p.user_id, p]));
    setFriendships(rows.map(r => ({
      id: r.id,
      status: r.status,
      initiated_by: r.initiated_by,
      created_at: r.created_at,
      friend: profById[r.user_id_a === uid ? r.user_id_b : r.user_id_a] || null,
    })));
    setFriendshipsLoaded(true);
  }, [session?.user]);

  useEffect(() => {
    if (!session?.user) { setProfile(null); setFriendships([]); setFriendshipsLoaded(false); return; }
    loadProfile();
    loadFriendships();
    // Realtime: any change to friendships involving me → reload.
    // Requires `alter publication supabase_realtime add table public.friendships`
    // in the database, otherwise no event reaches the client.
    const ch = supabase
      .channel('friendships:' + session.user.id)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'friendships' },
        () => loadFriendships())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [session?.user, loadProfile, loadFriendships]);

  // Announcements: fetch active rows + the rider's dismissed-IDs from
  // announcement_dismissals (so a dismiss on the web stays dismissed on
  // the phone). Subscribe to changes on both tables. Foreground + 10-min
  // poll as a safety-net. localStorage still mirrors dismissed-IDs as an
  // offline cache so the banner doesn't flash back during the network
  // round-trip on cold launch.
  useEffect(() => {
    if (!session?.user) { setAnnouncements([]); return; }
    const userId = session.user.id;

    const loadAnns = async () => {
      const nowIso = new Date().toISOString();
      const { data, error } = await supabase
        .from('announcements')
        .select('id,kind,title,body,url,url_label,starts_at,ends_at,dismissible')
        .lte('starts_at', nowIso)
        .or(`ends_at.is.null,ends_at.gt.${nowIso}`)
        .order('starts_at', { ascending: false });
      if (!error && data) setAnnouncements(data);
    };

    const loadDismissed = async () => {
      const { data, error } = await supabase
        .from('announcement_dismissals')
        .select('announcement_id')
        .eq('user_id', userId);
      if (!error && data) {
        const ids = new Set(data.map(r => r.announcement_id));
        setDismissedAnnouncements(ids);
        try { localStorage.setItem('tt_dismissed_anns', JSON.stringify([...ids])); } catch {}
      }
    };

    loadAnns();
    loadDismissed();

    const annsCh = supabase
      .channel('announcements')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'announcements' },
        () => loadAnns())
      .subscribe();
    const dismissCh = supabase
      .channel('announcement_dismissals:' + userId)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'announcement_dismissals', filter: `user_id=eq.${userId}` },
        () => loadDismissed())
      .subscribe();

    const onVis = () => {
      if (document.visibilityState === 'visible') { loadAnns(); loadDismissed(); }
    };
    document.addEventListener('visibilitychange', onVis);
    const interval = setInterval(() => { loadAnns(); loadDismissed(); }, 10 * 60 * 1000);

    return () => {
      supabase.removeChannel(annsCh);
      supabase.removeChannel(dismissCh);
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(interval);
    };
  }, [session?.user]);

  // Pick the announcement to show right now. Sort priority: critical first,
  // then maintenance, then warning, then info — within each tier, newest first.
  const kindWeight = { critical: 0, maintenance: 1, warning: 2, info: 3 };
  const visibleAnnouncement = announcements
    .filter(a => !dismissedAnnouncements.has(a.id))
    .sort((a, b) => {
      const dw = (kindWeight[a.kind] ?? 9) - (kindWeight[b.kind] ?? 9);
      if (dw !== 0) return dw;
      return new Date(b.starts_at) - new Date(a.starts_at);
    })[0];

  function dismissAnnouncement(id) {
    // Optimistic local update so the banner disappears instantly.
    setDismissedAnnouncements(prev => {
      const next = new Set(prev); next.add(id);
      try { localStorage.setItem('tt_dismissed_anns', JSON.stringify([...next])); } catch {}
      return next;
    });
    // Persist server-side so it stays dismissed on other devices the rider
    // signs in with. Best-effort — failure just means the dismiss only
    // sticks on this device (still better than no dismiss).
    if (session?.user) {
      supabase.from('announcement_dismissals')
        .upsert({ user_id: session.user.id, announcement_id: id }, { onConflict: 'user_id,announcement_id' })
        .then(({ error }) => { if (error) console.warn('[announce] dismiss persist failed:', error.message); });
    }
  }

  // Watch friendships for transitions worth surfacing as toasts.
  useEffect(() => {
    if (!session?.user) { prevFriendshipsRef.current = []; return; }
    const prev = prevFriendshipsRef.current;
    const prevById = Object.fromEntries(prev.map(f => [f.id, f]));
    for (const f of friendships) {
      const before = prevById[f.id];
      const name = f.friend?.display_name || 'A rider';
      // My outgoing request just got accepted by the other side.
      if (before && before.status === 'pending' && f.status === 'accepted' &&
          before.initiated_by === session.user.id) {
        setFriendToast({ kind: 'success', msg: `${name} accepted your friend request!` });
      }
      // A new incoming request just arrived.
      else if (!before && f.status === 'pending' && f.initiated_by !== session.user.id) {
        setFriendToast({ kind: 'info', msg: `${name} wants to ride with you` });
      }
    }
    prevFriendshipsRef.current = friendships;
  }, [friendships, session?.user]);

  // Auto-dismiss toast after a few seconds.
  useEffect(() => {
    if (!friendToast) return;
    const t = setTimeout(() => setFriendToast(null), 4500);
    return () => clearTimeout(t);
  }, [friendToast]);

  async function sendFriendRequest() {
    const raw = addFriendInput.trim();
    if (!raw || addingFriend || !session?.user) return;
    setAddingFriend(true); setAddFriendStatus(null);
    try {
      let targetProfile = null;
      if (raw.includes('@')) {
        // Email lookup via edge function (auth.users isn't queryable from client)
        const r = await fetch(`${SUPABASE_URL}/functions/v1/find-rider`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ email: raw }),
        });
        const body = await r.json();
        if (body.self) { setAddFriendStatus({ kind: 'error', msg: 'That’s you.' }); return; }
        if (!body.found) { setAddFriendStatus({ kind: 'error', msg: 'No rider with that email.' }); return; }
        targetProfile = body.profile;
      } else {
        // Share-code lookup — direct via profiles (allowed by RLS)
        const code = raw.toUpperCase();
        if (!/^[A-Z2-9]{6}$/.test(code)) {
          setAddFriendStatus({ kind: 'error', msg: 'Codes are 6 letters/digits.' });
          return;
        }
        if (profile && code === profile.share_code) {
          setAddFriendStatus({ kind: 'error', msg: 'That’s your own code.' });
          return;
        }
        const { data, error: err } = await supabase
          .from('profiles')
          .select('user_id, display_name, share_code')
          .eq('share_code', code)
          .maybeSingle();
        if (err || !data) {
          setAddFriendStatus({ kind: 'error', msg: 'No rider with that code.' });
          return;
        }
        targetProfile = data;
      }

      // Canonicalise (a, b) so the unique constraint matches regardless of caller.
      const me = session.user.id;
      const other = targetProfile.user_id;
      const [a, b] = me < other ? [me, other] : [other, me];

      const { error: insertErr } = await supabase
        .from('friendships')
        .insert({ user_id_a: a, user_id_b: b, status: 'pending', initiated_by: me });

      if (insertErr) {
        const msg = /duplicate/i.test(insertErr.message || '')
          ? 'You’re already connected (or have a pending request).'
          : (insertErr.message || 'Could not send request.');
        setAddFriendStatus({ kind: 'error', msg });
        return;
      }

      setAddFriendStatus({ kind: 'success', msg: `Request sent to ${targetProfile.display_name}.` });
      setAddFriendInput('');
      loadFriendships();
    } finally {
      setAddingFriend(false);
    }
  }

  async function acceptFriendship(id) {
    await supabase.from('friendships').update({ status: 'accepted' }).eq('id', id);
    loadFriendships();
  }
  async function deleteFriendship(id) {
    await supabase.from('friendships').delete().eq('id', id);
    loadFriendships();
  }

  async function shareInvite() {
    if (!profile) return;
    const url = `https://twotired.net/?add=${profile.share_code}`;
    const text = `Ride with me on TwoTired — use my code ${profile.share_code} or tap: ${url}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Join me on TwoTired', text, url }); }
      catch { /* user cancelled */ }
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      setAddFriendStatus({ kind: 'success', msg: 'Invite copied to clipboard' });
    } else {
      setAddFriendStatus({ kind: 'error', msg: 'Sharing not supported on this device' });
    }
  }

  // ── Shared routes (inbox + outgoing) ──────────────────────────────────────
  const loadSharedRoutes = useCallback(async () => {
    if (!session?.user) return;
    const me = session.user.id;
    const { data, error } = await supabase
      .from('shared_routes')
      .select('id, sharer_id, recipient_id, title, distance_mi, duration_str, geometry, stops, intent, instructions, shared_at, viewed_at')
      .eq('recipient_id', me)
      .order('shared_at', { ascending: false })
      .limit(50);
    if (error || !data) return;
    // Resolve sharer names from already-loaded friendships.
    const nameById = Object.fromEntries(
      friendships.filter(f => f.friend).map(f => [f.friend.user_id, f.friend.display_name])
    );
    setSharedRoutes(data.map(r => ({ ...r, sharer_name: nameById[r.sharer_id] || 'A rider' })));
  }, [session?.user, friendships]);

  // Realtime: any change to shared_routes where recipient_id = me → reload.
  useEffect(() => {
    if (!session?.user) return;
    const me = session.user.id;
    const ch = supabase
      .channel('shared-routes:' + me)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'shared_routes',
        filter: `recipient_id=eq.${me}`,
      }, () => loadSharedRoutes())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [session?.user, loadSharedRoutes]);

  useEffect(() => { loadSharedRoutes(); }, [loadSharedRoutes]);

  // Toast on new arrivals (vs initial hydration). The first time this effect
  // runs we just snapshot; afterwards any newly-arrived id triggers a toast.
  useEffect(() => {
    const prev = prevSharedRouteIdsRef.current;
    if (sharedRoutesHydratedRef.current) {
      for (const r of sharedRoutes) {
        if (!prev.has(r.id) && !r.viewed_at) {
          setFriendToast({ kind: 'info', msg: `${r.sharer_name} shared a route with you — tap to open` });
          break;
        }
      }
    }
    prevSharedRouteIdsRef.current = new Set(sharedRoutes.map(r => r.id));
    sharedRoutesHydratedRef.current = true;
  }, [sharedRoutes]);

  async function shareRouteWith(friendUserId) {
    if (!session?.user || !routeData) return;
    setSharingRoute(true);
    try {
      const payload = {
        sharer_id: session.user.id,
        recipient_id: friendUserId,
        title: routeData.title || 'Shared ride',
        distance_mi: routeData.distance_mi ?? null,
        duration_str: routeData.duration_str ?? null,
        geometry: routeData.geometry,
        stops: routeData.stops || [],
        intent: routeData.intent || null,
        instructions: routeData.instructions || [],
      };
      const { error } = await supabase.from('shared_routes').insert(payload);
      if (error) {
        console.warn('[shared_routes] insert failed:', error.code, error.message);
        setFriendToast({ kind: 'error', msg: 'Could not share — ' + (error.message || error.code) });
      } else {
        const friend = friendships.find(f => f.friend?.user_id === friendUserId)?.friend;
        setFriendToast({ kind: 'success', msg: `Sent to ${friend?.display_name || 'mate'}` });
      }
    } finally {
      setSharingRoute(false);
      setShareModalOpen(false);
    }
  }

  async function openSharedRoute(shared) {
    if (!shared) return;
    const route = {
      id: shared.id,
      title: shared.title,
      distance_mi: shared.distance_mi,
      duration_str: shared.duration_str,
      geometry: shared.geometry,
      stops: shared.stops || [],
      intent: shared.intent || null,
      instructions: shared.instructions || [],
    };
    setRouteData(route);
    setCurrentIntent(route.intent);
    setRouteApproved(false);
    setRefineOpen(false);
    setMessages([{ role: 'route', route }]);
    drawRouteOnMap(route);
    if (isMobile) setSheetMode('collapsed');
    setMenuOpen(false);

    // Add to local Recents so it shows up alongside user-planned routes (with
    // a `shared_from` field that the UI uses to tint the row orange).
    const entry = {
      id: Date.now(),
      title: route.title,
      distance_mi: route.distance_mi,
      duration_str: route.duration_str,
      geometry: route.geometry,
      intent: route.intent,
      stops: route.stops,
      instructions: route.instructions,
      shared_from: shared.sharer_name || 'A rider',
    };
    setRecent(prev => {
      const updated = [entry, ...prev.filter(x => x.title !== entry.title)].slice(0, 5);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(updated)); } catch {}
      return updated;
    });

    // Mark viewed (best-effort).
    if (!shared.viewed_at) {
      supabase.from('shared_routes').update({ viewed_at: new Date().toISOString() })
        .eq('id', shared.id).then(() => {});
    }
  }

  async function deleteSharedRoute(id) {
    await supabase.from('shared_routes').delete().eq('id', id);
    loadSharedRoutes();
  }

  async function saveDisplayName() {
    const name = draftDisplayName.trim();
    if (!name || !session?.user) return;
    const { error: err } = await supabase
      .from('profiles')
      .update({ display_name: name, updated_at: new Date().toISOString() })
      .eq('user_id', session.user.id);
    if (!err) {
      setProfile(p => p ? { ...p, display_name: name } : p);
      setEditingDisplayName(false);
    }
  }

  // Deep-link friend-add: when the app boots OR is foregrounded via an invite
  // URL (?add=CODE), prefill the Add input and open the menu so the user
  // confirms with one tap.
  //   • Cold start (Universal Link OR web URL): code is in window.location
  //   • Warm app (Universal Link tapped while app is in background): Capacitor's
  //     appUrlOpen event fires with the original URL
  const handleAddDeepLink = useCallback((rawUrl) => {
    if (!profile || !session?.user) return;
    let code = '';
    try {
      const u = new URL(rawUrl, window.location.origin);
      code = (u.searchParams.get('add') || '').toUpperCase();
    } catch { /* ignore malformed */ }
    if (!code) return;
    if (code === profile.share_code) return; // own invite — ignore silently
    setAddFriendInput(code);
    setMenuOpen(true);
    if (isMobile) setSheetMode('expanded');
  }, [profile, session?.user, isMobile]);

  useEffect(() => {
    if (!profile || !session?.user) return;
    // Cold-start: consume the URL once and strip it.
    handleAddDeepLink(window.location.href);
    if (new URLSearchParams(window.location.search).get('add')) {
      window.history.replaceState({}, '', window.location.pathname);
    }
    // Warm-foreground: listen for Universal Link taps via Capacitor's App plugin.
    const sub = CapacitorApp.addListener('appUrlOpen', ({ url }) => {
      handleAddDeepLink(url);
    });
    return () => { sub?.then?.(s => s.remove()); };
  }, [profile, session?.user, handleAddDeepLink]);

  // ── Live position sharing (DB-backed) ─────────────────────────────────────
  // Each user upserts a row in `mate_positions` (sharer, recipient, lat, lng,
  // updated_at) every ~5s while their per-mate Share toggle is on. Recipients
  // subscribe to postgres_changes on that table (same mechanism powering the
  // friendship toasts — proven reliable) and also poll every 60s.
  //
  // Replaces an earlier Realtime Presence approach which proved brittle on
  // iOS WKWebView: presence is connection-bound and the handshake regularly
  // failed to establish, leaving both peers broadcasting but neither seeing
  // the other.
  const userLocationRef = useRef(null);
  useEffect(() => { userLocationRef.current = userLocation; }, [userLocation]);

  // Load all positions shared TO me, keyed by friendship_id on the map.
  const loadMatePositions = useCallback(async () => {
    if (!session?.user) return;
    const me = session.user.id;
    const acceptedById = Object.fromEntries(
      friendships.filter(f => f.status === 'accepted' && f.friend)
                 .map(f => [f.friend.user_id, f])
    );
    const sharerIds = Object.keys(acceptedById);
    if (sharerIds.length === 0) {
      setMatePositions({});
      return;
    }
    const { data, error } = await supabase
      .from('mate_positions')
      .select('sharer_id, lat, lng, updated_at')
      .eq('recipient_id', me)
      .in('sharer_id', sharerIds);
    if (error) {
      console.warn('[mate_positions] select failed:', error.code, error.message);
      return;                              // transient failure — keep existing markers
    }
    if (!data) return;
    // Merge fresh rows in (don't blow away existing state on a transient empty
    // response — toggle-off is handled separately via the postgres_changes
    // DELETE event; absolute expiry is handled by the stale-cleanup interval).
    const cutoff = Date.now() - 45000;
    setMatePositions(prev => {
      const next = { ...prev };
      for (const row of data) {
        const f = acceptedById[row.sharer_id];
        if (!f) continue;
        const ts = new Date(row.updated_at).getTime();
        if (ts < cutoff) continue;
        next[f.id] = {
          user_id: row.sharer_id, lat: row.lat, lng: row.lng,
          name: f.friend.display_name, ts,
        };
      }
      return next;
    });
  }, [session?.user, friendships]);

  // Subscribe to postgres_changes on mate_positions where recipient_id = me.
  // INSERT/UPDATE triggers a fresh load (merge); DELETE removes that mate's
  // marker immediately so toggle-off is reflected without waiting.
  useEffect(() => {
    if (!session?.user) return;
    const me = session.user.id;
    const ch = supabase
      .channel('mate-positions:' + me)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'mate_positions',
        filter: `recipient_id=eq.${me}`,
      }, () => loadMatePositions())
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'mate_positions',
        filter: `recipient_id=eq.${me}`,
      }, () => loadMatePositions())
      .on('postgres_changes', {
        event: 'DELETE',
        schema: 'public',
        table: 'mate_positions',
        filter: `recipient_id=eq.${me}`,
      }, (payload) => {
        const sharerId = payload?.old?.sharer_id;
        if (!sharerId) return;
        setMatePositions(prev => {
          const f = friendships.find(x => x.friend?.user_id === sharerId);
          if (!f) return prev;
          if (!(f.id in prev)) return prev;
          const next = { ...prev };
          delete next[f.id];
          return next;
        });
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [session?.user, loadMatePositions, friendships]);

  // Initial / friendship-change snapshot.
  useEffect(() => { loadMatePositions(); }, [loadMatePositions]);

  // Foreground refresh: friendships + positions.
  useEffect(() => {
    const sub = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) return;
      try { supabase.realtime.disconnect(); } catch {}
      try { supabase.realtime.connect();    } catch {}
      loadFriendships();
      loadMatePositions();
    });
    return () => { sub?.then?.(s => s.remove()); };
  }, [loadFriendships, loadMatePositions]);

  // 60s safety-net poll for both friendships and positions.
  useEffect(() => {
    if (!session?.user) return;
    const interval = setInterval(() => {
      loadFriendships();
      loadMatePositions();
    }, 60000);
    return () => clearInterval(interval);
  }, [session?.user, loadFriendships, loadMatePositions]);

  // Stale-position cleanup: every 15s evict mate markers older than 45s.
  useEffect(() => {
    const interval = setInterval(() => {
      const cutoff = Date.now() - 45000;
      setMatePositions(prev => {
        let changed = false;
        const next = { ...prev };
        for (const [id, pos] of Object.entries(prev)) {
          if (pos?.ts && pos.ts < cutoff) { delete next[id]; changed = true; }
        }
        return changed ? next : prev;
      });
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  // Upsert my position every 5s while sharing with at least one mate.
  // One DB write per mate per 5s — cheap and survives socket blips.
  useEffect(() => {
    console.log('[mate_positions] effect run',
      'user:', !!session?.user, 'sharing:', sharingFriendIds.size,
      'friendships:', friendships.length);
    if (!session?.user || sharingFriendIds.size === 0) return;
    const me = session.user.id;
    const recipientFor = (id) =>
      friendships.find(f => f.id === id && f.status === 'accepted' && f.friend)?.friend?.user_id;

    const tick = async () => {
      const loc = userLocationRef.current;
      if (!loc) { console.log('[mate_positions] tick skip: no GPS yet'); return; }
      const rows = [];
      const idsTried = [];
      for (const id of sharingFriendIds) {
        idsTried.push(id.slice(0, 8));
        const recipient = recipientFor(id);
        if (!recipient) {
          console.warn('[mate_positions] no recipient for friendship', id.slice(0, 8));
          continue;
        }
        rows.push({
          sharer_id: me, recipient_id: recipient,
          lat: loc.lat, lng: loc.lng,
          updated_at: new Date().toISOString(),
        });
      }
      if (rows.length) {
        const { error: upErr } = await supabase
          .from('mate_positions')
          .upsert(rows, { onConflict: 'sharer_id,recipient_id' });
        if (upErr) console.warn('[mate_positions] upsert failed:', upErr.code, upErr.message);
      }
    };
    tick();
    const interval = setInterval(tick, 5000);
    return () => clearInterval(interval);
  }, [session?.user, sharingFriendIds, friendships]);

  // Drop sharing entries (and the corresponding rows) for friendships that
  // disappeared. Also clean stale matePositions for removed friendships.
  //
  // Gated on `friendshipsLoaded` so we don't run on the initial default-[]
  // state — otherwise hydrating sharingFriendIds from localStorage (12h
  // sessions) would be immediately wiped because the empty initial
  // friendships array has no accepted ids.
  useEffect(() => {
    if (!session?.user || !friendshipsLoaded) return;
    const accepted = friendships.filter(f => f.status === 'accepted' && f.friend);
    const acceptedIds = new Set(accepted.map(f => f.id));
    for (const id of Array.from(sharingFriendIds)) {
      if (!acceptedIds.has(id)) {
        setSharingFriendIds(prev => { const n = new Set(prev); n.delete(id); return n; });
        const sessions = loadSharingSessions();
        if (sessions[id]) { delete sessions[id]; saveSharingSessions(sessions); }
      }
    }
    setMatePositions(prev => {
      let changed = false;
      const next = { ...prev };
      for (const id of Object.keys(prev)) {
        if (!acceptedIds.has(id)) { delete next[id]; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [friendships, friendshipsLoaded, session?.user, sharingFriendIds]);

  const toggleShareWith = useCallback((friendshipId) => {
    const f = friendships.find(x => x.id === friendshipId);
    const recipient = f?.friend?.user_id;
    setSharingFriendIds(prev => {
      const next = new Set(prev);
      const sessions = loadSharingSessions();
      if (next.has(friendshipId)) {
        next.delete(friendshipId);
        delete sessions[friendshipId];
        // Delete the shared row so the mate's marker disappears for them.
        if (recipient && session?.user) {
          supabase.from('mate_positions').delete()
            .eq('sharer_id', session.user.id).eq('recipient_id', recipient)
            .then(() => {});
        }
      } else {
        next.add(friendshipId);
        sessions[friendshipId] = { expiresAt: Date.now() + SHARING_TTL_MS };
      }
      saveSharingSessions(sessions);
      return next;
    });
  }, [friendships, session?.user]);

  // Schedule auto-stop for any active sharing session at its expiry timestamp.
  useEffect(() => {
    if (sharingFriendIds.size === 0) return;
    const sessions = loadSharingSessions();
    const timers = [];
    for (const id of sharingFriendIds) {
      const entry = sessions[id];
      if (!entry) continue;
      const msLeft = entry.expiresAt - Date.now();
      const t = setTimeout(() => {
        if (sharingFriendIds.has(id)) toggleShareWith(id);
      }, Math.max(0, msLeft));
      timers.push(t);
    }
    return () => timers.forEach(clearTimeout);
  }, [sharingFriendIds, toggleShareWith]);

  // Render mate markers on the map. Reusable: setLngLat for existing markers,
  // create for new mates, remove for mates who stopped sharing.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) return;
    const currentIds = new Set(Object.keys(matePositions));
    for (const [id, pos] of Object.entries(matePositions)) {
      let marker = mateMarkersRef.current[id];
      if (marker) {
        marker.setLngLat([pos.lng, pos.lat]);
      } else {
        const el = makeMateMarkerEl(pos.name);
        marker = new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat([pos.lng, pos.lat])
          .addTo(map);
        mateMarkersRef.current[id] = marker;
      }
    }
    for (const id of Object.keys(mateMarkersRef.current)) {
      if (!currentIds.has(id)) {
        mateMarkersRef.current[id].remove();
        delete mateMarkersRef.current[id];
      }
    }
  }, [matePositions]);

  // ── Auth init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session); setAuthReady(true);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      setSession(session); setAuthReady(true);
    });
    return () => subscription.unsubscribe();
  }, []);

  // ── Map init — wait for session so map-canvas is in DOM ───────────────────
  useEffect(() => {
    if (!session) return;
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLE,
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      attributionControl: false,
      preserveDrawingBuffer: true,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    map.on('load', () => {
      mapLoadedRef.current = true;
      if (pendingRoute.current) {
        drawRouteOnMap(pendingRoute.current);
        pendingRoute.current = null;
      }
      // Note: the previous build auto-restored LAST_ROUTE_KEY from localStorage
      // here so that reopening the app or refreshing showed yesterday's route.
      // Removed — users prefer the app to start blank. Previous rides are
      // reachable via the recents drawer in the idle sheet.

      // Center on user location once on startup. Same dev sim override as
      // onGeoPosition so the map doesn't fly to SF on the simulator for
      // whitelisted accounts.
      getCurrentGPS({ timeout: 5000, maximumAge: 60000 }).then(gps => {
        if (!gps || !mapRef.current) return;
        let { lat, lng } = gps;
        const override = SIM_OVERRIDE_ACCOUNTS[sessionEmailRef.current];
        if (override && isSimulatorDefaultCoord(lat, lng)) {
          lat = override.lat; lng = override.lng;
        }
        mapRef.current.flyTo({ center: [lng, lat], zoom: 12, duration: 1200 });
      });

      // Start always-on position watch for live marker
      if (navigator.geolocation) {
        locationWatchRef.current = navigator.geolocation.watchPosition(
          onGeoPosition,
          () => {},
          { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
        );
      }

      // ── Manual map interaction during navigation ─────────────────────────
      // Drag (pan) means the rider wants to look around → stop following them,
      // show the recenter button, NO auto-return. Pinch zoom means "peek
      // ahead" → also stop following, but schedule an auto-return after 5 s
      // of no further interaction.
      const onUserDrag = (e) => {
        if (!navModeRef.current) return;
        if (!e?.originalEvent) return;        // ignore programmatic moves
        followingUserRef.current = false;
        setNeedsRecenter(true);
        // Cancel any pending auto-return — the rider is panning, not glancing.
        if (navMapPannedReturnRef.current) {
          clearTimeout(navMapPannedReturnRef.current);
          navMapPannedReturnRef.current = null;
        }
      };
      const onUserZoom = (e) => {
        if (!navModeRef.current) return;
        if (!e?.originalEvent) return;        // ignore our own easeTo zooms
        followingUserRef.current = false;
        setNeedsRecenter(true);
        // (Re)schedule the auto-return.
        if (navMapPannedReturnRef.current) clearTimeout(navMapPannedReturnRef.current);
        navMapPannedReturnRef.current = setTimeout(() => {
          navMapPannedReturnRef.current = null;
          if (navModeRef.current) recenterMapOnRider();
        }, 5000);
      };
      map.on('dragstart', onUserDrag);
      map.on('zoomstart', onUserZoom);
    });

    // ── WebGL-context-loss reconciliation ─────────────────────────────────
    // iOS WKWebView occasionally purges the WebGL context under memory
    // pressure or after long backgrounding. When it comes back, MapLibre
    // reloads the style and EVERY dynamic source / layer / marker silently
    // vanishes — the rider sees the route line disappear mid-navigation, or
    // their mate's location pin drop off the map, even though both are still
    // in React state. Restarting the app rebuilds from state, which is why
    // it "comes back" after a relaunch. We instead listen for the style
    // reload and re-add everything ourselves.
    let initialStyleLoad = false;
    map.on('style.load', () => {
      if (!initialStyleLoad) { initialStyleLoad = true; return; }
      console.log('[map] style reloaded — reconciling layers and markers');
      // 1. Route polyline + stop markers
      const r = routeDataRef.current;
      if (r?.geometry) {
        try { drawRouteOnMap(r); }
        catch (e) { console.warn('[reconcile] route:', e?.message || e); }
      }
      // 2. Mate markers — DOM is gone, refs are stale. Drop refs, recreate
      // from the synced positions ref.
      for (const id of Object.keys(mateMarkersRef.current)) {
        try { mateMarkersRef.current[id].remove(); } catch {}
      }
      mateMarkersRef.current = {};
      const positions = matePositionsRef.current || {};
      for (const [id, pos] of Object.entries(positions)) {
        try {
          const el = makeMateMarkerEl(pos.name);
          mateMarkersRef.current[id] = new maplibregl.Marker({ element: el, anchor: 'center' })
            .setLngLat([pos.lng, pos.lat])
            .addTo(map);
        } catch (e) { console.warn('[reconcile] mate', id, e?.message || e); }
      }
      // 3. User nav marker — clear the ref so onGeoPosition recreates it on
      // the next GPS tick (instead of trying to setLngLat on a detached DOM).
      userMarkerRef.current = null;
    });
    // Diagnostic — confirm the context-loss path is what's firing in the wild.
    const mapCanvas = map.getCanvas();
    mapCanvas.addEventListener('webglcontextlost', () => {
      console.log('[map] WebGL context lost');
    }, { passive: true });
    mapCanvas.addEventListener('webglcontextrestored', () => {
      console.log('[map] WebGL context restored');
    }, { passive: true });

    mapRef.current = map;
    return () => {
      if (locationWatchRef.current !== null) {
        navigator.geolocation.clearWatch(locationWatchRef.current);
        locationWatchRef.current = null;
      }
      // Clear marker ref so next map init creates a fresh marker (bug fix: stale ref)
      userMarkerRef.current = null;
      map.remove();
      mapRef.current = null;
      mapLoadedRef.current = false;
    };
  }, [session]);

  // ── Position callback — always-on, refs avoid stale closures ─────────────
  function onGeoPosition(pos) {
    let { latitude: lat, longitude: lng } = pos.coords;

    // Dev sim override: re-anchor known simulator default coordinates to a
    // real-world spot for whitelisted accounts. Bounded so real-device GPS
    // is never affected.
    const override = SIM_OVERRIDE_ACCOUNTS[sessionEmailRef.current];
    if (override && isSimulatorDefaultCoord(lat, lng)) {
      lat = override.lat; lng = override.lng;
    }

    setUserLocation({ lat, lng });
    // Snapshot last GPS fix so timer-driven nav events (e.g. off-route trigger)
    // can attach position even when pos isn't in their scope.
    lastGpsFixRef.current = {
      lat, lng,
      speed_mps: typeof pos.coords.speed === 'number' && !isNaN(pos.coords.speed) ? pos.coords.speed : null,
      heading:   typeof pos.coords.heading === 'number' && !isNaN(pos.coords.heading) ? pos.coords.heading : null,
    };

    // ── Map matching ────────────────────────────────────────────────────
    // During navigation, project the raw GPS onto the route polyline. If
    // we're within MAP_MATCH_MAX_M of the route, treat the snapped point as
    // the rider's "true" position — the marker, the map centre, the bearing,
    // and the off-route distance all derive from it. This is the standard
    // pattern in production nav apps (Google, Apple) and is what eliminates
    // the bearing/marker jitter that raw GPS noise introduces.
    const MAP_MATCH_MAX_M = 30;
    const route = routeDataRef.current;
    let mapMatch = null;
    let onRoute  = false;
    let displayLat = lat;
    let displayLng = lng;
    if (navModeRef.current && route) {
      mapMatch = projectOntoRoute(lat, lng, route);
      onRoute  = mapMatch != null && mapMatch.distFromRoute < MAP_MATCH_MAX_M;
      if (onRoute) {
        displayLat = mapMatch.snappedLat;
        displayLng = mapMatch.snappedLng;
      }
      // Trim the visible polyline so only the road AHEAD of the rider is
      // drawn. The rider doesn't care where they've been — only where they
      // need to go. Uses setData on the existing source so we don't churn
      // layers every GPS tick. Restored to full geometry by stopNavigation.
      if (mapMatch && mapRef.current?.getSource('route')) {
        const ahead = sliceRouteAhead(route, mapMatch.segmentIdx, mapMatch.snappedLat, mapMatch.snappedLng);
        if (ahead) {
          try { mapRef.current.getSource('route').setData({ type: 'Feature', geometry: ahead }); }
          catch {}
        }
      }
    }

    // Debug log (kept while we shake the nav UX out — can drop later).
    if (navModeRef.current) {
      const off = mapMatch ? mapMatch.distFromRoute : null;
      console.log(
        `[gps] lat=${lat.toFixed(6)} lng=${lng.toFixed(6)}` +
        (off !== null ? ` distFromRoute=${off.toFixed(1)}m onRoute=${onRoute}` : '') +
        (offRouteSinceRef.current ? ` offFor=${Date.now() - offRouteSinceRef.current}ms` : '')
      );
    }

    const map = mapRef.current;
    if (map) {
      if (!userMarkerRef.current) {
        userMarkerRef.current = new maplibregl.Marker({
          element: makeMotoMarkerEl(),
          anchor: 'center',
        }).setLngLat([displayLng, displayLat]).addTo(map);
      } else {
        userMarkerRef.current.setLngLat([displayLng, displayLat]);
      }

      if (navModeRef.current) {
        // ── Bearing source priority ─────────────────────────────────────
        // The map's bearing follows the ROUTE direction, not the rider's
        // direction. This matches Google/Apple Maps: the road ahead always
        // points up the screen, regardless of whether the rider is stopped,
        // moving, on the polyline, or briefly off it. We decouple "where the
        // marker is drawn" (rider position) from "which way is up" (route).
        //
        //   1. Snapped segment tangent — preferred whenever we have a route
        //      projection (which is every tick during nav). Stable across an
        //      entire road segment; rotates smoothly at curves.
        //   2. GPS heading — only when there is no route projection AND the
        //      rider is moving. Effectively a safety fallback; rarely hit.
        //   3. Hold steady — no projection, not moving. Map doesn't spin.
        //   4. First fix — seed with routeBearingAt before the first match.
        const heading = pos.coords.heading;
        const speed   = pos.coords.speed;
        const hasValidHeading = (typeof heading === 'number' && !isNaN(heading));
        const isMoving        = (typeof speed   === 'number' && !isNaN(speed)   && speed > 1.0);

        let target = navBearingRef.current;
        let source = 'hold';
        // Bearing = tangent of the polyline segment closest to the rider —
        // the local direction of travel. This is what Google/Apple do.
        if (mapMatch) {
          target = mapMatch.segmentBearing;
          source = onRoute ? 'route' : 'route-offline';
        } else if (isMoving && hasValidHeading) {
          target = heading;
          source = 'gps';
        }

        // NO smoothing on bearing. Look-ahead bearing from projectOntoRoute is
        // already stable (it only changes when the rider crosses to a new
        // polyline segment), so smoothing adds lag without buying anything.
        // We snap the map bearing directly to the target — fast and crisp,
        // the way Google/Apple do it.
        console.log(`[bearing] source=${source} speed=${speed?.toFixed?.(1) ?? 'null'} heading=${hasValidHeading ? heading.toFixed(1) : 'null'} target=${target.toFixed(1)}`);
        navBearingRef.current = target;
        lastNavPosRef.current = { lat, lng };

        // Bearing applied INSTANTLY via setBearing. Animated easeTo doesn't
        // work for bearing during nav — each new GPS tick cancels the prior
        // animation before it can finish, so the map crawls toward the target.
        // Position is still eased smoothly (separately) when following.
        map.setBearing(target);
        if (followingUserRef.current) {
          map.easeTo({
            center: [displayLng, displayLat],
            zoom: 17,
            pitch: 55,
            duration: 600,
          });
        }
      }
    }

    // Turn-by-turn announcements + remaining-progress stats (nav mode only).
    // Use displayLat/Lng — the snapped position when on route, raw GPS when
    // off — so turn distance is measured along the polyline (more accurate).
    if (route && navModeRef.current) {
      const result = findNextTurn(route, displayLat, displayLng);
      setNextTurn(result);
      const prog = routeProgress(route, displayLat, displayLng);
      if (prog) setNavProgress(prog);

      if (result) {
        const { instruction, dist } = result;
        const bucket = dist < 120 ? 'close' : dist < 350 ? 'far' : null;
        const key = `${instruction.text}-${bucket}`;
        if (bucket && lastAnnouncedRef.current !== key) {
          lastAnnouncedRef.current = key;
          const distPhrase = dist < 120 ? 'Now' : `In ${formatDist(dist)}`;
          speak(`${distPhrase}, ${instruction.text}`);
        }
      }

      // Off-route detection. Use the map-matched perpendicular distance —
      // it's the true measure of "how far am I from the polyline?" instead
      // of the older nearest-vertex approximation.
      if (!reroutingRef.current) {
        const offDist = mapMatch ? mapMatch.distFromRoute : distanceToRouteM(lat, lng, route);
        if (offDist > OFF_ROUTE_THRESHOLD_M) {
          // Remember last known off-route position; the scheduled trigger uses
          // it if no further GPS fixes arrive within the grace window (tunnel,
          // urban canyon, sim Custom Location which only fires one event).
          lastOffRoutePosRef.current = { lat, lng };
          if (offRouteSinceRef.current === null) {
            offRouteSinceRef.current = Date.now();
            console.log(`[offroute] entered off-route at ${offDist.toFixed(1)}m, scheduling reroute in ${OFF_ROUTE_GRACE_MS}ms`);
            logNavEvent('off_route', {
              lat, lng,
              metadata: { dist_off_route_m: Math.round(offDist) },
            });
            // Schedule a check at exactly grace-period later so the reroute
            // fires even if no new GPS events arrive in the meantime.
            const offRouteCheck = () => {
              offRouteTimerRef.current = null;
              if (!navModeRef.current) {
                console.log('[offroute] timer fired but navMode is off — skipping');
                return;
              }
              if (reroutingRef.current) {
                console.log('[offroute] timer fired but reroute already in flight — skipping');
                return;
              }
              if (offRouteSinceRef.current === null) {
                console.log('[offroute] timer fired but rider got back on route — skipping');
                return;
              }
              const sinceLast = Date.now() - lastRerouteAtRef.current;
              if (sinceLast < REROUTE_COOLDOWN_MS) {
                // Re-schedule the trigger for when the cooldown actually
                // expires, instead of giving up. Previously this just returned,
                // and unless the rider got back on route then off again, no
                // follow-up ever fired.
                const wait = REROUTE_COOLDOWN_MS - sinceLast + 100;
                console.log(`[offroute] timer fired but cooldown active (${sinceLast}ms < ${REROUTE_COOLDOWN_MS}ms) — rescheduling in ${wait}ms`);
                offRouteTimerRef.current = setTimeout(offRouteCheck, wait);
                return;
              }
              const p = lastOffRoutePosRef.current;
              if (!p) {
                console.log('[offroute] timer fired but no last position — skipping');
                return;
              }
              console.log(`[offroute] firing reroute from lat=${p.lat.toFixed(6)} lng=${p.lng.toFixed(6)}`);
              offRouteSinceRef.current = null;
              // Cooldown semantics:
              //   ok === 'changed'   → new route, full cooldown
              //   ok === 'unchanged' → server returned same route. ALSO full
              //                        cooldown — using a short one here
              //                        produced an infinite "Recalculating…"
              //                        loop on real rides when the rider sat
              //                        inside GraphHopper's snap zone.
              //   ok === false       → reroute didn't even reach the server
              //                        (no destination etc.). No cooldown so
              //                        the next attempt can try again.
              rerouteFromCurrentPosition(p.lat, p.lng).then(ok => {
                // Apply full cooldown on any attempt that reached the server
                // — success ('changed'/'unchanged') OR error ('errored').
                // Only skip cooldown when we never attempted (ok === false,
                // e.g. no destination available). This prevents tight retry
                // loops against a flaking server (see 2026-06-10 incident).
                if (ok === 'changed' || ok === 'unchanged' || ok === 'errored') {
                  lastRerouteAtRef.current = Date.now();
                }
              });
            };
            if (offRouteTimerRef.current) clearTimeout(offRouteTimerRef.current);
            offRouteTimerRef.current = setTimeout(offRouteCheck, OFF_ROUTE_GRACE_MS);
          }
        } else {
          // Back on route — reset the timer + cancel any pending trigger so
          // the next drift starts fresh.
          offRouteSinceRef.current = null;
          if (offRouteTimerRef.current) {
            clearTimeout(offRouteTimerRef.current);
            offRouteTimerRef.current = null;
          }
        }
      }
    }
  }

  // ── Draw route on map ─────────────────────────────────────────────────────
  function drawRouteOnMap(route) {
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) { pendingRoute.current = route; return; }

    if (map.getLayer('route-line')) map.removeLayer('route-line');
    if (map.getLayer('route-casing')) map.removeLayer('route-casing');
    if (map.getSource('route')) map.removeSource('route');
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];

    if (!route?.geometry) return;

    map.addSource('route', { type:'geojson', data:{ type:'Feature', geometry:route.geometry } });
    // Zoom-aware width: thin at preview zoom (~10) where the whole route fits on
    // screen, fat at nav zoom (~17+) so the rider can see the line clearly while
    // riding. Casing scales in lockstep so it always reads as a single ribbon.
    map.addLayer({ id:'route-casing', type:'line', source:'route',
      layout:{ 'line-join':'round','line-cap':'round' },
      paint:{
        'line-color':'#fff',
        'line-opacity':0.5,
        'line-width': ['interpolate', ['linear'], ['zoom'],
          10, 6,
          14, 10,
          17, 18,
          20, 24,
        ],
      } });
    map.addLayer({ id:'route-line', type:'line', source:'route',
      layout:{ 'line-join':'round','line-cap':'round' },
      paint:{
        'line-color':'#2563eb',
        'line-opacity':0.95,
        'line-width': ['interpolate', ['linear'], ['zoom'],
          10, 4,
          14, 7,
          17, 13,
          20, 18,
        ],
      } });

    route.stops?.forEach(stop => {
      if (!stop.lat || !stop.lng) return;
      const el = document.createElement('div');
      // Pick emoji by stop type keyword
      const t = (stop.type || stop.name || '').toLowerCase();
      const emoji = t.includes('coffee') || t.includes('cafe') || t.includes('espresso') ? '☕'
        : t.includes('lunch') || t.includes('dinner') || t.includes('restaurant') || t.includes('diner') || t.includes('food') || t.includes('eat') ? '🍽️'
        : t.includes('gas') || t.includes('fuel') || t.includes('petrol') ? '⛽'
        : t.includes('bar') || t.includes('pub') || t.includes('beer') || t.includes('brewery') ? '🍺'
        : t.includes('ice cream') || t.includes('dessert') || t.includes('bakery') ? '🍦'
        : t.includes('view') || t.includes('overlook') || t.includes('scenic') ? '📸'
        : '📍';
      el.textContent = emoji;
      // Inline styles — MapLibre overrides external CSS on custom marker elements
      Object.assign(el.style, {
        width: '36px', height: '36px',
        background: '#ffffff',
        border: '2.5px solid #f97316',
        borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '18px', lineHeight: '1',
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
        cursor: 'pointer',
        userSelect: 'none',
      });
      // Build a full info banner: name, rating, address, optional website, and
      // an "Open in Google Maps" link. Place_id link is preferred (it opens the
      // exact place card in Google Maps); falls back to a query+coords URL when
      // we don't have the place_id from the Places API.
      const escHtml = (s) => String(s).replace(/[&<>"']/g, c => (
        c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;'
        : c === '"' ? '&quot;' : '&#39;'
      ));
      const escUri = (s) => encodeURIComponent(s);
      const gmapsUrl = stop.placeId
        ? `https://www.google.com/maps/search/?api=1&query=${escUri(stop.name)}&query_place_id=${escUri(stop.placeId)}`
        : `https://www.google.com/maps/search/?api=1&query=${escUri(stop.name + ' ' + (stop.address || ''))}`;
      const ratingLine = stop.rating
        ? `<div class="stop-card-rating">⭐ ${stop.rating.toFixed(1)}${stop.ratingCount ? ` <span class="stop-card-count">(${stop.ratingCount.toLocaleString()})</span>` : ''}</div>`
        : '';
      const addressLine = stop.address
        ? `<div class="stop-card-addr">${escHtml(stop.address)}</div>`
        : '';
      const websiteLink = stop.website
        ? `<a class="stop-card-link" href="${escHtml(stop.website)}" target="_blank" rel="noreferrer">Website ↗</a>`
        : '';
      const popup = new maplibregl.Popup({ offset: 16, closeButton: true, maxWidth: '300px', className: 'stop-popup' })
        .setHTML(`
          <div class="stop-card">
            <div class="stop-card-title">${emoji} ${escHtml(stop.name)}</div>
            ${ratingLine}
            ${addressLine}
            <div class="stop-card-actions">
              <button type="button" class="stop-card-link stop-card-link--primary stop-card-details-btn">View details ↗</button>
              ${websiteLink}
            </div>
          </div>
        `);
      // Wire the "View details" button to open the rich modal. Forward the
      // whole stop object plus a fallback Google Maps URL the modal uses if
      // googleMapsUri isn't on the stop (e.g. routes generated before this
      // edge-function deploy).
      popup.on('open', () => {
        const popEl = popup.getElement();
        const btn = popEl?.querySelector('.stop-card-details-btn');
        if (btn) {
          btn.addEventListener('click', () => {
            selectedPlaceRef.current?.({
              ...stop,
              fallbackGmapsUrl: gmapsUrl,
            });
          });
        }
      });
      markersRef.current.push(
        new maplibregl.Marker({ element: el }).setLngLat([stop.lng, stop.lat]).setPopup(popup).addTo(map)
      );
    });

    // Fit the whole route in view — but ONLY when we're previewing a route
    // (not during navigation). If we fitBounds during nav, the map zooms out
    // and looks broken until the next GPS fix re-centers it (or never, in
    // the sim where GPS is one-shot). Reroutes are the common trigger.
    if (!navModeRef.current) {
      const coords = route.geometry.coordinates;
      const bounds = coords.reduce((b,c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
      const padding = isMobile ? { top:60, right:20, bottom:320, left:20 } : { top:60, right:60, bottom:60, left:60 };
      map.fitBounds(bounds, { padding, duration:900, maxZoom:14 });
    }
  }

  // ── Navigation ────────────────────────────────────────────────────────────
  function speak(text) {
    if (voiceMutedRef.current) return;
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickBestVoice();
    if (v) u.voice = v;
    u.rate = 1.0; u.volume = 1.0; u.pitch = 1.0;
    window.speechSynthesis.speak(u);
  }

  function restoreRecentRoute(r) {
    if (r.geometry) {
      setRouteData(r);
      setCurrentIntent(r.intent || null);
      setRouteApproved(false);
      setRefineOpen(false);
      setMessages([{ role:'route', route:r }]);
      drawRouteOnMap(r);
      localStorage.setItem(LAST_ROUTE_KEY, JSON.stringify(r));
      if (isMobile) setSheetMode('collapsed');
    } else {
      setQuery(r.title); submitQuery(r.title);
    }
  }

  // Off-route detection thresholds. Calibrated for motorcycle speeds:
  //   - 40 m balances responsiveness with real-world GPS noise. iPhone GPS
  //     is ~5–15 m in open sky and can spike to 30+ m under tree cover, in
  //     urban canyons, or near tall trucks. The map polyline is also drawn
  //     down the road centreline, so a rider in the actual lane is already
  //     ~3–5 m off. 20 m made the trigger fire constantly on real rides.
  //   - 3 s of sustained off-route filters out one-shot GPS spikes.
  //   - 10 s reroute cooldown applies to all attempts (changed OR unchanged).
  //     Previously we used a 3 s cooldown for unchanged routes; combined
  //     with the rider sometimes staying in GraphHopper's snap zone, this
  //     produced an infinite "Recalculating…" loop on real rides.
  // For reference: Apple Maps ~50–80 m / 10 s, Google ~30–50 m / 8 s,
  // Waze ~20–30 m / 5 s.
  const OFF_ROUTE_THRESHOLD_M = 40;
  const OFF_ROUTE_GRACE_MS    = 3000;
  const REROUTE_COOLDOWN_MS   = 10000;

  // Recalculate from the rider's current position when they've drifted off
  // the route. Sends a raw RouteRequest (NOT a refine) so Claude doesn't get
  // re-invoked — `refine: true` made Claude interpret "recalculate" as "add
  // waypoints to get back to the original route", producing routes that
  // looked unchanged on the map even though the voice was saying new turns.
  // Apple/Google Maps both do the same: throw the old route away, plan a
  // fresh path from current GPS to the original destination, accept that
  // the new path may not rejoin the old one.
  async function rerouteFromCurrentPosition(lat, lng) {
    if (reroutingRef.current) return false;

    // Build a destination from whichever source has one. Priority:
    //   1. currentIntent.destination — the LLM's raw output (string or object)
    //   2. routeData.destination — the resolved destination string the
    //      edge function returned, present on every route
    //   3. last waypoint coord — works even when the route was restored from
    //      a shared route or recents (no intent at all)
    // Returns null if NONE are available, in which case we can't reroute.
    // Coord-string pattern: "41.320895,-73.991731" or "41.32,-73.99"
    // The server saves a coord-string as destName whenever the original
    // destination payload was a LatLng, so subsequent reroutes can see it.
    // We need to recognise that and send it as a real LatLng — not as a
    // `query`, because Google Places rejects coord-strings as text queries
    // (HTTP 400 "Coordinates are not a valid input for the query search").
    const parseCoordString = (s) => {
      if (typeof s !== 'string') return null;
      const m = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
      if (!m) return null;
      const lat = parseFloat(m[1]);
      const lng = parseFloat(m[2]);
      if (isNaN(lat) || isNaN(lng)) return null;
      return { lat, lng };
    };

    const buildDestination = () => {
      const fromIntent = currentIntent?.destination;
      if (fromIntent) {
        if (typeof fromIntent === 'string') {
          const asCoord = parseCoordString(fromIntent);
          if (asCoord) return asCoord;
          return { query: fromIntent };
        }
        if (typeof fromIntent === 'object' && 'lat' in fromIntent) return fromIntent;
        if (typeof fromIntent === 'object' && 'query' in fromIntent) {
          const asCoord = parseCoordString(fromIntent.query);
          if (asCoord) return asCoord;
          return fromIntent;
        }
      }
      const r = routeDataRef.current;
      if (r?.destination && typeof r.destination === 'string') {
        const asCoord = parseCoordString(r.destination);
        if (asCoord) return asCoord;
        return { query: r.destination };
      }
      const wps = r?.waypoints;
      if (Array.isArray(wps) && wps.length) {
        const last = wps[wps.length - 1];
        if (last?.lat != null && last?.lng != null) return { lat: last.lat, lng: last.lng };
      }
      const coords = r?.geometry?.coordinates;
      if (Array.isArray(coords) && coords.length) {
        const [lng, lat] = coords[coords.length - 1];
        if (lat != null && lng != null) return { lat, lng };
      }
      return null;
    };

    const destination = buildDestination();
    if (!destination) {
      console.warn('[reroute] no destination available from intent, routeData, or waypoints — skipping');
      logNavEvent('reroute_failed', {
        lat, lng,
        metadata: { error: 'no_destination_available' },
      });
      return false;  // false = don't start the cooldown, let the next off-route try again
    }

    reroutingRef.current = true;
    setRerouting(true);
    speak('Recalculating.');

    const oldFirstCoord = routeDataRef.current?.geometry?.coordinates?.[0];
    console.log(`[reroute] start lat=${lat.toFixed(6)} lng=${lng.toFixed(6)}`,
                'destination=', JSON.stringify(destination),
                'oldFirst=', oldFirstCoord);
    logNavEvent('reroute_request', {
      lat, lng,
      metadata: { destination, old_first_coord: oldFirstCoord },
    });

    let success = false;
    try {
      const reroutePayload = {
        origin: { lat, lng },
        destination,
        // Tag for the route_logs linkage so the admin Ride Detail timeline
        // can label this pipeline call as a reroute (not the initial query).
        event_origin: 'reroute',
        // Drop any old anchor waypoints — they were chosen for the original
        // origin and would pull the new route back toward the old path.
        intermediate_waypoints: [],
        // Preserve scenic intent so the rider doesn't get dumped onto a
        // highway just because they missed a turn.
        road_corridor: currentIntent?.road_corridor || undefined,
        curviness: currentIntent?.curviness ?? 2,
        round_trip: false,
      };
      const oldGeomKey = JSON.stringify(routeDataRef.current?.geometry?.coordinates?.slice(0, 5));
      const oldLength  = routeDataRef.current?.geometry?.coordinates?.length;
      console.log('[reroute] calling generateRoute, oldRoute coords=', oldLength);
      const genResult = await generateRoute(reroutePayload, { lat, lng });
      // If generateRoute swallowed a server error, treat as a real failure
      // (not a "complete with no change"). Without this, off-route during a
      // server outage produced misleading reroute_complete events showing
      // huge dist_from_rider distances vs. the unchanged original polyline.
      if (genResult && genResult.ok === false && !genResult.aborted) {
        throw new Error(genResult.error || 'generateRoute failed');
      }
      const newFirstCoord = routeDataRef.current?.geometry?.coordinates?.[0];
      const newGeomKey = JSON.stringify(routeDataRef.current?.geometry?.coordinates?.slice(0, 5));
      const newLength  = routeDataRef.current?.geometry?.coordinates?.length;
      const changed = oldGeomKey !== newGeomKey;
      console.log('[reroute] done. newFirst=', newFirstCoord, 'newLength=', newLength,
                  'changed=', changed,
                  changed ? '' : '(server returned identical first 5 coords)');
      // Distance from rider's current position to the new route's first coord —
      // this is THE diagnostic for the "reroute starts somewhere else" bug.
      const newFirstLat = newFirstCoord?.[1];
      const newFirstLng = newFirstCoord?.[0];
      const distFromRiderM = (newFirstLat != null && newFirstLng != null)
        ? Math.round(haversineM(lat, lng, newFirstLat, newFirstLng))
        : null;
      logNavEvent('reroute_complete', {
        lat, lng,
        metadata: {
          changed,
          new_first_lat: newFirstLat ?? null,
          new_first_lng: newFirstLng ?? null,
          dist_from_rider_m: distFromRiderM,
          new_length: newLength ?? null,
          drive_minutes: routeDataRef.current?.drive_minutes ?? null,
          raw_gh_minutes: routeDataRef.current?.raw_time_minutes ?? null,
          total_minutes: routeDataRef.current?.total_minutes ?? null,
        },
      });
      if (changed) {
        // Reset turn-announcement debouncer so the rider hears the first
        // instruction on the new route instead of waiting for the next bucket.
        lastAnnouncedRef.current = null;
        success = 'changed';
      } else {
        // Server returned the same route — rider's position snapped to the
        // same starting road point as the existing route. Caller uses a
        // short cooldown so we re-attempt as soon as the rider moves out of
        // that snap zone, without spamming the API.
        success = 'unchanged';
      }
    } catch (e) {
      console.warn('[reroute] failed:', e?.message || e);
      logNavEvent('reroute_failed', {
        lat, lng,
        metadata: { error: String(e?.message || e) },
      });
      // Mark as errored (vs unattempted) so the caller applies a cooldown.
      // Without this, a flaking server (e.g. today's Tailscale outage) puts
      // the client in a tight reroute loop — see route_logs cluster of 80+
      // errors against the same client in a 4-min window on 2026-06-10.
      success = 'errored';
    } finally {
      reroutingRef.current = false;
      setRerouting(false);
      offRouteSinceRef.current = null;
    }
    // After a successful reroute, immediately trigger a fresh GPS tick so the
    // bearing/match recomputes against the new polyline. On a real bike, the
    // next watchPosition fix arrives within a second, but in the simulator
    // (Custom Location is one-shot) nothing else fires until the rider moves,
    // so the overlay would otherwise show stale OFF and stale next-turn until
    // the next manual interaction.
    if (success === 'changed' && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(onGeoPosition, () => {}, { enableHighAccuracy: true });
    }
    return success;
  }

  // Switch the active map polyline + state to a route that's already in the
  // conversation thread (e.g. when the rider refined to "more curvy" and now
  // wants the original back). Unlike restoreRecentRoute, this preserves the
  // existing `messages` array so the rider can keep toggling between options.
  function selectThreadRoute(r) {
    if (!r?.geometry) return;
    setRouteData(r);
    setCurrentIntent(r.intent || null);
    setRouteApproved(false);
    drawRouteOnMap(r);
    localStorage.setItem(LAST_ROUTE_KEY, JSON.stringify(r));
    if (isMobile) setSheetMode('collapsed');
  }

  function startNavigation() {
    setNavMode(true);
    navModeRef.current = true;
    // Start a fresh nav session id so all events from this ride group together.
    navSessionIdRef.current = crypto.randomUUID();
    logNavEvent('nav_start', {
      lat: userLocation?.lat,
      lng: userLocation?.lng,
      metadata: {
        route_title: routeData?.title,
        distance_mi: routeData?.distance_mi,
        drive_minutes: routeData?.drive_minutes,
        stop_minutes: routeData?.stop_minutes,
        total_minutes: routeData?.total_minutes,
        destination: routeData?.destination,
      },
    });
    lastAnnouncedRef.current = null;
    lastNavPosRef.current = null;
    // Clear any leftover off-route state from a previous nav session.
    offRouteSinceRef.current = null;
    lastRerouteAtRef.current = 0;
    lastOffRoutePosRef.current = null;
    if (offRouteTimerRef.current) { clearTimeout(offRouteTimerRef.current); offRouteTimerRef.current = null; }
    // Fresh nav starts in follow-mode; rider hasn't touched the map yet.
    followingUserRef.current = true;
    setNeedsRecenter(false);
    if (navMapPannedReturnRef.current) { clearTimeout(navMapPannedReturnRef.current); navMapPannedReturnRef.current = null; }

    // Initial bearing = tangent of the polyline segment nearest the rider.
    const r = routeData;
    let initialBearing = 0;
    if (r?.geometry?.coordinates && userLocation) {
      const mm = projectOntoRoute(userLocation.lat, userLocation.lng, r);
      if (mm) initialBearing = mm.segmentBearing;
    }
    navBearingRef.current = initialBearing;

    navigator.wakeLock?.request('screen')
      .then(lock => { wakeLockRef.current = lock; })
      .catch(() => {});

    if (userLocation && mapRef.current) {
      mapRef.current.easeTo({
        center: [userLocation.lng, userLocation.lat],
        zoom: 17, pitch: 55, bearing: initialBearing,
        duration: 800,
      });
    }

    // Trigger an immediate position fix in case userLocation is stale
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(onGeoPosition, () => {}, { enableHighAccuracy: true });
    }

    // Pin screen brightness to 100% during navigation so the rider can read
    // the map in direct sunlight. iOS auto-brightness sometimes mis-reads
    // glare and dims the screen — overriding here keeps it bright until nav
    // stops. iOS reverts to the user's chosen brightness automatically when
    // the app backgrounds; we restore manually on stopNavigation. Dynamically
    // imported so the web build still runs (plugin is iOS/Android only).
    if (Capacitor.isNativePlatform()) {
      import('@capacitor-community/screen-brightness').then(({ ScreenBrightness }) => {
        ScreenBrightness.getBrightness()
          .then(({ brightness }) => { prevBrightnessRef.current = brightness; })
          .catch(() => {});
        ScreenBrightness.setBrightness({ brightness: 1.0 }).catch(() => {});
      }).catch(e => console.warn('[brightness] plugin unavailable:', e?.message || e));
    }

    if (isMobile) setSheetMode('collapsed');
  }

  function stopNavigation() {
    logNavEvent('nav_stop', { metadata: { reason: 'manual' } });
    navSessionIdRef.current = null;
    setNavMode(false);
    navModeRef.current = false;
    setNextTurn(null);
    setNavProgress(null);
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
    // Restore the user's pre-nav brightness. If we never captured one (plugin
    // failed, web build, etc.) just leave the system alone.
    if (Capacitor.isNativePlatform() && prevBrightnessRef.current != null) {
      const target = prevBrightnessRef.current;
      prevBrightnessRef.current = null;
      import('@capacitor-community/screen-brightness').then(({ ScreenBrightness }) => {
        ScreenBrightness.setBrightness({ brightness: target }).catch(() => {});
      }).catch(() => {});
    }
    // Cancel any pending off-route trigger so it can't fire after nav stops.
    offRouteSinceRef.current = null;
    lastOffRoutePosRef.current = null;
    if (offRouteTimerRef.current) { clearTimeout(offRouteTimerRef.current); offRouteTimerRef.current = null; }
    // Clear the map-follow state too so the next nav session starts clean.
    followingUserRef.current = true;
    setNeedsRecenter(false);
    if (navMapPannedReturnRef.current) { clearTimeout(navMapPannedReturnRef.current); navMapPannedReturnRef.current = null; }
    // Restore a normal flat north-up view.
    if (mapRef.current) {
      mapRef.current.easeTo({ bearing: 0, pitch: 0, zoom: 13, duration: 600 });
    }
    // Restore the FULL polyline now that the rider has finished or cancelled
    // — during nav we trimmed it to "ahead only" each GPS tick. Without this,
    // the route preview after nav would still be the last sliced version.
    const r = routeDataRef.current;
    if (r?.geometry && mapRef.current?.getSource('route')) {
      try { mapRef.current.getSource('route').setData({ type: 'Feature', geometry: r.geometry }); }
      catch {}
    }
  }

  function centerOnUser() {
    if (userLocation && mapRef.current) {
      mapRef.current.flyTo({ center: [userLocation.lng, userLocation.lat], zoom: 14, duration: 600 });
    }
  }

  // Recenter the map on the rider during navigation. Re-enables auto-follow,
  // smooth-eases back to the nav camera (centered, zoomed in, tilted, bearing
  // aligned to direction of travel). Called by the floating recenter button
  // and by the 5-second auto-return timer after a pinch-zoom interaction.
  function recenterMapOnRider() {
    if (!navModeRef.current || !mapRef.current) return;
    followingUserRef.current = true;
    setNeedsRecenter(false);
    if (navMapPannedReturnRef.current) {
      clearTimeout(navMapPannedReturnRef.current);
      navMapPannedReturnRef.current = null;
    }
    const u = userLocation;
    if (u) {
      mapRef.current.easeTo({
        center: [u.lng, u.lat],
        zoom: 17,
        bearing: navBearingRef.current,
        pitch: 55,
        duration: 700,
      });
    }
  }

  // ── Auto scroll ───────────────────────────────────────────────────────────
  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // ── Recover navigation after app is backgrounded and foregrounded ─────────
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !navModeRef.current) return;
      // Re-acquire wake lock (it is automatically released when backgrounded)
      navigator.wakeLock?.request('screen')
        .then(lock => { wakeLockRef.current = lock; })
        .catch(() => {});
      // Reset speech synthesis — iOS leaves it in a broken state after backgrounding
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      // Re-draw the route polyline: when iOS reclaims the WebGL surface during
      // backgrounding the route-line and route-casing layers vanish, leaving
      // navigation running over a map with no visible line. Calling
      // drawRouteOnMap with the current route re-adds the source + layers.
      const activeRoute = routeDataRef.current;
      if (activeRoute?.geometry && mapRef.current) {
        try { drawRouteOnMap(activeRoute); }
        catch (e) { console.warn('[foreground] failed to redraw route:', e?.message || e); }
      }
      // Trigger a fresh GPS fix and re-centre the map
      if (navigator.geolocation && mapRef.current) {
        navigator.geolocation.getCurrentPosition(
          pos => {
            const { latitude: lat, longitude: lng } = pos.coords;
            if (mapRef.current) {
              mapRef.current.easeTo({
                center: [lng, lat], zoom: 17,
                bearing: navBearingRef.current, pitch: 55,
                duration: 600,
              });
            }
          },
          () => {},
          { enableHighAccuracy: true, timeout: 8000 }
        );
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    // iOS WKWebView sometimes keeps document.visibilityState as 'visible' even
    // when the app is backgrounded (no transition → no visibilitychange event
    // on foreground). Capacitor's appStateChange fires reliably; pipe it into
    // the same recovery handler.
    let capSub = null;
    if (Capacitor.isNativePlatform()) {
      CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) onVisible();
      }).then(s => { capSub = s; }).catch(() => {});
    }
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      try { capSub?.remove?.(); } catch {}
    };
  }, []);

  // ── Track keyboard height via visualViewport so sheet stays above keyboard ─
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const kbH = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
      document.documentElement.style.setProperty('--keyboard-height', `${kbH}px`);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      document.documentElement.style.setProperty('--keyboard-height', '0px');
    };
  }, []);

  // ── Generate route ────────────────────────────────────────────────────────
  async function generateRoute(payload, gps = null) {
    setLoading(true); setError(null);
    const cycle = ['Planning your ride…','Finding scenic roads…','Checking stops…','Almost there…'];
    let ci = 0; setLoadingMsg(cycle[0]);
    const ticker = setInterval(() => { ci=(ci+1)%cycle.length; setLoadingMsg(cycle[ci]); }, 2500);

    // Make the in-flight request cancellable so the rider can hit X while
    // we're "thinking" and go back to a blank slate. cancelGeneration()
    // calls .abort() on this controller, which makes fetch throw AbortError.
    const controller = new AbortController();
    routeAbortRef.current = controller;
    // Belt-and-suspenders defense against late responses: even if the
    // AbortController fails (some webviews don't honor signal after the
    // response has started buffering), this stamp lets us discard results
    // from a generation that's no longer the current one. cancelGeneration
    // bumps routeGenRef so myGen !== routeGenRef.current → discard.
    const myGen = ++routeGenRef.current;
    const stale = () => controller.signal.aborted || routeGenRef.current !== myGen;

    try {
      const token = session?.access_token || SUPABASE_ANON_KEY;
      const body = { ...payload, user_id: session?.user?.id || null };
      if (gps) { body.userLat = gps.lat; body.userLng = gps.lng; }
      // Linkage so the admin portal can stitch route_logs ↔ nav_events for
      // a unified ride timeline. nav_session_id is set whenever navigation
      // is active (reroutes during a ride). event_origin is set by the
      // caller for non-default flows; default it from payload shape.
      if (navSessionIdRef.current) body.nav_session_id = navSessionIdRef.current;
      if (!body.event_origin) body.event_origin = payload?.refine ? 'refine' : 'initial_query';
      console.log('[generateRoute] sending body keys=', Object.keys(body).join(','),
                  'userLat=', body.userLat, 'userLng=', body.userLng,
                  'destination=', JSON.stringify(body.destination));

      const res = await fetch(EDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${token}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // Guard: if the rider hit Stop while the response was in flight (the
      // server-side function still runs to completion and the body may already
      // be buffered locally), discard the result instead of dropping a stale
      // route onto the map while the rider is recording a new prompt.
      if (stale()) { clearInterval(ticker); return; }
      const data = await res.json();
      if (stale()) { clearInterval(ticker); return; }
      clearInterval(ticker);
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      if (data.clarify) {
        if (stale()) return;
        setMessages(prev => [...prev, {
          role:'clarify', question:data.question, options:data.options||[],
          onSelect:(opt) => handleFollowUp(opt),
        }]);
        if (isMobile) setSheetMode('expanded');
        return;
      }

      if (stale()) return;
      const r = data.route;
      setRouteData(r);
      setCurrentIntent(r.intent);
      setRouteApproved(false);
      setRefineOpen(false);
      setMessages(prev => [...prev, { role:'route', route:r }]);
      drawRouteOnMap(r);
      if (isMobile) setSheetMode('collapsed');

      // Store full geometry so recent rides can be redrawn without an API call
      const entry = { id:Date.now(), title:r.title, destination:r.destination, distance_mi:r.distance_mi, duration_str:r.duration_str, geometry:r.geometry, intent:r.intent, stops:r.stops||[], instructions:r.instructions||[] };
      const updated = [entry, ...recent.filter(x=>x.title!==entry.title)].slice(0,5);
      setRecent(updated); localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
      // Persist last active route so it survives tab switches and reloads
      localStorage.setItem(LAST_ROUTE_KEY, JSON.stringify(r));
      return { ok: true };

    } catch(err) {
      clearInterval(ticker);
      // Rider hit the X button to abort; not a real error — stay silent.
      if (err.name !== 'AbortError') setError(err.message);
      // Return an explicit failure so callers (e.g. rerouteFromCurrentPosition)
      // can log reroute_failed instead of misleading reroute_complete.
      return { ok: false, error: err?.message || String(err), aborted: err?.name === 'AbortError' };
    }
    finally {
      setLoading(false);
      if (routeAbortRef.current === controller) routeAbortRef.current = null;
      // Clear the input now that planning is done (success, error, or clarify).
      // The captured prompt was visible during loading so the rider could
      // verify what was heard; once we have a route to show, the input goes
      // back to "Where do you want to ride?" placeholder.
      setQuery('');
    }
  }

  // Cancel an in-flight route generation and reset the UI to a blank slate.
  // Wired into the orange stop pill on the loading hero. Cleans up four things:
  //   1. The fetch (abort + null the ref so guard checks in generateRoute fail)
  //   2. React state (messages, query, routeData, etc.)
  //   3. The map polyline — drawRouteOnMap(null) actually removes the layers,
  //      because setRouteData(null) alone leaves the previous polyline visible
  //   4. The pendingRoute queue, so an earlier-queued route can't draw later
  //      when the map finishes loading
  function cancelGeneration() {
    routeAbortRef.current?.abort();
    routeAbortRef.current = null;
    // Bump the generation counter — any in-flight generateRoute whose `myGen`
    // is now != routeGenRef.current will discard its result via stale().
    routeGenRef.current++;
    pendingRoute.current = null;
    setMessages([]);
    setError(null);
    setQuery('');
    setRouteData(null);
    setRouteApproved(false);
    setLoading(false);
    drawRouteOnMap(null);
    localStorage.removeItem(LAST_ROUTE_KEY);
  }

  async function submitQuery(q) {
    const text = (q || query).trim();
    if (!text || loading) return;
    // Stop voice recognition so it doesn't keep appending to the next query.
    if (voice.listening) voice.stop();
    // Keep the captured prompt visible in the input pill while we plan — the
    // rider may not have been watching when the words appeared. We clear it
    // in generateRoute's `finally` once planning is done.
    setQuery(text);
    setMessages([{ role:'user', content:text }]);
    setRouteData(null); setRouteApproved(false);
    // Don't expand the sheet — stay in idle/compact view while loading.
    // Sheet transitions to 'collapsed' automatically when route arrives.

    // Use the always-on watch position instantly if available.
    // Only block on a GPS call if the watch hasn't fired yet — and cap it at 1.5s
    // so the app never hangs. Route generation works fine without GPS (uses query text).
    let gps = userLocation;
    if (!gps) {
      setLoading(true);
      setLoadingMsg('Getting your location…');
      gps = await getCurrentGPS({ timeout: 1500, maximumAge: 30000 });
      setLoading(false);
    }

    if (gps && !isInServiceArea(gps.lat, gps.lng)) {
      setOutOfAreaToast(true);
      return;
    }

    generateRoute({ query: text }, gps);
  }

  async function handleFollowUp(text) {
    const t = (text || followUpInput).trim();
    if (!t || loading) return;
    setFollowUpInput(''); setRefineOpen(false);
    if (isApproval(t)) { setRouteApproved(true); if (isMobile) setSheetMode('collapsed'); return; }
    setMessages(prev => [...prev, { role:'user', content:t }]);
    if (isMobile) setSheetMode('expanded');

    const gps = userLocation || await getCurrentGPS({ timeout: 1500, maximumAge: 30000 });
    if (gps && !isInServiceArea(gps.lat, gps.lng)) {
      setOutOfAreaToast(true);
      return;
    }
    await generateRoute(currentIntent ? { refine:true, feedback:t, intent:currentIntent } : { query:t }, gps);
  }

  // Capture the current map view to a JPEG data URL. Requires the MapLibre
  // canvas to have been created with preserveDrawingBuffer:true (already set
  // in the map init).
  async function captureMapNow() {
    const map = mapRef.current;
    if (!map) return null;
    try {
      map.triggerRepaint();
      await new Promise(resolve => {
        const done = () => resolve();
        map.once('render', done);
        setTimeout(done, 600);
      });
      const canvas = map.getCanvas();
      const data = canvas.toDataURL('image/jpeg', 0.6);
      if (!data || data === 'data:,' || data.length < 100) {
        console.warn('[screenshot] blank or empty canvas');
        return null;
      }
      return data;
    } catch (e) {
      console.error('[captureMapNow]', e?.name, e?.message);
      return null;
    }
  }

  // Open the dedicated bug-report sheet. Snapshot the map RIGHT NOW so the
  // user's framing (zoom + pan) is preserved even if they keep scrolling
  // around while typing the comment.
  async function openBugReport() {
    setBugComment('');
    setBugDone(false);
    setBugReportOpen(true);
    const shot = await captureMapNow();
    setBugScreenshot(shot);
  }

  async function retakeBugScreenshot() {
    setBugScreenshot(null);
    const shot = await captureMapNow();
    setBugScreenshot(shot);
  }

  async function submitBug() {
    if (bugSubmitting) return;
    setBugSubmitting(true);
    try {
      const query = messages.find(m=>m.role==='user')?.content || '';
      await fetch(`${SUPABASE_URL}/rest/v1/bug_reports`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'apikey':SUPABASE_ANON_KEY,
          'Authorization':`Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
          'Prefer':'return=minimal' },
        body: JSON.stringify({
          user_id: session?.user?.id || null,
          route_id: routeData?.id || null,
          comment: bugComment,
          image_data: bugScreenshot,
          page_context: query || null,
          created_at: new Date().toISOString(),
          route_context: routeData ? {
            title: routeData.title || null,
            destination: routeData.destination || null,
            distance_mi: routeData.distance_mi || null,
            duration_str: routeData.duration_str || null,
            // Claude's routing decisions — the most useful context for lesson extraction
            escape_waypoint: routeData.intent?.escape_waypoint || null,
            escape_via_waypoints: routeData.intent?.escape_via_waypoints || null,
            intermediate_waypoints: routeData.intent?.intermediate_waypoints || null,
            curviness: routeData.intent?.curviness || null,
            origin_query: routeData.intent?.origin || null,
            destination_query: routeData.intent?.destination || null,
          } : null,
        }),
      });
      setBugDone(true);
      setTimeout(() => {
        setBugReportOpen(false);
        setBugDone(false);
        setBugComment('');
        setBugScreenshot(null);
      }, 1800);
    } finally { setBugSubmitting(false); }
  }

  // ── Auth gates ────────────────────────────────────────────────────────────
  if (!authReady) return <div className="loading-shell"><span className="dot-spin"/></div>;
  if (!session) return <LoginScreen />;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="app-shell">

      {/* Friendship status toast — floats over everything, auto-dismissed */}
      {friendToast && (
        <div className={`friend-toast friend-toast--${friendToast.kind}`}
             onClick={() => {
               setFriendToast(null);
               // If it's a shared-route notification, expand that section
               // immediately so the new route is one tap away.
               if (/shared a route/.test(friendToast.msg)) setSharedWithOpen(true);
               setMenuOpen(true);
               if (isMobile) setSheetMode('expanded');
             }}>
          {friendToast.msg}
        </div>
      )}

      {/* Bug-report sheet — slides up over the map with the captured screenshot
          + comment field. Snapshot was taken at the moment Report was tapped,
          so the user's framing is preserved while they type. */}
      {bugReportOpen && (
        <div className="bug-modal-backdrop" onClick={() => { if (!bugSubmitting) setBugReportOpen(false); }}>
          <div className="bug-modal" onClick={e => e.stopPropagation()}>
            <div className="bug-modal-header">
              <h3>Report an issue</h3>
              <button className="bug-modal-close"
                onClick={() => setBugReportOpen(false)}
                disabled={bugSubmitting}
                aria-label="Close">✕</button>
            </div>

            {bugDone ? (
              <div className="bug-modal-done">
                <div className="bug-modal-done-icon">✓</div>
                <div className="bug-modal-done-title">Thanks!</div>
                <div className="bug-modal-done-sub">Reviewing it now — your feedback improves future routes.</div>
              </div>
            ) : (
              <>
                <div className="bug-modal-shot">
                  {bugScreenshot ? (
                    <img src={bugScreenshot} alt="map snapshot"
                         onClick={() => setBugScreenshotZoom(true)}/>
                  ) : (
                    <div className="bug-modal-shot-placeholder">
                      <span className="dot-spin"/> capturing…
                    </div>
                  )}
                  <button className="bug-modal-retake"
                    onClick={retakeBugScreenshot}
                    disabled={bugSubmitting}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="1 4 1 10 7 10"/>
                      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                    </svg>
                    Retake
                  </button>
                </div>

                <label className="bug-modal-label">What's wrong here?</label>
                <textarea className="bug-modal-comment"
                  rows={4}
                  placeholder="e.g. 'Why is there a weird loop through the city?' or 'Detour goes through a parking lot'"
                  value={bugComment}
                  onChange={e => setBugComment(e.target.value)}
                  disabled={bugSubmitting}
                  autoFocus/>

                <div className="bug-modal-actions">
                  <button className="bug-modal-cancel"
                    onClick={() => setBugReportOpen(false)}
                    disabled={bugSubmitting}>
                    Cancel
                  </button>
                  <button className="bug-modal-submit"
                    onClick={submitBug}
                    disabled={bugSubmitting || !bugComment.trim()}>
                    {bugSubmitting ? 'Sending…' : 'Send report'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Full-screen screenshot preview — tap-to-dismiss */}
      {bugScreenshotZoom && bugScreenshot && (
        <div className="bug-shot-zoom" onClick={() => setBugScreenshotZoom(false)}>
          <img src={bugScreenshot} alt="map snapshot full size"/>
        </div>
      )}

      {/* Delete-account confirmation — Apple Guideline 5.1.1(v).
          Requires typing "DELETE" to enable the destructive button so an
          accidental tap can't nuke the account. */}
      {deleteAccountOpen && (
        <div className="bug-modal-backdrop"
          onClick={() => { if (!deleteSubmitting) setDeleteAccountOpen(false); }}>
          <div className="bug-modal" onClick={e => e.stopPropagation()}>
            <div className="bug-modal-header">
              <h3>Delete account</h3>
              <button className="bug-modal-close"
                onClick={() => setDeleteAccountOpen(false)}
                disabled={deleteSubmitting}
                aria-label="Close">✕</button>
            </div>

            <p className="delete-account-warning">
              This permanently removes your account, profile, friendships,
              shared routes, and live position data. It cannot be undone.
            </p>

            <label className="bug-modal-label">
              Type <strong>DELETE</strong> to confirm:
            </label>
            <input className="bug-modal-comment"
              style={{ minHeight: 0, height: 44 }}
              type="text"
              inputMode="text"
              name="confirmDelete"
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore
              value={deleteConfirmText}
              onChange={e => setDeleteConfirmText(e.target.value)}
              disabled={deleteSubmitting}
              placeholder="DELETE"
              autoFocus
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}/>

            {deleteError && (
              <div className="error-banner" style={{ marginTop: 8 }}>{deleteError}</div>
            )}

            <div className="bug-modal-actions">
              <button className="bug-modal-cancel"
                onClick={() => setDeleteAccountOpen(false)}
                disabled={deleteSubmitting}>
                Cancel
              </button>
              <button className="bug-modal-submit menu-delete-account"
                onClick={async () => {
                  setDeleteSubmitting(true);
                  setDeleteError(null);
                  try {
                    const { data: sessionData } = await supabase.auth.getSession();
                    const token = sessionData?.session?.access_token;
                    if (!token) throw new Error('Not signed in.');
                    const res = await fetch(`${SUPABASE_URL}/functions/v1/delete-account`, {
                      method: 'POST',
                      headers: {
                        'Authorization': `Bearer ${token}`,
                        'apikey': SUPABASE_ANON_KEY,
                      },
                    });
                    const body = await res.json().catch(() => ({}));
                    if (!res.ok || !body.ok) {
                      throw new Error(body.error || `Server error (${res.status}).`);
                    }
                    // Wiped server-side — now clear local session + state.
                    await supabase.auth.signOut();
                    try { localStorage.removeItem(RECENT_KEY); } catch {}
                    setDeleteAccountOpen(false);
                  } catch (err) {
                    setDeleteError(err.message || 'Delete failed. Try again or email support@twotired.net.');
                  } finally {
                    setDeleteSubmitting(false);
                  }
                }}
                disabled={deleteSubmitting || deleteConfirmText !== 'DELETE'}>
                {deleteSubmitting ? 'Deleting…' : 'Delete forever'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Share-this-route modal — pick a mate to send the current route to. */}
      {shareModalOpen && (
        <div className="share-modal-backdrop" onClick={() => setShareModalOpen(false)}>
          <div className="share-modal" onClick={e => e.stopPropagation()}>
            <div className="share-modal-header">
              <h3>Share this ride</h3>
              <button className="share-modal-close" onClick={() => setShareModalOpen(false)} aria-label="Close">✕</button>
            </div>
            {routeData && (
              <div className="share-modal-route">
                <div className="share-modal-route-title">{routeData.title || 'Route'}</div>
                <div className="share-modal-route-meta">
                  {routeData.distance_mi != null ? `${routeData.distance_mi.toFixed(0)} mi` : ''}
                  {routeData.duration_str ? ` · ${routeData.duration_str}` : ''}
                </div>
              </div>
            )}
            <div className="share-modal-section-label">Send to</div>
            {friendships.filter(f => f.status === 'accepted' && f.friend).length === 0 && (
              <div className="share-modal-empty">No connected mates yet. Invite a friend first.</div>
            )}
            <div className="share-modal-list">
              {friendships.filter(f => f.status === 'accepted' && f.friend).map(f => (
                <button key={f.id} className="share-modal-friend"
                  disabled={sharingRoute}
                  onClick={() => shareRouteWith(f.friend.user_id)}>
                  <Avatar name={f.friend.display_name} size={36} />
                  <span className="share-modal-friend-name">{f.friend.display_name}</span>
                  <span className="share-modal-friend-action">{sharingRoute ? '…' : 'Send'}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Announcement banner — pinned at the top of the screen, above the map
          and nav UI. Critical announcements can't be dismissed; everything
          else has an X. Single banner at a time (priority-sorted in
          visibleAnnouncement). */}
      {visibleAnnouncement && (
        <div className={`announcement announcement--${visibleAnnouncement.kind}`} role={visibleAnnouncement.kind === 'critical' ? 'alert' : 'status'}>
          <span className="announcement-icon" aria-hidden>
            {visibleAnnouncement.kind === 'critical'    ? '⚠️'
             : visibleAnnouncement.kind === 'maintenance' ? '🛠'
             : visibleAnnouncement.kind === 'warning'     ? '⚠'
             :                                              'ℹ︎'}
          </span>
          <div className="announcement-body">
            <span className="announcement-title">{visibleAnnouncement.title}</span>
            {visibleAnnouncement.body && (
              <span className="announcement-text">{visibleAnnouncement.body}</span>
            )}
            {visibleAnnouncement.url && (
              <a className="announcement-link"
                 href={visibleAnnouncement.url}
                 target="_blank" rel="noreferrer">
                {visibleAnnouncement.url_label || 'Learn more'} →
              </a>
            )}
          </div>
          {visibleAnnouncement.dismissible !== false && visibleAnnouncement.kind !== 'critical' && (
            <button className="announcement-dismiss"
              onClick={() => dismissAnnouncement(visibleAnnouncement.id)}
              aria-label="Dismiss">✕</button>
          )}
        </div>
      )}

      {/* Out-of-service-area toast — fixed at the top of the screen, visible
          regardless of sheet mode. User must tap × to dismiss. */}
      {outOfAreaToast && (
        <div className="oa-toast" role="alert" aria-live="assertive">
          <div className="oa-toast-body">{OUT_OF_AREA_MSG}</div>
          <button className="oa-toast-close"
            onClick={() => setOutOfAreaToast(false)}
            aria-label="Dismiss">✕</button>
        </div>
      )}

      {/* Full-screen Google Maps Embed for a tapped stop. Uses Maps Embed API
          (Place mode) which renders Google's native place card — photos,
          reviews, hours, ratings, phone — inside an iframe. Falls back to a
          plain external link if no API key is configured or no placeId. */}
      {selectedPlace && (
        <PlaceModal
          place={selectedPlace}
          onClose={() => setSelectedPlace(null)}
        />
      )}

      {/* Map panel — locate button moved into the sheet handle row */}
      <div className="map-panel">
        <div ref={mapContainerRef} className={`map-canvas${navMode ? ' map-canvas--nav' : ''}`}/>
        {/* Floating Report-issue button. Always visible above the map so users
            can flag whatever they're looking at (weird route, missing road,
            etc.) without losing their place. Tapping snapshots the current
            map view and opens the dedicated report sheet. */}
        {!navMode && (
          <button className="report-fab"
            onClick={openBugReport}
            aria-label="Report an issue">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 22V4c0-.6.4-1 1-1h13l-2 5 2 5H5"/>
              <line x1="4" y1="22" x2="4" y2="15"/>
            </svg>
          </button>
        )}
      </div>

      {/* ── Navigation overlay ── */}
      {navMode && (
        <div className="nav-overlay">
          {(() => {
            const labelInfo = nextTurn ? shortDestinationLabel(nextTurn.instruction) : { exit: null, street: 'Follow the route' };
            return (
              <div className="nav-turn-banner">
                {/* Row 1 — glance line: arrow, distance, optional exit chip */}
                <div className="nav-turn-row1">
                  <span className="nav-turn-arrow">
                    {nextTurn ? turnArrow(nextTurn.instruction.sign, nextTurn.instruction.text) : '↑'}
                  </span>
                  {nextTurn && (
                    <span className="nav-turn-dist">{formatDist(nextTurn.dist)}</span>
                  )}
                  {labelInfo.exit && (
                    <span className="nav-turn-exit">{labelInfo.exit}</span>
                  )}
                  <div className="nav-turn-row1-spacer"/>
                  <button
                    className={`nav-voice-btn${voiceMuted ? ' nav-voice-btn--muted' : ''}`}
                    onClick={toggleVoiceMute}
                    aria-pressed={voiceMuted}
                    aria-label={voiceMuted ? 'Unmute voice directions' : 'Mute voice directions'}
                  >
                    {voiceMuted ? (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                        <line x1="22" y1="9"  x2="16" y2="15"/>
                        <line x1="16" y1="9"  x2="22" y2="15"/>
                      </svg>
                    ) : (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                        <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                        <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
                      </svg>
                    )}
                  </button>
                  <button className="nav-stop-btn" onClick={stopNavigation} aria-label="Stop navigation">✕</button>
                </div>
                {/* Row 2 — destination: the big road name the rider is being
                    led onto (or the exit destination). One line, ellipsised. */}
                {labelInfo.street && (
                  <div className="nav-turn-row2">
                    <span className="nav-turn-street">{labelInfo.street}</span>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Reroute banner — sits between the top turn-banner and the bottom
              progress bar so it's clearly visible without covering either. */}
          {rerouting && (
            <div className="nav-reroute-banner" role="status" aria-live="polite">
              <span className="dot-spin nav-reroute-spinner"/>
              <span>Recalculating from your location…</span>
            </div>
          )}

          {needsRecenter && (
            <button className="nav-recenter-btn"
              onClick={recenterMapOnRider}
              aria-label="Recenter on rider">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>
              </svg>
            </button>
          )}

          <div className="nav-bottom-bar">
            <div className="nav-progress">
              <span className="nav-stat nav-stat--time">
                {navProgress ? formatRemainingTime(navProgress.timeMs) : '—'}
              </span>
              <span className="nav-stat-sep">·</span>
              <span className="nav-stat">
                {navProgress ? formatMilesShort(navProgress.distM) : (routeData?.distance_mi?.toFixed(0) + ' mi')}
              </span>
              <span className="nav-stat-sep">·</span>
              <span className="nav-stat nav-stat--eta">
                {navProgress ? `ETA ${formatETA(navProgress.timeMs)}` : ''}
              </span>
            </div>
            <span className="nav-route-title">{routeData?.title}</span>
          </div>
        </div>
      )}

      {/* Floating map FABs (locate + menu) — sit OVER the map, just above the
          sheet. Hidden when sheet is fully expanded or the menu drawer is open,
          since those modes need the buttons inside the sheet itself. */}
      {isMobile && !navMode && !menuOpen && sheetMode !== 'expanded' && (
        <div className="map-fab-row"
             style={{
               '--fab-bottom': (sheetMode === 'idle' ? idleSheetHeight : 240) + 'px',
             }}>
          <button
            className={`sheet-locate-btn${userLocation ? '' : ' sheet-locate-btn--dim'}`}
            onClick={centerOnUser}
            aria-label="Centre on my location"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>
            </svg>
          </button>
          <button
            className="sheet-menu-btn"
            onClick={() => { setSheetMode('expanded'); setMenuOpen(true); }}
            aria-label="Menu"
          >
            <svg width="18" height="14" viewBox="0 0 24 18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="3"  x2="21" y2="3"/>
              <line x1="3" y1="9"  x2="21" y2="9"/>
              <line x1="3" y1="15" x2="21" y2="15"/>
            </svg>
          </button>
        </div>
      )}

      {/* ════════════════ MOBILE bottom sheet ════════════════ */}
      {isMobile && !navMode ? (
        <div className={`sheet sheet--${sheetMode}${menuOpen ? ' sheet--menu-open' : ''}`}
             style={{
               ...(sheetMode === 'idle' ? { '--idle-height': idleSheetHeight + 'px' } : {}),
               ...(menuOpen           ? { '--menu-height': menuSheetHeight + 'px' } : {}),
             }}>

          {/* Handle row: drag bar (centre) + always-visible menu button (right) */}
          <div className="sheet-handle-row">
            <button
              className={`sheet-locate-btn${userLocation ? '' : ' sheet-locate-btn--dim'}`}
              onClick={centerOnUser}
              aria-label="Centre on my location"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>
              </svg>
            </button>
            {/* Centre spacer — pushes locate + hamburger to opposite edges. */}
            <div className="sheet-handle-spacer"/>
            <button
              className={`sheet-menu-btn${menuOpen ? ' active' : ''}`}
              onClick={() => {
                if (menuOpen) {
                  setSheetMode(routeData ? 'collapsed' : 'idle');
                  setMenuOpen(false);
                } else {
                  setSheetMode('expanded');
                  setMenuOpen(true);
                }
              }}
              aria-label="Menu"
            >
              <svg width="18" height="14" viewBox="0 0 24 18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="3"  x2="21" y2="3"/>
                <line x1="3" y1="9"  x2="21" y2="9"/>
                <line x1="3" y1="15" x2="21" y2="15"/>
              </svg>
            </button>
          </div>

          {!menuOpen && sheetMode === 'idle' && (
            <div className="sheet-idle">
              {/* Hero row: mic + recents toggle, side-by-side, both glove-friendly */}
              <div className="idle-hero-row">
                {loading ? (
                  <div className="hero-btn hero-btn--mic" style={{cursor:'default', pointerEvents:'none'}}>
                    <span className="dot-spin" style={{width:22,height:22,borderWidth:2.5}}/>
                  </div>
                ) : (
                  <button
                    className={`hero-btn hero-btn--mic${voice.listening ? ' hero-btn--listening' : ''}`}
                    onClick={() => {
                      if (query.trim()) { submitQuery(); }
                      else if (voice.supported) { voice.listening ? voice.stop() : voice.start(); }
                    }}
                    aria-label={query.trim() ? 'Submit' : 'Voice input'}
                  >
                    {voice.listening && <span className="mic-pulse"/>}
                    {query.trim() ? (
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>
                      </svg>
                    ) : (
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                        <line x1="12" y1="19" x2="12" y2="23"/>
                      </svg>
                    )}
                  </button>
                )}
                <button
                  className={`hero-btn hero-btn--recents${recentsOpen ? ' hero-btn--active' : ''}`}
                  onClick={() => setRecentsOpen(x => !x)}
                  aria-expanded={recentsOpen}
                  aria-label={recentsOpen ? 'Hide recent rides' : 'Show recent rides'}
                >
                  {recentsOpen ? (
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>
                    </svg>
                  ) : (
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="9"/>
                      <polyline points="12 7 12 12 15.5 14"/>
                    </svg>
                  )}
                </button>
              </div>
              {/* Text input — auto-resizing pill; sheet grows with it via --idle-height */}
              <div className="idle-input-row">
                <textarea ref={idleInputRef} rows={1}
                  className="query-input query-input--idle"
                  placeholder={loading ? loadingMsg
                    : voice.listening ? 'Listening…'
                    : 'Where do you want to ride?'}
                  value={query} onChange={e=>setQuery(e.target.value)}
                  onFocus={() => {
                    // If recents drawer is open when the user starts typing,
                    // close it. Otherwise the keyboard pushes the near-full-screen
                    // sheet up far enough that the input scrolls off the top.
                    if (recentsOpen) setRecentsOpen(false);
                  }}
                  onKeyDown={e=>{
                    if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); submitQuery(); }
                  }}
                  disabled={loading}/>
                {/* Universal kill switch — clears whatever the rider currently
                    has going. Single button that handles three states so the
                    rider always knows where the "out" is:
                      • loading → abort the in-flight planning request
                      • voice.listening → cancel recording + drop transcript
                      • typed text present → clear the textarea
                    The hero stays a clean "mic / submit" button untouched. */}
                {(loading || voice.listening || query) && (
                  <button className="query-input-clear"
                    onClick={() => {
                      if (loading)             cancelGeneration();
                      else if (voice.listening){ voice.cancel(); setQuery(''); }
                      else                     setQuery('');
                    }}
                    aria-label={
                      loading           ? 'Cancel planning'
                      : voice.listening ? 'Cancel recording'
                      :                   'Clear input'
                    }>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>
                    </svg>
                  </button>
                )}
              </div>
              {voice.error && (
                <div className="voice-error">{voice.error}</div>
              )}

              {/* Recents drawer fills the area below the input when open.
                  Mic + input remain visible at the top so the user can still
                  type/speak to filter or replace the query. */}
              {recentsOpen && (
                <div className="idle-recents">
                  <div className="idle-recents-header">Recent rides</div>
                  {recent.length > 0 ? (
                    <div className="idle-recents-list">
                      {recent.map(r => (
                        <button key={r.id}
                          className={`idle-recent-item${r.shared_from ? ' idle-recent-item--shared' : ''}`}
                          onClick={() => { setRecentsOpen(false); restoreRecentRoute(r); }}>
                          <span className="idle-recent-title">{r.title}</span>
                          <span className="idle-recent-meta">
                            {r.shared_from ? `↪ from ${r.shared_from} · ` : ''}
                            {r.distance_mi?.toFixed(0)} mi · {r.duration_str}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="idle-recents-empty">
                      <span className="idle-recents-empty-icon">
                        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="9"/>
                          <polyline points="12 7 12 12 15.5 14"/>
                        </svg>
                      </span>
                      <span className="idle-recents-empty-title">No rides yet</span>
                      <span className="idle-recents-empty-sub">Plan your first ride — it’ll show up here for quick re-runs.</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {!menuOpen && sheetMode === 'collapsed' && routeData && (
            <div className="sheet-collapsed-content">
              <div className="collapsed-info">
                <span className="collapsed-title">{routeData.title}</span>
                <span className="collapsed-meta">
                  {routeData.stop_duration_str
                    ? `Ride ${routeData.drive_duration_str} · Stops ${routeData.stop_duration_str} · ${routeData.distance_mi?.toFixed(0)} mi`
                    : `${routeData.duration_str} · ${routeData.distance_mi?.toFixed(0)} mi`}
                </span>
              </div>
              <button className="start-nav-btn" onClick={startNavigation}>▶ Navigate</button>
              <div className="route-secondary-actions">
                <button className="route-action-btn" onClick={() => {
                  setRouteData(null); setRouteApproved(false);
                  setMessages([]); setFollowUpInput(''); setQuery('');
                  setRefineOpen(false); setSheetMode('idle');
                  const m = mapRef.current;
                  if (m) {
                    if (m.getLayer('route-line'))   m.removeLayer('route-line');
                    if (m.getLayer('route-casing')) m.removeLayer('route-casing');
                    if (m.getSource('route'))       m.removeSource('route');
                  }
                }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                  </svg>
                  New
                </button>
                <button className="route-action-btn" onClick={() => {
                  setRouteApproved(false); setRefineOpen(true);
                  setSheetMode('expanded');
                }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
                  </svg>
                  Edit
                </button>
                <button className="route-action-btn" onClick={() => setShareModalOpen(true)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="18" cy="5"  r="3"/><circle cx="6"  cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
                    <line x1="15.41" y1="6.51" x2="8.59"  y2="10.49"/>
                  </svg>
                  Share
                </button>
              </div>
            </div>
          )}

          {/* ── Overflow menu — shown in all sheet modes via handle ⋯ button ── */}
          {menuOpen && (
            <div className="overflow-menu overflow-menu-sheet" ref={menuContentRef}>
              {/* Recent rides removed from menu — accessible via the
                  Recents button next to the mic in the idle sheet.
                  User email + Sign out moved to the bottom. */}
              {/* ── Shared with me (inbox of routes mates sent) ───────── */}
              {sharedRoutes.length > 0 && (
                <>
                  <button className="menu-section-collapsible"
                    onClick={() => setSharedWithOpen(x => !x)}
                    aria-expanded={sharedWithOpen}>
                    <span>Shared with me<span className="menu-section-count"> ({sharedRoutes.length})</span></span>
                    <svg className={`menu-section-chevron${sharedWithOpen ? ' menu-section-chevron--open' : ''}`}
                      width="12" height="8" viewBox="0 0 12 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="2 2 6 6 10 2"/>
                    </svg>
                  </button>
                  {sharedWithOpen && sharedRoutes.map(r => (
                    <div key={r.id} className={`shared-route-row${r.viewed_at ? '' : ' shared-route-row--unread'}`}>
                      <Avatar name={r.sharer_name} size={28} />
                      <button className="shared-route-body" onClick={() => openSharedRoute(r)}>
                        <div className="shared-route-title">{r.title}</div>
                        <div className="shared-route-meta">
                          from {r.sharer_name}
                          {r.distance_mi != null ? ` · ${r.distance_mi.toFixed(0)} mi` : ''}
                          {r.duration_str ? ` · ${r.duration_str}` : ''}
                        </div>
                      </button>
                      <button className="shared-route-delete"
                        onClick={() => deleteSharedRoute(r.id)} aria-label="Delete">✕</button>
                    </div>
                  ))}
                  <div className="menu-divider"/>
                </>
              )}

              {/* ── Riding mates ─────────────────────────────────────── */}
              <div className="menu-section-label">Riding mates</div>
              {profile && (
                <>
                  <div className="profile-row">
                    {editingDisplayName ? (
                      <>
                        <input className="profile-name-input"
                          value={draftDisplayName}
                          onChange={e=>setDraftDisplayName(e.target.value.slice(0, 40))}
                          onKeyDown={e=>{ if (e.key === 'Enter') saveDisplayName(); }}
                          autoFocus />
                        <button className="profile-save-btn" onClick={saveDisplayName}>Save</button>
                        <button className="profile-cancel-btn" onClick={()=>setEditingDisplayName(false)}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <Avatar name={profile.display_name} size={32} />
                        <div className="profile-name-block">
                          <div className="profile-name">{profile.display_name}</div>
                          <div className="profile-code">Your code: <strong>{profile.share_code}</strong></div>
                        </div>
                        <button className="profile-edit-btn"
                          onClick={()=>{ setDraftDisplayName(profile.display_name); setEditingDisplayName(true); }}
                          aria-label="Edit display name">✎</button>
                      </>
                    )}
                  </div>
                  <button className="invite-share-btn" onClick={shareInvite}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
                      <polyline points="16 6 12 2 8 6"/>
                      <line x1="12" y1="2" x2="12" y2="15"/>
                    </svg>
                    <span>Invite a friend to ride</span>
                  </button>
                </>
              )}

              {friendships.filter(f => f.status === 'pending' && f.initiated_by !== session.user.id && f.friend).map(f => (
                <div key={f.id} className="friend-row friend-row--pending">
                  <Avatar name={f.friend.display_name} size={32} />
                  <div className="friend-name-block">
                    <div className="friend-name">{f.friend.display_name}</div>
                    <div className="friend-sub">wants to ride with you</div>
                  </div>
                  <button className="friend-accept-btn" onClick={()=>acceptFriendship(f.id)}>Accept</button>
                  <button className="friend-reject-btn" onClick={()=>deleteFriendship(f.id)} aria-label="Decline">✕</button>
                </div>
              ))}

              {friendships.filter(f => f.status === 'accepted' && f.friend).map(f => {
                const sharing = sharingFriendIds.has(f.id);
                const mate = matePositions[f.id];
                let sub = 'Connected';
                if (mate) sub = `📍 ${formatMateDistance(mate, userLocation)}`;
                else if (sharing) sub = 'You’re sharing — waiting on them';
                return (
                  <div key={f.id} className={`friend-row${mate ? ' friend-row--live' : ''}`}>
                    <Avatar name={f.friend.display_name} size={32} />
                    <div className="friend-name-block">
                      <div className="friend-name">{f.friend.display_name}</div>
                      <div className="friend-sub">{sub}</div>
                    </div>
                    <button
                      className={`friend-share-btn${sharing ? ' friend-share-btn--active' : ''}`}
                      onClick={() => toggleShareWith(f.id)}
                      aria-pressed={sharing}
                      title={sharing ? 'Stop sharing your location' : 'Share your location with this friend'}
                    >
                      {sharing ? 'Sharing' : 'Share'}
                    </button>
                    <button className="friend-remove-btn" onClick={()=>deleteFriendship(f.id)} aria-label="Remove friend">✕</button>
                  </div>
                );
              })}

              {friendships.filter(f => f.status === 'pending' && f.initiated_by === session.user.id && f.friend).map(f => (
                <div key={f.id} className="friend-row friend-row--outgoing">
                  <Avatar name={f.friend.display_name} size={32} />
                  <div className="friend-name-block">
                    <div className="friend-name">{f.friend.display_name}</div>
                    <div className="friend-sub">Request sent</div>
                  </div>
                  <button className="friend-remove-btn" onClick={()=>deleteFriendship(f.id)} aria-label="Cancel request">✕</button>
                </div>
              ))}

              <div className="add-friend-row">
                <input className="add-friend-input"
                  placeholder="Email or 6-char code"
                  value={addFriendInput}
                  onChange={e=>{ setAddFriendInput(e.target.value); setAddFriendStatus(null); }}
                  onKeyDown={e=>{ if (e.key === 'Enter') sendFriendRequest(); }} />
                <button className="add-friend-btn"
                  onClick={sendFriendRequest}
                  disabled={addingFriend || !addFriendInput.trim()}>
                  {addingFriend ? '…' : 'Add'}
                </button>
              </div>
              {addFriendStatus && (
                <div className={`add-friend-status add-friend-status--${addFriendStatus.kind}`}>
                  {addFriendStatus.msg}
                </div>
              )}

              <div className="menu-divider"/>
              <div className="menu-user-row">
                <span className="menu-user-email">{session.user.email}</span>
                <button className="menu-signout" onClick={() => supabase.auth.signOut()}>Sign out</button>
              </div>
              <button className="menu-delete-account"
                onClick={() => { setDeleteConfirmText(''); setDeleteError(null); setDeleteAccountOpen(true); }}>
                Delete account
              </button>
            </div>
          )}

          {!menuOpen && sheetMode === 'expanded' && (
            <div className="sheet-expanded-content">
              {error && <div className="error-banner">⚠️ {error}</div>}
              <ConversationThread messages={messages} loading={loading}
                loadingMsg={loadingMsg} messagesEndRef={messagesEnd}
                currentRoute={routeData} onSelectRoute={selectThreadRoute}/>
              <div className="sheet-input-area">
                {routeData && !routeApproved && refineOpen && (
                  <div className="chips-row">
                    {REFINE_CHIPS.map(c=>(
                      <button key={c} className="chip" onClick={()=>handleFollowUp(c)}>{c}</button>
                    ))}
                    <button className="chip chip-approve" onClick={()=>handleFollowUp('looks good')}>👍 Approve</button>
                  </div>
                )}
                <div className="input-row">
                  {voice.supported && (
                    <button className={`mic-small${voice.listening?' mic-listening':''}`}
                      onClick={voice.listening?voice.stop:voice.start} aria-label="Voice input">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                        <line x1="12" y1="19" x2="12" y2="23"/>
                      </svg>
                    </button>
                  )}
                  <input className="followup-input"
                    placeholder={routeData ? 'Refine or approve…' : 'Where do you want to ride?'}
                    value={followUpInput || query}
                    onChange={e => routeData ? setFollowUpInput(e.target.value) : setQuery(e.target.value)}
                    onKeyDown={e => e.key==='Enter' && (routeData ? handleFollowUp() : submitQuery())}
                    disabled={loading}/>
                  {routeData && !routeApproved && (
                    <button className={`refine-btn${refineOpen?' active':''}`}
                      onClick={()=>setRefineOpen(x=>!x)} aria-label="Refine options">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/>
                      </svg>
                    </button>
                  )}
                  <button className="send-btn"
                    onClick={()=> routeData ? handleFollowUp() : submitQuery()}
                    disabled={loading || (routeData ? !followUpInput.trim() : !query.trim())}>↑</button>
                </div>
              </div>
            </div>
          )}
        </div>

      ) : !navMode ? (
        <div className="sidebar">
          <div className="sidebar-header">
            <div className="sidebar-brand">
              <span className="sidebar-brand-mark" aria-hidden>🏍</span>
              <span className="sidebar-brand-name">TwoTired</span>
            </div>
            <div className="sidebar-account" ref={accountMenuRef}>
              <button
                className={`sidebar-account-chip${accountMenuOpen ? ' sidebar-account-chip--open' : ''}`}
                onClick={() => setAccountMenuOpen(x => !x)}
                aria-expanded={accountMenuOpen}
                aria-haspopup="menu"
                aria-label="Account menu"
              >
                <Avatar name={profile?.display_name || session.user.email} size={26} />
                <span className="sidebar-account-name">
                  {profile?.display_name || session.user.email.split('@')[0]}
                </span>
                <svg width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={`sidebar-account-chevron${accountMenuOpen ? ' sidebar-account-chevron--open' : ''}`}>
                  <polyline points="1 1 5 5 9 1"/>
                </svg>
              </button>

              {accountMenuOpen && (
                <div className="sidebar-account-menu" role="menu">
                  <div className="sidebar-account-menu-id">
                    <Avatar name={profile?.display_name || session.user.email} size={36} />
                    <div className="sidebar-account-menu-id-block">
                      <div className="sidebar-account-menu-name">{profile?.display_name || 'You'}</div>
                      <div className="sidebar-account-menu-email">{session.user.email}</div>
                    </div>
                  </div>
                  <button className="sidebar-account-menu-item"
                    onClick={() => { setAccountMenuOpen(false); supabase.auth.signOut(); }}
                    role="menuitem">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                      <polyline points="16 17 21 12 16 7"/>
                      <line x1="21" y1="12" x2="9" y2="12"/>
                    </svg>
                    Sign out
                  </button>
                  <div className="sidebar-account-menu-divider"/>
                  <button className="sidebar-account-menu-item sidebar-account-menu-item--danger"
                    onClick={() => { setAccountMenuOpen(false); setDeleteConfirmText(''); setDeleteError(null); setDeleteAccountOpen(true); }}
                    role="menuitem">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/>
                      <path d="M10 11v6M14 11v6"/>
                      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>
                    </svg>
                    Delete account
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="query-row">
            <input className="query-input" placeholder="Where do you want to ride?"
              value={query} onChange={e=>setQuery(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&submitQuery()} disabled={loading}/>
            {voice.supported && (
              <button className={`mic-desktop${voice.listening?' mic-listening':''}`}
                onClick={voice.listening?voice.stop:voice.start} aria-label="Voice">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                  <line x1="12" y1="19" x2="12" y2="23"/>
                </svg>
              </button>
            )}
            <button className="go-btn" onClick={()=>submitQuery()} disabled={loading||!query.trim()}>→</button>
          </div>

          {error && <div className="error-banner">⚠️ {error}</div>}

          {/* Riding mates + shared routes — same content as the mobile menu's
              overflow sheet. Collapsible header so the desktop sidebar's
              messages area still gets most of the height. */}
          <div className="sidebar-mates">
            <button className="sidebar-mates-header"
              onClick={() => setMatesPanelOpen(x => !x)}
              aria-expanded={matesPanelOpen}>
              <span>
                🏍 Riding mates
                {(() => {
                  const accepted = friendships.filter(f => f.status === 'accepted' && f.friend).length;
                  const pending  = friendships.filter(f => f.status === 'pending' && f.initiated_by !== session.user.id && f.friend).length;
                  const parts = [];
                  if (accepted) parts.push(`${accepted}`);
                  if (pending)  parts.push(`${pending} pending`);
                  return parts.length ? <span className="sidebar-mates-count"> ({parts.join(' · ')})</span> : null;
                })()}
              </span>
              <svg className={`sidebar-mates-chevron${matesPanelOpen ? ' sidebar-mates-chevron--open' : ''}`}
                width="12" height="8" viewBox="0 0 12 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 2 6 6 10 2"/>
              </svg>
            </button>

            {matesPanelOpen && (
              <div className="sidebar-mates-body">
                {/* Your profile + invite button */}
                {profile && (
                  <div className="sidebar-mates-section">
                    <div className="profile-row">
                      {editingDisplayName ? (
                        <>
                          <input className="profile-name-input"
                            value={draftDisplayName}
                            onChange={e=>setDraftDisplayName(e.target.value.slice(0, 40))}
                            onKeyDown={e=>{ if (e.key === 'Enter') saveDisplayName(); }}
                            autoFocus />
                          <button className="profile-save-btn" onClick={saveDisplayName}>Save</button>
                          <button className="profile-cancel-btn" onClick={()=>setEditingDisplayName(false)}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <Avatar name={profile.display_name} size={32} />
                          <div className="profile-name-block">
                            <div className="profile-name">{profile.display_name}</div>
                            <div className="profile-code">Your code: <strong>{profile.share_code}</strong></div>
                          </div>
                          <button className="profile-edit-btn"
                            onClick={()=>{ setDraftDisplayName(profile.display_name); setEditingDisplayName(true); }}
                            aria-label="Edit display name">✎</button>
                        </>
                      )}
                    </div>
                    <button className="invite-share-btn" onClick={shareInvite}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
                        <polyline points="16 6 12 2 8 6"/>
                        <line x1="12" y1="2" x2="12" y2="15"/>
                      </svg>
                      <span>Invite a friend to ride</span>
                    </button>
                  </div>
                )}

                {/* Friend rows: incoming pending, accepted, outgoing pending */}
                {friendships.filter(f => f.status === 'pending' && f.initiated_by !== session.user.id && f.friend).map(f => (
                  <div key={f.id} className="friend-row friend-row--pending">
                    <Avatar name={f.friend.display_name} size={32} />
                    <div className="friend-name-block">
                      <div className="friend-name">{f.friend.display_name}</div>
                      <div className="friend-sub">wants to ride with you</div>
                    </div>
                    <button className="friend-accept-btn" onClick={()=>acceptFriendship(f.id)}>Accept</button>
                    <button className="friend-reject-btn" onClick={()=>deleteFriendship(f.id)} aria-label="Decline">✕</button>
                  </div>
                ))}

                {friendships.filter(f => f.status === 'accepted' && f.friend).map(f => {
                  const sharing = sharingFriendIds.has(f.id);
                  const mate = matePositions[f.id];
                  let sub = 'Connected';
                  if (mate) sub = `📍 ${formatMateDistance(mate, userLocation)}`;
                  else if (sharing) sub = 'You’re sharing — waiting on them';
                  return (
                    <div key={f.id} className={`friend-row${mate ? ' friend-row--live' : ''}`}>
                      <Avatar name={f.friend.display_name} size={32} />
                      <div className="friend-name-block">
                        <div className="friend-name">{f.friend.display_name}</div>
                        <div className="friend-sub">{sub}</div>
                      </div>
                      <button
                        className={`friend-share-btn${sharing ? ' friend-share-btn--active' : ''}`}
                        onClick={() => toggleShareWith(f.id)}
                        aria-pressed={sharing}
                        title={sharing ? 'Stop sharing your location' : 'Share your location with this friend'}
                      >
                        {sharing ? 'Sharing' : 'Share'}
                      </button>
                      <button className="friend-remove-btn" onClick={()=>deleteFriendship(f.id)} aria-label="Remove friend">✕</button>
                    </div>
                  );
                })}

                {friendships.filter(f => f.status === 'pending' && f.initiated_by === session.user.id && f.friend).map(f => (
                  <div key={f.id} className="friend-row friend-row--outgoing">
                    <Avatar name={f.friend.display_name} size={32} />
                    <div className="friend-name-block">
                      <div className="friend-name">{f.friend.display_name}</div>
                      <div className="friend-sub">Request sent</div>
                    </div>
                    <button className="friend-remove-btn" onClick={()=>deleteFriendship(f.id)} aria-label="Cancel request">✕</button>
                  </div>
                ))}

                {/* Add by code/email */}
                <div className="add-friend-row">
                  <input className="add-friend-input"
                    placeholder="Email or 6-char code"
                    value={addFriendInput}
                    onChange={e=>{ setAddFriendInput(e.target.value); setAddFriendStatus(null); }}
                    onKeyDown={e=>{ if (e.key === 'Enter') sendFriendRequest(); }} />
                  <button className="add-friend-btn"
                    onClick={sendFriendRequest}
                    disabled={addingFriend || !addFriendInput.trim()}>
                    {addingFriend ? '…' : 'Add'}
                  </button>
                </div>
                {addFriendStatus && (
                  <div className={`add-friend-status add-friend-status--${addFriendStatus.kind}`}>
                    {addFriendStatus.msg}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="sidebar-scroll">
            {messages.length > 0 ? (
              <>
                <ConversationThread messages={messages} loading={loading}
                  loadingMsg={loadingMsg} messagesEndRef={messagesEnd}
                  currentRoute={routeData} onSelectRoute={selectThreadRoute}/>
                {(sharedRoutes.length > 0 || recent.filter(r=>r.title !== routeData?.title).length > 0) && (
                  <div className="recent-sidebar">
                    <div className="recent-label">Recent rides</div>
                    {/* Incoming shared routes — appear at the top with sharer label */}
                    {sharedRoutes.map(r => (
                      <div key={`shared-${r.id}`}
                        className={`recent-item recent-item--shared${r.viewed_at ? '' : ' recent-item--unread'}`}>
                        <button className="recent-item-main" onClick={() => openSharedRoute(r)}>
                          <span className="recent-title">{r.title}</span>
                          <span className="recent-meta">
                            ↪ from {r.sharer_name}
                            {r.distance_mi != null ? ` · ${r.distance_mi.toFixed(0)} mi` : ''}
                            {r.duration_str ? ` · ${r.duration_str}` : ''}
                          </span>
                        </button>
                        <button className="recent-item-delete"
                          onClick={(e) => { e.stopPropagation(); deleteSharedRoute(r.id); }}
                          aria-label="Delete shared route">✕</button>
                      </div>
                    ))}
                    {recent.filter(r=>r.title !== routeData?.title).map(r=>(
                      <button key={r.id}
                        className={`recent-item${r.shared_from ? ' recent-item--from-friend' : ''}`}
                        onClick={()=>restoreRecentRoute(r)}>
                        <span className="recent-title">{r.title}</span>
                        <span className="recent-meta">
                          {r.shared_from ? `↪ from ${r.shared_from} · ` : ''}
                          {r.distance_mi?.toFixed(0)} mi · {r.duration_str}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="empty-state">
                {(sharedRoutes.length > 0 || recent.length > 0) ? (
                  <>
                    <div className="recent-label">Recent rides</div>
                    {sharedRoutes.map(r => (
                      <div key={`shared-${r.id}`}
                        className={`recent-item recent-item--shared${r.viewed_at ? '' : ' recent-item--unread'}`}>
                        <button className="recent-item-main" onClick={() => openSharedRoute(r)}>
                          <span className="recent-title">{r.title}</span>
                          <span className="recent-meta">
                            ↪ from {r.sharer_name}
                            {r.distance_mi != null ? ` · ${r.distance_mi.toFixed(0)} mi` : ''}
                            {r.duration_str ? ` · ${r.duration_str}` : ''}
                          </span>
                        </button>
                        <button className="recent-item-delete"
                          onClick={(e) => { e.stopPropagation(); deleteSharedRoute(r.id); }}
                          aria-label="Delete shared route">✕</button>
                      </div>
                    ))}
                    {recent.map(r=>(
                      <button key={r.id}
                        className={`recent-item${r.shared_from ? ' recent-item--from-friend' : ''}`}
                        onClick={()=>restoreRecentRoute(r)}>
                        <span className="recent-title">{r.title}</span>
                        <span className="recent-meta">
                          {r.shared_from ? `↪ from ${r.shared_from} · ` : ''}
                          {r.distance_mi?.toFixed(0)} mi · {r.duration_str}
                        </span>
                      </button>
                    ))}
                  </>
                ) : (
                  <div className="hints">
                    <p>Try: <em>"Take me to Hawks Nest with coffee in Newburgh"</em></p>
                    <p>Or: <em>"Bear Mountain loop, as twisty as possible"</em></p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Action bar — pinned just above the footer so the rider can always
              see Start Navigation + the refine controls regardless of how far
              they scrolled the conversation thread above. Only shown when
              there's a current route to act on. */}
          {routeData && (
            <div className="sidebar-actions">
              <button className="start-nav-btn-desktop" onClick={startNavigation}>▶ Start Navigation</button>
              {routeApproved ? (
                <div className="approved-banner">✅ Route approved — ride safe!</div>
              ) : (
                <>
                  <div className="chips-row">
                    {REFINE_CHIPS.map(c=>(
                      <button key={c} className="chip" onClick={()=>handleFollowUp(c)}>{c}</button>
                    ))}
                  </div>
                  <div className="input-row">
                    <input className="followup-input" placeholder="Refine or approve…"
                      value={followUpInput} onChange={e=>setFollowUpInput(e.target.value)}
                      onKeyDown={e=>e.key==='Enter'&&handleFollowUp()}/>
                    <button className="send-btn" onClick={()=>handleFollowUp()}
                      disabled={!followUpInput.trim()}>↑</button>
                  </div>
                </>
              )}
            </div>
          )}

          <div className="sidebar-bug">
            <button className="bug-trigger" onClick={()=>setMenuOpen(x=>!x)}>🐛 Report issue</button>
            {menuOpen && (
              <div className="bug-inline">
                <textarea className="bug-textarea" placeholder="What went wrong?"
                  value={bugComment} onChange={e=>setBugComment(e.target.value)}/>
                {bugDone
                  ? <p className="bug-done">Thanks!</p>
                  : <button className="menu-submit" onClick={submitBug} disabled={bugSubmitting||!bugComment.trim()}>
                      {bugSubmitting?'Sending…':'Submit'}
                    </button>
                }
              </div>
            )}
          </div>
        </div>
      ) : null}

      {appVersion && (
        <div className="app-version">
          ver.{appVersion.version}.{appVersion.build}
        </div>
      )}
    </div>
  );
}
