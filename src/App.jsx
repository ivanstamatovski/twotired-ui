import { useState, useEffect, useRef } from 'react';
<<<<<<< Updated upstream
import { MapContainer, TileLayer, GeoJSON, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { createClient } from '@supabase/supabase-js';
import { Menu, X, Map as MapIcon, Maximize, Bug, LogIn, LogOut, BookmarkPlus } from 'lucide-react';
import html2canvas from 'html2canvas';
import './App.css';
=======

import { supabase } from './lib/supabase';

import { Menu, X, Maximize, Bug, LogIn, LogOut } from 'lucide-react';

import './App.css';

import { getRoutes, submitBugReport, saveRoute, logRouteRequest } from './lib/routeService';
>>>>>>> Stashed changes

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Inject CSS for spinner and pulse
const styles = `
<<<<<<< Updated upstream
@keyframes spin {
  to { transform: rotate(360deg); }
}
@keyframes pulse {
  0% { opacity: 1; }
  50% { opacity: 0.5; }
  100% { opacity: 1; }
}
=======
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
>>>>>>> Stashed changes
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
<<<<<<< Updated upstream
=======

  // ── Route state ────────────────────────────────────────────────────────────
>>>>>>> Stashed changes
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

<<<<<<< Updated upstream
  const mapRef = useRef(null);
=======
  const mapDivRef = useRef(null); // DOM div for the map
  const mapRef = useRef(null);    // google.maps.Map instance
  const polylinesRef = useRef([]); // active Polyline instances

  const mapsLoaded = useMapsLoaded();
>>>>>>> Stashed changes

  useEffect(() => {
<<<<<<< Updated upstream
    // Auth Check
=======
>>>>>>> Stashed changes
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

<<<<<<< Updated upstream
    const fetchRoutes = async () => {
      const { data, error } = await supabase.from('routes').select('*');
      if (data) {
=======
    const fetchInitialRoutes = async () => {
      const { data, error } = await supabase
        .from('routes')
        .select('*')
        .eq('is_stale', false)
        .order('community_score', { ascending: false });
      if (!error && data) {
>>>>>>> Stashed changes
        setRoutesDb(data.map(r => ({ ...r, group: r.group_name })));
      } else {
        console.error('Error fetching routes:', error);
      }
    };

<<<<<<< Updated upstream
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
=======
    const channel = supabase.channel('public:routes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'routes' }, (payload) => {
        if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
          const mapped = { ...payload.new, group: payload.new.group_name };
          setSelectedRouteId(prev => mapped.geojson ? mapped.id : (prev ?? mapped.id));
          setIsRequestingRoute(false);
          setGenerating(false);
          setRouteRequestSuccess('');
          setShowRightSidebar(true);
          if (window.innerWidth <= 768 || window.innerHeight <= 500) {
            setShowLeftSidebar(false);
          }
          setRoutesDb(prev => {
            const idx = prev.findIndex(r => r.id === mapped.id);
            if (idx >= 0) { const next = [...prev]; next[idx] = mapped; return next; }
            return [...prev, mapped];
          });
          setSearchResults(prev => {
            const list = prev ?? [];
            const idx = list.findIndex(r => r.id === mapped.id);
            if (idx >= 0) {
              const existing = list[idx];
              const merged = { ...mapped, ...(existing.waypoints ? { waypoints: existing.waypoints } : {}), ...(existing.segments ? { segments: existing.segments } : {}) };
              const next = [...list]; next[idx] = merged; return next;
>>>>>>> Stashed changes
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

<<<<<<< Updated upstream
  const selectedRoute = routesDb.find(r => r.id === selectedRouteId);
  const selectedGeoJSON = selectedRoute ? selectedRoute.geojson : null;
=======
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
    if (route.geojson) return;
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
        setComputedGeoJSON({
          type: 'FeatureCollection',
          features: [{ type: 'Feature', geometry: {
            type: 'LineString',
            coordinates: waypoints.map(w => [w.lng, w.lat])
          }, properties: {} }]
        });
      });
  }, [selectedRouteId, routesDb, searchResults]);

  // ── Derived values (must be before any useEffect that uses them in deps) ───
  const selectedRoute = (searchResults || []).find(r => r.id === selectedRouteId)
    || routesDb.find(r => r.id === selectedRouteId);
  const selectedGeoJSON = selectedRoute?.geojson ?? computedGeoJSON;

  // Only show search results — never show the full historical DB list
  const displayRoutes = searchResults !== null ? searchResults : [];

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

  // ── Handlers ───────────────────────────────────────────────────────────────
  const handleRouteRequest = async () => {
    const query = routeRequestText.trim();
    if (!query) return;
    setLastSearchedQuery(query);
    setGenerating(true);
    setRouteRequestSuccess('');
    setSearchResults(null);
    setSelectedRouteId(null);

    let backgroundMode = false;
    try {
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
      } else if (data?.status === 'generating') {
        backgroundMode = true;
        setTimeout(() => { setGenerating(false); setIsRequestingRoute(false); }, 90000);
      } else {
        const routes = Array.isArray(data) ? data : [];
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
>>>>>>> Stashed changes

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
<<<<<<< Updated upstream
    selectedGeoJSON.features.forEach(feature => {
      if (feature.geometry && feature.geometry.type === 'LineString') {
        feature.geometry.coordinates.forEach(coord => {
          trkpts += `      <trkpt lat="${coord[1]}" lon="${coord[0]}"></trkpt>\n`;
=======
    selectedGeoJSON.features.forEach(f => {
      if (f.geometry?.type === 'LineString') {
        f.geometry.coordinates.forEach(c => {
          trkpts += `  <trkpt lat="${c[1]}" lon="${c[0]}"></trkpt>\n`;
>>>>>>> Stashed changes
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
    a.href = url; a.download = `${(selectedRoute?.title || 'route').replace(/[^a-z0-9]/gi, '_').toLowerCase()}.gpx`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
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
<<<<<<< Updated upstream
      const canvas = await html2canvas(document.body, { useCORS: true });
      const base64_data_url = canvas.toDataURL('image/png');
      setBugScreenshot(base64_data_url);
=======
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' },
        preferCurrentTab: true,
      });
      await new Promise(r => setTimeout(r, 400));
      const track = stream.getVideoTracks()[0];
      const video = document.createElement('video');
      video.srcObject = stream; video.muted = true;
      await new Promise(r => { video.onloadedmetadata = r; });
      await video.play();
      await new Promise(r => requestAnimationFrame(r));
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      setBugScreenshot(canvas.toDataURL('image/jpeg', 0.85));
>>>>>>> Stashed changes
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
<<<<<<< Updated upstream

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
=======
      setBugSubmitSuccess(true);
      setTimeout(() => {
        setBugSubmitSuccess(false); setIsBugModalOpen(false);
        setBugScreenshot(null); setBugComment('');
      }, 2000);
>>>>>>> Stashed changes
    } catch (err) {
      console.error(err);
      alert('Error submitting bug report');
    } finally {
      setIsSubmittingBug(false);
    }
  };

  const closeBugModal = () => { setIsBugModalOpen(false); setBugScreenshot(null); setBugComment(''); };

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

  const handleLogout = async () => { await supabase.auth.signOut(); };

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
<<<<<<< Updated upstream
    <div className="app-container">
      {/* Floating Header */}
      <div className="absolute top-0 left-0 w-full z-[2000] p-4 flex justify-between items-center pointer-events-none">
        <div className="flex items-center gap-2 pointer-events-auto">
          {isMobile && (
            <button className="bg-white p-2 rounded-md shadow-md" onClick={() => setShowLeftSidebar(!showLeftSidebar)}>
              {showLeftSidebar ? <X size={24} /> : <Menu size={24} />}
            </button>
          )}
          <h1 className="m-0 text-xl font-bold bg-white/90 px-3 py-1 rounded-md shadow-md backdrop-blur-sm text-gray-800">🏍️ TwistyRoute</h1>
        </div>
        
        <div className="flex items-center gap-2 pointer-events-auto">
          {isMobile && selectedRoute && (
            <button className="bg-white p-2 rounded-md shadow-md" onClick={() => setShowRightSidebar(!showRightSidebar)}>
              {showRightSidebar ? <X size={24} /> : <MapIcon size={24} />}
            </button>
          )}
          {user ? (
            <button onClick={handleLogout} className="bg-white p-2 rounded-md shadow-md flex items-center justify-center text-gray-800" title="Logout">
              <LogOut size={20} />
            </button>
          ) : (
            <button onClick={() => setIsAuthModalOpen(true)} className="bg-white p-2 rounded-md shadow-md flex items-center justify-center text-gray-800" title="Login">
              <LogIn size={20} />
            </button>
=======
    <div style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', fontFamily: 'sans-serif' }}>

      {isMobile && !showLeftSidebar && (
        <button onClick={() => setShowLeftSidebar(true)} style={{ position: 'absolute', top: '12px', left: '12px', zIndex: 1001, background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '8px', cursor: 'pointer' }}>
          <Menu size={20} />
        </button>
      )}

      {/* ── Left sidebar ────────────────────────────────────────────────────── */}
      {showLeftSidebar && (
        <div style={{ width: '280px', background: '#fff', borderRight: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', padding: '16px', zIndex: 1000, overflowY: 'auto', position: isMobile ? 'absolute' : 'relative', top: 0, left: 0, height: '100%' }}>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <h1 style={{ fontSize: '20px', fontWeight: 700, margin: 0 }}>🏍️ TwistyRoute</h1>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              {user ? (
                <button onClick={handleLogout} title="Logout" style={{ background: 'none', border: 'none', cursor: 'pointer' }}><LogOut size={18} /></button>
              ) : (
                <button onClick={() => setIsAuthModalOpen(true)} title="Login" style={{ background: 'none', border: 'none', cursor: 'pointer' }}><LogIn size={18} /></button>
              )}
              {isMobile && (
                <button onClick={() => setShowLeftSidebar(false)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><X size={20} /></button>
              )}
            </div>
          </div>

          <div style={{ marginBottom: '8px' }}>
            <label style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: '4px' }}>FROM</label>
            <input value={startLocation} readOnly style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box', background: '#f9fafb' }} />
          </div>

          <div style={{ marginBottom: '12px' }}>
            <label style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: '4px' }}>WHERE TO?</label>
            <input value={routeRequestText} onChange={e => setRouteRequestText(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleRouteRequest()} placeholder="e.g., Bear Mountain, Hawk's Nest" style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }} />
          </div>

          <button onClick={handleRouteRequest} disabled={generating || isRequestingRoute || !routeRequestText.trim()} style={{ width: '100%', padding: '10px', background: generating || isRequestingRoute ? '#93c5fd' : '#3b82f6', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '15px', fontWeight: 600, cursor: generating || isRequestingRoute || !routeRequestText.trim() ? 'not-allowed' : 'pointer', marginBottom: '16px' }}>
            {(generating || isRequestingRoute) ? loadingMessages[loadingMsgIdx] : 'Generate'}
          </button>

          {isRequestingRoute && (
            <div style={{ border: '1px dashed #3b82f6', borderRadius: '8px', padding: '16px', marginBottom: '16px', textAlign: 'center' }}>
              <div style={{ width: '32px', height: '32px', border: '3px solid #e5e7eb', borderTop: '3px solid #3b82f6', borderRadius: '50%', margin: '0 auto 12px', animation: 'spin 1s linear infinite' }} />
              <p style={{ fontWeight: 600, margin: '0 0 8px' }}>Generating Custom Route...</p>
              <p style={{ fontSize: '13px', color: '#6b7280', margin: 0 }}>AI is finding the best twisty roads to <strong>{lastSearchedQuery}</strong></p>
            </div>
          )}

          {routeRequestSuccess && (
            <div style={{ background: '#d1fae5', border: '1px solid #6ee7b7', borderRadius: '8px', padding: '12px', marginBottom: '16px', fontSize: '13px', color: '#065f46' }}>{routeRequestSuccess}</div>
          )}

          {hasSearched && searchResults !== null && searchResults.length === 0 && !isRequestingRoute && (
            <div style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: '8px', padding: '12px', marginBottom: '16px', fontSize: '13px', color: '#92400e' }}>
              No saved routes match "{lastSearchedQuery}". A custom route request has been sent.
            </div>
          )}

          {displayRoutes.length > 0 && (
            <div style={{ marginBottom: '16px' }}>
              <p style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 8px' }}>{`Results for "${lastSearchedQuery}"`}</p>
              {displayRoutes.map(route => {
                const segs = route.segments || [];
                const total = segs.length > 0 ? sumDurations(segs) : (route.duration_str || '');
                return (
                  <div key={route.id} onClick={() => handleSelectRoute(route.id)} style={{ padding: '10px 12px', borderRadius: '8px', marginBottom: '8px', cursor: 'pointer', border: selectedRouteId === route.id ? '2px solid #3b82f6' : '1px solid #e5e7eb', background: selectedRouteId === route.id ? '#eff6ff' : '#fff' }}>
                    <p style={{ margin: '0 0 2px', fontWeight: 600, fontSize: '14px' }}>{route.title}</p>
                    <p style={{ margin: 0, fontSize: '12px', color: '#6b7280' }}>{total && `⏱ ${total}`}{route.destination ? ` · ${route.destination}` : ''}</p>
                  </div>
                );
              })}
            </div>
          )}

          {recentRoutes.length > 0 && (
            <div>
              <p style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 8px' }}>Recent Results</p>
              <div style={{ maxHeight: '240px', overflowY: 'auto' }}>
                {recentRoutes.map(route => {
                  const segs = route.segments || [];
                  const total = segs.length > 0 ? sumDurations(segs) : (route.duration_str || '');
                  return (
                    <div key={route.id} onClick={() => handleSelectRoute(route.id)} style={{ padding: '10px 12px', borderRadius: '8px', marginBottom: '6px', cursor: 'pointer', border: selectedRouteId === route.id ? '2px solid #3b82f6' : '1px solid #e5e7eb', background: selectedRouteId === route.id ? '#eff6ff' : '#fafafa' }}>
                      <p style={{ margin: '0 0 2px', fontWeight: 600, fontSize: '13px' }}>{route.title}</p>
                      <p style={{ margin: 0, fontSize: '11px', color: '#9ca3af' }}>{total && `⏱ ${total}`}{route.destination ? ` · ${route.destination}` : ''}</p>
                    </div>
                  );
                })}
              </div>
            </div>
>>>>>>> Stashed changes
          )}
        </div>
      </div>

      

      {/* Left Sidebar - Route List */}
      <div className={`left-sidebar absolute z-[1000] transition-all duration-300 ${isMobile ? `bottom-0 left-0 w-full max-h-[50vh] overflow-y-auto rounded-t-2xl shadow-xl bg-white ${showLeftSidebar ? 'translate-y-0' : 'translate-y-full'}` : `top-0 left-0 w-80 h-full shadow-lg bg-white/95 backdrop-blur-sm pt-20 ${showLeftSidebar ? 'translate-x-0' : '-translate-x-full'}`}`}>
        
        
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
            {!user ? 'Sign up or Log in to Generate' : (isRequestingRoute ? 'Generating...' : 'Generate')}
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
<<<<<<< Updated upstream

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
=======
        <div ref={mapDivRef} style={{ height: '100%', width: '100%' }} />
        <div style={{ position: 'absolute', bottom: '16px', right: '16px', display: 'flex', gap: '8px', zIndex: 1000 }}>
          <button onClick={handleReportBug} style={{ padding: '8px 14px', background: '#fff', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Bug size={14} /> {reportStatus}
          </button>
          <button onClick={fitRoute} disabled={!selectedGeoJSON} style={{ padding: '8px 14px', background: '#fff', border: '1px solid #d1d5db', borderRadius: '6px', cursor: selectedGeoJSON ? 'pointer' : 'default', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px', opacity: selectedGeoJSON ? 1 : 0.5 }}>
            <Maximize size={14} /> Fit Route
>>>>>>> Stashed changes
          </button>
        </div>
      </div>

<<<<<<< Updated upstream
      {/* Right Sidebar - Route Details */}
      {selectedRoute && (
        <div className={`right-sidebar absolute z-[1000] transition-all duration-300 ${isMobile ? `bottom-0 left-0 w-full max-h-[50vh] overflow-y-auto rounded-t-2xl shadow-xl bg-white ${showRightSidebar ? 'translate-y-0' : 'translate-y-full'}` : `top-0 right-0 w-80 h-full shadow-lg bg-white/95 backdrop-blur-sm pt-20 ${showRightSidebar ? 'translate-x-0' : 'translate-x-full'}`}`}>
          {isMobile && (
            <div className="bottom-sheet-handle" onClick={() => setShowRightSidebar(false)}>
              <div className="handle-bar"></div>
            </div>
          )}
          <div className="right-content">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div className="right-title">{selectedRoute.title}</div>

            </div>
            
            {selectedRoute.duration_str && (
              <p className="right-time">⏱️ {selectedRoute.duration_str} • 🛣️ {selectedRoute.distance_mi} miles</p>
            )}
            <div className="right-desc">{selectedRoute.desc}</div>
            
            <div className="flex gap-2 mb-5 flex-wrap">
              <button 
                onClick={handleSaveRoute}
                className="bg-yellow-500 hover:bg-yellow-600 text-white border-none rounded px-3 py-2 cursor-pointer flex items-center justify-center gap-1 flex-1 text-sm font-bold transition-colors"
              >
                <BookmarkPlus size={16} /> Save
              </button>
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
=======
      {/* ── Right panel ──────────────────────────────────────────────────── */}
      {selectedRoute && showRightSidebar && (
        <div style={{ width: '260px', background: '#fff', borderLeft: '1px solid #e5e7eb', padding: '16px', overflowY: 'auto', zIndex: 1000, position: isMobile ? 'absolute' : 'relative', top: 0, right: 0, height: '100%' }}>
          {(() => {
            const segs = selectedRoute.segments
              ? selectedRoute.segments.map(s => ({ color: s.color, label: s.label, desc: s.description, duration: s.duration, miles: s.miles }))
              : [
                  { color: '#e74c3c', label: '⚡ City / Highway', desc: selectedRoute.highway_desc },
                  { color: '#9b59b6', label: '🛣️ Parkway', desc: selectedRoute.parkway_desc },
                  { color: '#2ecc71', label: '🌲 The Ride', desc: selectedRoute.twisty_desc },
                ].filter(s => s.desc);
            const totalDuration = selectedRoute.duration_str || sumDurations(segs);
            const totalMiles = selectedRoute.distance_mi ? `${selectedRoute.distance_mi} mi` : segs.map(s => s.miles).filter(Boolean).join(' + ');
            return (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                  <div>
                    <p style={{ margin: '0 0 4px', fontWeight: 700, fontSize: '15px' }}>{selectedRoute.title}</p>
                    <p style={{ margin: 0, fontSize: '13px', color: '#f97316', fontWeight: 600 }}>
                      {totalDuration && `⏱ ${totalDuration}`}{totalMiles && ` · 🛣️ ${totalMiles}`}
                    </p>
                    {selectedRoute.destination && <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#9ca3af' }}>→ {selectedRoute.destination}</p>}
                  </div>
                  {isMobile && <button onClick={() => setShowRightSidebar(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}><X size={18} /></button>}
                </div>
                <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                  <button onClick={handleSaveRoute} style={{ flex: 1, padding: '8px', background: '#eab308', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>Save</button>
                  <button onClick={handleOpenInGoogleMaps} style={{ flex: 1, padding: '8px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>Maps</button>
                  <button onClick={handleDownloadGPX} style={{ flex: 1, padding: '8px', background: '#22c55e', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>GPX</button>
                </div>
                {segs.map((seg, i) => (
                  <div key={i} style={{ borderLeft: `4px solid ${seg.color}`, paddingLeft: '12px', marginBottom: '14px' }}>
                    <p style={{ fontWeight: 600, margin: '0 0 2px', fontSize: '14px' }}>{seg.label}</p>
                    {(seg.duration || seg.miles) && <p style={{ margin: '0 0 4px', fontSize: '12px', color: '#f97316', fontWeight: 600 }}>{[seg.duration, seg.miles].filter(Boolean).join(' · ')}</p>}
                    {seg.desc && <p style={{ margin: 0, fontSize: '13px', color: '#6b7280', lineHeight: 1.5 }}>{seg.desc}</p>}
                  </div>
                ))}
              </>
            );
          })()}
>>>>>>> Stashed changes
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
<<<<<<< Updated upstream
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
=======
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div style={{ background: '#fff', borderRadius: '12px', padding: '24px', width: '360px', maxWidth: '90vw' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h2 style={{ margin: 0, fontSize: '18px' }}>Report a Bug</h2>
              <button onClick={closeBugModal} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><X size={20} /></button>
            </div>
            {bugScreenshot && <img src={bugScreenshot} alt="Screenshot" style={{ width: '100%', borderRadius: '8px', marginBottom: '12px', border: '1px solid #e5e7eb' }} />}
            <textarea value={bugComment} onChange={e => setBugComment(e.target.value)} placeholder="What went wrong?" rows={3} style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box', marginBottom: '12px', resize: 'vertical' }} />
>>>>>>> Stashed changes
            {bugSubmitSuccess ? (
              <div style={{ textAlign: 'center', padding: '40px 0' }}>
                <h2 style={{ color: '#2ecc71', margin: 0 }}>Thanks for reporting!</h2>
              </div>
            ) : (
<<<<<<< Updated upstream
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
=======
              <button onClick={handleSubmitBug} disabled={isSubmittingBug} style={{ width: '100%', padding: '10px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '15px', fontWeight: 600, cursor: isSubmittingBug ? 'not-allowed' : 'pointer' }}>
                {isSubmittingBug ? 'Submitting...' : 'Submit Bug Report'}
              </button>
>>>>>>> Stashed changes
            )}
          </div>
        </div>
      )}

      {/* Auth Modal */}
      {isAuthModalOpen && (
<<<<<<< Updated upstream
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
=======
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div style={{ background: '#fff', borderRadius: '12px', padding: '32px', width: '320px', maxWidth: '90vw' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0, fontSize: '18px' }}>{authMode === 'login' ? 'Log In' : 'Sign Up'}</h2>
              <button onClick={() => setIsAuthModalOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><X size={20} /></button>
            </div>
            {authError && <p style={{ color: '#ef4444', fontSize: '13px', marginBottom: '12px' }}>{authError}</p>}
            <input type="email" placeholder="Email" value={authEmail} onChange={e => setAuthEmail(e.target.value)} style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '6px', marginBottom: '10px', fontSize: '14px', boxSizing: 'border-box' }} />
            <input type="password" placeholder="Password" value={authPassword} onChange={e => setAuthPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAuth()} style={{ width: '100%', padding: '10px', border: '1px solid #d1d5db', borderRadius: '6px', marginBottom: '16px', fontSize: '14px', boxSizing: 'border-box' }} />
            <button onClick={handleAuth} style={{ width: '100%', padding: '10px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '15px', fontWeight: 600, cursor: 'pointer', marginBottom: '12px' }}>
              {authMode === 'login' ? 'Log In' : 'Sign Up'}
            </button>
            <p style={{ textAlign: 'center', fontSize: '13px', margin: 0 }}>
              {authMode === 'login' ? "Don't have an account? " : 'Already have an account? '}
              <span onClick={() => setAuthMode(authMode === 'login' ? 'signup' : 'login')} style={{ color: '#3b82f6', cursor: 'pointer', fontWeight: 600 }}>
                {authMode === 'login' ? 'Sign Up' : 'Log In'}
>>>>>>> Stashed changes
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
