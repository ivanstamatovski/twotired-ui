import { useState, useEffect, useRef } from 'react';
import { supabase } from './lib/supabase';
import { Menu, X, Maximize, Bug, LogIn, LogOut } from 'lucide-react';
import './App.css';
import { getRoutes, submitBugReport, saveRoute, logRouteRequest } from './lib/routeService';

// Poll until the Google Maps script (loaded in index.html) is ready
function useMapsLoaded() {
  const [loaded, setLoaded] = useState(!!window.google?.maps);
  useEffect(() => {
    if (window.google?.maps) { setLoaded(true); return; }
    const id = setInterval(() => {
      if (window.google?.maps) { setLoaded(true); clearInterval(id); }
    }, 100);
    return () => clearInterval(id);
  }, []);
  return loaded;
}

// Inject CSS for spinner animation
const styles = `
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
`;
if (typeof document !== 'undefined') {
  const styleSheet = document.createElement('style');
  styleSheet.innerText = styles;
  document.head.appendChild(styleSheet);
}

// ── Duration helpers ───────────────────────────────────────────────────────
const parseMins = (str) => {
  if (!str) return 0;
  const h = str.match(/(\d+)\s*h/);
  const m = str.match(/(\d+)\s*min/);
  return (h ? parseInt(h[1]) * 60 : 0) + (m ? parseInt(m[1]) : 0);
};
const formatMins = (total) => {
  if (!total || total <= 0) return '';
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
};
const sumDurations = (segs) => formatMins(segs.reduce((acc, s) => acc + parseMins(s.duration), 0));

const RECENT_KEY = 'twistyroute_recent';

// Convert GeoJSON FeatureCollection → array of {path, options} for Google Maps Polylines
function geoJSONToPolylines(geojson) {
  const features = geojson?.type === 'FeatureCollection' ? geojson.features : [geojson];
  return features.map(f => {
    const leg = f.properties?.leg;
    const color = leg === 'highway' ? '#e74c3c' : leg === 'parkway' ? '#9b59b6' : '#2ecc71';
    const weight = leg === 'highway' || leg === 'parkway' ? 5 : 6;
    const geom = f.geometry || f;
    const coords = geom.type === 'MultiLineString'
      ? geom.coordinates.flat()
      : geom.coordinates || [];
    return {
      path: coords.map(([lng, lat]) => ({ lat, lng })),
      options: { strokeColor: color, strokeWeight: weight, strokeOpacity: 0.9 }
    };
  });
}

function App() {
  // ── Route state ────────────────────────────────────────────────────────────
  const [routesDb, setRoutesDb] = useState([]);
  const [selectedRouteId, setSelectedRouteId] = useState(null);
  const [searchResults, setSearchResults] = useState(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [lastSearchedQuery, setLastSearchedQuery] = useState('');
  const [generating, setGenerating] = useState(false);
  const [isRequestingRoute, setIsRequestingRoute] = useState(false);
  const [routeRequestSuccess, setRouteRequestSuccess] = useState('');

  // ── UI state ───────────────────────────────────────────────────────────────
  const [showLeftSidebar, setShowLeftSidebar] = useState(true);
  const [showRightSidebar, setShowRightSidebar] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768 || window.innerHeight <= 500);

  // ── Input state ────────────────────────────────────────────────────────────
  const [startLocation] = useState('Balancero Astoria');
  const [routeRequestText, setRouteRequestText] = useState('');

  // ── Recent routes (localStorage) ──────────────────────────────────────────
  const [recentRoutes, setRecentRoutes] = useState(() => {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
  });

  // ── Cycling loading message ────────────────────────────────────────────────
  const loadingMessages = ['Researching routes...', 'Connecting to destination...', 'Drawing your path...', 'Finding twisty roads...'];
  const [loadingMsgIdx, setLoadingMsgIdx] = useState(0);

  // ── Bug report state ───────────────────────────────────────────────────────
  const [reportStatus, setReportStatus] = useState('Report Bug');
  const [isBugModalOpen, setIsBugModalOpen] = useState(false);
  const [bugScreenshot, setBugScreenshot] = useState(null);
  const [bugComment, setBugComment] = useState('');
  const [isSubmittingBug, setIsSubmittingBug] = useState(false);
  const [bugSubmitSuccess, setBugSubmitSuccess] = useState(false);

  // ── Auth state ─────────────────────────────────────────────────────────────
  const [user, setUser] = useState(null);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authMode, setAuthMode] = useState('login');
  const [authError, setAuthError] = useState('');

  const mapDivRef = useRef(null);   // DOM div for the map
  const mapRef = useRef(null);      // google.maps.Map instance
  const polylinesRef = useRef([]);  // active Polyline instances
  const mapsLoaded = useMapsLoaded();

  // ── Auth + initial data + realtime subscription ────────────────────────────
  useEffect(() => {
    // Auth check
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    // Load all existing routes on mount
    const fetchInitialRoutes = async () => {
      const { data, error } = await supabase
        .from('routes')
        .select('*')
        .eq('is_stale', false)
        .order('community_score', { ascending: false });
      if (!error && data) {
        setRoutesDb(data.map(r => ({ ...r, group: r.group_name })));
      }
    };
    fetchInitialRoutes();

    // Realtime: listen for new/updated routes (e.g. from AI generation)
    const channel = supabase.channel('public:routes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'routes' }, (payload) => {
        if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
          const mapped = { ...payload.new, group: payload.new.group_name };
          // Prefer routes with geojson (drawable line). If this route has geojson,
          // always upgrade the selection — even if another route was auto-selected first.
          // Only keeps prev if it already had geojson or this one doesn't.
          setSelectedRouteId(prev => mapped.geojson ? mapped.id : (prev ?? mapped.id));
          setIsRequestingRoute(false);
          setGenerating(false); // background generation complete
          setRouteRequestSuccess('');
          setShowRightSidebar(true);
          if (window.innerWidth <= 768 || window.innerHeight <= 500) {
            setShowLeftSidebar(false);
          }
          // Add to DB cache
          setRoutesDb(prev => {
            const idx = prev.findIndex(r => r.id === mapped.id);
            if (idx >= 0) { const next = [...prev]; next[idx] = mapped; return next; }
            return [...prev, mapped];
          });
          // Accumulate into searchResults — but never overwrite a route that already
          // has waypoints (edge function response) with a DB version that lacks them
          setSearchResults(prev => {
            const list = prev ?? [];
            const idx = list.findIndex(r => r.id === mapped.id);
            if (idx >= 0) {
              const existing = list[idx];
              // Keep whichever version has waypoints
              const merged = { ...mapped, ...(existing.waypoints ? { waypoints: existing.waypoints } : {}), ...(existing.segments ? { segments: existing.segments } : {}) };
              const next = [...list]; next[idx] = merged; return next;
            }
            return [...list, mapped];
          });
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      subscription.unsubscribe();
    };
  }, []);

  // ── Resize handler ─────────────────────────────────────────────────────────
  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth <= 768 || window.innerHeight <= 500;
      setIsMobile(mobile);
      if (!mobile) setShowLeftSidebar(true);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // ── Cycle loading message while generating ─────────────────────────────────
  useEffect(() => {
    if (!generating && !isRequestingRoute) return;
    setLoadingMsgIdx(0);
    const id = setInterval(() => setLoadingMsgIdx(i => (i + 1) % loadingMessages.length), 1800);
    return () => clearInterval(id);
  }, [generating, isRequestingRoute]);

  // ── Auto-resolve loading when new route arrives via websocket ──────────────
  useEffect(() => {
    if (isRequestingRoute && routeRequestText.trim()) {
      const query = routeRequestText.trim().toLowerCase();
      const matches = routesDb.filter(r =>
        (r.title && r.title.toLowerCase().includes(query)) ||
        (r.desc && r.desc.toLowerCase().includes(query)) ||
        (r.group && r.group.toLowerCase().includes(query))
      );
      if (matches.length > 0) {
        setIsRequestingRoute(false);
        setSearchResults(matches);
      }
    }
  }, [routesDb, isRequestingRoute, routeRequestText]);

  // ── OSRM route fetching (for routes without stored geojson) ───────────────
  const [computedGeoJSON, setComputedGeoJSON] = useState(null);

  useEffect(() => {
    setComputedGeoJSON(null);
    if (!selectedRouteId) return;
    const route = (searchResults || []).find(r => r.id === selectedRouteId)
      || routesDb.find(r => r.id === selectedRouteId);
    if (!route) return;
    if (route.geojson) return; // already has geojson, no need to fetch

    const waypoints = route.waypoints;
    if (!waypoints || waypoints.length < 2) return;

    const coords = waypoints.map(w => `${w.lng},${w.lat}`).join(';');
    const radii = waypoints.map(() => 'unlimited').join(';');
    fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&radiuses=${radii}`)
      .then(r => r.json())
      .then(data => {
        if (data.routes && data.routes[0]) {
          setComputedGeoJSON({
            type: 'FeatureCollection',
            features: [{ type: 'Feature', geometry: data.routes[0].geometry, properties: {} }]
          });
        }
      })
      .catch(() => {
        // Fallback: straight line between waypoints
        setComputedGeoJSON({
          type: 'FeatureCollection',
          features: [{ type: 'Feature', geometry: {
            type: 'LineString',
            coordinates: waypoints.map(w => [w.lng, w.lat])
          }, properties: {} }]
        });
      });
  }, [selectedRouteId, routesDb, searchResults]);

  // ── Init native Google Maps when API is ready ─────────────────────────────
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

  // ── Draw polylines + auto-fit when route changes ──────────────────────────
  useEffect(() => {
    if (!mapRef.current || !window.google) return;
    // Clear previous polylines
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

  // ── Derived values ─────────────────────────────────────────────────────────
  const selectedRoute = (searchResults || []).find(r => r.id === selectedRouteId)
    || routesDb.find(r => r.id === selectedRouteId);
  const selectedGeoJSON = selectedRoute?.geojson ?? computedGeoJSON;
  // Only show search results — never show the full historical DB list
  const displayRoutes = searchResults !== null ? searchResults : [];

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleRouteRequest = async () => {
    const query = routeRequestText.trim();
    if (!query) return;

    setLastSearchedQuery(query);
    setGenerating(true);
    setRouteRequestSuccess('');
    setSearchResults(null);
    setSelectedRouteId(null); // reset so realtime auto-selects the first new route

    let backgroundMode = false;
    try {
      // Step 1: Check DB for existing cached routes
      const { routes: cachedRoutes } = await getRoutes(query);
      if (cachedRoutes && cachedRoutes.length > 0) {
        const mapped = cachedRoutes.map(r => ({ ...r, group: r.group_name }));
        setSearchResults(mapped);
        setHasSearched(true);
        setRoutesDb(prev => {
          const merged = [...prev];
          mapped.forEach(r => { if (!merged.find(e => e.id === r.id)) merged.push(r); });
          return merged;
        });
        return;
      }

      // Step 2: Call edge function — Gemini handles geocoding internally via Maps grounding
      // Use fetch with explicit anon key — avoids supabase.functions.invoke sending an
      // expired session JWT which results in 401 from the Supabase gateway.
      setIsRequestingRoute(true);
      const edgeFnUrl = import.meta.env.VITE_SUPABASE_URL + '/functions/v1/generate-route';
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
      const res = await fetch(edgeFnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + anonKey },
        body: JSON.stringify({ start: startLocation, destination: query })
      });
      const data = res.ok ? await res.json() : null;
      const error = res.ok ? null : { message: `HTTP ${res.status}` };

      if (error) {
        console.error('[generate-route] Edge function error:', error.message);
        // fall through to finally — clear loading state
      } else if (data?.status === 'generating') {
        // Edge function returned immediately — all work is running in background.
        // Realtime subscription will deliver routes + geojson when DB insert fires.
        // Keep generating=true and isRequestingRoute=true so the spinner stays up.
        // The realtime handler clears both when the first route arrives.
        // Failsafe: clear after 90s in case realtime never fires.
        backgroundMode = true;
        setTimeout(() => { setGenerating(false); setIsRequestingRoute(false); }, 90000);
      } else {
        // Edge function returned routes directly (future fast path)
        const routes = Array.isArray(data) ? data : [];
        console.log('[generate-route] Direct response:', routes.length, 'routes');
        if (routes.length > 0) {
          const mapped = routes.map(r => ({ ...r, group: r.group_name }));
          setSearchResults(mapped);
          setHasSearched(true);
          setRoutesDb(prev => {
            const merged = [...prev];
            mapped.forEach(r => { if (!merged.find(e => e.id === r.id)) merged.push(r); });
            return merged;
          });
          setSelectedRouteId(mapped[0].id);
          setShowRightSidebar(true);
          if (isMobile) setShowLeftSidebar(false);
          setRecentRoutes(prev => {
            const merged = [...mapped, ...prev.filter(r => !mapped.find(nr => nr.id === r.id))].slice(0, 5);
            try { localStorage.setItem(RECENT_KEY, JSON.stringify(merged)); } catch {}
            return merged;
          });
        }
      }
    } catch (err) {
      console.error('[generate-route] Exception:', err);
    } finally {
      if (!backgroundMode) {
        setGenerating(false);
        setIsRequestingRoute(false);
      }
    }
  };

  const handleSelectRoute = (id) => {
    setSelectedRouteId(id);
    setShowRightSidebar(true);
    if (isMobile) setShowLeftSidebar(false);
  };

  const fitRoute = () => {
    if (mapRef.current && selectedGeoJSON && window.google) {
      const bounds = new window.google.maps.LatLngBounds();
      const features = selectedGeoJSON.type === 'FeatureCollection' ? selectedGeoJSON.features : [selectedGeoJSON];
      features.forEach(f => {
        const geom = f.geometry || f;
        const coords = geom.type === 'MultiLineString' ? geom.coordinates.flat() : (geom.coordinates || []);
        coords.forEach(([lng, lat]) => bounds.extend({ lat, lng }));
      });
      mapRef.current.fitBounds(bounds, 40);
    }
  };

  const handleOpenInGoogleMaps = () => {
    if (!selectedGeoJSON?.features) return;
    let coords = [];
    selectedGeoJSON.features.forEach(f => {
      if (f.geometry?.type === 'LineString') coords.push(...f.geometry.coordinates);
    });
    if (coords.length === 0) return;
    const origin = coords[0];
    const dest = coords[coords.length - 1];
    const maxWP = 8;
    let waypoints = [];
    if (coords.length > 2) {
      const step = Math.max(1, Math.floor((coords.length - 2) / (maxWP + 1)));
      for (let i = 1; i <= maxWP && i * step < coords.length - 1; i++) {
        waypoints.push(coords[i * step]);
      }
    }
    const fmt = c => `${c[1]},${c[0]}`;
    let url = `https://www.google.com/maps/dir/?api=1&origin=${fmt(origin)}&destination=${fmt(dest)}`;
    if (waypoints.length > 0) url += `&waypoints=${waypoints.map(fmt).join('|')}`;
    window.open(url, '_blank');
  };

  const handleDownloadGPX = () => {
    if (!selectedGeoJSON?.features) return;
    let trkpts = '';
    selectedGeoJSON.features.forEach(f => {
      if (f.geometry?.type === 'LineString') {
        f.geometry.coordinates.forEach(c => {
          trkpts += `    <trkpt lat="${c[1]}" lon="${c[0]}"></trkpt>\n`;
        });
      }
    });
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TwistyRoute">
  <trk>
    <name>${selectedRoute?.title || 'Route'}</name>
    <trkseg>
${trkpts}    </trkseg>
  </trk>
</gpx>`;
    const blob = new Blob([gpx], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(selectedRoute?.title || 'route').replace(/[^a-z0-9]/gi, '_').toLowerCase()}.gpx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleSaveRoute = async () => {
    if (!user) { setIsAuthModalOpen(true); return; }
    if (!selectedRouteId) return;
    await saveRoute(selectedRouteId, user.id);
  };

  const handleReportBug = async () => {
    setReportStatus('Capturing...');
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' },
        preferCurrentTab: true,
      });

      // Let the browser repaint the tab fully after the share dialog closes
      await new Promise(r => setTimeout(r, 400));

      const track = stream.getVideoTracks()[0];
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await new Promise(r => { video.onloadedmetadata = r; });
      await video.play();
      await new Promise(r => requestAnimationFrame(r));

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0);

      // Google Maps renders natively in the browser capture — no manual redraw needed

      setBugScreenshot(canvas.toDataURL('image/jpeg', 0.85));
      setIsBugModalOpen(true);
      setReportStatus('Report Bug');
    } catch (err) {
      console.error('Screen capture failed:', err);
      setReportStatus('Report Bug');
    } finally {
      if (stream) stream.getTracks().forEach(t => t.stop());
    }
  };

  const handleSubmitBug = async () => {
    setIsSubmittingBug(true);
    try {
      await submitBugReport({
        userId: user?.id ?? null,
        routeId: selectedRouteId,
        comment: bugComment,
        imageData: bugScreenshot,
        pageContext: {
          destination: routeRequestText,
          selectedRouteTitle: selectedRoute?.title ?? null,
          url: window.location.href,
        },
      });
      setBugSubmitSuccess(true);
      setTimeout(() => {
        setBugSubmitSuccess(false);
        setIsBugModalOpen(false);
        setBugScreenshot(null);
        setBugComment('');
      }, 2000);
    } catch (err) {
      console.error(err);
      alert('Error submitting bug report');
    } finally {
      setIsSubmittingBug(false);
    }
  };

  const closeBugModal = () => {
    setIsBugModalOpen(false);
    setBugScreenshot(null);
    setBugComment('');
  };

  const handleAuth = async () => {
    setAuthError('');
    if (authMode === 'login') {
      const { error } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword });
      if (error) setAuthError(error.message);
      else setIsAuthModalOpen(false);
    } else {
      const { error } = await supabase.auth.signUp({ email: authEmail, password: authPassword });
      if (error) setAuthError(error.message);
      else setAuthError('Check your email for the confirmation link.');
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', fontFamily: 'sans-serif' }}>

      {/* Mobile hamburger */}
      {isMobile && !showLeftSidebar && (
        <button
          onClick={() => setShowLeftSidebar(true)}
          style={{ position: 'absolute', top: '12px', left: '12px', zIndex: 1001, background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '8px', cursor: 'pointer' }}
        >
          <Menu size={20} />
        </button>
      )}

      {/* ── Left sidebar ────────────────────────────────────────────────── */}
      {showLeftSidebar && (
        <div style={{
          width: '280px', background: '#fff', borderRight: '1px solid #e5e7eb',
          display: 'flex', flexDirection: 'column', padding: '16px',
          zIndex: 1000, overflowY: 'auto',
          position: isMobile ? 'absolute' : 'relative',
          top: 0, left: 0, height: '100%'
        }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <h1 style={{ fontSize: '20px', fontWeight: 700, margin: 0 }}>🏍️ TwistyRoute</h1>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              {user ? (
                <button onClick={handleLogout} title="Logout" style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                  <LogOut size={18} />
                </button>
              ) : (
                <button onClick={() => setIsAuthModalOpen(true)} title="Login" style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                  <LogIn size={18} />
                </button>
              )}
              {isMobile && (
                <button onClick={() => setShowLeftSidebar(false)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                  <X size={20} />
                </button>
              )}
            </div>
          </div>

          {/* From */}
          <div style={{ marginBottom: '8px' }}>
            <label style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: '4px' }}>FROM</label>
            <input
              value={startLocation}
              readOnly
              style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box', background: '#f9fafb' }}
            />
          </div>

          {/* Destination */}
          <div style={{ marginBottom: '12px' }}>
            <label style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: '4px' }}>WHERE TO?</label>
            <input
              value={routeRequestText}
              onChange={e => setRouteRequestText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleRouteRequest()}
              placeholder="e.g., Bear Mountain, Hawk's Nest"
              style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }}
            />
          </div>

          {/* Generate button */}
          <button
            onClick={handleRouteRequest}
            disabled={generating || isRequestingRoute || !routeRequestText.trim()}
            style={{
              width: '100%', padding: '10px',
              background: generating || isRequestingRoute ? '#93c5fd' : '#3b82f6',
              color: '#fff', border: 'none', borderRadius: '6px',
              fontSize: '15px', fontWeight: 600,
              cursor: generating || isRequestingRoute || !routeRequestText.trim() ? 'not-allowed' : 'pointer',
              marginBottom: '16px'
            }}
          >
            {(generating || isRequestingRoute) ? loadingMessages[loadingMsgIdx] : 'Generate'}
          </button>

          {/* AI generation loading state */}
          {isRequestingRoute && (
            <div style={{ border: '1px dashed #3b82f6', borderRadius: '8px', padding: '16px', marginBottom: '16px', textAlign: 'center' }}>
              <div style={{ width: '32px', height: '32px', border: '3px solid #e5e7eb', borderTop: '3px solid #3b82f6', borderRadius: '50%', margin: '0 auto 12px', animation: 'spin 1s linear infinite' }} />
              <p style={{ fontWeight: 600, margin: '0 0 8px' }}>Generating Custom Route...</p>
              <p style={{ fontSize: '13px', color: '#6b7280', margin: 0 }}>
                AI is finding the best twisty roads to <strong>{lastSearchedQuery}</strong>
              </p>
            </div>
          )}

          {/* Success message */}
          {routeRequestSuccess && (
            <div style={{ background: '#d1fae5', border: '1px solid #6ee7b7', borderRadius: '8px', padding: '12px', marginBottom: '16px', fontSize: '13px', color: '#065f46' }}>
              {routeRequestSuccess}
            </div>
          )}

          {/* No results message */}
          {hasSearched && searchResults !== null && searchResults.length === 0 && !isRequestingRoute && (
            <div style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: '8px', padding: '12px', marginBottom: '16px', fontSize: '13px', color: '#92400e' }}>
              No saved routes match "{lastSearchedQuery}". A custom route request has been sent.
            </div>
          )}

          {/* Current results */}
          {displayRoutes.length > 0 && (
            <div style={{ marginBottom: '16px' }}>
              <p style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 8px' }}>
                {`Results for "${lastSearchedQuery}"`}
              </p>
              {displayRoutes.map(route => {
                const segs = route.segments || [];
                const total = segs.length > 0 ? sumDurations(segs) : (route.duration_str || '');
                return (
                  <div
                    key={route.id}
                    onClick={() => handleSelectRoute(route.id)}
                    style={{
                      padding: '10px 12px', borderRadius: '8px', marginBottom: '8px', cursor: 'pointer',
                      border: selectedRouteId === route.id ? '2px solid #3b82f6' : '1px solid #e5e7eb',
                      background: selectedRouteId === route.id ? '#eff6ff' : '#fff'
                    }}
                  >
                    <p style={{ margin: '0 0 2px', fontWeight: 600, fontSize: '14px' }}>{route.title}</p>
                    <p style={{ margin: 0, fontSize: '12px', color: '#6b7280' }}>
                      {total && `⏱ ${total}`}{route.destination ? ` · ${route.destination}` : ''}
                    </p>
                  </div>
                );
              })}
            </div>
          )}

          {/* Recent Results */}
          {recentRoutes.length > 0 && (
            <div>
              <p style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 8px' }}>
                Recent Results
              </p>
              <div style={{ maxHeight: '240px', overflowY: 'auto' }}>
                {recentRoutes.map(route => {
                  const segs = route.segments || [];
                  const total = segs.length > 0 ? sumDurations(segs) : (route.duration_str || '');
                  return (
                    <div
                      key={route.id}
                      onClick={() => handleSelectRoute(route.id)}
                      style={{
                        padding: '10px 12px', borderRadius: '8px', marginBottom: '6px', cursor: 'pointer',
                        border: selectedRouteId === route.id ? '2px solid #3b82f6' : '1px solid #e5e7eb',
                        background: selectedRouteId === route.id ? '#eff6ff' : '#fafafa'
                      }}
                    >
                      <p style={{ margin: '0 0 2px', fontWeight: 600, fontSize: '13px' }}>{route.title}</p>
                      <p style={{ margin: 0, fontSize: '11px', color: '#9ca3af' }}>
                        {total && `⏱ ${total}`}{route.destination ? ` · ${route.destination}` : ''}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Map ──────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative' }}>
        {!mapsLoaded && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f3f4f6', zIndex: 1 }}>
            Loading map…
          </div>
        )}
        <div ref={mapDivRef} style={{ height: '100%', width: '100%' }} />

        {/* Map action buttons */}
        <div style={{ position: 'absolute', bottom: '16px', right: '16px', display: 'flex', gap: '8px', zIndex: 1000 }}>
          <button
            onClick={handleReportBug}
            style={{ padding: '8px 14px', background: '#fff', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <Bug size={14} /> {reportStatus}
          </button>
          <button
            onClick={fitRoute}
            disabled={!selectedGeoJSON}
            style={{ padding: '8px 14px', background: '#fff', border: '1px solid #d1d5db', borderRadius: '6px', cursor: selectedGeoJSON ? 'pointer' : 'default', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px', opacity: selectedGeoJSON ? 1 : 0.5 }}
          >
            <Maximize size={14} /> Fit Route
          </button>
        </div>
      </div>

      {/* ── Right panel ──────────────────────────────────────────────────── */}
      {selectedRoute && showRightSidebar && (
        <div style={{
          width: '260px', background: '#fff', borderLeft: '1px solid #e5e7eb',
          padding: '16px', overflowY: 'auto', zIndex: 1000,
          position: isMobile ? 'absolute' : 'relative',
          top: 0, right: 0, height: '100%'
        }}>
          {(() => {
            // Support both AI-generated routes (segments array) and old DB routes (flat fields)
            const segs = selectedRoute.segments
              ? selectedRoute.segments.map(s => ({ color: s.color, label: s.label, desc: s.description, duration: s.duration, miles: s.miles }))
              : [
                  { color: '#e74c3c', label: '⚡ City / Highway', desc: selectedRoute.highway_desc },
                  { color: '#9b59b6', label: '🛣️ Parkway',        desc: selectedRoute.parkway_desc },
                  { color: '#2ecc71', label: '🌲 The Ride',       desc: selectedRoute.twisty_desc },
                ].filter(s => s.desc);

            const totalDuration = selectedRoute.duration_str || sumDurations(segs);
            const totalMiles = selectedRoute.distance_mi
              ? `${selectedRoute.distance_mi} mi`
              : segs.map(s => s.miles).filter(Boolean).join(' + ');

            return (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                  <div>
                    <p style={{ margin: '0 0 4px', fontWeight: 700, fontSize: '15px' }}>{selectedRoute.title}</p>
                    <p style={{ margin: 0, fontSize: '13px', color: '#f97316', fontWeight: 600 }}>
                      {totalDuration && `⏱ ${totalDuration}`}
                      {totalMiles && ` · 🛣️ ${totalMiles}`}
                    </p>
                    {selectedRoute.destination && (
                      <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#9ca3af' }}>→ {selectedRoute.destination}</p>
                    )}
                  </div>
                  {isMobile && (
                    <button onClick={() => setShowRightSidebar(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}>
                      <X size={18} />
                    </button>
                  )}
                </div>

                <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                  <button onClick={handleSaveRoute} style={{ flex: 1, padding: '8px', background: '#eab308', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>Save</button>
                  <button onClick={handleOpenInGoogleMaps} style={{ flex: 1, padding: '8px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>Maps</button>
                  <button onClick={handleDownloadGPX} style={{ flex: 1, padding: '8px', background: '#22c55e', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>GPX</button>
                </div>

                {segs.map((seg, i) => (
                  <div key={i} style={{ borderLeft: `4px solid ${seg.color}`, paddingLeft: '12px', marginBottom: '14px' }}>
                    <p style={{ fontWeight: 600, margin: '0 0 2px', fontSize: '14px' }}>{seg.label}</p>
                    {(seg.duration || seg.miles) && (
                      <p style={{ margin: '0 0 4px', fontSize: '12px', color: '#f97316', fontWeight: 600 }}>
                        {[seg.duration, seg.miles].filter(Boolean).join(' · ')}
                      </p>
                    )}
                    {seg.desc && (
                      <p style={{ margin: 0, fontSize: '13px', color: '#6b7280', lineHeight: 1.5 }}>{seg.desc}</p>
                    )}
                  </div>
                ))}
              </>
            );
          })()}
        </div>
      )}

      {/* ── Bug report modal ──────────────────────────────────────────────── */}
      {isBugModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div style={{ background: '#fff', borderRadius: '12px', padding: '24px', width: '360px', maxWidth: '90vw' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h2 style={{ margin: 0, fontSize: '18px' }}>Report a Bug</h2>
              <button onClick={closeBugModal} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><X size={20} /></button>
            </div>
            {bugScreenshot && (
              <img src={bugScreenshot} alt="Screenshot" style={{ width: '100%', borderRadius: '8px', marginBottom: '12px', border: '1px solid #e5e7eb' }} />
            )}
            <textarea
              value={bugComment}
              onChange={e => setBugComment(e.target.value)}
              placeholder="What went wrong?"
              rows={3}
              style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box', marginBottom: '12px', resize: 'vertical' }}
            />
            {bugSubmitSuccess ? (
              <div style={{ textAlign: 'center', color: '#059669', fontWeight: 600 }}>✓ Bug reported! Thanks.</div>
            ) : (
              <button
                onClick={handleSubmitBug}
                disabled={isSubmittingBug}
                style={{ width: '100%', padding: '10px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '15px', fontWeight: 600, cursor: isSubmittingBug ? 'not-allowed' : 'pointer' }}
              >
                {isSubmittingBug ? 'Submitting...' : 'Submit Bug Report'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Auth modal ────────────────────────────────────────────────────── */}
      {isAuthModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div style={{ background: '#fff', borderRadius: '12px', padding: '32px', width: '320px', maxWidth: '90vw' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0, fontSize: '18px' }}>{authMode === 'login' ? 'Log In' : 'Sign Up'}</h2>
              <button onClick={() => setIsAuthModalOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><X size={20} /></button>
            </div>
            {authError && <p style={{ color: '#ef4444', fontSize: '13px', marginBottom: '12px' }}>{authError}</p>}
            <input
              type="email"
              placeholder="Email"
              value={authEmail}
              onChange={e => setAuthEmail(e.target.value)}
              style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '6px', marginBottom: '10px', fontSize: '14px', boxSizing: 'border-box' }}
            />
            <input
              type="password"
              placeholder="Password"
              value={authPassword}
              onChange={e => setAuthPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAuth()}
              style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '6px', marginBottom: '16px', fontSize: '14px', boxSizing: 'border-box' }}
            />
            <button
              onClick={handleAuth}
              style={{ width: '100%', padding: '10px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '15px', fontWeight: 600, cursor: 'pointer', marginBottom: '12px' }}
            >
              {authMode === 'login' ? 'Log In' : 'Sign Up'}
            </button>
            <p style={{ textAlign: 'center', fontSize: '13px', margin: 0 }}>
              {authMode === 'login' ? "Don't have an account? " : 'Already have an account? '}
              <span
                onClick={() => setAuthMode(authMode === 'login' ? 'signup' : 'login')}
                style={{ color: '#3b82f6', cursor: 'pointer', fontWeight: 600 }}
              >
                {authMode === 'login' ? 'Sign Up' : 'Log In'}
              </span>
            </p>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
