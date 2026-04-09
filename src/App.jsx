import { useState, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, GeoJSON, useMap, ZoomControl } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { supabase } from './lib/supabase';
import { Menu, X, Map as MapIcon, Maximize, Bug, LogIn, LogOut, BookmarkPlus } from 'lucide-react';
import html2canvas from 'html2canvas';
import './App.css';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
import { getRoutes, submitBugReport, saveRoute } from './lib/routeService';

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
  try {
    const { routes } = await getRoutes(destination);
    setRoutes(routes);
  } catch (err) {
    console.error('Route fetch error:', err);
  }
};

  const [generating, setGenerating] = useState(false);

const handleGenerate = async () => {
  if (!destination) return;
  setGenerating(true);
  try {
    const { routes } = await getRoutes(destination);
    setRoutes(routes);
  } catch (err) {
    console.error(err);
  } finally {
    setGenerating(false);
  }
};
  
 fetchRoutes();

 const channel = supabase.channel('public:routes')
 .on('postgres_changes', { event: '*', schema: 'public', table: 'routes' }, (payload) => {
 if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
 const mappedNew = { ...payload.new, group: payload.new.group_name };
 
 // Force selection and clear generation states
 setSelectedRouteId(mappedNew.id);
 setIsRequestingRoute(false);
 setRouteRequestSuccess('');
 setHasSearched(false);
 setRouteRequestText('');
 setSearchResults(null);
 
 // Pop open the route details side panel
 setShowRightSidebar(true);
 if (window.innerWidth <= 768 || window.innerHeight <= 500) {
 setShowLeftSidebar(false);
 }

 setRoutesDb(prev => {
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
 trkpts += ` <trkpt lat="${coord[1]}" lon="${coord[0]}"></trkpt>\n`;
 });
 }
 });

 const gpxData = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TwistyRoute">
 <trk>
 <name>${selectedRoute?.title || 'Route'}</name>
 <trkseg>
${trkpts} </trkseg>
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
 if (!user) {
 setIsAuthModalOpen(true);
 return;
 }

 setIsRequestingRoute(true);
 setRouteRequestSuccess('');
 try {
 const { error } = await supabase.from('route_requests').insert({
 request_text: startLocation ? `Start: ${startLocation}. Request: ${routeRequestText}` : routeRequestText,
 user_id: user.id,
 email: user.email
 });

 if (!error) {
 setRouteRequestText('');
 setRouteRequestSuccess(`Your request is in! We will email you at ${user.email} when our AI agents finish creating your custom route.`);
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

  return (
    <div style={{ display:'flex', height:'100vh', width:'100vw', overflow:'hidden', fontFamily:'sans-serif' }}>

      {/* Left sidebar */}
      <div style={{ width:'280px', background:'#fff', borderRight:'1px solid #e5e7eb', display:'flex', flexDirection:'column', padding:'16px', zIndex:1000, overflowY:'auto' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'16px' }}>
          <h1 style={{ fontSize:'20px', fontWeight:700, margin:0 }}>🏍️ TwistyRoute</h1>
          {user ? (
            <button onClick={handleLogout} title="Logout" style={{ background:'none', border:'none', cursor:'pointer' }}>
              <LogOut size={18} />
            </button>
          ) : (
            <button onClick={() => setIsAuthModalOpen(true)} title="Login" style={{ background:'none', border:'none', cursor:'pointer' }}>
              <LogIn size={18} />
            </button>
          )}
        </div>

        <div style={{ marginBottom:'8px' }}>
          <input value="Balancero Astoria" readOnly
            style={{ width:'100%', padding:'8px', border:'1px solid #d1d5db', borderRadius:'6px', fontSize:'14px', boxSizing:'border-box', background:'#f9fafb' }} />
        </div>

        <div style={{ marginBottom:'12px' }}>
          <label style={{ fontSize:'13px', fontWeight:600, display:'block', marginBottom:'4px' }}>Where to?</label>
          <input value={destination} onChange={e => setDestination(e.target.value)}
            placeholder="e.g., Bear Mountain, Hawk's Nest"
            style={{ width:'100%', padding:'8px', border:'1px solid #d1d5db', borderRadius:'6px', fontSize:'14px', boxSizing:'border-box' }} />
        </div>

        <button onClick={handleGenerate} disabled={generating}
          style={{ width:'100%', padding:'10px', background: generating ? '#93c5fd' : '#3b82f6', color:'#fff', border:'none', borderRadius:'6px', fontSize:'15px', fontWeight:600, cursor: generating ? 'not-allowed' : 'pointer', marginBottom:'16px' }}>
          {generating ? 'Generating...' : 'Generate'}
        </button>

        {generatingState && (
          <div style={{ border:'1px dashed #3b82f6', borderRadius:'8px', padding:'16px', marginBottom:'16px', textAlign:'center' }}>
            <div style={{ width:'32px', height:'32px', border:'3px solid #e5e7eb', borderTop:'3px solid #3b82f6', borderRadius:'50%', margin:'0 auto 12px', animation:'spin 1s linear infinite' }} />
            <p style={{ fontWeight:600, margin:'0 0 8px' }}>Generating Custom Route...</p>
            <p style={{ fontSize:'13px', color:'#6b7280', margin:0 }}>AI is analyzing twisty roads for <strong>{destination}</strong></p>
          </div>
        )}

        {routes.length > 0 && (
          <div>
            <p style={{ fontSize:'12px', fontWeight:600, color:'#6b7280', textTransform:'uppercase', letterSpacing:'0.05em', margin:'0 0 8px' }}>Matching Routes</p>
            {routes.map(route => (
              <div key={route.id} onClick={() => handleRouteSelect(route)}
                style={{ padding:'10px 12px', borderRadius:'8px', marginBottom:'8px', cursor:'pointer',
                  border: selectedRoute?.id === route.id ? '2px solid #3b82f6' : '1px solid #e5e7eb',
                  background: selectedRoute?.id === route.id ? '#eff6ff' : '#fff' }}>
                <p style={{ margin:'0 0 2px', fontWeight:600, fontSize:'14px' }}>{route.title}</p>
                <p style={{ margin:0, fontSize:'12px', color:'#6b7280' }}>{route.destination || route.group_name}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Map */}
      <div style={{ flex:1, position:'relative' }}>
        <MapContainer center={[41.0, -74.0]} zoom={9} style={{ height:'100%', width:'100%' }} zoomControl={false} ref={mapRef}>
          <ZoomControl position="topright" />
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
            attribution='&copy; OpenStreetMap contributors &copy; CARTO'
          />
          {selectedRoute?.geojson && (
            <GeoJSON key={selectedRoute.id} data={selectedRoute.geojson}
              style={feature => ({ color: feature.properties?.color || '#3b82f6', weight:4, opacity:0.9 })} />
          )}
          <MapController selectedRoute={selectedRoute} />
        </MapContainer>

        <div style={{ position:'absolute', bottom:'16px', right:'16px', display:'flex', gap:'8px', zIndex:1000 }}>
          <button onClick={handleReportBug} style={{ padding:'8px 14px', background:'#fff', border:'1px solid #d1d5db', borderRadius:'6px', cursor:'pointer', fontSize:'13px', display:'flex', alignItems:'center', gap:'6px' }}>
            <Bug size={14} /> Report Bug
          </button>
          <button onClick={handleFitRoute} style={{ padding:'8px 14px', background:'#fff', border:'1px solid #d1d5db', borderRadius:'6px', cursor:'pointer', fontSize:'13px', display:'flex', alignItems:'center', gap:'6px' }}>
            <Maximize size={14} /> Fit Route
          </button>
        </div>
      </div>

      {/* Right panel */}
      {selectedRoute && (
        <div style={{ width:'260px', background:'#fff', borderLeft:'1px solid #e5e7eb', padding:'16px', overflowY:'auto', zIndex:1000 }}>
          <div style={{ fontSize:'13px', color:'#f97316', fontWeight:600, marginBottom:'12px' }}>
            ⏱ {selectedRoute.duration_str} &bull; 🛣️ {selectedRoute.distance_mi} mi
          </div>
          <div style={{ display:'flex', gap:'8px', marginBottom:'16px' }}>
            <button onClick={handleSaveRoute} style={{ flex:1, padding:'8px', background:'#eab308', color:'#fff', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:600 }}>Save</button>
            <button onClick={handleOpenGoogleMaps} style={{ flex:1, padding:'8px', background:'#3b82f6', color:'#fff', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:600 }}>Google Maps</button>
            <button onClick={handleDownloadGPX} style={{ flex:1, padding:'8px', background:'#22c55e', color:'#fff', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:600 }}>GPX</button>
          </div>
          {[
            { color: selectedRoute.colors?.city || '#E24B4A', label:'⚡ City / Highway', desc: selectedRoute.highway_desc },
            { color: selectedRoute.colors?.parkway || '#7F77DD', label:'🛣️ Parkway', desc: selectedRoute.parkway_desc },
            { color: selectedRoute.colors?.scenic || '#34A853', label:'🌲 The Ride', desc: selectedRoute.twisty_desc },
          ].filter(s => s.desc).map((seg, i) => (
            <div key={i} style={{ borderLeft:'4px solid '+seg.color, paddingLeft:'12px', marginBottom:'12px' }}>
              <p style={{ fontWeight:600, margin:'0 0 4px', fontSize:'14px' }}>{seg.label}</p>
              <p style={{ margin:0, fontSize:'13px', color:'#6b7280', lineHeight:1.5 }}>{seg.desc}</p>
            </div>
          ))}
        </div>
      )}

      {/* Auth modal */}
      {isAuthModalOpen && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:9999 }}>
          <div style={{ background:'#fff', borderRadius:'12px', padding:'32px', width:'320px' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'20px' }}>
              <h2 style={{ margin:0, fontSize:'18px' }}>{authMode === 'login' ? 'Log In' : 'Sign Up'}</h2>
              <button onClick={() => setIsAuthModalOpen(false)} style={{ background:'none', border:'none', cursor:'pointer' }}><X size={20} /></button>
            </div>
            {authError && <p style={{ color:'#ef4444', fontSize:'13px', marginBottom:'12px' }}>{authError}</p>}
            <input type="email" placeholder="Email" value={authEmail} onChange={e => setAuthEmail(e.target.value)}
              style={{ width:'100%', padding:'10px', border:'1px solid #d1d5db', borderRadius:'6px', marginBottom:'10px', fontSize:'14px', boxSizing:'border-box' }} />
            <input type="password" placeholder="Password" value={authPassword} onChange={e => setAuthPassword(e.target.value)}
              style={{ width:'100%', padding:'10px', border:'1px solid #d1d5db', borderRadius:'6px', marginBottom:'16px', fontSize:'14px', boxSizing:'border-box' }} />
            <button onClick={handleAuth}
              style={{ width:'100%', padding:'10px', background:'#3b82f6', color:'#fff', border:'none', borderRadius:'6px', fontSize:'15px', fontWeight:600, cursor:'pointer', marginBottom:'12px' }}>
              {authMode === 'login' ? 'Log In' : 'Sign Up'}
            </button>
            <p style={{ textAlign:'center', fontSize:'13px', margin:0 }}>
              {authMode === 'login' ? "Don't have an account? " : 'Already have an account? '}
              <span onClick={() => setAuthMode(authMode === 'login' ? 'signup' : 'login')}
                style={{ color:'#3b82f6', cursor:'pointer', fontWeight:600 }}>
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
