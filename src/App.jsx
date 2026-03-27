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

  

    return () => {
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
    <div className="relative w-screen h-screen overflow-hidden bg-gray-100">
      {/* Floating Top Header */}
      <div className="absolute top-0 left-0 right-0 z-[2000] bg-white/85 backdrop-blur-md shadow-sm flex justify-between items-center px-4 py-3">
        <div className="flex items-center gap-3">
          {isMobile && (
            <button 
              className="text-gray-800 p-1 hover:bg-gray-100 rounded-md transition-colors" 
              onClick={() => {
                if(showRightSidebar) {
                  setShowRightSidebar(false);
                  setShowLeftSidebar(true);
                } else {
                  setShowLeftSidebar(!showLeftSidebar);
                }
              }}
            >
              {(showLeftSidebar || showRightSidebar) ? <X size={24} /> : <Menu size={24} />}
            </button>
          )}
          <h1 className="text-xl sm:text-2xl font-bold m-0 text-gray-800 flex items-center gap-2">🏍️ TwistyRoute</h1>
        </div>
        <div className="flex items-center gap-2 sm:gap-4">
          {user ? (
            <button onClick={handleLogout} className="flex items-center gap-2 px-3 py-1.5 sm:px-4 sm:py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-md transition-colors font-semibold text-sm">
              <LogOut size={16} /> <span className="hidden sm:inline">Logout</span>
            </button>
          ) : (
            <button onClick={() => setIsAuthModalOpen(true)} className="flex items-center gap-2 px-3 py-1.5 sm:px-4 sm:py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-md transition-colors font-semibold text-sm">
              <LogIn size={16} /> <span className="hidden sm:inline">Login</span>
            </button>
          )}
          {isMobile && selectedRoute && !showRightSidebar && (
            <button 
              className="text-blue-500 p-1 bg-blue-50 rounded-md ml-2" 
              onClick={() => { setShowRightSidebar(true); setShowLeftSidebar(false); }}
            >
              <MapIcon size={24} />
            </button>
          )}
        </div>
      </div>

      {/* Map Background (z-0 to sit behind panels) */}
      <div className="absolute inset-0 z-0">
        <MapContainer 
          center={[41.05, -74.0]} 
          zoom={10} 
          zoomSnap={0.1} 
          wheelPxPerZoomLevel={150} 
          ref={mapRef}
          style={{ width: '100%', height: '100%' }}
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
        
        <div className="absolute bottom-[20px] right-[20px] z-[1000] flex flex-col sm:flex-row gap-2">
          <button className="bg-white p-3 rounded-full sm:rounded-md sm:py-2 sm:px-4 shadow-md border border-gray-200 text-gray-700 hover:bg-gray-50 flex items-center justify-center gap-2 font-bold transition-colors" onClick={handleReportBug} title="Report Bug">
            <Bug size={18} /> <span className="hidden sm:inline">{reportStatus}</span>
          </button>
          <button className="bg-white p-3 rounded-full sm:rounded-md sm:py-2 sm:px-4 shadow-md border border-gray-200 text-gray-700 hover:bg-gray-50 flex items-center justify-center gap-2 font-bold transition-colors" onClick={fitRoute} title="Fit Route">
            <Maximize size={18} /> <span className="hidden sm:inline">Fit Route</span>
          </button>
        </div>
      </div>

      {/* Left Panel (Route List / Search) */}
      <div className={`
        ${isMobile 
          ? `absolute bottom-0 w-full bg-white rounded-t-2xl shadow-[0_-4px_15px_rgba(0,0,0,0.1)] max-h-[50vh] overflow-y-auto z-[1500] transition-transform duration-300 ${showLeftSidebar ? 'translate-y-0' : 'translate-y-full'}` 
          : `absolute top-20 left-4 w-96 max-h-[calc(100vh-6rem)] bg-white rounded-xl shadow-xl overflow-y-auto z-[1000] ${showLeftSidebar ? 'block' : 'hidden'}`
        }
      `}>
        {isMobile && (
          <div className="w-full flex justify-center py-3 sticky top-0 bg-white z-10 cursor-pointer" onClick={() => setShowLeftSidebar(false)}>
            <div className="w-12 h-1.5 bg-gray-300 rounded-full"></div>
          </div>
        )}
        <div className="p-5 pt-0 sm:pt-5">
          {/* Where to? Search Bar */}
          <div className="p-4 bg-gray-50 rounded-lg border border-gray-200 flex flex-col mb-5">
            <label className="mb-1 text-sm font-bold text-gray-600">Start location</label>
            <input 
              type="text" 
              value={startLocation}
              onChange={(e) => setStartLocation(e.target.value)}
              className="w-full p-2.5 mb-3 border border-gray-300 rounded-md bg-white text-gray-800"
            />

            <h3 className="mb-2 text-base font-bold text-gray-800">Where to?</h3>
            <input 
              type="text" 
              placeholder="e.g., Bear Mountain, Hawk's Nest..."
              value={routeRequestText}
              onChange={(e) => setRouteRequestText(e.target.value)}
              onKeyDown={(e) => { if(e.key === 'Enter') handleRouteRequest(); }}
              className="w-full p-2.5 mb-2 border-2 border-blue-500 rounded-md bg-white text-gray-800 outline-none"
            />
            <button 
              onClick={handleRouteRequest}
              disabled={isRequestingRoute || !routeRequestText.trim()}
              className={`w-full p-2.5 text-white font-bold rounded-md transition-colors ${isRequestingRoute ? 'bg-gray-500 cursor-not-allowed' : 'bg-blue-500 hover:bg-blue-600 cursor-pointer'}`}
            >
              {isRequestingRoute ? 'Generating...' : 'Generate'}
            </button>
          </div>

          {/* Selected Route Display */}
          {selectedRoute && !isRequestingRoute && (
            <div className="mb-5 p-4 bg-blue-50 rounded-lg border border-blue-200">
              <h4 className="m-0 mb-2 text-blue-500 text-xs font-bold uppercase tracking-wider">
                Selected Route
              </h4>
              <div className="text-gray-800 text-lg font-bold">
                {selectedRoute.title}
              </div>
            </div>
          )}

          {/* Search Results or Placeholder */}
          {hasSearched && (
            <div className="mt-2">
              {searchResults && searchResults.length > 0 ? (
                <div>
                  <h3 className="m-0 mb-3 text-gray-600 text-sm font-bold uppercase tracking-wider">Matching Routes</h3>
                  {searchResults.map(r => (
                    <div 
                      key={r.id} 
                      className={`p-3 bg-gray-50 rounded-md mb-2 cursor-pointer border transition-all ${selectedRouteId === r.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-orange-500 hover:bg-orange-50'}`}
                      onClick={() => handleSelectRoute(r.id)}
                    >
                      <div className="text-base font-bold text-gray-800">{r.title}</div>
                      {r.group && <div className="text-xs text-gray-500 mt-1">{r.group}</div>}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-3 p-6 bg-white border-2 border-dashed border-blue-400 rounded-lg text-center shadow-[0_4px_12px_rgba(52,152,219,0.1)]">
                  <div className="flex justify-center mb-5">
                    <div className="w-11 h-11 border-4 border-blue-100 border-t-blue-500 rounded-full animate-spin"></div>
                  </div>
                  <h4 className="m-0 mb-3 text-gray-800 text-lg font-bold">Generating Custom Route...</h4>
                  <p className="m-0 text-gray-600 text-sm leading-relaxed">
                    AI is analyzing twisty roads and building the perfect ride for <strong className="text-gray-800">"{lastSearchedQuery}"</strong>.
                  </p>
                  {routeRequestSuccess && (
                    <div className="mt-5 p-2 bg-green-50 text-green-600 rounded-md text-sm font-bold animate-pulse">
                      {routeRequestSuccess}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right Panel (Route Details) */}
      {selectedRoute && (
        <div className={`
          ${isMobile 
            ? `absolute bottom-0 w-full bg-white rounded-t-2xl shadow-[0_-4px_15px_rgba(0,0,0,0.1)] max-h-[50vh] overflow-y-auto z-[1500] transition-transform duration-300 ${showRightSidebar ? 'translate-y-0' : 'translate-y-full'}` 
            : `absolute top-20 right-4 w-96 max-h-[calc(100vh-6rem)] bg-white rounded-xl shadow-xl overflow-y-auto z-[1000] ${showRightSidebar ? 'block' : 'hidden'}`
          }
        `}>
          {isMobile && (
            <div className="w-full flex justify-center py-3 sticky top-0 bg-white z-10 cursor-pointer" onClick={() => setShowRightSidebar(false)}>
              <div className="w-12 h-1.5 bg-gray-300 rounded-full"></div>
            </div>
          )}
          <div className="p-5 pt-0 sm:pt-5">
            <div className="flex justify-between items-start mb-4 gap-2">
              <div className="text-xl font-bold text-gray-800 leading-tight">{selectedRoute.title}</div>
              <button 
                onClick={handleSaveRoute}
                className="bg-orange-500 hover:bg-orange-600 text-white border-none rounded-md px-3 py-1.5 cursor-pointer flex items-center gap-1.5 font-bold text-sm shrink-0 transition-colors"
              >
                <BookmarkPlus size={16} /> Save
              </button>
            </div>
            
            {selectedRoute.duration_str && (
              <p className="text-orange-600 font-bold mt-[-5px] mb-4 text-sm">⏱️ {selectedRoute.duration_str} • 🛣️ {selectedRoute.distance_mi} miles</p>
            )}
            <div className="text-gray-600 text-sm leading-relaxed mb-6">{selectedRoute.desc}</div>
            
            <div className="flex flex-col sm:flex-row gap-3 mb-6">
              <button 
                onClick={handleOpenInGoogleMaps}
                className="bg-blue-500 hover:bg-blue-600 text-white border-none rounded-md px-4 py-2.5 cursor-pointer flex items-center justify-center gap-2 flex-1 text-sm font-bold shadow-sm transition-colors"
              >
                🗺️ Google Maps
              </button>
              <button 
                onClick={handleDownloadGPX}
                className="bg-green-500 hover:bg-green-600 text-white border-none rounded-md px-4 py-2.5 cursor-pointer flex items-center justify-center gap-2 flex-1 text-sm font-bold shadow-sm transition-colors"
              >
                ⬇️ Download GPX
              </button>
            </div>
            
            <div className="mb-4 p-3 rounded-md bg-gray-50 border-l-4 border-l-red-500">
              <div className="font-bold text-sm mb-2 text-gray-800">⚡ City / Highway</div>
              <div className="text-xs text-gray-600 leading-relaxed">{selectedRoute.highway_desc}</div>
            </div>
            
            {selectedRoute.parkway_desc !== "No parkway on this route." && (
              <div className="mb-4 p-3 rounded-md bg-gray-50 border-l-4 border-l-purple-500">
                <div className="font-bold text-sm mb-2 text-gray-800">🛣️ Parkway</div>
                <div className="text-xs text-gray-600 leading-relaxed">{selectedRoute.parkway_desc}</div>
              </div>
            )}
            
            <div className="mb-4 p-3 rounded-md bg-gray-50 border-l-4 border-l-green-500">
              <div className="font-bold text-sm mb-2 text-gray-800">🌲 The Ride</div>
              <div className="text-xs text-gray-600 leading-relaxed">{selectedRoute.twisty_desc}</div>
            </div>
          </div>
        </div>
      )}
      
      {/* Mobile Backdrops (disabled since bottom sheets don't block interaction behind, but added logic if user expects it) */}
      {/* 
      {isMobile && showLeftSidebar && (
        <div className="mobile-backdrop" onClick={() => setShowLeftSidebar(false)}></div>
      )}
      {isMobile && showRightSidebar && (
        <div className="mobile-backdrop" onClick={() => setShowRightSidebar(false)}></div>
      )}
      */}

      {/* Bug Report Modal */}
      {isBugModalOpen && (
        <div className="fixed inset-0 bg-black/60 z-[9999] flex items-center justify-center p-5">
          <div className="bg-white rounded-xl p-5 max-h-[90vh] overflow-y-auto w-full max-w-lg flex flex-col gap-4 shadow-xl text-gray-800">
            {bugSubmitSuccess ? (
              <div className="text-center py-10">
                <h2 className="text-green-500 m-0 font-bold text-xl">Thanks for reporting!</h2>
              </div>
            ) : (
              <>
                <h2 className="m-0 text-xl font-bold">Report a Bug</h2>
                {bugScreenshot && (
                  <div className="border border-gray-300 rounded-md overflow-hidden w-full max-h-[250px] flex justify-center bg-gray-100">
                    <img src={bugScreenshot} alt="Screenshot preview" className="w-full h-auto object-contain" />
                  </div>
                )}
                <textarea
                  placeholder="Add a comment..."
                  value={bugComment}
                  onChange={(e) => setBugComment(e.target.value)}
                  className="w-full min-h-[100px] p-3 border border-gray-300 rounded-md font-sans text-gray-800 bg-white box-border resize-y"
                />
                <div className="flex flex-col gap-2 mt-3">
                  <button 
                    onClick={closeBugModal}
                    disabled={isSubmittingBug}
                    className="w-full p-3 bg-gray-100 border border-gray-300 rounded-md cursor-pointer text-gray-800 text-base font-semibold hover:bg-gray-200 transition-colors"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={submitBugReport}
                    disabled={isSubmittingBug}
                    className="w-full p-3 bg-red-500 border-none rounded-md cursor-pointer text-white text-base font-bold hover:bg-red-600 transition-colors"
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
        <div className="fixed inset-0 bg-black/60 z-[9999] flex items-center justify-center p-5">
          <div className="bg-white rounded-xl p-5 w-full max-w-md flex flex-col gap-4 shadow-xl text-gray-800">
            <h2 className="m-0 text-xl font-bold text-center">
              {authMode === 'login' ? 'Login' : 'Sign Up'}
            </h2>
            {authError && (
              <div className="bg-red-100 text-red-800 p-3 rounded-md text-sm font-medium">
                {authError}
              </div>
            )}
            <input
              type="email"
              placeholder="Email"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
              className="p-3 border border-gray-300 rounded-md w-full box-border text-gray-800 bg-white focus:outline-none focus:border-blue-500"
            />
            <input
              type="password"
              placeholder="Password"
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
              className="p-3 border border-gray-300 rounded-md w-full box-border text-gray-800 bg-white focus:outline-none focus:border-blue-500"
            />
            <button 
              onClick={handleAuth}
              className="p-3 bg-blue-500 text-white border-none rounded-md cursor-pointer font-bold hover:bg-blue-600 transition-colors"
            >
              {authMode === 'login' ? 'Login' : 'Sign Up'}
            </button>
            <div className="text-center text-sm text-gray-600">
              {authMode === 'login' ? "Don't have an account? " : "Already have an account? "}
              <span 
                className="text-blue-500 cursor-pointer underline font-medium hover:text-blue-700"
                onClick={() => setAuthMode(authMode === 'login' ? 'signup' : 'login')}
              >
                {authMode === 'login' ? 'Sign Up' : 'Login'}
              </span>
            </div>
            <button 
              onClick={() => setIsAuthModalOpen(false)}
              className="p-2.5 bg-gray-100 border border-gray-300 rounded-md cursor-pointer mt-2 text-gray-800 font-medium hover:bg-gray-200 transition-colors"
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
