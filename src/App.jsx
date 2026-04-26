import { useState, useEffect, useCallback, useRef } from 'react';
import './App.css';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const EDGE_URL = `${SUPABASE_URL}/functions/v1/generate-route`;
const START = 'Balancero cafe, Astoria, Queens, NY';
const START_LABEL = 'Balancero cafe, Astoria';

const LOADING_MSGS = [
  'Asking Gemini for the best twisties…',
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
    // Bare geometry object
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
  const dest = route.destination ? encodeURIComponent(route.destination) : toStr(wps[wps.length - 1]);
  const middle = wps.slice(0, 23).map(toStr).join('/');
  return `https://www.google.com/maps/dir/${origin}${middle ? '/' + middle : ''}/${dest}`;
}

export default function App() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState(0);
  const [error, setError] = useState('');
  const [route, setRoute] = useState(null);
  const [recent, setRecent] = useState([]);

  const mapsLoaded = useMapsLoaded();
  const mapDivRef = useRef(null);          // the <div> the map renders into
  const mapRef = useRef(null);             // google.maps.Map instance
  const polylineRef = useRef(null);        // current drawn polyline

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
      // Reset to default view
      mapRef.current.setCenter({ lat: 40.92, lng: -74.2 });
      mapRef.current.setZoom(9);
      return;
    }

    const path = extractPath(route.geojson);

    if (path.length >= 2) {
      // Draw the full step-level GeoJSON polyline — exact route computed by Directions API
      polylineRef.current = new window.google.maps.Polyline({
        path,
        geodesic: true,
        strokeColor: '#3b82f6',
        strokeOpacity: 0.9,
        strokeWeight: 5,
        map: mapRef.current,
      });

      // Fit map to the route
      const bounds = new window.google.maps.LatLngBounds();
      path.forEach(p => bounds.extend(p));
      mapRef.current.fitBounds(bounds, { top: 40, right: 40, bottom: 40, left: 40 });
    } else {
      // No GeoJSON (old route from DB) — fall back to centering on destination coords
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
      setRoute(r);
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

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', fontFamily: "'Inter', -apple-system, sans-serif", background: '#f1f5f9' }}>

      {/* ── Left panel ──────────────────────────────────────────────────────── */}
      <div style={{ width: 260, background: '#0f172a', color: 'white', display: 'flex', flexDirection: 'column', padding: 16, gap: 12, overflowY: 'auto', flexShrink: 0 }}>

        <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.5px' }}>🏙️ TwistyRoute</div>

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
            <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.3 }}>{route.title}</div>
            <div style={{ fontSize: 11, color: '#93c5fd', marginTop: 4 }}>
              ⏱ {route.duration_str} · 🛣️ {route.distance_mi} mi
            </div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>📍 → {route.destination}</div>
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
            <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.3, color: '#0f172a' }}>{route.title}</div>
            <div style={{ fontSize: 13, color: '#64748b', marginTop: 6 }}>
              ⏱ {route.duration_str} &nbsp;·&nbsp; 🛣️ {route.distance_mi} mi
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>📍 → {route.destination}</div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 20 }}>
            {(route.segments || []).map((seg, i) => (
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
