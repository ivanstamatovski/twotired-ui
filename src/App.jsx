import { useState, useEffect, useRef } from 'react';
import './App.css';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const EDGE_URL = `${SUPABASE_URL}/functions/v1/generate-route`;
const RECENT_KEY = 'twistyroute_recent';
const DEFAULT_CENTER = { lat: 41.4, lng: -74.3 };
const DEFAULT_ZOOM = 9;

const APPROVAL_WORDS = [
  'looks good','perfect','great','love it','approve',"let's go",
  'nice','yes','send it','go for it','awesome','nailed it','lets go','do it',
];
const QUICK_CHIPS = ['👍 Looks great','More twisty','Add a coffee stop','Different road'];

function isApproval(t) {
  const s = t.toLowerCase().trim();
  return APPROVAL_WORDS.some(w => s.includes(w));
}

function buildNavUrl(waypoints) {
  if (!waypoints?.length < 2) return null;
  const o = `${waypoints[0].lat},${waypoints[0].lng}`;
  const d = `${waypoints[waypoints.length-1].lat},${waypoints[waypoints.length-1].lng}`;
  const wps = waypoints.slice(1,-1).map(w=>`${w.lat},${w.lng}`).join('|');
  return `https://www.google.com/maps/dir/?api=1&origin=${o}&destination=${d}${wps?`&waypoints=${wps}`:''}&travelmode=driving`;
}

// ── Module-level component ────────────────────────────────────────────────────
function ConversationThread({
  messages, loading, loadingMsg, conversationActive, routeApproved,
  followUpInput, setFollowUpInput, onFollowUp, onChipClick,
  bugMode, setBugMode, bugComment, setBugComment,
  bugSubmitting, bugDone, bugError, onSubmitBug, messagesEndRef,
}) {
  return (
    <div className="conversation-wrap">
      <div className="messages-scroll">
        {messages.map((msg, i) => {
          if (msg.role === 'user')
            return <div key={i} className="bubble bubble-user">{msg.content}</div>;

          if (msg.role === 'clarify')
            return (
              <div key={i} className="bubble bubble-clarify">
                <p className="clarify-question">{msg.question}</p>
                <div className="clarify-options">
                  {msg.options.map(o => (
                    <button key={o} className="clarify-opt" onClick={()=>onChipClick(o)}>{o}</button>
                  ))}
                </div>
              </div>
            );

          if (msg.role === 'route') {
            const r = msg.route;
            return (
              <div key={i} className="bubble bubble-route">
                <div className="route-card-title">{r.title}</div>
                <div className="route-card-meta">
                  <span>🕐 {r.duration_str}</span>
                  <span>🛣 {r.distance_mi?.toFixed(1)} mi</span>
                </div>
                {r.stops?.length > 0 && (
                  <div className="route-stops">
                    {r.stops.map((s,si) => (
                      <div key={si} className="stop-pill">
                        📍 {s.name}
                        {s.address && <span className="stop-address">{s.address}</span>}
                        {s.rating  && <span className="stop-rating">{s.rating}★</span>}
                      </div>
                    ))}
                  </div>
                )}
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

      {conversationActive && !routeApproved && (
        <div className="followup-area">
          <div className="chips-row">
            {QUICK_CHIPS.map(c => (
              <button key={c} className="chip" onClick={()=>onChipClick(c)}>{c}</button>
            ))}
          </div>
          <div className="followup-input-row">
            <input
              className="followup-input"
              placeholder="Suggest changes or approve…"
              value={followUpInput}
              onChange={e=>setFollowUpInput(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&onFollowUp()}
            />
            <button className="send-btn" onClick={onFollowUp} disabled={!followUpInput.trim()}>↑</button>
          </div>
        </div>
      )}

      {routeApproved && <div className="approved-banner">✅ Route approved — ride safe!</div>}

      {conversationActive && (
        <div className="bug-area">
          {!bugMode
            ? <button className="bug-trigger" onClick={()=>setBugMode(true)}>🐛 Report an issue</button>
            : (
              <div className="bug-form">
                <textarea className="bug-textarea" placeholder="Describe what went wrong…"
                  value={bugComment} onChange={e=>setBugComment(e.target.value)}/>
                <div className="bug-actions">
                  <button className="bug-cancel" onClick={()=>setBugMode(false)}>Cancel</button>
                  <button className="bug-submit" onClick={onSubmitBug} disabled={bugSubmitting}>
                    {bugSubmitting?'Sending…':'Submit'}
                  </button>
                </div>
                {bugDone  && <p className="bug-done">Thanks! Bug reported.</p>}
                {bugError && <p className="bug-error">{bugError}</p>}
              </div>
            )
          }
        </div>
      )}
    </div>
  );
}
// ─────────────────────────────────────────────────────────────────────────────

function useMapsLoaded() {
  const [loaded, setLoaded] = useState(!!window.google?.maps?.Map);
  useEffect(() => {
    if (window.google?.maps?.Map) return;
    const iv = setInterval(() => {
      if (window.google?.maps?.Map) { setLoaded(true); clearInterval(iv); }
    }, 100);
    return () => clearInterval(iv);
  }, []);
  return loaded;
}

function useIsMobile() {
  const [mobile, setMobile] = useState(window.innerWidth <= 700);
  useEffect(() => {
    const h = () => setMobile(window.innerWidth <= 700);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  return mobile;
}

export default function App() {
  const [query, setQuery]                   = useState('');
  const [loading, setLoading]               = useState(false);
  const [loadingMsg, setLoadingMsg]         = useState('Planning your ride…');
  const [route, setRoute]                   = useState(null);
  const [error, setError]                   = useState(null);
  const [messages, setMessages]             = useState([]);
  const [currentIntent, setCurrentIntent]   = useState(null);
  const [followUpInput, setFollowUpInput]   = useState('');
  const [conversationActive, setConvActive] = useState(false);
  const [routeApproved, setRouteApproved]   = useState(false);
  const [sheetExpanded, setSheetExpanded]   = useState(false);
  const [bugMode, setBugMode]               = useState(false);
  const [bugComment, setBugComment]         = useState('');
  const [bugSubmitting, setBugSubmitting]   = useState(false);
  const [bugDone, setBugDone]               = useState(false);
  const [bugError, setBugError]             = useState(null);
  const [recent, setRecent] = useState(() => {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY)||'[]'); } catch { return []; }
  });

  const mapRef        = useRef(null);
  const mapInstance   = useRef(null);
  const polylineRef   = useRef(null);
  const markersRef    = useRef([]);
  const messagesEnd   = useRef(null);
  const mapsLoaded    = useMapsLoaded();
  const isMobile      = useIsMobile();

  // Init map on load
  useEffect(() => {
    if (!mapsLoaded || !mapRef.current || mapInstance.current) return;
    try {
      mapInstance.current = new window.google.maps.Map(mapRef.current, {
        zoom: DEFAULT_ZOOM,
        center: DEFAULT_CENTER,
        mapTypeId: 'roadmap',
        disableDefaultUI: true,
        zoomControl: !isMobile,
        gestureHandling: 'greedy',
      });
    } catch(e) { console.error('Map init failed', e); }
  }, [mapsLoaded]);

  // Scroll thread
  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior:'smooth' });
  }, [messages, loading]);

  // Auto-expand sheet on mobile when conversation starts
  useEffect(() => {
    if (isMobile && conversationActive) setSheetExpanded(true);
  }, [conversationActive, isMobile]);

  // Draw route + markers
  useEffect(() => {
    if (!mapInstance.current || !route?.geometry) return;

    if (polylineRef.current) polylineRef.current.setMap(null);
    markersRef.current.forEach(m => m.setMap(null));
    markersRef.current = [];

    const coords = route.geometry.coordinates.map(([lng,lat]) => ({lat,lng}));
    polylineRef.current = new window.google.maps.Polyline({
      path: coords, geodesic: true,
      strokeColor: '#4A90FF', strokeOpacity: 0.9, strokeWeight: 4,
    });
    polylineRef.current.setMap(mapInstance.current);

    if (route.stops?.length) {
      route.stops.forEach(stop => {
        if (!stop.lat || !stop.lng) return;
        const marker = new window.google.maps.Marker({
          position: { lat: stop.lat, lng: stop.lng },
          map: mapInstance.current,
          title: stop.name,
          icon: {
            path: window.google.maps.SymbolPath.CIRCLE,
            scale: 9, fillColor: '#FF6B35', fillOpacity: 1,
            strokeColor: '#fff', strokeWeight: 2,
          },
        });
        const info = new window.google.maps.InfoWindow({
          content: `<div style="font-size:13px;line-height:1.4"><strong>${stop.name}</strong>${stop.address?`<br><span style="color:#666">${stop.address}</span>`:''}${stop.rating?`<br>⭐ ${stop.rating}`:''}</div>`,
        });
        marker.addListener('click', () => info.open(mapInstance.current, marker));
        markersRef.current.push(marker);
      });
    }

    const bounds = new window.google.maps.LatLngBounds();
    coords.forEach(c => bounds.extend(c));
    markersRef.current.forEach(m => bounds.extend(m.getPosition()));
    // On mobile, pad bottom so sheet doesn't cover the route
    const padding = isMobile ? { top:40, right:20, bottom:280, left:20 } : { top:40, right:40, bottom:40, left:40 };
    mapInstance.current.fitBounds(bounds, padding);
  }, [route, isMobile]);

  async function generateRoute(payload) {
    setLoading(true);
    setError(null);
    const msgs = ['Planning your ride…','Finding scenic roads…','Checking stops…','Almost there…'];
    let mi = 0;
    setLoadingMsg(msgs[0]);
    const ticker = setInterval(() => { mi=(mi+1)%msgs.length; setLoadingMsg(msgs[mi]); }, 2500);

    try {
      const res = await fetch(EDGE_URL, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      clearInterval(ticker);
      if (!res.ok) throw new Error(data.error||`HTTP ${res.status}`);

      if (data.clarify) {
        setMessages(prev=>[...prev,{ role:'clarify', question:data.question, options:data.options||[] }]);
        setConvActive(true);
        return;
      }

      const r = data.route;
      setRoute(r);
      setCurrentIntent(r.intent);
      setConvActive(true);
      setRouteApproved(false);
      setMessages(prev=>[...prev,{ role:'route', route:r }]);

      const entry = { id:Date.now(), title:r.title, distance_mi:r.distance_mi, duration_str:r.duration_str };
      const updated = [entry,...recent.filter(x=>x.title!==entry.title)].slice(0,5);
      setRecent(updated);
      localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
    } catch(err) {
      clearInterval(ticker);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit() {
    const q = query.trim();
    if (!q||loading) return;
    setQuery('');
    setMessages([{ role:'user', content:q }]);
    setConvActive(false);
    setRouteApproved(false);
    setRoute(null);
    await generateRoute({ query:q });
  }

  async function handleFollowUp(text) {
    const t = (text||followUpInput).trim();
    if (!t||loading) return;
    setFollowUpInput('');
    if (isApproval(t)) { handleApprove(); return; }
    setMessages(prev=>[...prev,{ role:'user', content:t }]);
    await generateRoute(currentIntent
      ? { refine:true, feedback:t, intent:currentIntent }
      : { query:t }
    );
  }

  function handleChipClick(chip) {
    if (chip==='👍 Looks great') { handleApprove(); return; }
    handleFollowUp(chip);
  }

  function handleApprove() { setRouteApproved(true); setConvActive(false); }

  async function handleSubmitBug() {
    if (bugSubmitting) return;
    setBugSubmitting(true); setBugError(null);
    try {
      const lastRoute = messages.findLast?.(m=>m.role==='route')?.route||route;
      await fetch(`${SUPABASE_URL}/rest/v1/rpc/insert_bug_report`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'apikey':SUPABASE_ANON_KEY, 'Authorization':`Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify({ p_query:messages.find(m=>m.role==='user')?.content||'', p_route_data:lastRoute||null, p_comment:bugComment, p_screenshot_url:null }),
      });
      setBugDone(true); setBugComment('');
      setTimeout(() => { setBugMode(false); setBugDone(false); }, 2500);
    } catch { setBugError('Failed to submit — try again.'); }
    finally { setBugSubmitting(false); }
  }

  const sheetClass = `left-panel${isMobile ? (sheetExpanded?' sheet-expanded':' sheet-collapsed') : ''}`;

  return (
    <div className="app-shell">
      {/* Map — always rendered fullscreen on mobile, side panel on desktop */}
      <div className="map-panel">
        <div ref={mapRef} className="map-canvas"/>
      </div>

      {/* Left panel / bottom sheet */}
      <div className={sheetClass}>

        {/* Mobile drag handle */}
        {isMobile && (
          <div className="sheet-handle" onClick={()=>setSheetExpanded(x=>!x)}>
            <div className="sheet-handle-bar"/>
          </div>
        )}

        <div className="brand">
          <span className="brand-icon">🏍</span>
          <span className="brand-name">TwoTired</span>
        </div>

        <div className="query-row">
          <input
            className="query-input"
            placeholder="Where do you want to ride?"
            value={query}
            onChange={e=>setQuery(e.target.value)}
            onKeyDown={e=>e.key==='Enter'&&handleSubmit()}
            disabled={loading}
          />
          <button className="go-btn" onClick={handleSubmit} disabled={loading||!query.trim()}>→</button>
        </div>

        {error && <div className="error-banner">⚠️ {error}</div>}

        {messages.length > 0 ? (
          <ConversationThread
            messages={messages} loading={loading} loadingMsg={loadingMsg}
            conversationActive={conversationActive} routeApproved={routeApproved}
            followUpInput={followUpInput} setFollowUpInput={setFollowUpInput}
            onFollowUp={handleFollowUp} onChipClick={handleChipClick}
            bugMode={bugMode} setBugMode={setBugMode}
            bugComment={bugComment} setBugComment={setBugComment}
            bugSubmitting={bugSubmitting} bugDone={bugDone} bugError={bugError}
            onSubmitBug={handleSubmitBug} messagesEndRef={messagesEnd}
          />
        ) : (
          <div className="recent-section">
            {recent.length > 0 ? (
              <>
                <div className="recent-label">Recent rides</div>
                {recent.map(r=>(
                  <div key={r.id} className="recent-item" onClick={()=>setQuery(r.title)}>
                    <span className="recent-title">{r.title}</span>
                    <span className="recent-meta">{r.distance_mi?.toFixed(0)} mi · {r.duration_str}</span>
                  </div>
                ))}
              </>
            ) : (
              <div className="empty-hint">
                <p>Try: <em>"Take me to Hawks Nest with coffee in Newburgh"</em></p>
                <p>Or: <em>"Bear Mountain loop, as twisty as possible"</em></p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
