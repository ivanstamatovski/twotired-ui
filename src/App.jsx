import { useState, useEffect, useRef, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './App.css';

const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const EDGE_URL          = `${SUPABASE_URL}/functions/v1/generate-route`;
const RECENT_KEY        = 'twistyroute_recent';
const MAP_STYLE         = 'https://tiles.openfreemap.org/styles/fiord';
const DEFAULT_CENTER    = [-74.3, 41.4];
const DEFAULT_ZOOM      = 9;

const APPROVAL_WORDS = ['looks good','perfect','great','love it','approve',
  "let's go",'nice','yes','send it','go for it','awesome','nailed it','lets go','do it'];

const REFINE_CHIPS = ['More twisty','Less highway','Add a coffee stop','Different road','Make it shorter'];

function isApproval(t) {
  const s = t.toLowerCase().trim();
  return APPROVAL_WORDS.some(w => s.includes(w));
}

function buildNavUrl(waypoints) {
  if (!waypoints || waypoints.length < 2) return null;
  const o = `${waypoints[0].lat},${waypoints[0].lng}`;
  const d = `${waypoints[waypoints.length-1].lat},${waypoints[waypoints.length-1].lng}`;
  const wps = waypoints.slice(1,-1).map(w=>`${w.lat},${w.lng}`).join('|');
  return `https://www.google.com/maps/dir/?api=1&origin=${o}&destination=${d}${wps?`&waypoints=${wps}`:''}&travelmode=driving`;
}

// ── Voice hook ────────────────────────────────────────────────────────────────
function useVoice(onResult) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const recogRef = useRef(null);

  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    setSupported(true);
    const r = new SR();
    r.continuous = false;
    r.interimResults = false;
    r.lang = 'en-US';
    r.onresult = e => { onResult(e.results[0][0].transcript); setListening(false); };
    r.onerror  = () => setListening(false);
    r.onend    = () => setListening(false);
    recogRef.current = r;
  }, [onResult]);

  const start = useCallback(() => { recogRef.current?.start(); setListening(true);  }, []);
  const stop  = useCallback(() => { recogRef.current?.stop();  setListening(false); }, []);
  return { listening, supported, start, stop };
}

// ── Mobile detect ─────────────────────────────────────────────────────────────
function useIsMobile() {
  const [mobile, setMobile] = useState(window.innerWidth <= 700);
  useEffect(() => {
    const h = () => setMobile(window.innerWidth <= 700);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  return mobile;
}

// ── ConversationThread — module level (never inside App) ──────────────────────
function ConversationThread({ messages, loading, loadingMsg, messagesEndRef }) {
  return (
    <div className="messages-scroll">
      {messages.map((msg, i) => {
        if (msg.role === 'user')
          return <div key={i} className="bubble bubble-user">{msg.content}</div>;

        if (msg.role === 'clarify')
          return (
            <div key={i} className="bubble bubble-clarify">
              <p className="clarify-q">{msg.question}</p>
              {msg.options.map(o => (
                <button key={o} className="clarify-opt"
                  onClick={() => msg.onSelect(o)}>{o}</button>
              ))}
            </div>
          );

        if (msg.role === 'route') {
          const r = msg.route;
          return (
            <div key={i} className="bubble bubble-route">
              <div className="route-title">{r.title}</div>
              <div className="route-meta">
                <span>🕐 {r.duration_str}</span>
                <span>🛣 {r.distance_mi?.toFixed(1)} mi</span>
              </div>
              {r.stops?.map((s,si) => (
                <div key={si} className="stop-pill">
                  📍 {s.name}
                  {s.rating && <span className="stop-rating">{s.rating}★</span>}
                </div>
              ))}
              {r.waypoints && (
                <a className="nav-link" href={buildNavUrl(r.waypoints)} target="_blank" rel="noreferrer">
                  Open in Google Maps →
                </a>
              )}
            </div>
          );
        }
        return null;
      })}

      {loading && (
        <div className="bubble bubble-loading">
          <span className="dot-spin"/> {loadingMsg}
        </div>
      )}
      <div ref={messagesEndRef}/>
    </div>
  );
}
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  // Core state
  const [query, setQuery]               = useState('');
  const [loading, setLoading]           = useState(false);
  const [loadingMsg, setLoadingMsg]     = useState('Planning your ride…');
  const [error, setError]               = useState(null);
  const [messages, setMessages]         = useState([]);
  const [currentIntent, setCurrentIntent] = useState(null);
  const [followUpInput, setFollowUpInput] = useState('');
  const [routeData, setRouteData]       = useState(null);
  const [routeApproved, setRouteApproved] = useState(false);

  // Mobile sheet UI state
  // 'idle' | 'collapsed' | 'expanded'
  const [sheetMode, setSheetMode]       = useState('idle');
  const [refineOpen, setRefineOpen]     = useState(false);
  const [menuOpen, setMenuOpen]         = useState(false);

  // Bug report
  const [bugComment, setBugComment]     = useState('');
  const [bugSubmitting, setBugSubmitting] = useState(false);
  const [bugDone, setBugDone]           = useState(false);

  // Recent
  const [recent, setRecent] = useState(() => {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY)||'[]'); } catch { return []; }
  });

  // Refs
  const mapContainerRef = useRef(null);
  const mapRef          = useRef(null);
  const mapLoadedRef    = useRef(false);
  const pendingRoute    = useRef(null);
  const markersRef      = useRef([]);
  const messagesEnd     = useRef(null);
  const isMobile        = useIsMobile();

  // Voice
  const handleVoiceResult = useCallback((transcript) => {
    setQuery(transcript);
    submitQuery(transcript);
  }, []);
  const voice = useVoice(handleVoiceResult);

  // ── Map init ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLE,
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    map.on('load', () => {
      mapLoadedRef.current = true;
      if (pendingRoute.current) {
        drawRouteOnMap(pendingRoute.current);
        pendingRoute.current = null;
      }
    });

    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; mapLoadedRef.current = false; };
  }, []);

  // ── Draw route on map ─────────────────────────────────────────────────────
  function drawRouteOnMap(route) {
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) { pendingRoute.current = route; return; }

    // Remove old route layer + source
    if (map.getLayer('route-line'))   map.removeLayer('route-line');
    if (map.getLayer('route-casing')) map.removeLayer('route-casing');
    if (map.getSource('route'))       map.removeSource('route');

    // Remove old markers
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];

    if (!route?.geometry) return;

    // Add route as GeoJSON source
    map.addSource('route', {
      type: 'geojson',
      data: { type: 'Feature', geometry: route.geometry },
    });

    // White casing for contrast on dark map
    map.addLayer({
      id: 'route-casing', type: 'line', source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#fff', 'line-width': 6, 'line-opacity': 0.3 },
    });

    // Main route line
    map.addLayer({
      id: 'route-line', type: 'line', source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#4A90FF', 'line-width': 4, 'line-opacity': 0.95 },
    });

    // Stop markers
    route.stops?.forEach(stop => {
      if (!stop.lat || !stop.lng) return;
      const el = document.createElement('div');
      el.className = 'map-stop-marker';

      const popup = new maplibregl.Popup({ offset: 14, closeButton: false })
        .setHTML(`<div class="map-popup"><strong>${stop.name}</strong>${stop.rating ? `<br>⭐ ${stop.rating}` : ''}</div>`);

      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([stop.lng, stop.lat])
        .setPopup(popup)
        .addTo(map);

      markersRef.current.push(marker);
    });

    // Fit bounds
    const coords = route.geometry.coordinates;
    const bounds = coords.reduce(
      (b, c) => b.extend(c),
      new maplibregl.LngLatBounds(coords[0], coords[0])
    );
    const padding = isMobile
      ? { top: 60, right: 20, bottom: 320, left: 20 }
      : { top: 60, right: 60, bottom: 60, left: 60 };
    map.fitBounds(bounds, { padding, duration: 900, maxZoom: 14 });
  }

  // ── Auto scroll thread ────────────────────────────────────────────────────
  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // ── Generate route ────────────────────────────────────────────────────────
  async function generateRoute(payload) {
    setLoading(true);
    setError(null);
    const cycle = ['Planning your ride…','Finding scenic roads…','Checking stops…','Almost there…'];
    let ci = 0; setLoadingMsg(cycle[0]);
    const ticker = setInterval(() => { ci=(ci+1)%cycle.length; setLoadingMsg(cycle[ci]); }, 2500);

    try {
      const res  = await fetch(EDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      clearInterval(ticker);
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      if (data.clarify) {
        setMessages(prev => [...prev, {
          role: 'clarify', question: data.question, options: data.options||[],
          onSelect: (opt) => handleFollowUp(opt),
        }]);
        if (isMobile) setSheetMode('expanded');
        return;
      }

      const r = data.route;
      setRouteData(r);
      setCurrentIntent(r.intent);
      setRouteApproved(false);
      setRefineOpen(false);
      setMessages(prev => [...prev, { role: 'route', route: r }]);
      drawRouteOnMap(r);

      if (isMobile) setSheetMode('collapsed');

      // Save recent
      const entry = { id:Date.now(), title:r.title, distance_mi:r.distance_mi, duration_str:r.duration_str };
      const updated = [entry, ...recent.filter(x=>x.title!==entry.title)].slice(0,5);
      setRecent(updated); localStorage.setItem(RECENT_KEY, JSON.stringify(updated));

    } catch(err) { clearInterval(ticker); setError(err.message); }
    finally { setLoading(false); }
  }

  function submitQuery(q) {
    const text = (q || query).trim();
    if (!text || loading) return;
    setQuery('');
    setMessages([{ role:'user', content:text }]);
    setRouteData(null);
    setRouteApproved(false);
    if (isMobile) setSheetMode('expanded');
    generateRoute({ query: text });
  }

  async function handleFollowUp(text) {
    const t = (text || followUpInput).trim();
    if (!t || loading) return;
    setFollowUpInput('');
    setRefineOpen(false);
    if (isApproval(t)) { setRouteApproved(true); if (isMobile) setSheetMode('collapsed'); return; }
    setMessages(prev => [...prev, { role:'user', content:t }]);
    if (isMobile) setSheetMode('expanded');
    await generateRoute(currentIntent
      ? { refine:true, feedback:t, intent:currentIntent }
      : { query:t }
    );
  }

  async function submitBug() {
    setBugSubmitting(true);
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/rpc/insert_bug_report`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json','apikey':SUPABASE_ANON_KEY,'Authorization':`Bearer ${SUPABASE_ANON_KEY}` },
        body:JSON.stringify({ p_query:messages.find(m=>m.role==='user')?.content||'', p_route_data:routeData||null, p_comment:bugComment, p_screenshot_url:null }),
      });
      setBugDone(true); setBugComment('');
      setTimeout(() => { setMenuOpen(false); setBugDone(false); }, 2000);
    } finally { setBugSubmitting(false); }
  }

  // ── Sheet height by mode ──────────────────────────────────────────────────
  const sheetHeight = { idle:'160px', collapsed:'118px', expanded:'68vh' }[sheetMode] || '160px';

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="app-shell">

      {/* ── Map ── */}
      <div className="map-panel">
        <div ref={mapContainerRef} className="map-canvas"/>
      </div>

      {/* ════════════════════════════════════════
          MOBILE bottom sheet
          ════════════════════════════════════════ */}
      {isMobile ? (
        <div className="sheet" style={{ height: sheetHeight }}>

          {/* Drag handle — always tappable to toggle */}
          <div className="sheet-handle" onClick={() =>
            setSheetMode(m => m === 'expanded' ? (routeData ? 'collapsed' : 'idle') : 'expanded')
          }>
            <div className="sheet-bar"/>
          </div>

          {/* ── IDLE: big mic hero ── */}
          {sheetMode === 'idle' && (
            <div className="sheet-idle">
              {voice.supported ? (
                <button
                  className={`mic-hero${voice.listening?' mic-listening':''}`}
                  onClick={voice.listening ? voice.stop : voice.start}
                  aria-label="Speak your route"
                >
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                    <line x1="12" y1="19" x2="12" y2="23"/>
                    <line x1="8" y1="23" x2="16" y2="23"/>
                  </svg>
                  {voice.listening && <span className="mic-pulse"/>}
                </button>
              ) : null}
              <div className="idle-input-row">
                <input
                  className="query-input"
                  placeholder={voice.listening ? 'Listening…' : 'Where do you want to ride?'}
                  value={query}
                  onChange={e=>setQuery(e.target.value)}
                  onKeyDown={e=>e.key==='Enter'&&submitQuery()}
                  onFocus={()=>setSheetMode('expanded')}
                  disabled={loading||voice.listening}
                />
                <button className="go-btn" onClick={()=>submitQuery()} disabled={loading||!query.trim()}>→</button>
              </div>
              {recent.length > 0 && !voice.listening && (
                <div className="recent-peek">
                  {recent.slice(0,2).map(r=>(
                    <button key={r.id} className="recent-chip" onClick={()=>{ setQuery(r.title); submitQuery(r.title); }}>
                      {r.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── COLLAPSED: route peek ── */}
          {sheetMode === 'collapsed' && routeData && (
            <div className="sheet-collapsed-content">
              <div className="collapsed-info">
                <span className="collapsed-title">{routeData.title}</span>
                <span className="collapsed-meta">{routeData.duration_str} · {routeData.distance_mi?.toFixed(0)} mi</span>
              </div>
              <a className="open-maps-btn" href={buildNavUrl(routeData.waypoints)} target="_blank" rel="noreferrer">
                Navigate →
              </a>
            </div>
          )}

          {/* ── EXPANDED: full conversation ── */}
          {sheetMode === 'expanded' && (
            <div className="sheet-expanded-content">
              {error && <div className="error-banner">⚠️ {error}</div>}

              <ConversationThread
                messages={messages} loading={loading} loadingMsg={loadingMsg}
                messagesEndRef={messagesEnd}
              />

              {/* Input area — always at bottom */}
              <div className="sheet-input-area">

                {/* Refine chips — collapsed by default */}
                {routeData && !routeApproved && refineOpen && (
                  <div className="chips-row">
                    {REFINE_CHIPS.map(c=>(
                      <button key={c} className="chip" onClick={()=>handleFollowUp(c)}>{c}</button>
                    ))}
                    <button className="chip chip-approve" onClick={()=>handleFollowUp('looks good')}>
                      👍 Approve
                    </button>
                  </div>
                )}

                <div className="input-row">
                  {/* Mic (small) */}
                  {voice.supported && (
                    <button
                      className={`mic-small${voice.listening?' mic-listening':''}`}
                      onClick={voice.listening ? voice.stop : voice.start}
                      aria-label="Voice input"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                        <line x1="12" y1="19" x2="12" y2="23"/>
                      </svg>
                    </button>
                  )}

                  {/* Text input */}
                  <input
                    className="followup-input"
                    placeholder={routeData ? 'Refine or approve…' : 'Where do you want to ride?'}
                    value={followUpInput || query}
                    onChange={e => routeData ? setFollowUpInput(e.target.value) : setQuery(e.target.value)}
                    onKeyDown={e => e.key==='Enter' && (routeData ? handleFollowUp() : submitQuery())}
                    disabled={loading}
                  />

                  {/* Refine toggle (only when route exists) */}
                  {routeData && !routeApproved && (
                    <button
                      className={`refine-btn${refineOpen?' active':''}`}
                      onClick={()=>setRefineOpen(x=>!x)}
                      aria-label="Refine options"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/>
                      </svg>
                    </button>
                  )}

                  {/* Send */}
                  <button className="send-btn"
                    onClick={()=> routeData ? handleFollowUp() : submitQuery()}
                    disabled={loading || (routeData ? !followUpInput.trim() : !query.trim())}
                  >↑</button>

                  {/* ⋯ menu */}
                  <button className="menu-btn" onClick={()=>setMenuOpen(x=>!x)} aria-label="More options">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>
                    </svg>
                  </button>
                </div>

                {/* ⋯ menu contents */}
                {menuOpen && (
                  <div className="overflow-menu">
                    {recent.length > 0 && (
                      <>
                        <div className="menu-section-label">Recent rides</div>
                        {recent.slice(0,3).map(r=>(
                          <button key={r.id} className="menu-item" onClick={()=>{
                            setMenuOpen(false); setQuery(r.title); submitQuery(r.title);
                          }}>
                            {r.title}
                            <span className="menu-item-meta">{r.distance_mi?.toFixed(0)} mi</span>
                          </button>
                        ))}
                        <div className="menu-divider"/>
                      </>
                    )}
                    <div className="menu-section-label">Report an issue</div>
                    <textarea className="bug-textarea" placeholder="What went wrong?"
                      value={bugComment} onChange={e=>setBugComment(e.target.value)}/>
                    {bugDone
                      ? <p className="bug-done">Thanks! Reported.</p>
                      : <button className="menu-submit" onClick={submitBug} disabled={bugSubmitting||!bugComment.trim()}>
                          {bugSubmitting?'Sending…':'Submit report'}
                        </button>
                    }
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

      ) : (
        /* ════════════════════════════════════════
           DESKTOP sidebar
           ════════════════════════════════════════ */
        <div className="sidebar">
          <div className="brand">
            <span className="brand-name">🏍 TwoTired</span>
          </div>

          <div className="query-row">
            <input className="query-input"
              placeholder="Where do you want to ride?"
              value={query} onChange={e=>setQuery(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&submitQuery()} disabled={loading}
            />
            {voice.supported && (
              <button className={`mic-desktop${voice.listening?' mic-listening':''}`}
                onClick={voice.listening?voice.stop:voice.start} aria-label="Voice">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                  <line x1="12" y1="19" x2="12" y2="23"/>
                </svg>
              </button>
            )}
            <button className="go-btn" onClick={()=>submitQuery()} disabled={loading||!query.trim()}>→</button>
          </div>

          {error && <div className="error-banner">⚠️ {error}</div>}

          <div className="sidebar-scroll">
            {messages.length > 0 ? (
              <>
                <ConversationThread messages={messages} loading={loading}
                  loadingMsg={loadingMsg} messagesEndRef={messagesEnd}/>

                {routeData && !routeApproved && (
                  <div className="desktop-followup">
                    <div className="chips-row">
                      {REFINE_CHIPS.map(c=>(
                        <button key={c} className="chip" onClick={()=>handleFollowUp(c)}>{c}</button>
                      ))}
                    </div>
                    <div className="input-row">
                      <input className="followup-input"
                        placeholder="Refine or approve…"
                        value={followUpInput}
                        onChange={e=>setFollowUpInput(e.target.value)}
                        onKeyDown={e=>e.key==='Enter'&&handleFollowUp()}
                      />
                      <button className="send-btn" onClick={()=>handleFollowUp()}
                        disabled={!followUpInput.trim()}>↑</button>
                    </div>
                  </div>
                )}

                {routeApproved && <div className="approved-banner">✅ Route approved — ride safe!</div>}
              </>
            ) : (
              <div className="empty-state">
                {recent.length > 0 ? (
                  <>
                    <div className="recent-label">Recent rides</div>
                    {recent.map(r=>(
                      <div key={r.id} className="recent-item" onClick={()=>{ setQuery(r.title); submitQuery(r.title); }}>
                        <span className="recent-title">{r.title}</span>
                        <span className="recent-meta">{r.distance_mi?.toFixed(0)} mi · {r.duration_str}</span>
                      </div>
                    ))}
                  </>
                ) : (
                  <div className="hints">
                    <p>Try: <em>"Take me to Hawks Nest with coffee in Newburgh"</em></p>
                    <p>Or: <em>"Bear Mountain loop, as twisty as possible"</em></p>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="sidebar-bug">
            <button className="bug-trigger"
              onClick={()=>setMenuOpen(x=>!x)}>🐛 Report issue</button>
            {menuOpen && (
              <div className="bug-inline">
                <textarea className="bug-textarea" placeholder="What went wrong?"
                  value={bugComment} onChange={e=>setBugComment(e.target.value)}/>
                {bugDone
                  ? <p className="bug-done">Thanks!</p>
                  : <button className="menu-submit" onClick={submitBug}
                      disabled={bugSubmitting||!bugComment.trim()}>
                      {bugSubmitting?'Sending…':'Submit'}
                    </button>
                }
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
