
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
 console.log('APP RENDERING');

  return (
    <div>
      <p>Loading TwistyRoute...</p>
    </div>
  );
}

export default App;
