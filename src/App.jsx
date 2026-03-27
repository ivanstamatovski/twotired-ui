import { useState, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, GeoJSON, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { createClient } from '@supabase/supabase-js';
import { Menu, X, Map as MapIcon, Maximize, Bug, LogIn, LogOut, BookmarkPlus } from 'lucide-react';
import html2canvas from 'html2canvas';
import './App.css';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Inject CSS for spinner and pulse
const styles = `
@keyframes spin {
  to { transform: rotate(360deg); }
}
@keyframes pulse {
  0% { opacity: 1; }
  50% { opacity: 0.5; }
  100% { opacity: 1; }
}
`;
if (typeof document !== 'undefined') {
  const styleSheet = document.createElement("style");
  styleSheet.innerText = styles;
  document.head.appendChild(styleSheet);
}

// Component to handle auto-fitting the map to the selected route
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
  const [routesDb, setRoutesDb] = useState([]);
  const [selectedRouteId, setSelectedRouteId] = useState(null);
  const [showLeftSidebar, setShowLeftSidebar] = useState(true);
  const [showRightSidebar, setShowRightSidebar] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768 || window.innerHeight <= 500);
  const [reportStatus, setReportStatus] = useState('Report Bug');
  const [isBugModalOpen, setIsBugModalOpen] = useState(false);
  const [bugScreenshot, setBugScreenshot] = useState(null);
  const [bugComment, setBugComment] = useState('');
  const [isSubmittingBug, setIsSubmittingBug] = useState(false);
  const [bugSubmitSuccess, setBugSubmitSuccess] = useState(false);
  
  const [startLocation, setStartLocation] = useState('Balancero Astoria');
  const [routeRequestText, setRouteRequestText] = useState('');
  const [isRequestingRoute, setIsRequestingRoute] = useState(false);
  const [routeRequestSuccess, setRouteRequestSuccess] = useState('');

  // New states for search-first logic
  const [searchResults, setSearchResults] = useState(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [lastSearchedQuery, setLastSearchedQuery] = useState('');

  // Auth States
  const [user, setUser] = useState(null);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authMode, setAuthMode] = useState('login');
  const [authError, setAuthError] = useState('');

  const mapRef = useRef(null);

  useEffect(() => {
    // Auth Check
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    const fetchRoutes = async () => {
      const { data, error } = await supabase.from('routes').select('*');
      if (data) {
        setRoutesDb(data.map(r => ({ ...r, group: r.group_name })));
      } else {
        console.error('Error fetching routes:', error);
      }
    };

    fetchRoutes();

    const channel = supabase.channel('public:routes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'routes' }, (payload) => {
        if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
          setRoutesDb(prev => {
            const mappedNew = { ...payload.new, group: payload.new.group_name };
            const existingIndex = prev.findIndex(r => r.id === mappedNew.id);
            if (existingIndex >= 0) {
              const next = [...prev];
              next[existingIndex] = mappedNew;
              return next;
            } else {
              return [...prev, mappedNew];
            }
          });
        }
      })
      .subscribe();

  
  const handleOpenInGoogleMaps = () => {
    if (!selectedGeoJSON || !selectedGeoJSON.features) return;
    
    // Extract all coordinates from LineStrings
    let coords = [];
    selectedGeoJSON.features.forEach(feature => {
      if (feature.geometry && feature.geometry.type === 'LineString') {
        coords.push(...feature.geometry.coordinates);
      }
    });

    if (coords.length === 0) return;

    // Pick origin, destination, and up to 8 waypoints
    const maxWaypoints = 8;
    const origin = coords[0];
    const destination = coords[coords.length - 1];
    
    let waypoints = [];
    if (coords.length > 2) {
      const step = Math.max(1, Math.floor((coords.length - 2) / (maxWaypoints + 1)));
      for (let i = 1; i <= maxWaypoints && (i * step) < coords.length - 1; i++) {
        waypoints.push(coords[i * step]);
      }
    }

    // Convert [lng, lat] to lat,lng
    const formatCoord = (c) => `${c[1]},${c[0]}`;

    let url = `https://www.google.com/maps/dir/?api=1&origin=${formatCoord(origin)}&destination=${formatCoord(destination)}`;
    if (waypoints.length > 0) {
      const wpStr = waypoints.map(formatCoord).join('|');
      url += `&waypoints=${wpStr}`;
    }

    window.open(url, '_blank');
  };

  const handleDownloadGPX = () => {
    if (!selectedGeoJSON || !selectedGeoJSON.features) return;

    let trkpts = '';
    selectedGeoJSON.features.forEach(feature => {
      if (feature.geometry && feature.geometry.type === 'LineString') {
        feature.geometry.coordinates.forEach(coord => {
          trkpts += `      <trkpt lat="${coord[1]}" lon="${coord[0]}"></trkpt>\n`;
        });
      }
    });

    const gpxData = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TwistyRoute">
  <trk>
    <name>${selectedRoute?.title || 'Route'}</name>
    <trkseg>
${trkpts}    </trkseg>
  </trk>
</gpx>`;

    const blob = new Blob([gpxData], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(selectedRoute?.title || 'route').replace(/[^a-z0-9]/gi, '_').toLowerCase()}.gpx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
) => {
      supabase.removeChannel(channel);
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth <= 768 || window.innerHeight <= 500;
      setIsMobile(mobile);
      if (!mobile) {
        setShowLeftSidebar(true);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const selectedRoute = routesDb.find(r => r.id === selectedRouteId);
  const selectedGeoJSON = selectedRoute ? selectedRoute.geojson : null;

  const handleSelectRoute = (id) => {
    setSelectedRouteId(id);
    setShowRightSidebar(true);
    if (isMobile) {
      setShowLeftSidebar(false); // Close left menu on mobile when a route is picked
    }
  };

  const getStyle = (feature) => {
    const leg = feature.properties?.leg;
    if (leg === "highway") return { color: '#e74c3c', weight: 5, opacity: 0.9 };
    if (leg === "parkway") return { color: '#9b59b6', weight: 5, opacity: 0.9 };
    return { color: '#2ecc71', weight: 6, opacity: 0.9 }; // twisty
  };

  const fitRoute = () => {
    if (mapRef.current && selectedGeoJSON) {
      const map = mapRef.current;
      const layer = L.geoJSON(selectedGeoJSON);
      map.flyToBounds(layer.getBounds().pad(0.1), { duration: 0.6 });
    }
  };

  const handleReportBug = async () => {
    setReportStatus('Capturing...');
    try {
      const canvas = await html2canvas(document.body, { useCORS: true });
      const base64_data_url = canvas.toDataURL('image/png');
      setBugScreenshot(base64_data_url);
      setIsBugModalOpen(true);
      setReportStatus('Report Bug');
    } catch (err) {
      console.error(err);
      setReportStatus('Error');
      setTimeout(() => setReportStatus('Report Bug'), 3000);
    }
  };

  const submitBugReport = async () => {
    setIsSubmittingBug(true);
    try {
      const { error } = await supabase.from('bug_reports').insert({
        image_data: bugScreenshot,
        route_id: selectedRouteId,
        comment: bugComment,
        user_id: user ? user.id : null
      });

      if (!error) {
        setBugSubmitSuccess(true);
        setTimeout(() => {
          setBugSubmitSuccess(false);
          setIsBugModalOpen(false);
          setBugScreenshot(null);
          setBugComment('');
        }, 2000);
      } else {
        alert('Error submitting bug report: ' + error.message);
      }
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

  const handleRouteRequest = async () => {
    if (!routeRequestText.trim()) return;
    
    const query = routeRequestText.trim().toLowerCase();
    setLastSearchedQuery(routeRequestText.trim());
    
    // Filter routesDb based on fuzzy matching (title, desc, group)
    const matches = routesDb.filter(r => 
      (r.title && r.title.toLowerCase().includes(query)) ||
      (r.desc && r.desc.toLowerCase().includes(query)) ||
      (r.group && r.group.toLowerCase().includes(query))
    );

    setSearchResults(matches);
    setHasSearched(true);
    
    if (matches.length > 0) {
      return;
    }

    // No matches -> Trigger AI custom route generation logic via Supabase insert
    setIsRequestingRoute(true);
    setRouteRequestSuccess('');
    try {
      const { error } = await supabase.from('route_requests').insert({
        request_text: startLocation ? `Start: ${startLocation}. Request: ${routeRequestText}` : routeRequestText,
        user_id: user ? user.id : null
      });

      if (!error) {
        setRouteRequestText('');
        setRouteRequestSuccess('Route requested! Check back later.');
      } else {
        alert('Error submitting route request: ' + error.message);
      }
    } catch (err) {
      console.error(err);
      alert('Error submitting route request');
    } finally {
      setIsRequestingRoute(false);
    }
  };

  // Auto-resolve loading state when new route arrives via websocket
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

  const handleAuth = async () => {
    setAuthError('');
    if (authMode === 'login') {
      const { error } = await supabase.auth.signInWithPassword({
        email: authEmail,
        password: authPassword,
      });
      if (error) setAuthError(error.message);
      else {
        setIsAuthModalOpen(false);
      }
    } else {
      const { error } = await supabase.auth.signUp({
        email: authEmail,
        password: authPassword,
      });
      if (error) setAuthError(error.message);
      else {
        setAuthError('Check your email for the confirmation link.');
      }
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  const handleSaveRoute = async () => {
    if (!user) {
      setIsAuthModalOpen(true);
      return;
    }
    const { error } = await supabase
      .from('user_saved_routes')
      .insert({ user_id: user.id, route_id: selectedRouteId });
      
    if (error) {
      if (error.code === '23505') {
        alert('You have already saved this route!');
      } else {
        alert('Error saving route: ' + error.message);
      }
    } else {
      alert('Route saved successfully!');
    }
  };

  return (
    <div className="app-container">
      {/* Mobile Header */}
      {isMobile && (
        <div className="mobile-header">
          <button className="menu-btn" onClick={() => setShowLeftSidebar(!showLeftSidebar)}>
            {showLeftSidebar ? <X size={24} /> : <Menu size={24} />}
          </button>
          <h1 className="mobile-title">🏍️ TwistyRoute</h1>
          <button className="menu-btn" onClick={() => setShowRightSidebar(!showRightSidebar)} disabled={!selectedRoute}>
            {showRightSidebar ? <X size={24} /> : <MapIcon size={24} />}
          </button>
        </div>
      )}

      {/* Left Sidebar - Route List */}
      <div className={`left-sidebar ${showLeftSidebar ? 'open' : ''} ${isMobile ? 'mobile-drawer' : ''}`}>
        {!isMobile && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h1>🏍️ TwistyRoute</h1>
            {user ? (
              <button onClick={handleLogout} className="zoom-fit-btn" style={{ padding: '8px', background: 'transparent', border: '1px solid #ccc', color: '#333' }} title="Logout">
                <LogOut size={18} />
              </button>
            ) : (
              <button onClick={() => setIsAuthModalOpen(true)} className="zoom-fit-btn" style={{ padding: '8px', background: 'transparent', border: '1px solid #ccc', color: '#333' }} title="Login">
                <LogIn size={18} />
              </button>
            )}
          </div>
        )}
        
        {/* Where to? Search Bar */}
        <div className="search-section" style={{ padding: '15px', background: '#f9f9f9', borderRadius: '8px', border: '1px solid #ddd', display: 'flex', flexDirection: 'column', marginBottom: '20px' }}>
          
          <label style={{ margin: '0 0 5px 0', fontSize: '0.85rem', color: '#555', fontWeight: 'bold' }}>Start location</label>
          <input 
            type="text" 
            value={startLocation}
            onChange={(e) => setStartLocation(e.target.value)}
            style={{ width: '100%', padding: '10px', marginBottom: '15px', border: '1px solid #ccc', borderRadius: '6px', boxSizing: 'border-box', background: '#fff', color: '#333' }}
          />

          <h3 style={{ margin: '0 0 10px 0', fontSize: '1rem', color: '#333', fontWeight: 'bold' }}>Where to?</h3>
          <input 
            type="text" 
            placeholder="e.g., Bear Mountain, Hawk's Nest..."
            value={routeRequestText}
            onChange={(e) => setRouteRequestText(e.target.value)}
            onKeyDown={(e) => { if(e.key === 'Enter') handleRouteRequest(); }}
            style={{ width: '100%', padding: '10px', marginBottom: '10px', border: '2px solid #3498db', borderRadius: '6px', boxSizing: 'border-box', background: '#fff', color: '#333', outline: 'none' }}
          />
          <button 
            onClick={handleRouteRequest}
            disabled={isRequestingRoute || !routeRequestText.trim()}
            style={{ width: '100%', padding: '10px', background: isRequestingRoute ? '#555' : '#3498db', color: 'white', border: 'none', borderRadius: '4px', cursor: isRequestingRoute || !routeRequestText.trim() ? 'not-allowed' : 'pointer', fontWeight: 'bold', transition: 'background 0.2s ease' }}
          >
            {isRequestingRoute ? 'Generating...' : 'Generate'}
          </button>
        </div>

        {/* Selected Route Display */}
        {selectedRoute && !isRequestingRoute && (
          <div style={{ marginBottom: '20px', padding: '15px', background: 'rgba(52, 152, 219, 0.1)', borderRadius: '8px', border: '1px solid #3498db' }}>
            <h4 style={{ margin: '0 0 10px 0', color: '#3498db', fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '1px' }}>
              Selected Route
            </h4>
            <div style={{ color: '#333', fontSize: '1.05rem', fontWeight: 'bold' }}>
              {selectedRoute.title}
            </div>
          </div>
        )}

        {/* Search Results or Placeholder */}
        {hasSearched && (
          <div className="search-results-section">
            {searchResults && searchResults.length > 0 ? (
              <div className="route-options">
                <h3 className="options-title" style={{ margin: '0 0 15px 0', color: '#555', fontSize: '0.95rem', textTransform: 'uppercase', letterSpacing: '1px' }}>Matching Routes</h3>
                {searchResults.map(r => (
                  <div 
                    key={r.id} 
                    className={`route-card ${selectedRouteId === r.id ? 'active' : ''}`}
                    onClick={() => handleSelectRoute(r.id)}
                    style={{ padding: '12px', background: '#f9f9f9', borderRadius: '6px', marginBottom: '8px', cursor: 'pointer', border: selectedRouteId === r.id ? '1px solid #3498db' : '1px solid #e0e0e0', transition: 'all 0.2s ease' }}
                  >
                    <div className="route-title" style={{ fontSize: '1rem', fontWeight: '500', color: '#333' }}>{r.title}</div>
                    {r.group && <div style={{ fontSize: '0.8rem', color: '#777', marginTop: '4px' }}>{r.group}</div>}
                  </div>
                ))}
              </div>
            ) : (
              <div className="generating-placeholder" style={{ marginTop: '10px', padding: '25px 20px', background: '#fff', border: '2px dashed #3498db', borderRadius: '8px', textAlign: 'center', boxShadow: '0 4px 12px rgba(52, 152, 219, 0.1)' }}>
                <div className="spinner-container" style={{ display: 'flex', justifyContent: 'center', marginBottom: '20px' }}>
                  <div className="custom-spinner" style={{ width: '45px', height: '45px', border: '4px solid rgba(52, 152, 219, 0.2)', borderTopColor: '#3498db', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>
                </div>
                <h4 style={{ margin: '0 0 12px 0', color: '#333', fontSize: '1.15rem', fontWeight: 'bold' }}>Generating Custom Route...</h4>
                <p style={{ margin: 0, color: '#666', fontSize: '0.95rem', lineHeight: '1.5' }}>
                  AI is analyzing twisty roads and building the perfect ride for <strong>"{lastSearchedQuery}"</strong>.
                </p>
                {routeRequestSuccess && (
                  <div style={{ marginTop: '20px', padding: '10px', background: 'rgba(46, 204, 113, 0.1)', color: '#2ecc71', borderRadius: '6px', fontSize: '0.9rem', fontWeight: 'bold', animation: 'pulse 2s infinite' }}>
                    {routeRequestSuccess}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Map Container */}
      <div className="map-container">
        <MapContainer 
          center={[41.05, -74.0]} 
          zoom={10} 
          zoomSnap={0.1} 
          wheelPxPerZoomLevel={150} 
          ref={mapRef}
          style={{ width: '100%', height: '100%', zIndex: 1 }}
        >
          <TileLayer
            attribution='&copy; OpenStreetMap &copy; CARTO'
            url='https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png'
          />
          {selectedGeoJSON && (
            <GeoJSON 
              key={selectedRouteId} // Force remount when route changes
              data={selectedGeoJSON} 
              style={getStyle} 
            />
          )}
          {selectedGeoJSON && <FitBounds geojson={selectedGeoJSON} />}
        </MapContainer>
        
        <div style={{ position: 'absolute', bottom: '30px', right: '20px', zIndex: 1000, display: 'flex', gap: '10px' }}>
          <button className="zoom-fit-btn" style={{ position: 'relative', bottom: 'auto', right: 'auto' }} onClick={handleReportBug} title="Report Bug">
            <Bug size={18} /> <span className="btn-text">{reportStatus}</span>
          </button>
          <button className="zoom-fit-btn" style={{ position: 'relative', bottom: 'auto', right: 'auto' }} onClick={fitRoute} title="Fit Route">
            <Maximize size={18} /> <span className="btn-text">Fit Route</span>
          </button>
        </div>
      </div>

      {/* Right Sidebar - Route Details */}
      {selectedRoute && (
        <div className={`right-sidebar ${showRightSidebar ? 'open' : ''} ${isMobile ? 'mobile-drawer bottom-sheet' : ''}`}>
          {isMobile && (
            <div className="bottom-sheet-handle" onClick={() => setShowRightSidebar(false)}>
              <div className="handle-bar"></div>
            </div>
          )}
          <div className="right-content">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div className="right-title">{selectedRoute.title}</div>
              <button 
                onClick={handleSaveRoute}
                style={{ background: '#f39c12', color: '#fff', border: 'none', borderRadius: '4px', padding: '6px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px' }}
              >
                <BookmarkPlus size={16} /> Save
              </button>
            </div>
            
            {selectedRoute.duration_str && (
              <p className="right-time">⏱️ {selectedRoute.duration_str} • 🛣️ {selectedRoute.distance_mi} miles</p>
            )}
            <div className="right-desc">{selectedRoute.desc}</div>
            
            <div className="flex gap-2 mb-5 flex-wrap">
              <button 
                onClick={handleOpenInGoogleMaps}
                className="bg-blue-500 hover:bg-blue-600 text-white border-none rounded px-3 py-2 cursor-pointer flex items-center justify-center gap-1 flex-1 text-sm font-bold transition-colors"
              >
                🗺️ Open in Google Maps
              </button>
              <button 
                onClick={handleDownloadGPX}
                className="bg-green-500 hover:bg-green-600 text-white border-none rounded px-3 py-2 cursor-pointer flex items-center justify-center gap-1 flex-1 text-sm font-bold transition-colors"
              >
                ⬇️ Download GPX
              </button>
            </div>

            
            <div className="right-leg" style={{borderLeftColor: '#e74c3c'}}>
              <div className="leg-title">⚡ City / Highway</div>
              <div className="leg-details">{selectedRoute.highway_desc}</div>
            </div>
            
            {selectedRoute.parkway_desc !== "No parkway on this route." && (
              <div className="right-leg" style={{borderLeftColor: '#9b59b6'}}>
                <div className="leg-title">🛣️ Parkway</div>
                <div className="leg-details">{selectedRoute.parkway_desc}</div>
              </div>
            )}
            
            <div className="right-leg" style={{borderLeftColor: '#2ecc71'}}>
              <div className="leg-title">🌲 The Ride</div>
              <div className="leg-details">{selectedRoute.twisty_desc}</div>
            </div>
          </div>
        </div>
      )}
      
      {/* Mobile Backdrop for Left Drawer */}
      {isMobile && showLeftSidebar && (
        <div className="mobile-backdrop" onClick={() => setShowLeftSidebar(false)}></div>
      )}
      {/* Mobile Backdrop for Right Sheet */}
      {isMobile && showRightSidebar && (
        <div className="mobile-backdrop" onClick={() => setShowRightSidebar(false)}></div>
      )}

      {/* Bug Report Modal */}
      {isBugModalOpen && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px'
        }}>
          <div style={{
            background: '#fff', borderRadius: '12px', padding: '20px', maxHeight: '90vh', overflowY: 'auto', boxSizing: 'border-box',
            width: '100%', maxWidth: '500px', display: 'flex', flexDirection: 'column', gap: '16px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)', color: '#333'
          }}>
            {bugSubmitSuccess ? (
              <div style={{ textAlign: 'center', padding: '40px 0' }}>
                <h2 style={{ color: '#2ecc71', margin: 0 }}>Thanks for reporting!</h2>
              </div>
            ) : (
              <>
                <h2 style={{ margin: 0, fontSize: '1.25rem' }}>Report a Bug</h2>
                {bugScreenshot && (
                  <div style={{ border: '1px solid #ddd', borderRadius: '4px', overflow: 'hidden', width: '100%', maxHeight: '250px', display: 'flex', justifyContent: 'center', backgroundColor: '#f0f0f0' }}>
                    <img src={bugScreenshot} alt="Screenshot preview" style={{ width: '100%', height: 'auto', objectFit: 'contain' }} />
                  </div>
                )}
                <textarea
                  placeholder="Add a comment..."
                  value={bugComment}
                  onChange={(e) => setBugComment(e.target.value)}
                  style={{
                    width: '100%', minHeight: '100px', padding: '12px',
                    border: '1px solid #ccc', borderRadius: '4px', resize: 'vertical',
                    fontFamily: 'inherit', color: '#333', backgroundColor: '#fff', boxSizing: 'border-box'
                  }}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '12px' }}>
                  <button 
                    onClick={closeBugModal}
                    disabled={isSubmittingBug}
                    style={{ width: '100%', padding: '12px 16px', background: '#f1f1f1', border: '1px solid #ddd', borderRadius: '6px', cursor: 'pointer', color: '#333', fontSize: '16px', fontWeight: '500' }}
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={submitBugReport}
                    disabled={isSubmittingBug}
                    style={{ width: '100%', padding: '12px 16px', background: '#e74c3c', border: 'none', borderRadius: '6px', cursor: 'pointer', color: '#333', fontSize: '16px', fontWeight: 'bold' }}
                  >
                    {isSubmittingBug ? 'Submitting...' : 'Submit Bug'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Auth Modal */}
      {isAuthModalOpen && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px'
        }}>
          <div style={{
            background: '#fff', borderRadius: '12px', padding: '20px', 
            width: '100%', maxWidth: '400px', display: 'flex', flexDirection: 'column', gap: '16px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)', color: '#333'
          }}>
            <h2 style={{ margin: 0, fontSize: '1.25rem', textAlign: 'center' }}>
              {authMode === 'login' ? 'Login' : 'Sign Up'}
            </h2>
            {authError && (
              <div style={{ background: '#f8d7da', color: '#721c24', padding: '10px', borderRadius: '4px', fontSize: '0.9rem' }}>
                {authError}
              </div>
            )}
            <input
              type="email"
              placeholder="Email"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
              style={{ padding: '10px', border: '1px solid #ccc', borderRadius: '4px', width: '100%', boxSizing: 'border-box', color: '#333', background: '#fff' }}
            />
            <input
              type="password"
              placeholder="Password"
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
              style={{ padding: '10px', border: '1px solid #ccc', borderRadius: '4px', width: '100%', boxSizing: 'border-box', color: '#333', background: '#fff' }}
            />
            <button 
              onClick={handleAuth}
              style={{ padding: '12px', background: '#3498db', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
            >
              {authMode === 'login' ? 'Login' : 'Sign Up'}
            </button>
            <div style={{ textAlign: 'center', fontSize: '0.9rem', color: '#555' }}>
              {authMode === 'login' ? "Don't have an account? " : "Already have an account? "}
              <span 
                style={{ color: '#3498db', cursor: 'pointer', textDecoration: 'underline' }}
                onClick={() => setAuthMode(authMode === 'login' ? 'signup' : 'login')}
              >
                {authMode === 'login' ? 'Sign Up' : 'Login'}
              </span>
            </div>
            <button 
              onClick={() => setIsAuthModalOpen(false)}
              style={{ padding: '10px', background: '#f1f1f1', border: '1px solid #ddd', borderRadius: '6px', cursor: 'pointer', marginTop: '10px', color: '#333' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
