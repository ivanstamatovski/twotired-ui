import { useState, useEffect, useCallback } from 'react';
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

// Read the Maps API key from the script tag src
function getMapsKey() {
  const el = Array.from(document.querySelectorAll('script')).find(s =>
    s.src && s.src.includes('maps.googleapis.com')
  );
  const m = el?.src.match(/[?&]key=([^&]+)/);
  return m?.[1] || '';
}

// Build Google Maps navigation URL (opens in Google Maps app / web for turn-by-turn)
function buildNavUrl(route) {
  if (!route) return '';
  const wps = route.waypoints || [];
  if (wps.length < 2) return '';
  const toStr = wp =>
    typeof wp === 'string' ? encodeURIComponent(wp) : `${wp.lat},${wp.lng}`;
  return `https://www.google.com/maps/dir/${wps.map(toStr).join('/')}`;
}

// Build Google Maps Embed URL for the route
function buildMapSrc(route, key) {
  if (!route || !key) return '';
  const wps = route.waypoints || [];
  if (wps.length < 2) return '';

  const toStr = wp =>
    typeof wp === 'string'
      ? encodeURIComponent(wp)
      : `${wp.lat},${wp.lng}`;

  const origin = toStr(wps[0]);
  const destination = toStr(wps[wps.length - 1]);
  const middle = wps.slice(1, -1).map(toStr).join('|');

  let url = `https://www.google.com/maps/embed/v1/directions?key=${key}&origin=${origin}&destination=${destination}&mode=driving`;
  if (middle) url += `&waypoints=${middle}`;
  return url;
}

export default function App() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState(0);
  const [error, setError] = useState('');
  const [route, setRoute] = useState(null);
  const [recent, setRecent] = useState([]);
  const [mapsKey, setMapsKey] = useState('');

  useEffect(() => {
    const key = getMapsKey();
    if (key) { setMapsKey(key); return; }
    const id = setInterval(() => {
      const k = getMapsKey();
      if (k) { setMapsKey(k); clearInterval(id); }
    }, 200);
    return () => clearInterval(id);
  }, []);

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

  useEffect(() => {
    if (!loading) return;
    setLoadingMsg(0);
    const id = setInterval(() => setLoadingMsg(i => (i + 1) % LOADING_MSGS.length), 2500);
    return () => clearInterval(id);
  }, [loading]);

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

  const mapSrc = buildMapSrc(route, mapsKey);
  const defaultSrc = mapsKey
    ? `https://www.google.com/maps/embed/v1/view?key=${mapsKey}&center=40.92,-74.2&zoom=9&maptype=roadmap`
    : '';

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', fontFamily: "'Inter', -apple-system, sans-serif", background: '#f1f5f9' }}>
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
            style={{ background: '#1e293b', color: 'white', border: '1px solid #334155', borderRadius: 10, padding: '10px 12px', resize: 'none', height: 100, fontSize: 13, lineHeight: 1.5, outline: 'none', transition: 'border 0.2s' }}
          />
          <button
            type="submit"
            disabled={loading || !query.trim()}
            style={{ background: loading ? '#1d4ed8' : '#3b82f6', color: 'white', border: 'none', borderRadius: 10, padding: '11px 16px', cursor: loading ? 'default' : 'pointer', fontWeight: 700, fontSize: 14, transition: 'background 0.2s' }}
          >
            {loading ? LOADING_MSGS[loadingMsg] : '🗺️ Generate Route'}
          </button>
        </form>
        {error && <div style={{ background: '#450a0a', border: '1px solid #7f1d1d', borderRadius: 8, padding: '8px 12px', fontSize: 12, color: '#fca5a5', lineHeight: 1.4 }}>{error}</div>}
        {route && (
          <div style={{ background: '#1e3a5f', border: '1px solid #2563eb', borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.3 }}>{route.title}</div>
            <div style={{ fontSize: 11, color: '#93c5fd', marginTop: 4 }}>⏱ {route.duration_str} · 🛣️ {route.distance_mi} mi</div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>📍 → {route.destination}</div>
          </div>
        )}
        {recent.length > 0 && (
          <>
            <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: 4 }}>Recent</div>
            {recent.filter(r => r.id !== route?.id).map(r => (
              <div key={r.id} onClick={() => openRecentRoute(r.id)}
                style={{ background: '#1e293b', borderRadius: 10, padding: '10px 12px', cursor: 'pointer', transition: 'background 0.15s' }}
                onMouseEnter={e => e.currentTarget.style.background = '#334155'}
                onMouseLeave={e => e.currentTarget.style.background = '#1e293b'}
              >
                <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>{r.title}</div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>⏱ {r.duration_str} · 🛣️ {r.distance_mi} mi</div>
              </div>
            ))}
          </>
        )}
      </div>
      <div style={{ flex: 1, position: 'relative' }}>
        {(mapSrc || defaultSrc) ? (
          <iframe key={mapSrc || defaultSrc} src={mapSrc || defaultSrc} style={{ width: '100%', height: '100%', border: 'none' }} allowFullScreen loading="lazy" referrerPolicy="no-referrer-when-downgrade" title="Route map" />
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#e2e8f0', color: '#64748b', fontSize: 15 }}>Loading map…</div>
        )}
      </div>
      {route && (
        <div style={{ width: 340, background: 'white', display: 'flex', flexDirection: 'column', boxShadow: '-2px 0 12px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
          <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid #f1f5f9' }}>
            <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.3, color: '#0f172a' }}>{route.title}</div>
            <div style={{ fontSize: 13, color: '#64748b', marginTop: 6 }}>⏱ {route.duration_str} &nbsp;·&nbsp; 🛣️ {route.distance_mi} mi</div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>📍 → {route.destination}</div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 20 }}>
            {(route.segments || []).map((seg, i) => (
              <div key={i} style={{ paddingLeft: 14, borderLeft: `4px solid ${seg.color || '#3b82f6'}` }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: seg.color || '#3b82f6', marginBottom: 2 }}>{seg.label}</div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>{seg.duration} &nbsp;·&nbsp; {seg.miles}</div>
                <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.6 }}>{seg.description}</div>
              </div>
            ))}
          </div>
          <div style={{ padding: '14px 20px', borderTop: '1px solid #f1f5f9', display: 'flex', gap: 8 }}>
            <a href={buildNavUrl(route)} target="_blank" rel="noopener noreferrer"
              style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: '#1d4ed8', color: 'white', border: 'none', borderRadius: 10, padding: '11px 16px', cursor: 'pointer', fontSize: 13, fontWeight: 700, textDecoration: 'none' }}
            >
              🧭 Open in Google Maps
            </a>
            <button onClick={() => setRoute(null)} style={{ background: '#f1f5f9', color: '#64748b', border: 'none', borderRadius: 10, padding: '11px 16px', cursor: 'pointer', fontSize: 13 }}>✕</button>
          </div>
        </div>
      )}
    </div>
  );
}
