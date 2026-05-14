import { useState, useEffect, useCallback, useRef } from 'react';
import './App.css';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const EDGE_URL = `${SUPABASE_URL}/functions/v1/generate-route`;
const START = 'Balancero cafe, Astoria, Queens, NY';
const START_LABEL = 'Balancero cafe, Astoria';

const LOADING_MSGS = [
  'Asking Claude for the best twisties…',
  'Plotting your escape from the city…',
  'Finding the scenic stuff…',
  'Almost there…',
];

// Poll until window.google.maps is ready (loaded async in index.html)
function useMapsLoaded() {
  const [loaded, setLoaded] = useState(!!window.google?.maps);
  useEffect(() => {
    if (window.google?.maps) return;
    const id = setInterval(() => {
      if (window.google?.maps) { setLoaded(true); clearInterval(id); }
    }, 100);
    return () => clearInterval(id);
  }, []);
  return loaded;
}

// Extract a flat [{ lat, lng }] path from whatever GeoJSON shape the edge function returns.
// Edge function stores coordinates as [lng, lat] (standard GeoJSON order).
function extractPath(geojson) {
  if (!geojson) return [];
  let coords = null;

  if (Array.isArray(geojson?.features) && geojson.features[0]?.geometry?.coordinates) {
    coords = geojson.features[0].geometry.coordinates;
  } else if (geojson?.geometry?.coordinates) {
    coords = geojson.geometry.coordinates;
  } else if (Array.isArray(geojson?.coordinates)) {
    coords = geojson.coordinates;
  }

  if (!coords || coords.length < 2) return [];
  return coords.map(([lng, lat]) => ({ lat, lng }));
}

// Build Google Maps navigation URL — full waypoint chain for turn-by-turn in Maps app
function buildNavUrl(route) {
  if (!route) return '';
  const wps = route.waypoints || [];
  const toStr = wp =>
    typeof wp === 'string' ? encodeURIComponent(wp) : `${wp.lat},${wp.lng}`;
  const origin = encodeURIComponent(START);
  const dest = route.destination
    ? encodeURIComponent(route.destination)
    : wps.length ? toStr(wps[wps.length - 1]) : '';
  const middle = wps.slice(0, 23).map(toStr).join('/');
  return `https://www.google.com/maps/dir/${origin}${middle ? '/' + middle : ''}/${dest}`;
}

// ── v1 / v2 compat helpers ────────────────────────────────────────────────────
function getTitle(r) {
  return r.title || (r.destination ? `Route to ${r.destination}` : 'Generated Route');
}
function getDuration(r) {
  if (r.duration_str) return r.duration_str;
  if (r.time_minutes != null) {
    const h = Math.floor(r.time_minutes / 60);
    const m = r.time_minutes % 60;
    return h > 0 ? `${h}h ${m}min` : `${m}min`;
  }
  return '';
}
function getDistance(r) { return r.distance_mi ?? r.distance_miles ?? ''; }

export default function App() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState(0);
  const [error, setError] = useState('');
  const [route, setRoute] = useState(null);
  const [recent, setRecent] = useState([]);

  // Bug report state
  const [bugMode, setBugMode] = useState(false);
  const [bugComment, setBugComment] = useState('');
  const [bugSubmitting, setBugSubmitting] = useState(false);
  const [bugDone, setBugDone] = useState(false);
  const [bugError, setBugError] = useState('');

  const mapsLoaded = useMapsLoaded();
  const mapDivRef = useRef(null);
  const mapRef = useRef(null);
  const polylineRef = useRef(null);

  // ── Initialize map once API is ready ──────────────────────────────────────
  useEffect(() => {
    if (!mapsLoaded || !mapDivRef.current || mapRef.current) return;
    mapRef.current = new window.google.maps.Map(mapDivRef.current, {
      center: { lat: 40.92, lng: -74.2 },
      zoom: 9,
      mapTypeId: 'roadmap',
      gestureHandling: 'greedy',
      fullscreenControl: true,
      streetViewControl: false,
    });
  }, [mapsLoaded]);

  // ── Draw / clear polyline when route changes ───────────────────────────────
  useEffect(() => {
    if (!mapRef.current) return;

    if (polylineRef.current) {
      polylineRef.current.setMap(null);
      polylineRef.current = null;
    }

    if (!route) {
      mapRef.current.setCenter({ lat: 40.92, lng: -74.2 });
      mapRef.current.setZoom(9);
      return;
    }

    const path = extractPath(route.geojson || route.geometry);

    if (path.length >= 2) {
      polylineRef.current = new window.google.maps.Polyline({
        path,
        geodesic: true,
        strokeColor: '#3b82f6',
        strokeOpacity: 0.9,
        strokeWeight: 5,
        map: mapRef.current,
      });

      const bounds = new window.google.maps.LatLngBounds();
      path.forEach(p => bounds.extend(p));
      mapRef.current.fitBounds(bounds, { top: 40, right: 40, bottom: 40, left: 40 });
    } else {
      const wps = route.waypoints || [];
      if (wps.length) {
        const last = wps[wps.length - 1];
        mapRef.current.setCenter({ lat: last.lat, lng: last.lng });
        mapRef.current.setZoom(10);
      }
    }
  }, [route]);

  // ── Load recent routes from DB (last 3 only) ───────────────────────────────
  const loadRecent = useCallback(() => {
    fetch(
      `${SUPABASE_URL}/rest/v1/routes?select=id,title,destination,duration_str,distance_mi&group_name=eq.AI%20Generated&order=created_at.desc&limit=3`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    )
      .then(r => r.json())
      .then(data => Array.isArray(data) && setRecent(data))
      .catch(() => {});
  }, []);

  useEffect(() => { loadRecent(); }, [loadRecent]);

  // ── Loading message rotation ───────────────────────────────────────────────
  useEffect(() => {
    if (!loading) return;
    setLoadingMsg(0);
    const id = setInterval(() => setLoadingMsg(i => (i + 1) % LOADING_MSGS.length), 2500);
    return () => clearInterval(id);
  }, [loading]);

  // ── Generate route ─────────────────────────────────────────────────────────
  async function generate(e) {
    e?.preventDefault();
    if (!query.trim() || loading) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(EDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify({ query: query.trim(), start: START }),
      });
      const data = await res.json();
      const r = Array.isArray(data) ? data[0] : data;
      if (r?.error) throw new Error(r.error);
      setRoute(r.route ?? r);
      loadRecent();
    } catch (err) {
      setError(`Failed to generate route: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  // ── Load a recent route (full record with geojson) ─────────────────────────
  async function openRecentRoute(id) {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/routes?id=eq.${id}&select=*`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
      );
      const data = await res.json();
      if (data[0]) setRoute(data[0]);
    } catch {}
  }

  // ── Bug report: programmatic route canvas capture → Supabase ───────────────
  // No user interaction needed — works on mobile too.
  async function submitBugReport() {
    if (!bugComment.trim() || bugSubmitting) return;
    setBugSubmitting(true);
    setBugError('');
    try {
      // 1. Render the route path onto a canvas (no screen capture permission needed)
      const path = extractPath(route?.geojson || route?.geometry);
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 560;
      const ctx = canvas.getContext('2d');

      // Background — light map-like grey
      ctx.fillStyle = '#e8eaed';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (path.length >= 2) {
        // Find route bounds
        let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
        for (const p of path) {
          if (p.lat < minLat) minLat = p.lat;
          if (p.lat > maxLat) maxLat = p.lat;
          if (p.lng < minLng) minLng = p.lng;
          if (p.lng > maxLng) maxLng = p.lng;
        }
        // Pad bounds by 12%
        const latPad = (maxLat - minLat) * 0.12 || 0.05;
        const lngPad = (maxLng - minLng) * 0.12 || 0.05;
        minLat -= latPad; maxLat += latPad;
        minLng -= lngPad; maxLng += lngPad;

        const PAD = 40; // canvas pixel padding
        function toXY(p) {
          return {
            x: PAD + ((p.lng - minLng) / (maxLng - minLng)) * (canvas.width - PAD * 2),
            y: PAD + ((maxLat - p.lat) / (maxLat - minLat)) * (canvas.height - PAD * 2 - 60),
          };
        }

        // Draw route line (white outline for contrast, then blue)
        ctx.beginPath();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 9;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        const p0 = toXY(path[0]);
        ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < path.length; i++) {
          const p = toXY(path[i]);
          ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();

        ctx.beginPath();
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 5;
        ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < path.length; i++) {
          const p = toXY(path[i]);
          ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();

        // Start dot (green)
        const start = toXY(path[0]);
        ctx.beginPath();
        ctx.fillStyle = 'white';
        ctx.arc(start.x, start.y, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.fillStyle = '#22c55e';
        ctx.arc(start.x, start.y, 7, 0, Math.PI * 2);
        ctx.fill();

        // End dot (red)
        const end = toXY(path[path.length - 1]);
        ctx.beginPath();
        ctx.fillStyle = 'white';
        ctx.arc(end.x, end.y, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.fillStyle = '#ef4444';
        ctx.arc(end.x, end.y, 7, 0, Math.PI * 2);
        ctx.fill();
      }

      // Info bar at bottom
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, canvas.height - 60, canvas.width, 60);
      ctx.fillStyle = 'white';
      ctx.font = 'bold 14px -apple-system, sans-serif';
      const title = getTitle(route) || 'Route';
      ctx.fillText(title.length > 55 ? title.slice(0, 55) + '…' : title, 16, canvas.height - 36);
      ctx.font = '12px -apple-system, sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`${getDistance(route)} mi · ${getDuration(route)} · "${(query || '').slice(0, 60)}"`, 16, canvas.height - 16);

      // 2. Upload PNG to Supabase Storage
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const fileName = `bug_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.png`;
      const uploadRes = await fetch(
        `${SUPABASE_URL}/storage/v1/object/bug-screenshots/${fileName}`,
        {
          method: 'POST',
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'image/png',
          },
          body: blob,
        }
      );
      if (!uploadRes.ok) throw new Error(`Upload failed (${uploadRes.status})`);
      const screenshotUrl = `${SUPABASE_URL}/storage/v1/object/public/bug-screenshots/${fileName}`;

      // 3. Insert record via SECURITY DEFINER RPC (bypasses anon RLS)
      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/insert_bug_report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          p_comment:        bugComment.trim(),
          p_screenshot_url: screenshotUrl,
          p_route_id:       route?.id ?? null,
          p_query:          query ?? null,
        }),
      });
      if (!rpcRes.ok) {
        const errText = await rpcRes.text();
        throw new Error(`Save failed: ${errText}`);
      }

      setBugDone(true);
      setBugComment('');
      setTimeout(() => { setBugMode(false); setBugDone(false); }, 2500);
    } catch (err) {
      console.error('Bug report error:', err);
      setBugError(err.message || 'Submission failed');
    } finally {
      setBugSubmitting(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', fontFamily: "'Inter', -apple-system, sans-serif", background: '#f1f5f9' }}>

      {/* ── Left panel ──────────────────────────────────────────────────────── */}
      <div style={{ width: 260, background: '#0f172a', color: 'white', display: 'flex', flexDirection: 'column', padding: 16, gap: 12, overflowY: 'auto', flexShrink: 0 }}>

        <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.5px' }}>🏍️ TwistyRoute</div>

        <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Starting from</div>
        <div style={{ fontSize: 13, color: '#94a3b8', marginTop: -8 }}>📍 {START_LABEL}</div>

        <form onSubmit={generate} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generate(); } }}
            placeholder={'e.g. "scenic loop to Hawks Nest"\n"Bears Nest coffee stop via Catskills"\n"twisty roads, avoid highways"'}
            disabled={loading}
            style={{
              background: '#1e293b', color: 'white', border: '1px solid #334155',
              borderRadius: 10, padding: '10px 12px', resize: 'none',
              height: 100, fontSize: 13, lineHeight: 1.5,
              outline: 'none', transition: 'border 0.2s',
            }}
          />
          <button
            type="submit"
            disabled={loading || !query.trim()}
            style={{
              background: loading ? '#1d4ed8' : '#3b82f6',
              color: 'white', border: 'none', borderRadius: 10,
              padding: '11px 16px', cursor: loading ? 'default' : 'pointer',
              fontWeight: 700, fontSize: 14, transition: 'background 0.2s',
            }}
          >
            {loading ? LOADING_MSGS[loadingMsg] : '🗺️ Generate Route'}
          </button>
        </form>

        {error && (
          <div style={{ background: '#450a0a', border: '1px solid #7f1d1d', borderRadius: 8, padding: '8px 12px', fontSize: 12, color: '#fca5a5', lineHeight: 1.4 }}>
            {error}
          </div>
        )}

        {route && (
          <div style={{ background: '#1e3a5f', border: '1px solid #2563eb', borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.3 }}>{getTitle(route)}</div>
            <div style={{ fontSize: 11, color: '#93c5fd', marginTop: 4 }}>
              ⏱ {getDuration(route)} · 🛣️ {getDistance(route)} mi
            </div>
            {route.destination && (
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>📍 → {route.destination}</div>
            )}
          </div>
        )}

        {recent.length > 0 && (
          <>
            <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: 4 }}>Recent</div>
            {recent.filter(r => r.id !== route?.id).map(r => (
              <div
                key={r.id}
                onClick={() => openRecentRoute(r.id)}
                style={{
                  background: '#1e293b', borderRadius: 10, padding: '10px 12px',
                  cursor: 'pointer', transition: 'background 0.15s',
                }}
                onMouseEnter={e => e.currentTarget.style.background = '#334155'}
                onMouseLeave={e => e.currentTarget.style.background = '#1e293b'}
              >
                <div style={{
                  fontSize: 13, fontWeight: 600, lineHeight: 1.3,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {r.title}
                </div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>
                  ⏱ {r.duration_str} · 🛣️ {r.distance_mi} mi
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* ── Map ─────────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative' }}>
        <div ref={mapDivRef} style={{ width: '100%', height: '100%' }} />
        {!mapsLoaded && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#e2e8f0', color: '#64748b', fontSize: 15 }}>
            Loading map…
          </div>
        )}

        {/* ── Bug report button / panel — floating top-right ─────────────── */}
        <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 10 }}>
          {!bugMode ? (
            <button
              onClick={() => setBugMode(true)}
              title="Report a routing issue"
              style={{
                background: 'white', border: 'none', borderRadius: 10,
                padding: '9px 14px', cursor: 'pointer', fontSize: 13,
                fontWeight: 600, color: '#64748b',
                boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
                display: 'flex', alignItems: 'center', gap: 6,
                transition: 'box-shadow 0.15s, color 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.22)'; e.currentTarget.style.color = '#1e293b'; }}
              onMouseLeave={e => { e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.18)'; e.currentTarget.style.color = '#64748b'; }}
            >
              🐛 Report issue
            </button>
          ) : (
            <div style={{
              background: 'white', borderRadius: 14, padding: 14, width: 280,
              boxShadow: '0 4px 24px rgba(0,0,0,0.18)',
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', marginBottom: 8 }}>
                🐛 What's wrong with this route?
              </div>
              <textarea
                value={bugComment}
                onChange={e => setBugComment(e.target.value)}
                placeholder={'e.g. Crosses GWB into NJ then immediately comes back — should escape via Goethals'}
                disabled={bugSubmitting}
                autoFocus
                style={{
                  width: '100%', boxSizing: 'border-box',
                  border: '1px solid #e2e8f0', borderRadius: 8,
                  padding: '8px 10px', resize: 'none', height: 90,
                  fontSize: 13, lineHeight: 1.5, outline: 'none',
                  color: '#1e293b', fontFamily: 'inherit',
                }}
              />
              {bugDone ? (
                <div style={{ color: '#16a34a', fontSize: 13, fontWeight: 600, textAlign: 'center', padding: '8px 0' }}>
                  ✓ Submitted — thanks!
                </div>
              ) : (
                <>
                  {bugError && (
                    <div style={{ color: '#dc2626', fontSize: 12, marginTop: 6, lineHeight: 1.4 }}>{bugError}</div>
                  )}
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button
                      onClick={submitBugReport}
                      disabled={bugSubmitting || !bugComment.trim()}
                      style={{
                        flex: 1, background: bugSubmitting ? '#93c5fd' : '#3b82f6',
                        color: 'white', border: 'none', borderRadius: 8,
                        padding: '9px 12px', cursor: bugSubmitting ? 'default' : 'pointer',
                        fontSize: 13, fontWeight: 700,
                        opacity: !bugComment.trim() ? 0.5 : 1,
                      }}
                    >
                      {bugSubmitting ? 'Submitting…' : 'Submit'}
                    </button>
                    <button
                      onClick={() => { setBugMode(false); setBugComment(''); setBugError(''); setBugDone(false); }}
                      disabled={bugSubmitting}
                      style={{
                        background: '#f1f5f9', color: '#64748b', border: 'none',
                        borderRadius: 8, padding: '9px 12px', cursor: 'pointer', fontSize: 13,
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Right panel ─────────────────────────────────────────────────────── */}
      {route && (
        <div style={{ width: 340, background: 'white', display: 'flex', flexDirection: 'column', boxShadow: '-2px 0 12px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
          <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid #f1f5f9' }}>
            <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.3, color: '#0f172a' }}>{getTitle(route)}</div>
            <div style={{ fontSize: 13, color: '#64748b', marginTop: 6 }}>
              ⏱ {getDuration(route)} &nbsp;·&nbsp; 🛣️ {getDistance(route)} mi
            </div>
            {route.destination && (
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>📍 → {route.destination}</div>
            )}
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* v2: prose narrative */}
            {route.narrative && (
              <div style={{ fontSize: 14, color: '#374151', lineHeight: 1.75 }}>
                {route.narrative}
              </div>
            )}

            {/* v2: stop business cards */}
            {route.stops?.length > 0 && (
              <div>
                <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>Stops</div>
                {route.stops.map((stop, i) => (
                  <div key={i} style={{ background: '#f8fafc', borderRadius: 10, padding: '10px 12px', marginBottom: 8, borderLeft: '4px solid #f59e0b' }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>{stop.name}</div>
                    {stop.rating && (
                      <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                        ⭐ {stop.rating} ({stop.ratingCount} reviews)
                      </div>
                    )}
                    {stop.address && (
                      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{stop.address}</div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* v1 fallback: segment cards */}
            {!route.narrative && (route.segments || []).map((seg, i) => (
              <div key={i} style={{ paddingLeft: 14, borderLeft: `4px solid ${seg.color || '#3b82f6'}` }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: seg.color || '#3b82f6', marginBottom: 2 }}>
                  {seg.label}
                </div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>
                  {seg.duration} &nbsp;·&nbsp; {seg.miles}
                </div>
                <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.6 }}>
                  {seg.description}
                </div>
              </div>
            ))}
          </div>

          <div style={{ padding: '14px 20px', borderTop: '1px solid #f1f5f9', display: 'flex', gap: 8 }}>
            <a
              href={buildNavUrl(route)}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                flex: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                background: '#1d4ed8', color: 'white',
                border: 'none', borderRadius: 10, padding: '11px 16px',
                cursor: 'pointer', fontSize: 13, fontWeight: 700,
                textDecoration: 'none',
              }}
            >
              🧭 Open in Google Maps
            </a>
            <button
              onClick={() => setRoute(null)}
              style={{ background: '#f1f5f9', color: '#64748b', border: 'none', borderRadius: 10, padding: '11px 16px', cursor: 'pointer', fontSize: 13 }}
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
