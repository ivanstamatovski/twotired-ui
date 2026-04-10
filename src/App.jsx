import { useState, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, GeoJSON, useMap, ZoomControl } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { supabase } from './lib/supabase';
import { Menu, X, Maximize, Bug, LogIn, LogOut } from 'lucide-react';
import html2canvas from 'html2canvas';
import './App.css';
import { getRoutes, submitBugReport, saveRoute, logRouteRequest } from './lib/routeService';

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

// Sub-component to auto-fit the map to the selected route
function FitBounds({ geojson }) {
  const map = useMap();
  useEffect(() => {
    if (geojson) {
      const layer = L.geoJSON(geojson);
      map.flyToBounds(layer.getBounds().pad(0.1), { duration: 0.6 });
    }
  }, [geojson, map]);
  return null;
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

  const mapRef = useRef(null);

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
          setSelectedRouteId(mapped.id);
          setIsRequestingRoute(false);
          setRouteRequestSuccess('');
          setHasSearched(false);
          setRouteRequestText('');
          setSearchResults(null);
          setShowRightSidebar(true);
          if (window.innerWidth <= 768 || window.innerHeight <= 500) {
            setShowLeftSidebar(false);
          }
          setRoutesDb(prev => {
            const idx = prev.findIndex(r => r.id === mapped.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = mapped;
              return next;
            }
            return [...prev, mapped];
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

  // ── Derived values ─────────────────────────────────────────────────────────
  const selectedRoute = routesDb.find(r => r.id === selectedRouteId);
  const [computedGeoJSON, setComputedGeoJSON] = useState(null);

  useEffect(() => {
    setComputedGeoJSON(null);
    if (!selectedRouteId) return;
    const route = routesDb.find(r => r.id === selectedRouteId);
    if (!route) return;
    if (route.geojson) return;
    const waypoints = route.waypoints;
    if (!waypoints || waypoints.length < 2) return;
    const coords = waypoints.map(w => `${w.lng},${w.lat}`).join(';');
    fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`)
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
        setComputedGeoJSON({
          type: 'FeatureCollection',
          features: [{ type: 'Feature', geometry: {
            type: 'LineString',
            coordinates: waypoints.map(w => [w.lng, w.lat])
          }, properties: {} }]
        });
      });
  }, [selectedRouteId, routesDb]);

  const selectedGeoJSON = selectedRoute?.geojson ?? computedGeoJSON;
  const displayRoutes = searchResults !== null ? searchResults : routesDb;

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleRouteRequest = async () => {
    const query = routeRequestText.trim();
    if (!query) return;

    setLastSearchedQuery(query);
    setGenerating(true);
    setRouteRequestSuccess('');

    try {
      const { routes } = await getRoutes(query);

      if (routes && routes.length > 0) {
        const mapped = routes.map(r => ({ ...r, group: r.group_name }));
        setSearchResults(mapped);
        setHasSearched(true);
        // Merge into routesDb
        setRoutesDb(prev => {
          const merged = [...prev];
          mapped.forEach(r => {
            if (!merged.find(e => e.id === r.id)) merged.push(r);
          });
          return merged;
        });
        return;
      }

      // No cached routes — trigger AI generation via route_requests
      if (!user) {
        setIsAuthModalOpen(true);
        return;
      }

      setIsRequestingRoute(true);
      await logRouteRequest(
        `Start: ${startLocation}. Request: ${query}`,
        user.email
      );
      setRouteRequestSuccess(`Your request is in! We'll email you at ${user.email} when your custom route is ready.`);
      setRouteRequestText('');
    } catch (err) {
      console.error(err);
      alert('Error generating route. Please try again.');
    } finally {
      setGenerating(false);
    }
  };

  const handleSelectRoute = (id) => {
    setSelectedRouteId(id);
    setShowRightSidebar(true);
    if (isMobile) setShowLeftSidebar(false);
  };

  const getStyle = (feature) => {
    const leg = feature.properties?.leg;
    if (leg === 'highway') return { color: '#e74c3c', weight: 5, opacity: 0.9 };
    if (leg === 'parkway') return { color: '#9b59b6', weight: 5, opacity: 0.9 };
    return { color: '#2ecc71', weight: 6, opacity: 0.9 };
  };

  const fitRoute = () => {
    if (mapRef.current && selectedGeoJSON) {
      const layer = L.geoJSON(selectedGeoJSON);
      mapRef.current.flyToBounds(layer.getBounds().pad(0.1), { duration: 0.6 });
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
    try {
      const canvas = await html2canvas(document.body, { useCORS: true });
      setBugScreenshot(canvas.toDataURL('image/png'));
      setIsBugModalOpen(true);
      setReportStatus('Report Bug');
    } catch (err) {
      console.error(err);
      setReportStatus('Error');
      setTimeout(() => setReportStatus('Report Bug'), 3000);
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

      {/* ── Left sidebar ─────────────────────────────────────────────────── */}
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
            {generating ? 'Searching...' : isRequestingRoute ? 'Generating...' : 'Generate'}
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

          {/* Route list */}
          {displayRoutes.length > 0 && (
            <div>
              <p style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 8px' }}>
                {searchResults !== null ? `Results for "${lastSearchedQuery}"` : 'Available Routes'}
              </p>
              {displayRoutes.map(route => (
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
                    {route.distance_mi ? `${route.distance_mi} mi · ` : ''}
                    {route.duration_str || route.destination || route.group}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Map ──────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative' }}>
        <MapContainer
          center={[41.0, -74.0]}
          zoom={9}
          style={{ height: '100%', width: '100%' }}
          zoomControl={false}
          ref={mapRef}
        >
          <ZoomControl position="topright" />
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
            attribution='&copy; OpenStreetMap contributors &copy; CARTO'
          />
          {selectedGeoJSON && (
            <>
              <GeoJSON key={selectedRouteId} data={selectedGeoJSON} style={getStyle} />
              <FitBounds geojson={selectedGeoJSON} />
            </>
          )}
        </MapContainer>

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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
            <div>
              <p style={{ margin: '0 0 4px', fontWeight: 700, fontSize: '15px' }}>{selectedRoute.title}</p>
              <p style={{ margin: 0, fontSize: '13px', color: '#f97316', fontWeight: 600 }}>
                {selectedRoute.duration_str && `⏱ ${selectedRoute.duration_str}`}
                {selectedRoute.distance_mi && ` · 🛣️ ${selectedRoute.distance_mi} mi`}
              </p>
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

          {[
            { color: '#e74c3c', label: '⚡ City / Highway', desc: selectedRoute.highway_desc },
            { color: '#9b59b6', label: '🛣️ Parkway',        desc: selectedRoute.parkway_desc },
            { color: '#2ecc71', label: '🌲 The Ride',       desc: selectedRoute.twisty_desc },
          ].filter(s => s.desc).map((seg, i) => (
            <div key={i} style={{ borderLeft: `4px solid ${seg.color}`, paddingLeft: '12px', marginBottom: '12px' }}>
              <p style={{ fontWeight: 600, margin: '0 0 4px', fontSize: '14px' }}>{seg.label}</p>
              <p style={{ margin: 0, fontSize: '13px', color: '#6b7280', lineHeight: 1.5 }}>{seg.desc}</p>
            </div>
          ))}
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
