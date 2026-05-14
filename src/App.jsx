import { useState, useEffect, useRef } from 'react';
import './App.css';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const EDGE_URL = `${SUPABASE_URL}/functions/v1/generate-route`;
const START = 'Balancero cafe, Astoria, Queens, NY';
const START_LABEL = 'Balancero cafe, Astoria';
const RECENT_KEY = 'twistyroute_recent';

const LOADING_MSGS = [
  'Asking Claude for the best twisties…',
  'Plotting your escape from the city…',
  'Finding the scenic stuff…',
  'Almost there…',
];

const APPROVAL_WORDS = ['looks good', 'perfect', 'great', 'love it', 'approve', "let's go",
  'nice', 'yes', 'send it', 'go for it', 'awesome', 'perfect', 'nailed it', '👍'];

const QUICK_CHIPS = ['👍 Looks great', 'More twisty', 'Add a coffee stop', 'Different road'];

// ── Helpers ───────────────────────────────────────────────────────────────────
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

function extractPath(geojson) {
  if (!geojson) return [];
  let coords = null;
  if (Array.isArray(geojson?.features) && geojson.features[0]?.geometry?.coordinates) {
    coords = geojson.features[0].geometry.coordinates;
  } else if (geojson?.geometry?.coordinates) {
    coords = geojson.geometry.coordinates;
  } else if (Array.isArray(geojson?.coordinates)) {
    coords = geojson.coordinates;
  }
  if (!coords || coords.length < 2) return [];
  return coords.map(([lng, lat]) => ({ lat, lng }));
}

function buildNavUrl(route) {
  if (!route) return '';
  const wps = route.waypoints || [];
  const toStr = wp => typeof wp === 'string' ? encodeURIComponent(wp) : `${wp.lat},${wp.lng}`;
  const origin = encodeURIComponent(START);
  const dest = route.destination ? encodeURIComponent(route.destination) : wps.length ? toStr(wps[wps.length - 1]) : '';
  const middle = wps.slice(0, 23).map(toStr).join('/');
  return `https://www.google.com/maps/dir/${origin}/${middle ? middle + '/' : ''}${dest}`;
}

function formatDuration(minutes) {
  if (!minutes) return '';
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h > 0 ? `${h}h ${m}min` : `${m}min`;
}
function getTitle(r) { return r?.title || 'Generated Route'; }
function getDuration(r) { return r?.duration_str || formatDuration(r?.time_minutes); }
function getDistance(r) { return r?.distance_mi ?? r?.distance_miles ?? '?'; }

function isApproval(text) {
  const t = text.toLowerCase().trim();
  return t === '👍' || APPROVAL_WORDS.some(w => t.includes(w));
}

// ── Shared route card used in both desktop and conversation thread ─────────────
function RouteCard({ route, onNav, compact = false }) {
  if (!route) return null;
  return (
    <div style={{
      background: '#1e293b', borderRadius: 12, padding: compact ? '10px 12px' : '12px 14px',
      border: '1px solid #334155',
    }}>
      <div style={{ fontSize: compact ? 13 : 14, fontWeight: 700, color: 'white', marginBottom: 4,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {getTitle(route)}
      </div>
      <div style={{ fontSize: 12, color: '#93c5fd' }}>
        ⏱ {getDuration(route)} · 🛣️ {getDistance(route)} mi
      </div>
      {!compact && route.stops?.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: '#94a3b8' }}>
          {route.stops.map((s, i) => (
            <span key={i}>☕ {s.name}{i < route.stops.length - 1 ? ' · ' : ''}</span>
          ))}
        </div>
      )}
      {onNav && (
        <a href={buildNavUrl(route)} target="_blank" rel="noopener noreferrer"
          style={{ display: 'inline-block', marginTop: 8, background: '#1d4ed8', color: 'white',
            borderRadius: 8, padding: '6px 14px', fontSize: 12, fontWeight: 700, textDecoration: 'none' }}>
          🧭 Go
        </a>
      )}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const mapRef = useRef(null);
  const polylineRef = useRef(null);
  const mapDivRef = useRef(null);
  const messagesEndRef = useRef(null);
  const mapsLoaded = useMapsLoaded();

  // Route state
  const [route, setRoute] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState(0);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  // Conversation state
  const [messages, setMessages] = useState([]);         // [{role, content, route?}]
  const [currentIntent, setCurrentIntent] = useState(null);
  const [followUpInput, setFollowUpInput] = useState('');
  const [conversationActive, setConversationActive] = useState(false);
  const [routeApproved, setRouteApproved] = useState(false);

  // Bug report state
  const [bugMode, setBugMode] = useState(false);
  const [bugComment, setBugComment] = useState('');
  const [bugSubmitting, setBugSubmitting] = useState(false);
  const [bugDone, setBugDone] = useState(false);
  const [bugError, setBugError] = useState('');

  // Mobile state
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);
  const [sheetState, setSheetState] = useState('search'); // 'search' | 'expanded'

  // ── Effects ─────────────────────────────────────────────────────────────────
  // Resize listener
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Map init
  useEffect(() => {
    if (!mapsLoaded || !mapDivRef.current || mapRef.current) return;
    mapRef.current = new window.google.maps.Map(mapDivRef.current, {
      center: { lat: 40.85, lng: -74.1 },
      zoom: 10,
      mapTypeId: 'roadmap',
    });
  }, [mapsLoaded]);

  // Draw polyline when route changes
  useEffect(() => {
    if (!mapRef.current || !route) return;
    if (polylineRef.current) polylineRef.current.setMap(null);
    const path = extractPath(route.geojson || route.geometry);
    if (path.length < 2) return;
    polylineRef.current = new window.google.maps.Polyline({
      path, strokeColor: '#3b82f6', strokeOpacity: 0.9, strokeWeight: 4, map: mapRef.current,
    });
    const bounds = new window.google.maps.LatLngBounds();
    path.forEach(p => bounds.extend(p));
    const mobile = window.innerWidth <= 768;
    mapRef.current.fitBounds(bounds, { top: 40, right: 40, bottom: mobile ? 220 : 40, left: 40 });
  }, [route]);

  // Cycle loading messages
  useEffect(() => {
    if (!loading) return;
    setLoadingMsg(0);
    const id = setInterval(() => setLoadingMsg(m => (m + 1) % LOADING_MSGS.length), 1800);
    return () => clearInterval(id);
  }, [loading]);

  // On mobile: when route arrives, snap to peek state
  useEffect(() => {
    if (route && isMobile) setSheetState('search');
  }, [route, isMobile]);

  // Auto-scroll conversation to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Handlers ─────────────────────────────────────────────────────────────────
  async function generateRoute(payload, userMessage) {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(EDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const routeData = data.route ?? data;
      setRoute(routeData);
      setCurrentIntent(routeData.intent || null);
      setMessages(prev => [...prev, { role: 'route', route: routeData }]);
      setConversationActive(true);
      setRouteApproved(false);
      if (isMobile) setSheetState('expanded');

      // Save to recents
      const recents = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      const entry = { title: getTitle(routeData), duration: getDuration(routeData), distance: getDistance(routeData), query: userMessage, ts: Date.now() };
      localStorage.setItem(RECENT_KEY, JSON.stringify([entry, ...recents.filter(r => r.query !== entry.query)].slice(0, 5)));
    } catch (err) {
      setError(`Failed to generate route: ${err.message}`);
      setMessages(prev => [...prev, { role: 'assistant', content: `⚠️ ${err.message}` }]);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e) {
    e?.preventDefault();
    if (!query.trim() || loading) return;
    const q = query.trim();
    setRoute(null);
    setConversationActive(false);
    setRouteApproved(false);
    setMessages([{ role: 'user', content: q }]);
    setFollowUpInput('');
    if (isMobile) setSheetState('search');
    await generateRoute({ query: q }, q);
  }

  async function handleFollowUp(text) {
    const t = text || followUpInput;
    if (!t.trim() || loading) return;
    setFollowUpInput('');

    if (isApproval(t)) {
      handleApprove();
      return;
    }

    setMessages(prev => [...prev, { role: 'user', content: t }]);
    await generateRoute({ refine: true, feedback: t, intent: currentIntent }, t);
  }

  function handleApprove() {
    setRouteApproved(true);
    setConversationActive(false);
    if (isMobile) setSheetState('search');
  }

  function handleClearRoute() {
    setRoute(null);
    setConversationActive(false);
    setRouteApproved(false);
    setMessages([]);
    setCurrentIntent(null);
    if (polylineRef.current) { polylineRef.current.setMap(null); polylineRef.current = null; }
    if (isMobile) setSheetState('search');
  }

  async function submitBugReport() {
    setBugSubmitting(true);
    setBugError('');
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser' }, preferCurrentTab: true });
      await new Promise(r => setTimeout(r, 400));
      const video = document.createElement('video');
      video.srcObject = stream;
      await video.play();
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0);
      stream.getTracks().forEach(t => t.stop());

      // Redraw polyline on canvas
      if (route && mapRef.current && polylineRef.current) {
        const path = extractPath(route.geojson || route.geometry);
        if (path.length > 1) {
          const mapRect = mapDivRef.current.getBoundingClientRect();
          const projection = mapRef.current.getProjection();
          const zoom = mapRef.current.getZoom();
          const scale = Math.pow(2, zoom);
          const nwPoint = new window.google.maps.LatLng(mapRef.current.getBounds().getNorthEast().lat(), mapRef.current.getBounds().getSouthWest().lng());
          const nwWorld = projection.fromLatLngToPoint(nwPoint);
          ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 3; ctx.beginPath();
          path.forEach((pt, i) => {
            const wp = projection.fromLatLngToPoint(new window.google.maps.LatLng(pt.lat, pt.lng));
            const x = (mapRect.left + (wp.x - nwWorld.x) * scale) * (canvas.width / window.innerWidth);
            const y = (mapRect.top + (wp.y - nwWorld.y) * scale) * (canvas.height / window.innerHeight);
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          });
          ctx.stroke();
        }
      }

      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      const filename = `bug_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.png`;
      const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/bug-screenshots/${filename}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'image/png' },
        body: blob,
      });
      if (!uploadRes.ok) throw new Error('Screenshot upload failed');
      const screenshotUrl = `${SUPABASE_URL}/storage/v1/object/public/bug-screenshots/${filename}`;
      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/insert_bug_report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`, 'apikey': SUPABASE_ANON_KEY },
        body: JSON.stringify({ p_comment: bugComment, p_screenshot_url: screenshotUrl, p_route_id: route?.id || null, p_query: query }),
      });
      if (!rpcRes.ok) throw new Error('Bug report submission failed');
      setBugDone(true); setBugComment('');
      setTimeout(() => { setBugMode(false); setBugDone(false); }, 3000);
    } catch (err) { setBugError(err.message); }
    finally { setBugSubmitting(false); }
  }

  // ── Conversation panel (shared desktop + mobile) ───────────────────────────
  function ConversationThread() {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 12px 4px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {messages.map((msg, i) => (
            msg.role === 'user' ? (
              <div key={i} style={{ alignSelf: 'flex-end', background: '#1d4ed8', color: 'white',
                borderRadius: '14px 14px 3px 14px', padding: '8px 12px', maxWidth: '88%', fontSize: 13, lineHeight: 1.4 }}>
                {msg.content}
              </div>
            ) : msg.role === 'route' ? (
              <div key={i} style={{ alignSelf: 'stretch' }}>
                <RouteCard route={msg.route} onNav compact />
              </div>
            ) : (
              <div key={i} style={{ alignSelf: 'flex-start', color: '#94a3b8', fontSize: 12, fontStyle: 'italic' }}>
                {msg.content}
              </div>
            )
          ))}
          {loading && (
            <div style={{ alignSelf: 'flex-start', color: '#93c5fd', fontSize: 12 }}>
              {LOADING_MSGS[loadingMsg]}
            </div>
          )}
          {routeApproved && (
            <div style={{ alignSelf: 'center', background: '#064e3b', color: '#6ee7b7',
              borderRadius: 10, padding: '8px 16px', fontSize: 13, fontWeight: 600 }}>
              ✅ Route saved — have a great ride! 🏍️
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Quick chips + input */}
        {conversationActive && !routeApproved && (
          <>
            <div style={{ padding: '6px 12px 4px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {QUICK_CHIPS.map(chip => (
                <button key={chip} onClick={() => handleFollowUp(chip)} disabled={loading}
                  style={{ background: '#0f172a', color: '#93c5fd', border: '1px solid #1e3a5f',
                    borderRadius: 20, padding: '5px 11px', fontSize: 11, cursor: 'pointer',
                    opacity: loading ? 0.5 : 1, transition: 'opacity 0.15s' }}>
                  {chip}
                </button>
              ))}
            </div>
            <form onSubmit={e => { e.preventDefault(); handleFollowUp(); }}
              style={{ padding: '4px 12px 12px', display: 'flex', gap: 6 }}>
              <input value={followUpInput} onChange={e => setFollowUpInput(e.target.value)}
                placeholder="Suggest changes or approve…" disabled={loading}
                style={{ flex: 1, background: '#1e293b', color: 'white', border: '1px solid #334155',
                  borderRadius: 10, padding: '9px 12px', fontSize: 13, outline: 'none' }} />
              <button type="submit" disabled={loading || !followUpInput.trim()}
                style={{ background: '#1d4ed8', color: 'white', border: 'none', borderRadius: 10,
                  padding: '0 14px', fontSize: 16, cursor: 'pointer', opacity: loading || !followUpInput.trim() ? 0.5 : 1 }}>
                ↑
              </button>
            </form>
          </>
        )}

        {/* Bug report */}
        {route && !conversationActive && (
          <div style={{ padding: '8px 12px 12px', borderTop: '1px solid #1e293b' }}>
            {!bugMode ? (
              <button onClick={() => setBugMode(true)}
                style={{ background: 'none', color: '#475569', border: 'none', fontSize: 11, cursor: 'pointer', padding: 0 }}>
                🐛 Report routing issue
              </button>
            ) : bugDone ? (
              <div style={{ color: '#6ee7b7', fontSize: 12 }}>✓ Report submitted — thanks!</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <textarea value={bugComment} onChange={e => setBugComment(e.target.value)}
                  placeholder="What went wrong with this route?" rows={2}
                  style={{ background: '#1e293b', color: 'white', border: '1px solid #334155', borderRadius: 8, padding: '6px 10px', fontSize: 12, resize: 'none' }} />
                {bugError && <div style={{ color: '#f87171', fontSize: 11 }}>{bugError}</div>}
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={submitBugReport} disabled={bugSubmitting}
                    style={{ flex: 1, background: '#1d4ed8', color: 'white', border: 'none', borderRadius: 8, padding: '7px', fontSize: 12, cursor: 'pointer' }}>
                    {bugSubmitting ? 'Capturing…' : '📸 Capture & Submit'}
                  </button>
                  <button onClick={() => { setBugMode(false); setBugComment(''); setBugError(''); }}
                    style={{ background: '#1e293b', color: '#94a3b8', border: '1px solid #334155', borderRadius: 8, padding: '7px 10px', fontSize: 12, cursor: 'pointer' }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Recent routes (shown when no conversation active) ─────────────────────
  const recentRoutes = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', height: '100vh', background: '#0f172a', color: 'white', fontFamily: 'system-ui, sans-serif', overflow: 'hidden' }}>

      {/* ── MAP (always full-screen behind everything) ── */}
      <div ref={mapDivRef} style={{
        position: 'absolute', inset: 0, background: '#1e293b',
      }} />

      {/* ══════════════════ DESKTOP LAYOUT ══════════════════ */}
      {!isMobile && (
        <>
          {/* Left panel */}
          <div style={{
            position: 'relative', zIndex: 10, width: 300, minWidth: 300,
            background: 'rgba(15,23,42,0.95)', borderRight: '1px solid #1e293b',
            display: 'flex', flexDirection: 'column', height: '100vh',
          }}>
            {/* Header + search */}
            <div style={{ padding: '16px 14px 12px', borderBottom: '1px solid #1e293b', flexShrink: 0 }}>
              <div style={{ fontSize: 17, fontWeight: 800, color: '#3b82f6', marginBottom: 10, letterSpacing: '-0.3px' }}>
                🏍️ TwoTired
              </div>
              <form onSubmit={handleSubmit}>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input value={query} onChange={e => setQuery(e.target.value)}
                    placeholder="Where to? Storm King, Hawks Nest…"
                    style={{ flex: 1, background: '#1e293b', color: 'white', border: '1px solid #334155',
                      borderRadius: 10, padding: '9px 12px', fontSize: 13, outline: 'none' }} />
                  <button type="submit" disabled={loading}
                    style={{ background: '#1d4ed8', color: 'white', border: 'none', borderRadius: 10,
                      padding: '0 14px', fontSize: 15, cursor: 'pointer', opacity: loading ? 0.6 : 1 }}>
                    {loading ? '…' : '→'}
                  </button>
                </div>
              </form>
              {error && <div style={{ color: '#f87171', fontSize: 11, marginTop: 6 }}>{error}</div>}
            </div>

            {/* Conversation or recent routes */}
            {(conversationActive || messages.length > 0) ? (
              <ConversationThread />
            ) : (
              <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
                {recentRoutes.length > 0 && (
                  <>
                    <div style={{ fontSize: 11, color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Recent</div>
                    {recentRoutes.map((r, i) => (
                      <div key={i} onClick={() => setQuery(r.query)}
                        style={{ padding: '8px 10px', borderRadius: 8, cursor: 'pointer', marginBottom: 4,
                          background: '#1e293b', border: '1px solid #1e293b' }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</div>
                        <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>⏱ {r.duration} · 🛣️ {r.distance} mi</div>
                      </div>
                    ))}
                  </>
                )}
                {recentRoutes.length === 0 && (
                  <div style={{ color: '#475569', fontSize: 13, textAlign: 'center', marginTop: 40 }}>
                    Type a destination above to plan your ride
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right panel — narrative */}
          {route && !conversationActive && (
            <div style={{
              position: 'absolute', right: 0, top: 0, bottom: 0, zIndex: 10, width: 320,
              background: 'rgba(15,23,42,0.95)', borderLeft: '1px solid #1e293b',
              display: 'flex', flexDirection: 'column',
            }}>
              <div style={{ flex: 1, overflowY: 'auto', padding: '16px 14px' }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'white', marginBottom: 4 }}>{getTitle(route)}</div>
                <div style={{ fontSize: 12, color: '#93c5fd', marginBottom: 12 }}>
                  ⏱ {getDuration(route)} · 🛣️ {getDistance(route)} mi
                </div>
                {route.stops?.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    {route.stops.map((s, i) => (
                      <div key={i} style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>
                        ☕ <strong style={{ color: '#e2e8f0' }}>{s.name}</strong> — {s.address}
                      </div>
                    ))}
                  </div>
                )}
                {route.narrative && (
                  <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.65 }}>{route.narrative}</div>
                )}
              </div>
              <div style={{ padding: '12px 14px', borderTop: '1px solid #1e293b', display: 'flex', gap: 8 }}>
                <a href={buildNavUrl(route)} target="_blank" rel="noopener noreferrer"
                  style={{ flex: 1, background: '#1d4ed8', color: 'white', borderRadius: 10, padding: '10px', fontSize: 13, fontWeight: 700, textDecoration: 'none', textAlign: 'center' }}>
                  🧭 Go
                </a>
              </div>
            </div>
          )}
        </>
      )}

      {/* ══════════════════ MOBILE LAYOUT ══════════════════ */}
      {isMobile && (
        <>
          {/* Loading overlay */}
          {loading && (
            <div style={{
              position: 'fixed', inset: 0, zIndex: 90,
              background: 'rgba(15,23,42,0.65)', backdropFilter: 'blur(3px)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16,
              pointerEvents: 'none',
            }}>
              <div style={{ fontSize: 48 }}>🏍️</div>
              <div style={{ color: 'white', fontSize: 16, fontWeight: 600, textAlign: 'center', padding: '0 40px', lineHeight: 1.5 }}>
                {LOADING_MSGS[loadingMsg]}
              </div>
            </div>
          )}

          {/* Bottom sheet */}
          <div style={{
            position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 100,
            background: 'rgba(15,23,42,0.97)',
            borderRadius: '20px 20px 0 0',
            border: '1px solid #1e293b',
            transition: 'height 0.3s ease',
            height: sheetState === 'expanded' ? '72vh' : (route ? '190px' : '108px'),
            display: 'flex', flexDirection: 'column',
          }}>
            {/* Drag handle */}
            <div onClick={() => setSheetState(s => s === 'expanded' ? 'search' : 'expanded')}
              style={{ flexShrink: 0, padding: '10px 0 4px', display: 'flex', justifyContent: 'center', cursor: 'pointer' }}>
              <div style={{ width: 36, height: 4, background: '#334155', borderRadius: 2 }} />
            </div>

            {/* Search row */}
            <div style={{ padding: '0 14px 10px', flexShrink: 0 }}>
              <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 8 }}>
                <input value={query} onChange={e => setQuery(e.target.value)}
                  placeholder="Where to? Storm King, Hawks Nest…"
                  style={{ flex: 1, background: '#1e293b', color: 'white', border: '1px solid #334155',
                    borderRadius: 10, padding: '9px 12px', fontSize: 14, outline: 'none' }} />
                <button type="submit" disabled={loading}
                  style={{ background: '#1d4ed8', color: 'white', border: 'none', borderRadius: 10,
                    padding: '0 16px', fontSize: 16, cursor: 'pointer', opacity: loading ? 0.6 : 1 }}>
                  {loading ? '…' : '→'}
                </button>
              </form>
              {error && <div style={{ color: '#f87171', fontSize: 11, marginTop: 5 }}>{error}</div>}
            </div>

            {/* Peek row — route summary when collapsed */}
            {route && sheetState === 'search' && (
              <div style={{ padding: '0 14px 14px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'white', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {getTitle(route)}
                  </div>
                  <div style={{ fontSize: 12, color: '#93c5fd', marginTop: 3 }}>
                    ⏱ {getDuration(route)} · 🛣️ {getDistance(route)} mi
                    {conversationActive && <span style={{ color: '#334155' }}> · tap ↑ to refine</span>}
                    {routeApproved && <span style={{ color: '#6ee7b7' }}> · ✅ saved</span>}
                  </div>
                </div>
                <a href={buildNavUrl(route)} target="_blank" rel="noopener noreferrer"
                  style={{ background: '#1d4ed8', color: 'white', borderRadius: 10, padding: '9px 14px', fontSize: 13, fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' }}>
                  🧭 Go
                </a>
                <button onClick={handleClearRoute}
                  style={{ background: '#1e293b', color: '#64748b', border: '1px solid #334155', borderRadius: 8, padding: '8px 10px', fontSize: 14, cursor: 'pointer' }}>
                  ✕
                </button>
              </div>
            )}

            {/* Expanded content */}
            {sheetState === 'expanded' && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                {(conversationActive || messages.length > 0) ? (
                  <ConversationThread />
                ) : route ? (
                  <div style={{ flex: 1, overflowY: 'auto', padding: '0 14px 14px' }}>
                    {route.stops?.length > 0 && (
                      <div style={{ marginBottom: 10 }}>
                        {route.stops.map((s, i) => (
                          <div key={i} style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>
                            ☕ <strong style={{ color: '#e2e8f0' }}>{s.name}</strong> — {s.address}
                          </div>
                        ))}
                      </div>
                    )}
                    {route.narrative && (
                      <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.65 }}>{route.narrative}</div>
                    )}
                  </div>
                ) : (
                  <div style={{ flex: 1, overflowY: 'auto', padding: '0 14px' }}>
                    {recentRoutes.map((r, i) => (
                      <div key={i} onClick={() => { setQuery(r.query); setSheetState('search'); }}
                        style={{ padding: '10px', borderRadius: 8, marginBottom: 6, background: '#1e293b', cursor: 'pointer' }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>{r.title}</div>
                        <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>⏱ {r.duration} · {r.distance} mi</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
