import { useState, useEffect, useRef } from 'react';
import { supabase } from './lib/supabase';
import { Menu, X, Maximize, Bug, LogIn, LogOut } from 'lucide-react';
import './App.css';

// ── Google Maps readiness poll ────────────────────────────────────────────────
function useMapsLoaded() {
  const [loaded, setLoaded] = useState(typeof window.google?.maps?.Map === 'function');
  useEffect(() => {
    if (typeof window.google?.maps?.Map === 'function') { setLoaded(true); return; }
    const id = setInterval(() => {
      if (typeof window.google?.maps?.Map === 'function') { setLoaded(true); clearInterval(id); }
    }, 100);
    return () => clearInterval(id);
  }, []);
  return loaded;
}

// ── Spinner CSS ───────────────────────────────────────────────────────────────
if (typeof document !== 'undefined') {
  const s = document.createElement('style');
  s.innerText = '@keyframes spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(s);
}

// ── GeoJSON → Google Maps Polylines ──────────────────────────────────────────
function geoJSONToPolylines(geojson) {
  const features = geojson?.type === 'FeatureCollection' ? geojson.features : [geojson];
  return features.map(f => {
    const geom = f.geometry || f;
    const coords = geom.type === 'MultiLineString' ? geom.coordinates.flat() : (geom.coordinates || []);
    return {
      path: coords.map(([lng, lat]) => ({ lat, lng })),
      options: { strokeColor: '#3b82f6', strokeWeight: 5, strokeOpacity: 0.85 }
    };
  });
}

const RECENT_KEY = 'twistyroute_recent_v2';
const START_LOCATION = 'Balancero cafe, Astoria, Queens, NY';
const LOADING_MESSAGES = [
  'Researching scenic roads…',
  'Asking Gemini for the best twisties…',
  'Plotting your escape from the city…',
  'Finding the good stuff…',
];

// ─────────────────────────────────────────────────────────────────────────────
export default function App() {

  // Route state
  const [routes, setRoutes] = useState([]);
  const [selectedRouteId, setSelectedRouteId] = useState(null);
  const [recentRoutes, setRecentRoutes] = useState(() => {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
  });

  // UI state
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  const [loading, setLoading] = useState(false);
  const [loadingMsgIdx, setLoadingMsgIdx] = useState(0);
  const [error, setError] = useState('');

  // Input
  const [query, setQuery] = useState('');

  // Bug report
  const [reportStatus, setReportStatus] = useState('Report Bug');
  const [isBugModalOpen, setIsBugModalOpen] = useState(false);
  const [bugScreenshot, setBugScreenshot] = useState(null);
  const [bugComment, setBugComment] = useState('');
  const [isSubmittingBug, setIsSubmittingBug] = useState(false);
  const [bugSubmitSuccess, setBugSubmitSuccess] = useState(false);

  // Auth
  const [user, setUser] = useState(null);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authMode, setAuthMode] = useState('login');
  const [authError, setAuthError] = useState('');

  // Map refs
  const mapDivRef = useRef(null);
  const mapRef = useRef(null);
  const polylinesRef = useRef([]);
  const mapsLoaded = useMapsLoaded();

  // Derived
  const selectedRoute = routes.find(r => r.id === selectedRouteId) || recentRoutes.find(r => r.id === selectedRouteId);
  const selectedGeoJSON = selectedRoute?.geojson ?? null;

  // ── Auth ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setUser(session?.user ?? null));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setUser(s?.user ?? null));
    return () => subscription.unsubscribe();
  }, []);

  // ── Resize ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const fn = () => { const m = window.innerWidth <= 768; setIsMobile(m); if (!m) setShowLeft(true); };
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);

  // ── Loading message cycle ───────────────────────────────────────────────────
  useEffect(() => {
    if (!loading) return;
    setLoadingMsgIdx(0);
    const id = setInterval(() => setLoadingMsgIdx(i => (i + 1) % LOADING_MESSAGES.length), 1800);
    return () => clearInterval(id);
  }, [loading]);

  // ── Init map ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapsLoaded || !mapDivRef.current || mapRef.current) return;
    mapRef.current = new window.google.maps.Map(mapDivRef.current, {
      center: { lat: 41.0, lng: -74.0 },
      zoom: 9,
      zoomControl: true,
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: false,
      gestureHandling: 'greedy',
    });
  }, [mapsLoaded]);

  // ── Draw route on map ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || !window.google) return;
    polylinesRef.current.forEach(p => p.setMap(null));
    polylinesRef.current = [];
    if (!selectedGeoJSON) return;
    const bounds = new window.google.maps.LatLngBounds();
    geoJSONToPolylines(selectedGeoJSON).forEach(line => {
      const poly = new window.google.maps.Polyline({
        path: line.path,
        strokeColor: line.options.strokeColor,
        strokeWeight: line.options.strokeWeight,
        strokeOpacity: line.options.strokeOpacity,
        map: mapRef.current,
      });
      polylinesRef.current.push(poly);
      line.path.forEach(pt => bounds.extend(pt));
    });
    if (!bounds.isEmpty()) mapRef.current.fitBounds(bounds, 40);
  }, [selectedGeoJSON, mapsLoaded]);

  // ── Generate route ──────────────────────────────────────────────────────────
  const handleGenerate = async () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError('');
    setRoutes([]);
    setSelectedRouteId(null);
    setShowRight(false);

    try {
      const edgeUrl = import.meta.env.VITE_SUPABASE_URL + '/functions/v1/generate-route';
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
      const res = await fetch(edgeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + anonKey },
        body: JSON.stringify({ query: q, start: START_LOCATION, destination: q }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const list = Array.isArray(data) ? data : [data];

      if (list.length === 0) {
        setError('No routes returned. Try a different request.');
        return;
      }

      setRoutes(list);
      setSelectedRouteId(list[0].id);
      setShowRight(true);
      if (isMobile) setShowLeft(false);

      // Save to recent
      setRecentRoutes(prev => {
        const merged = [...list, ...prev.filter(r => !list.find(nr => nr.id === r.id))].slice(0, 5);
        try { localStorage.setItem(RECENT_KEY, JSON.stringify(merged)); } catch {}
        return merged;
      });

    } catch (err) {
      console.error('[generate]', err);
      setError('Failed to generate route: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Map helpers ─────────────────────────────────────────────────────────────
  const fitRoute = () => {
    if (!mapRef.current || !selectedGeoJSON || !window.google) return;
    const bounds = new window.google.maps.LatLngBounds();
    const features = selectedGeoJSON.type === 'FeatureCollection' ? selectedGeoJSON.features : [selectedGeoJSON];
    features.forEach(f => {
      const geom = f.geometry || f;
      const coords = geom.type === 'MultiLineString' ? geom.coordinates.flat() : (geom.coordinates || []);
      coords.forEach(([lng, lat]) => bounds.extend({ lat, lng }));
    });
    if (!bounds.isEmpty()) mapRef.current.fitBounds(bounds, 40);
  };

  const openInGoogleMaps = () => {
    if (!selectedGeoJSON?.features) return;
    let coords = [];
    selectedGeoJSON.features.forEach(f => {
      if (f.geometry?.type === 'LineString') coords.push(...f.geometry.coordinates);
    });
    if (!coords.length) return;
    const fmt = c => `${c[1]},${c[0]}`;
    const origin = coords[0];
    const dest = coords[coords.length - 1];
    const maxWP = 8;
    let waypoints = [];
    if (coords.length > 2) {
      const step = Math.max(1, Math.floor((coords.length - 2) / (maxWP + 1)));
      for (let i = 1; i <= maxWP && i * step < coords.length - 1; i++) waypoints.push(coords[i * step]);
    }
    let url = `https://www.google.com/maps/dir/?api=1&origin=${fmt(origin)}&destination=${fmt(dest)}&travelmode=driving`;
    if (waypoints.length) url += `&waypoints=${waypoints.map(fmt).join('|')}`;
    window.open(url, '_blank');
  };

  const downloadGPX = () => {
    if (!selectedGeoJSON?.features) return;
    let trkpts = '';
    selectedGeoJSON.features.forEach(f => {
      if (f.geometry?.type === 'LineString') {
        f.geometry.coordinates.forEach(c => { trkpts += `  <trkpt lat="${c[1]}" lon="${c[0]}"></trkpt>\n`; });
      }
    });
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="TwistyRoute">\n  <trk>\n    <name>${selectedRoute?.title || 'Route'}</name>\n    <trkseg>\n${trkpts}    </trkseg>\n  </trk>\n</gpx>`;
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' })),
      download: `${(selectedRoute?.title || 'route').replace(/[^a-z0-9]/gi, '_').toLowerCase()}.gpx`,
    });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  // ── Bug report ──────────────────────────────────────────────────────────────
  const handleReportBug = async () => {
    setReportStatus('Capturing…');
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser' }, preferCurrentTab: true });
      await new Promise(r => setTimeout(r, 400));
      const video = Object.assign(document.createElement('video'), { srcObject: stream, muted: true });
      await new Promise(r => { video.onloadedmetadata = r; });
      await video.play();
      await new Promise(r => requestAnimationFrame(r));
      const canvas = Object.assign(document.createElement('canvas'), { width: video.videoWidth, height: video.videoHeight });
      canvas.getContext('2d').drawImage(video, 0, 0);
      setBugScreenshot(canvas.toDataURL('image/jpeg', 0.85));
      setIsBugModalOpen(true);
      setReportStatus('Report Bug');
    } catch { setReportStatus('Report Bug'); }
    finally { if (stream) stream.getTracks().forEach(t => t.stop()); }
  };

  const handleSubmitBug = async () => {
    setIsSubmittingBug(true);
    try {
      await supabase.from('bug_reports').insert([{
        user_id: user?.id ?? null,
        route_id: selectedRouteId ?? null,
        comment: bugComment,
        image_data: bugScreenshot,
        page_context: { query, selectedRouteTitle: selectedRoute?.title ?? null, url: window.location.href },
        created_at: new Date().toISOString(),
      }]);
      setBugSubmitSuccess(true);
      setTimeout(() => { setBugSubmitSuccess(false); setIsBugModalOpen(false); setBugScreenshot(null); setBugComment(''); }, 2000);
    } catch (err) { alert('Error submitting bug report'); }
    finally { setIsSubmittingBug(false); }
  };

  // ── Auth ────────────────────────────────────────────────────────────────────
  const handleAuth = async () => {
    setAuthError('');
    const fn = authMode === 'login' ? supabase.auth.signInWithPassword : supabase.auth.signUp;
    const { error } = await fn({ email: authEmail, password: authPassword });
    if (error) setAuthError(error.message);
    else if (authMode === 'login') setIsAuthOpen(false);
    else setAuthError('Check your email for the confirmation link.');
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', fontFamily: 'sans-serif' }}>

      {/* Mobile menu toggle */}
      {isMobile && !showLeft && (
        <button onClick={() => setShowLeft(true)} style={{ position: 'absolute', top: 12, left: 12, zIndex: 1001, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 8, cursor: 'pointer' }}>
          <Menu size={20} />
        </button>
      )}

      {/* ── Left sidebar ──────────────────────────────────────────────────── */}
      {showLeft && (
        <div style={{ width: 280, background: '#fff', borderRight: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', padding: 16, zIndex: 1000, overflowY: 'auto', position: isMobile ? 'absolute' : 'relative', top: 0, left: 0, height: '100%' }}>

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>🏍️ TwistyRoute</h1>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {user
                ? <button onClick={() => supabase.auth.signOut()} title="Logout" style={{ background: 'none', border: 'none', cursor: 'pointer' }}><LogOut size={18} /></button>
                : <button onClick={() => setIsAuthOpen(true)} title="Login" style={{ background: 'none', border: 'none', cursor: 'pointer' }}><LogIn size={18} /></button>
              }
              {isMobile && <button onClick={() => setShowLeft(false)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><X size={20} /></button>}
            </div>
          </div>

          {/* Starting point */}
          <div style={{ marginBottom: 14, padding: '10px 12px', background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' }}>
            <p style={{ margin: '0 0 2px', fontSize: 11, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Starting from</p>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#374151' }}>📍 Balancero cafe, Astoria</p>
          </div>

          {/* Query input */}
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Where do you want to ride?</label>
            <textarea
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleGenerate())}
              placeholder={"e.g., scenic route to Hawks Nest\ntwisty roads through the Catskills\nBear Mountain loop with a coffee stop"}
              rows={4}
              style={{ width: '100%', padding: 10, border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box', resize: 'none', lineHeight: 1.5, fontFamily: 'sans-serif', color: '#111827' }}
            />
          </div>

          {/* Generate button */}
          <button
            onClick={handleGenerate}
            disabled={loading || !query.trim()}
            style={{ width: '100%', padding: '11px 0', background: loading ? '#93c5fd' : '#3b82f6', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: loading || !query.trim() ? 'not-allowed' : 'pointer', marginBottom: 12 }}
          >
            {loading ? LOADING_MESSAGES[loadingMsgIdx] : '🗺️ Generate Route'}
          </button>

          {/* Loading spinner */}
          {loading && (
            <div style={{ textAlign: 'center', padding: '12px 0', marginBottom: 12 }}>
              <div style={{ width: 28, height: 28, border: '3px solid #e5e7eb', borderTop: '3px solid #3b82f6', borderRadius: '50%', margin: '0 auto 8px', animation: 'spin 1s linear infinite' }} />
              <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>AI is planning your ride…</p>
            </div>
          )}

          {/* Error */}
          {error && (
            <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 12px', marginBottom: 12, fontSize: 13, color: '#b91c1c' }}>
              {error}
            </div>
          )}

          {/* Current results */}
          {routes.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <p style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 8px' }}>Route</p>
              {routes.map(r => (
                <div key={r.id} onClick={() => { setSelectedRouteId(r.id); setShowRight(true); if (isMobile) setShowLeft(false); }}
                  style={{ padding: '10px 12px', borderRadius: 8, marginBottom: 6, cursor: 'pointer', border: selectedRouteId === r.id ? '2px solid #3b82f6' : '1px solid #e5e7eb', background: selectedRouteId === r.id ? '#eff6ff' : '#fff' }}>
                  <p style={{ margin: '0 0 2px', fontWeight: 700, fontSize: 14 }}>{r.title}</p>
                  <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>
                    {r.duration_str && `⏱ ${r.duration_str}`}{r.distance_mi && ` · 🛣️ ${r.distance_mi} mi`}
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* Recent routes */}
          {recentRoutes.length > 0 && (
            <div>
              <p style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 8px' }}>Recent</p>
              <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                {recentRoutes.map(r => (
                  <div key={r.id} onClick={() => { setSelectedRouteId(r.id); setShowRight(true); if (isMobile) setShowLeft(false); }}
                    style={{ padding: '8px 12px', borderRadius: 8, marginBottom: 4, cursor: 'pointer', border: selectedRouteId === r.id ? '2px solid #3b82f6' : '1px solid #e5e7eb', background: selectedRouteId === r.id ? '#eff6ff' : '#fafafa' }}>
                    <p style={{ margin: '0 0 1px', fontWeight: 600, fontSize: 13 }}>{r.title}</p>
                    <p style={{ margin: 0, fontSize: 11, color: '#9ca3af' }}>
                      {r.duration_str && `⏱ ${r.duration_str}`}{r.destination ? ` · ${r.destination}` : ''}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Map ───────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative' }}>
        {!mapsLoaded && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f3f4f6', zIndex: 1 }}>
            <p style={{ color: '#6b7280', fontSize: 14 }}>Loading map…</p>
          </div>
        )}
        <div ref={mapDivRef} style={{ height: '100%', width: '100%' }} />
        <div style={{ position: 'absolute', bottom: 16, right: 16, display: 'flex', gap: 8, zIndex: 1000 }}>
          <button onClick={handleReportBug} style={{ padding: '8px 14px', background: '#fff', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Bug size={14} /> {reportStatus}
          </button>
          <button onClick={fitRoute} disabled={!selectedGeoJSON} style={{ padding: '8px 14px', background: '#fff', border: '1px solid #d1d5db', borderRadius: 6, cursor: selectedGeoJSON ? 'pointer' : 'default', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, opacity: selectedGeoJSON ? 1 : 0.5 }}>
            <Maximize size={14} /> Fit Route
          </button>
        </div>
      </div>

      {/* ── Right panel ───────────────────────────────────────────────────── */}
      {selectedRoute && showRight && (
        <div style={{ width: 300, background: '#fff', borderLeft: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', zIndex: 1000, position: isMobile ? 'absolute' : 'relative', top: 0, right: 0, height: '100%' }}>

          {/* Route header */}
          <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid #f3f4f6' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: '0 0 4px', fontWeight: 700, fontSize: 17, lineHeight: 1.3 }}>{selectedRoute.title}</p>
                {(selectedRoute.duration_str || selectedRoute.distance_mi) && (
                  <p style={{ margin: 0, fontSize: 13, color: '#f97316', fontWeight: 600 }}>
                    {selectedRoute.duration_str && `⏱ ${selectedRoute.duration_str}`}
                    {selectedRoute.distance_mi && ` · 🛣️ ${selectedRoute.distance_mi} mi`}
                  </p>
                )}
                {selectedRoute.destination && (
                  <p style={{ margin: '3px 0 0', fontSize: 12, color: '#9ca3af' }}>📍 → {selectedRoute.destination}</p>
                )}
              </div>
              {isMobile && <button onClick={() => setShowRight(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', marginLeft: 8, flexShrink: 0 }}><X size={18} /></button>}
            </div>
          </div>

          {/* Segment narrative */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
            {(selectedRoute.segments || []).map((seg, i) => (
              <div key={i} style={{ borderLeft: `4px solid ${seg.color || '#6b7280'}`, paddingLeft: 14, marginBottom: 24 }}>
                <p style={{ fontWeight: 700, margin: '0 0 3px', fontSize: 14, color: '#111827' }}>{seg.label}</p>
                {(seg.duration || seg.miles) && (
                  <p style={{ margin: '0 0 8px', fontSize: 12, color: '#f97316', fontWeight: 600 }}>
                    {[seg.duration, seg.miles].filter(Boolean).join(' · ')}
                  </p>
                )}
                {(seg.description || seg.desc) && (
                  <p style={{ margin: 0, fontSize: 14, color: '#374151', lineHeight: 1.7 }}>
                    {seg.description || seg.desc}
                  </p>
                )}
              </div>
            ))}
            {(!selectedRoute.segments || selectedRoute.segments.length === 0) && (
              <p style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', marginTop: 40 }}>No route details available.</p>
            )}
          </div>

          {/* Action buttons */}
          <div style={{ padding: '12px 16px', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 8 }}>
            <button onClick={openInGoogleMaps} style={{ flex: 1, padding: '10px 8px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
              Open in Maps
            </button>
            <button onClick={downloadGPX} style={{ flex: 1, padding: '10px 8px', background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              Download GPX
            </button>
          </div>
        </div>
      )}

      {/* ── Bug modal ─────────────────────────────────────────────────────── */}
      {isBugModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 360, maxWidth: '90vw' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>Report a Bug</h2>
              <button onClick={() => { setIsBugModalOpen(false); setBugScreenshot(null); setBugComment(''); }} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><X size={20} /></button>
            </div>
            {bugScreenshot && <img src={bugScreenshot} alt="Screenshot" style={{ width: '100%', borderRadius: 8, marginBottom: 12, border: '1px solid #e5e7eb' }} />}
            <textarea value={bugComment} onChange={e => setBugComment(e.target.value)} placeholder="What went wrong?" rows={3} style={{ width: '100%', padding: 10, border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box', marginBottom: 12, resize: 'vertical' }} />
            {bugSubmitSuccess
              ? <div style={{ textAlign: 'center', color: '#059669', fontWeight: 600 }}>✓ Bug reported! Thanks.</div>
              : <button onClick={handleSubmitBug} disabled={isSubmittingBug} style={{ width: '100%', padding: 10, background: '#ef4444', color: '#fff', border: 'none', borderRadius: 6, fontSize: 15, fontWeight: 600, cursor: isSubmittingBug ? 'not-allowed' : 'pointer' }}>
                  {isSubmittingBug ? 'Submitting…' : 'Submit Bug Report'}
                </button>
            }
          </div>
        </div>
      )}

      {/* ── Auth modal ────────────────────────────────────────────────────── */}
      {isAuthOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 32, width: 320, maxWidth: '90vw' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>{authMode === 'login' ? 'Log In' : 'Sign Up'}</h2>
              <button onClick={() => setIsAuthOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><X size={20} /></button>
            </div>
            {authError && <p style={{ color: '#ef4444', fontSize: 13, marginBottom: 12 }}>{authError}</p>}
            <input type="email" placeholder="Email" value={authEmail} onChange={e => setAuthEmail(e.target.value)} style={{ width: '100%', padding: 10, border: '1px solid #d1d5db', borderRadius: 6, marginBottom: 10, fontSize: 14, boxSizing: 'border-box' }} />
            <input type="password" placeholder="Password" value={authPassword} onChange={e => setAuthPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAuth()} style={{ width: '100%', padding: 10, border: '1px solid #d1d5db', borderRadius: 6, marginBottom: 16, fontSize: 14, boxSizing: 'border-box' }} />
            <button onClick={handleAuth} style={{ width: '100%', padding: 10, background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, fontSize: 15, fontWeight: 600, cursor: 'pointer', marginBottom: 12 }}>
              {authMode === 'login' ? 'Log In' : 'Sign Up'}
            </button>
            <p style={{ textAlign: 'center', fontSize: 13, margin: 0 }}>
              {authMode === 'login' ? "Don't have an account? " : 'Already have an account? '}
              <span onClick={() => setAuthMode(authMode === 'login' ? 'signup' : 'login')} style={{ color: '#3b82f6', cursor: 'pointer', fontWeight: 600 }}>
                {authMode === 'login' ? 'Sign Up' : 'Log In'}
              </span>
            </p>
          </div>
        </div>
      )}

    </div>
  );
}
