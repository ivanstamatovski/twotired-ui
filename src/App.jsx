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
    // FeatureCollection with a single LineString feature
    coords = geojson.features[0].geometry.coordinates;
  } else if (geojson?.geometry?.coordinates) {
    // Feature with geometry
    coords = geojson.geometry.coordinates;
  } else if (Array.isArray(geojson?.coordinates)) {
    // Bare geometry object (v2: GraphHopper returns LineString directly)
    coords = geojson.coordinates;
  }

  if (!coords || coords.length < 2) return [];
  // GeoJSON is [lng, lat]; Google Maps wants { lat, lng }
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
// v1: { title, duration_str, distance_mi, destination, segments, geojson }
// v2: { time_minutes, distance_miles, narrative, stops, geometry } (no title/destination)
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
  const mapDivRef = useRef(null); // the <div> the map renders into
  const mapRef = useRef(null);    // google.maps.Map instance
  const polylineRef = useRef(null); // current drawn polyline

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

    // Clear previous polyline
    if (polylineRef.current) {
      polylineRef.current.setMap(null);
      polylineRef.current = null;
    }

    if (!route) {
      mapRef.current.setCenter({ lat: 40.92, lng: -74.2 });
      mapRef.current.setZoom(9);
      return;
    }

    // v2 returns route.geometry (bare LineString); v1 returns route.geojson (FeatureCollection)
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
      // No GeoJSON — fall back to centering on last waypoint
      const wps = route.waypoints || [];
      if (wps.length) {
        const last = wps[wps.length - 1];
        mapRef.current.setCenter({ lat: last.lat, lng: last.lng });
        mapRef.current.setZoom(10);
      }
    }
  }, [route]);

  // ── Load recent routes from DB ─────────────────────────────────────────────
  const loadRecent = useCallback(() => {
    fetch(
      `${SUPABASE_URL}/rest/v1/routes?select=id,title,destination,duration_str,distance_mi&group_name=eq.AI%20Generated&order=created_at.desc&limit=8`,
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
      // v2 wraps response: { success: true, route: {...} }. v1 returns route directly.
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

  // ── Bug report: screen capture + polyline redraw + Supabase insert ─────────
  async function submitBugReport() {
    if (!bugComment.trim() || bugSubmitting) return;
    setBugSubmitting(true);
    setBugError('');
    let stream = null;
    try {
      // 1. Capture current tab (Chrome shows one-click "Share this tab" dialog)
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { preferCurrentTab: true },
        audio: false,
      });
      // Wait for dialog to close and page to repaint
      await new Promise(r => setTimeout(r, 400));

      // 2. Grab one video frame onto a canvas
      const video = document.createElement('video');
      video.muted = true;
      video.srcObject = stream;
      await new Promise(r => { video.onloadedmetadata = r; });
      await video.play();

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0);

      // Stop capture stream immediately
      stream.getTracks().forEach(t => t.stop());
      stream = null;

      // 3. Redraw the route polyline on the canvas
      //    Google Maps polylines live on a compositor layer that getDisplayMedia
      //    may miss — this ensures the line is always visible in the screenshot.
      if (mapRef.current && route) {
        const path = extractPath(route.geojson || route.geometry);
        if (path.length >= 2) {
          const map = mapRef.current;
          const mapDiv = mapDivRef.current;
          const mapRect = mapDiv.getBoundingClientRect();
          const projection = map.getProjection();
          const scale = Math.pow(2, map.getZoom());
          const bounds = map.getBounds();
          // Northwest corner of the visible map in world coordinates
          const nw = projection.fromLatLngToPoint(
            new window.google.maps.LatLng(bounds.getNorthEast().lat(), bounds.getSouthWest().lng())
          );
          // Scale factors: canvas (physical px) ÷ window (CSS px)
          const xScale = canvas.width / window.innerWidth;
          const yScale = canvas.height / window.innerHeight;

          function toCanvas(latlng) {
            const wp = projection.fromLatLngToPoint(
              new window.google.maps.LatLng(latlng.lat, latlng.lng)
            );
            return {
              x: (mapRect.left + (wp.x - nw.x) * scale) * xScale,
              y: (mapRect.top  + (wp.y - nw.y) * scale) * yScale,
            };
          }

          ctx.beginPath();
          ctx.strokeStyle = '#3b82f6';
          ctx.lineWidth = Math.max(3, 5 * xScale);
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          const p0 = toCanvas(path[0]);
          ctx.moveTo(p0.x, p0.y);
          for (let i = 1; i < path.length; i++) {
            const p = toCanvas(path[i]);
            ctx.lineTo(p.x, p.y);
          }
          ctx.stroke();
        }
      }

      // 4. Upload PNG to Supabase Storage (bug-screenshots bucket, public)
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
      if (!uploadRes.ok) throw new Error(`Screenshot upload failed (${uploadRes.status})`);
      const screenshotUrl = `${SUPABASE_URL}/storage/v1/object/public/bug-screenshots/${fileName}`;

      // 5. Insert record via SECURITY DEFINER RPC (bypasses anon RLS)
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
        throw new Error(`DB insert failed: ${errText}`);
      }

      setBugDone(true);
      setBugComment('');
      setTimeout(() => { setBugMode(false); setBugDone(false); }, 2500);
    } catch (err) {
      console.error('Bug report error:', err);
      setBugError(err.message || 'Submission failed');
    } finally {
      if (stream) stream.getTracks().forEach(t => t.stop());
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
                <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>{r.title}</div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>
                  ⏱ {r.duration_str} · 🛣️ {r.distance_mi} mi
                </div>
              </div>
            ))}
          </>
        )}
        {/* ── Bug report ────────────────────────────────────────────────────── */}
        <div style={{ marginTop: 'auto', paddingTop: 12, borderTop: '1px solid #1e293b' }}>
          {!bugMode ? (
            <button
              onClick={() => setBugMode(true)}
              style={{
                width: '100%', background: 'transparent', color: '#475569',
                border: '1px solid #1e293b', borderRadius: 8, padding: '8px 12px',
                cursor: 'pointer', fontSize: 12, textAlign: 'left',
                transition: 'color 0.15s, border-color 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = '#94a3b8'; e.currentTarget.style.borderColor = '#334155'; }}
              onMouseLeave={e => { e.currentTarget.style.color = '#475569'; e.currentTarget.style.borderColor = '#1e293b'; }}
            >
              🐛 Report routing issue
            </button>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 11, color: '#94a3b8' }}>Describe the routing problem:</div>
              <textarea
                value={bugComment}
                onChange={e => setBugComment(e.target.value)}
                placeholder={'e.g. Route goes through Manhattan instead of using GWB'}
                disabled={bugSubmitting}
                style={{
                  background: '#1e293b', color: 'white', border: '1px solid #334155',
                  borderRadius: 8, padding: '8px 10px', resize: 'none',
                  height: 80, fontSize: 12, lineHeight: 1.5, outline: 'none',
                }}
              />
              {bugDone ? (
                <div style={{ color: '#22c55e', fontSize: 12, textAlign: 'center', padding: '4px 0' }}>
                  ✓ Report submitted — thanks!
                </div>
              ) : (
                <>
                  {bugError && (
                    <div style={{ color: '#f87171', fontSize: 11, lineHeight: 1.4 }}>{bugError}</div>
                  )}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      onClick={submitBugReport}
                      disabled={bugSubmitting || !bugComment.trim()}
                      style={{
                        flex: 1, background: bugSubmitting ? '#1d4ed8' : '#2563eb',
                        color: 'white', border: 'none', borderRadius: 8,
                        padding: '8px 10px', cursor: bugSubmitting ? 'default' : 'pointer',
                        fontSize: 12, fontWeight: 600, opacity: !bugComment.trim() ? 0.5 : 1,
                      }}
                    >
                      {bugSubmitting ? 'Capturing…' : '📸 Capture & Submit'}
                    </button>
                    <button
                      onClick={() => { setBugMode(false); setBugComment(''); setBugError(''); setBugDone(false); }}
                      disabled={bugSubmitting}
                      style={{
                        background: 'transparent', color: '#64748b', border: '1px solid #1e293b',
                        borderRadius: 8, padding: '8px 10px', cursor: 'pointer', fontSize: 12,
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

      </div>

      {/* ── Map ─────────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative' }}>
        <div ref={mapDivRef} style={{ width: '100%', height: '100%' }} />
        {!mapsLoaded && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#e2e8f0', color: '#64748b', fontSize: 15 }}>
            Loading map…
          </div>
        )}
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
