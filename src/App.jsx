import { useState, useEffect, useRef, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Capacitor } from '@capacitor/core';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './App.css';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const EDGE_URL = `${SUPABASE_URL}/functions/v1/generate-route`;
const RECENT_KEY = 'twistyroute_recent';
const LAST_ROUTE_KEY = 'twistyroute_last';
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const DEFAULT_CENTER = [-74.3, 41.4];
const DEFAULT_ZOOM = 9;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const APPROVAL_WORDS = ['looks good','perfect','great','love it','approve',
  "let's go",'nice','send it','go for it','awesome','nailed it','lets go','do it'];

const REFINE_CHIPS = ['More twisty','Less highway','Add a coffee stop','Different road','Make it shorter'];

// ── Helpers ───────────────────────────────────────────────────────────────────
function isApproval(t) {
  return APPROVAL_WORDS.some(w => t.toLowerCase().trim().includes(w));
}

function buildNavUrl(waypoints) {
  if (!waypoints || waypoints.length < 2) return null;
  const o = `${waypoints[0].lat},${waypoints[0].lng}`;
  const d = `${waypoints[waypoints.length-1].lat},${waypoints[waypoints.length-1].lng}`;
  const wps = waypoints.slice(1,-1).map(w=>`${w.lat},${w.lng}`).join('|');
  return `https://www.google.com/maps/dir/?api=1&origin=${o}&destination=${d}${wps?`&waypoints=${wps}`:''}&travelmode=driving`;
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6_371_000;
  const toR = (d) => d * Math.PI / 180;
  const dLat = toR(lat2 - lat1), dLng = toR(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distSq(lat1, lng1, lat2, lng2) {
  const dlat = lat1 - lat2;
  const dlng = (lng1 - lng2) * Math.cos(lat1 * Math.PI / 180);
  return dlat*dlat + dlng*dlng;
}

function formatDist(m) {
  if (m === null || m === undefined) return '';
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}

function formatMilesShort(m) {
  const mi = m / 1609.34;
  return mi >= 10 ? `${Math.round(mi)} mi` : `${mi.toFixed(1)} mi`;
}

function formatRemainingTime(ms) {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return `${h}h ${m}min`;
}

function formatETA(ms) {
  const eta = new Date(Date.now() + ms);
  return eta.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function turnArrow(sign) {
  const map = { '-7':'↰','-3':'↰','-2':'←','-1':'↖','0':'↑','1':'↗','2':'→','3':'↱','4':'🏁','5':'⟳','6':'⟲' };
  return map[String(sign)] ?? '↑';
}

// Find the index along route.geometry.coordinates closest to (lat,lng).
function nearestRouteIdx(coords, lat, lng) {
  let nearIdx = 0, bestSq = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const sq = distSq(lat, lng, coords[i][1], coords[i][0]);
    if (sq < bestSq) { bestSq = sq; nearIdx = i; }
  }
  return nearIdx;
}

// Bearing of the route AT the user's nearest point, sampled ~30m ahead so the
// map orients to the upcoming road segment rather than wobbling on tight
// vertices. Used when GPS heading is unreliable (stopped, walking, indoors).
function routeBearingAt(route, lat, lng) {
  const coords = route?.geometry?.coordinates;
  if (!coords || coords.length < 2) return null;
  const nearIdx = nearestRouteIdx(coords, lat, lng);
  let aheadIdx = nearIdx;
  for (let i = nearIdx + 1; i < coords.length; i++) {
    if (haversineM(coords[nearIdx][1], coords[nearIdx][0], coords[i][1], coords[i][0]) >= 30) {
      aheadIdx = i; break;
    }
  }
  if (aheadIdx === nearIdx) aheadIdx = Math.min(nearIdx + 1, coords.length - 1);
  if (aheadIdx === nearIdx) return null;
  return bearingBetween(
    coords[nearIdx][1],  coords[nearIdx][0],
    coords[aheadIdx][1], coords[aheadIdx][0]
  );
}

// Remaining time + distance from (lat,lng) to the end of the route.
//   distM:   sum of haversine segment lengths from user → next vertex → end
//   timeMs:  sum of GraphHopper instruction times whose interval lies ahead,
//            with the in-progress instruction prorated by how far along it the user is
function routeProgress(route, lat, lng) {
  const coords = route?.geometry?.coordinates;
  const instructions = route?.instructions;
  if (!coords || coords.length < 2 || !instructions?.length) return null;

  const nearIdx = nearestRouteIdx(coords, lat, lng);

  let distM = haversineM(lat, lng, coords[nearIdx][1], coords[nearIdx][0]);
  for (let i = nearIdx; i < coords.length - 1; i++) {
    distM += haversineM(coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0]);
  }

  let timeMs = 0;
  for (const inst of instructions) {
    const [start, end] = inst.interval || [0, 0];
    if (end < nearIdx) continue;                           // already passed
    if (start <= nearIdx && end >= nearIdx) {              // currently traversing
      const total = Math.max(1, end - start);
      const passed = Math.max(0, nearIdx - start);
      const remaining = (total - passed) / total;
      timeMs += (inst.time || 0) * Math.max(0, Math.min(1, remaining));
    } else {
      timeMs += inst.time || 0;
    }
  }

  return { distM, timeMs };
}

function findNextTurn(route, lat, lng) {
  const coords = route.geometry?.coordinates;
  const instructions = route.instructions;
  if (!coords?.length || !instructions?.length) return null;
  const nearIdx = nearestRouteIdx(coords, lat, lng);
  for (let i = 0; i < instructions.length; i++) {
    const [start, end] = instructions[i].interval;
    if (nearIdx >= start && nearIdx <= end) {
      const turnCoord = coords[Math.min(end, coords.length - 1)];
      const dist = haversineM(lat, lng, turnCoord[1], turnCoord[0]);
      return { instruction: instructions[i], dist };
    }
  }
  return null;
}

// Motorcycle front-view SVG for user location marker
// Initial-bearing helper — degrees from north (0–360) along great-circle path.
function bearingBetween(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const dλ = toRad(lng2 - lng1);
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Pick the highest-quality available SpeechSynthesis voice. iOS exposes premium /
// enhanced / neural variants when the user has downloaded them via Accessibility.
let _pickedVoice = null;
function pickBestVoice() {
  if (_pickedVoice) return _pickedVoice;
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  if (!synth) return null;
  const all = synth.getVoices();
  if (!all.length) return null;
  const en = all.filter(v => /^en/i.test(v.lang));
  const pool = en.length ? en : all;
  const score = v => {
    const n = v.name || '';
    let s = 0;
    if (/premium/i.test(n))  s += 12;
    if (/enhanced/i.test(n)) s += 8;
    if (/neural/i.test(n))   s += 8;
    if (/siri/i.test(n))     s += 6;
    const bare = n.replace(/\s*\(.*\)/, '').trim();
    if (/^(samantha|ava|allison|joelle|nicky|karen|moira|evan|aaron)$/i.test(bare)) s += 2;
    if (/^en-US/i.test(v.lang)) s += 1;
    if (v.localService) s += 1;
    return s;
  };
  pool.sort((a, b) => score(b) - score(a));
  _pickedVoice = pool[0];
  return _pickedVoice;
}

function makeMotoMarkerEl() {
  const el = document.createElement('div');
  el.className = 'user-moto-marker';
  el.innerHTML = `<svg width="44" height="44" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">
    <!-- Pulse ring -->
    <circle cx="22" cy="22" r="20" fill="rgba(249,115,22,0.12)" stroke="rgba(249,115,22,0.35)" stroke-width="1.5"/>
    <!-- Handlebars -->
    <line x1="4" y1="18" x2="16" y2="18" stroke="#1f2937" stroke-width="3" stroke-linecap="round"/>
    <line x1="28" y1="18" x2="40" y2="18" stroke="#1f2937" stroke-width="3" stroke-linecap="round"/>
    <!-- Grips -->
    <rect x="3" y="15.5" width="5" height="5" rx="2.5" fill="#374151"/>
    <rect x="36" y="15.5" width="5" height="5" rx="2.5" fill="#374151"/>
    <!-- Handlebar risers -->
    <line x1="16" y1="18" x2="16" y2="21" stroke="#1f2937" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="28" y1="18" x2="28" y2="21" stroke="#1f2937" stroke-width="2.5" stroke-linecap="round"/>
    <!-- Fairing body -->
    <path d="M15 21 Q15 13 22 12 Q29 13 29 21 L28 26 Q22 28 16 26 Z" fill="#f97316"/>
    <!-- Headlight -->
    <ellipse cx="22" cy="17" rx="4.5" ry="3.5" fill="#fef9c3" opacity="0.95"/>
    <ellipse cx="22" cy="17" rx="2.5" ry="2" fill="#fef08a"/>
    <!-- Front forks -->
    <line x1="17" y1="26" x2="16" y2="34" stroke="#6b7280" stroke-width="2" stroke-linecap="round"/>
    <line x1="27" y1="26" x2="28" y2="34" stroke="#6b7280" stroke-width="2" stroke-linecap="round"/>
    <!-- Front wheel -->
    <ellipse cx="22" cy="35" rx="8" ry="5" fill="#1f2937"/>
    <ellipse cx="22" cy="35" rx="4.5" ry="2.5" fill="#374151"/>
    <circle cx="22" cy="35" r="1.5" fill="#6b7280"/>
  </svg>`;
  return el;
}

// ── Get current GPS position (Promise wrapper — always resolves, never throws) ─
function getCurrentGPS({ timeout = 6000, maximumAge = 30000 } = {}) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge }
    );
  });
}

// ── Voice hook ────────────────────────────────────────────────────────────────
// Two paths:
//   • Native (Capacitor iOS): @capacitor-community/speech-recognition plugin.
//     Loaded via dynamic import + try/catch so this file still compiles before
//     the plugin is npm-installed; native path just stays disabled until then.
//   • Web: window.(webkit)SpeechRecognition with interim results + error logging.
function useVoice(onResult) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const [error, setError]         = useState(null);
  const [transcript, setTranscript] = useState('');

  const isNative = Capacitor.isNativePlatform();
  const pluginRef    = useRef(null);   // native plugin module (when loaded)
  const recogRef     = useRef(null);   // web SpeechRecognition instance
  const latestRef    = useRef('');     // last transcript heard (native)
  const firedRef     = useRef(false);  // dedupe onResult per session (native)
  const onResultRef  = useRef(onResult);
  useEffect(() => { onResultRef.current = onResult; }, [onResult]);

  useEffect(() => {
    let cancelled = false;
    const cleanups = [];

    async function setupNative() {
      try {
        const mod = await import('@capacitor-community/speech-recognition');
        const SR = mod.SpeechRecognition;
        const avail = await SR.available();
        if (cancelled) return;
        if (!avail?.available) { setSupported(false); return; }
        pluginRef.current = SR;
        setSupported(true);

        const partialL = await SR.addListener('partialResults', (data) => {
          const text = data?.matches?.[0];
          if (text) { latestRef.current = text; setTranscript(text); }
        });
        const stateL = await SR.addListener('listeningState', (data) => {
          if (data?.status === 'stopped') {
            setListening(false);
            const final = latestRef.current.trim();
            if (final && !firedRef.current) {
              firedRef.current = true;
              onResultRef.current?.(final);
            }
          }
        });
        cleanups.push(() => partialL?.remove?.(), () => stateL?.remove?.());
      } catch (e) {
        console.warn('[voice] native plugin unavailable:', e?.message || e);
        setSupported(false);
      }
    }

    function setupWeb() {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { setSupported(false); return; }
      const r = new SR();
      r.continuous = false;
      r.interimResults = true;
      r.lang = 'en-US';
      r.onstart  = () => { setError(null); };
      r.onresult = (e) => {
        let finalText = '', interimText = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          if (res.isFinal) finalText += res[0].transcript;
          else interimText += res[0].transcript;
        }
        if (finalText) {
          setTranscript(finalText);
          setListening(false);
          onResultRef.current?.(finalText.trim());
        } else if (interimText) {
          setTranscript(interimText);
        }
      };
      r.onerror = (e) => {
        const code = e?.error || 'unknown';
        console.warn('[voice] recognition error:', code, e);
        setError(code === 'not-allowed' ? 'Microphone permission denied'
              : code === 'no-speech'    ? 'Didn’t catch that — try again'
              : code === 'network'      ? 'Network error — voice needs internet'
              : `Voice error: ${code}`);
        setListening(false);
      };
      r.onend = () => setListening(false);
      recogRef.current = r;
      setSupported(true);
    }

    if (isNative) setupNative(); else setupWeb();

    return () => {
      cancelled = true;
      cleanups.forEach(fn => { try { fn(); } catch {} });
      try { recogRef.current?.abort?.(); } catch {}
      try { pluginRef.current?.stop?.(); } catch {}
    };
  }, [isNative]);

  const start = useCallback(async () => {
    setError(null);
    setTranscript('');
    latestRef.current = '';
    firedRef.current  = false;
    if (isNative) {
      const SR = pluginRef.current;
      if (!SR) { setError('Voice plugin not installed'); return; }
      try {
        const perm = await SR.requestPermissions();
        const state = perm?.speechRecognition || perm?.permission;
        if (state && state !== 'granted') {
          setError('Microphone permission denied');
          return;
        }
        await SR.start({ language: 'en-US', partialResults: true, popup: false });
        setListening(true);
      } catch (e) {
        console.warn('[voice] native start failed:', e);
        setError(e?.message || 'Could not start voice');
        setListening(false);
      }
    } else {
      try {
        recogRef.current?.start();
        setListening(true);
      } catch (e) {
        // Calling start() while already started throws InvalidStateError
        console.warn('[voice] web start failed:', e);
        setError(e?.message || 'Could not start voice');
      }
    }
  }, [isNative]);

  const stop = useCallback(async () => {
    if (isNative) {
      try { await pluginRef.current?.stop(); }
      catch (e) { console.warn('[voice] native stop failed:', e); }
      // Fallback: fire onResult here in case listeningState event doesn't arrive
      const final = latestRef.current.trim();
      if (final && !firedRef.current) {
        firedRef.current = true;
        onResultRef.current?.(final);
      }
    } else {
      try { recogRef.current?.stop(); } catch {}
    }
    setListening(false);
  }, [isNative]);

  return { listening, supported, error, transcript, start, stop };
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

// ── Login screen ──────────────────────────────────────────────────────────────
function LoginScreen() {
  const [email, setEmail]   = useState('');
  const [code, setCode]     = useState('');
  const [step, setStep]     = useState('email'); // 'email' | 'code'
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState(null);

  async function sendOtp() {
    if (!email.includes('@')) return;
    setLoading(true); setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    if (err) { setError(err.message); setLoading(false); return; }
    setStep('code'); setLoading(false);
  }

  async function verifyOtp() {
    const token = code.trim();
    if (token.length !== 6) return;
    setLoading(true); setError(null);
    const { error: err } = await supabase.auth.verifyOtp({
      email, token, type: 'email',
    });
    if (err) { setError(err.message); setLoading(false); return; }
    // Session is set automatically — auth state listener in App will pick it up
    setLoading(false);
  }

  if (step === 'code') return (
    <div className="login-shell">
      <div className="login-card">
        <div className="login-logo">🏍</div>
        <h2 className="login-title">Enter your code</h2>
        <p className="login-sub">We sent a 6-digit code to <strong>{email}</strong>.</p>
        <input className="login-input login-input--code"
          type="number" inputMode="numeric" placeholder="000000"
          value={code} onChange={e => setCode(e.target.value.slice(0, 6))}
          onKeyDown={e => e.key === 'Enter' && verifyOtp()} autoFocus/>
        {error && <p className="login-error">{error}</p>}
        <button className="login-btn" onClick={verifyOtp}
          disabled={loading || code.trim().length !== 6}>
          {loading ? 'Verifying…' : 'Sign in →'}
        </button>
        <button className="login-btn-secondary" onClick={() => { setStep('email'); setCode(''); setError(null); }}>
          Use a different email
        </button>
      </div>
    </div>
  );

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="login-logo">🏍</div>
        <h1 className="login-brand">TwoTired</h1>
        <p className="login-tagline">Your AI motorcycle ride planner</p>
        <input className="login-input" type="email" placeholder="Enter your email"
          value={email} onChange={e => setEmail(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && sendOtp()} autoFocus/>
        {error && <p className="login-error">{error}</p>}
        <button className="login-btn" onClick={sendOtp}
          disabled={loading || !email.includes('@')}>
          {loading ? 'Sending…' : 'Continue →'}
        </button>
        <p className="login-hint">No password needed — we'll send you a code.</p>
      </div>
    </div>
  );
}

// ── ConversationThread ────────────────────────────────────────────────────────
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
                <button key={o} className="clarify-opt" onClick={() => msg.onSelect(o)}>{o}</button>
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
  // Auth
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);

  // Core
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('Planning your ride…');
  const [error, setError] = useState(null);
  const [messages, setMessages] = useState([]);
  const [currentIntent, setCurrentIntent] = useState(null);
  const [followUpInput, setFollowUpInput] = useState('');
  const [routeData, setRouteData] = useState(null);
  const [routeApproved, setRouteApproved] = useState(false);

  // Mobile sheet
  const [sheetMode, setSheetMode] = useState('idle');
  const [refineOpen, setRefineOpen] = useState(false);
  const [idleSheetHeight, setIdleSheetHeight] = useState(220); // grows with multi-line input and the recents drawer
  const [recentsOpen, setRecentsOpen] = useState(false);
  const idleInputRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // Navigation
  const [navMode, setNavMode] = useState(false);
  const [nextTurn, setNextTurn] = useState(null);
  const [navProgress, setNavProgress] = useState(null);   // { distM, timeMs }
  const [userLocation, setUserLocation] = useState(null);
  const [voiceMuted, setVoiceMuted] = useState(() => {
    try { return localStorage.getItem('voice_muted') === '1'; } catch { return false; }
  });
  const voiceMutedRef = useRef(false);
  const lastNavPosRef = useRef(null);   // previous lat/lng during nav, for bearing delta
  const navBearingRef = useRef(0);      // smoothed bearing currently applied to the map

  // Routing variant A/B toggle (dev tool)
  const [routeVariant, setRouteVariant] = useState('classic');

  // Bug report
  const [bugComment, setBugComment] = useState('');
  const [bugSubmitting, setBugSubmitting] = useState(false);
  const [bugDone, setBugDone] = useState(false);

  // Recent
  const [recent, setRecent] = useState(() => {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY)||'[]'); } catch { return []; }
  });

  // Refs
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const mapLoadedRef = useRef(false);
  const pendingRoute = useRef(null);
  const markersRef = useRef([]);
  const messagesEnd = useRef(null);
  const userMarkerRef = useRef(null);
  const locationWatchRef = useRef(null); // always-on position watch
  const wakeLockRef = useRef(null);
  const lastAnnouncedRef = useRef(null);
  const routeDataRef = useRef(null);
  const navModeRef = useRef(false); // mirror of navMode for geolocation callback

  const isMobile = useIsMobile();

  useEffect(() => { routeDataRef.current = routeData; }, [routeData]);
  useEffect(() => { navModeRef.current = navMode; }, [navMode]);
  useEffect(() => { voiceMutedRef.current = voiceMuted; }, [voiceMuted]);

  // Prime the SpeechSynthesis voice list — many browsers load voices async and
  // return [] from the first getVoices() call. We listen so the picker can
  // upgrade from the default voice to a premium one as soon as it's available.
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const onVoices = () => { _pickedVoice = null; pickBestVoice(); };
    synth.addEventListener?.('voiceschanged', onVoices);
    onVoices();
    return () => synth.removeEventListener?.('voiceschanged', onVoices);
  }, []);

  const toggleVoiceMute = useCallback(() => {
    setVoiceMuted(m => {
      const next = !m;
      try { localStorage.setItem('voice_muted', next ? '1' : '0'); } catch {}
      if (next && window.speechSynthesis) window.speechSynthesis.cancel();
      return next;
    });
  }, []);

  const handleVoiceResult = useCallback((transcript) => {
    setQuery(transcript);
    submitQuery(transcript);
  }, []);
  const voice = useVoice(handleVoiceResult);

  // Live mirror of interim voice transcript into the input box, so the user
  // sees their words appear as they speak.
  useEffect(() => {
    if (voice.listening && voice.transcript) setQuery(voice.transcript);
  }, [voice.listening, voice.transcript]);

  // When recents are open, the sheet covers the map (buttons + input stay at the
  // top, recents list fills the rest). Otherwise: compact base — two-button
  // hero row + single-line input pill, sized to leave most of the map visible.
  const computeIdleHeight = useCallback((textH) => {
    if (recentsOpen) {
      // Near full screen, leaving room for the status bar/notch.
      const vh = (typeof window !== 'undefined' ? window.innerHeight : 800);
      return Math.min(900, vh - 40);
    }
    const errH = voice.error ? 40 : 0;
    // Base: 14px top + 56px buttons + 10px gap + textarea + 22px safe-area pad ≈ 102 + textH
    return Math.max(160, Math.min(102 + textH + errH, 420));
  }, [voice.error, recentsOpen]);

  // Auto-resize the idle textarea; grow the sheet so the whole prompt stays
  // visible. Uses RAF so iOS WKWebView has time to lay out before scrollHeight
  // is read, and a ResizeObserver so we also react when the browser changes the
  // textarea height itself (e.g. via `field-sizing: content` in supporting browsers).
  useEffect(() => {
    const ta = idleInputRef.current;
    if (!ta) return;
    const TEXT_MAX = 220;
    const recalc = () => {
      ta.style.height = 'auto';
      const textH = Math.min(ta.scrollHeight, TEXT_MAX);
      ta.style.height = textH + 'px';
      setIdleSheetHeight(computeIdleHeight(textH));
    };
    const raf = requestAnimationFrame(recalc);
    return () => cancelAnimationFrame(raf);
  }, [query, sheetMode, computeIdleHeight]);

  // Continuously observe textarea size changes (covers voice partial updates
  // and the browser growing the field via field-sizing).
  useEffect(() => {
    const ta = idleInputRef.current;
    if (!ta || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      setIdleSheetHeight(computeIdleHeight(ta.offsetHeight));
    });
    ro.observe(ta);
    return () => ro.disconnect();
  }, [sheetMode, computeIdleHeight]);

  // Close the recents drawer whenever we leave idle mode.
  useEffect(() => { if (sheetMode !== 'idle') setRecentsOpen(false); }, [sheetMode]);

  // ── Auth init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session); setAuthReady(true);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      setSession(session); setAuthReady(true);
    });
    return () => subscription.unsubscribe();
  }, []);

  // ── Map init — wait for session so map-canvas is in DOM ───────────────────
  useEffect(() => {
    if (!session) return;
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLE,
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      attributionControl: false,
      preserveDrawingBuffer: true,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    map.on('load', () => {
      mapLoadedRef.current = true;
      if (pendingRoute.current) {
        drawRouteOnMap(pendingRoute.current);
        pendingRoute.current = null;
      }
      // Note: the previous build auto-restored LAST_ROUTE_KEY from localStorage
      // here so that reopening the app or refreshing showed yesterday's route.
      // Removed — users prefer the app to start blank. Previous rides are
      // reachable via the recents drawer in the idle sheet.

      // Center on user location once on startup
      getCurrentGPS({ timeout: 5000, maximumAge: 60000 }).then(gps => {
        if (gps && mapRef.current) {
          mapRef.current.flyTo({ center: [gps.lng, gps.lat], zoom: 12, duration: 1200 });
        }
      });

      // Start always-on position watch for live marker
      if (navigator.geolocation) {
        locationWatchRef.current = navigator.geolocation.watchPosition(
          onGeoPosition,
          () => {},
          { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
        );
      }
    });

    mapRef.current = map;
    return () => {
      if (locationWatchRef.current !== null) {
        navigator.geolocation.clearWatch(locationWatchRef.current);
        locationWatchRef.current = null;
      }
      // Clear marker ref so next map init creates a fresh marker (bug fix: stale ref)
      userMarkerRef.current = null;
      map.remove();
      mapRef.current = null;
      mapLoadedRef.current = false;
    };
  }, [session]);

  // ── Position callback — always-on, refs avoid stale closures ─────────────
  function onGeoPosition(pos) {
    const { latitude: lat, longitude: lng } = pos.coords;
    setUserLocation({ lat, lng });

    const map = mapRef.current;
    if (map) {
      if (!userMarkerRef.current) {
        userMarkerRef.current = new maplibregl.Marker({
          element: makeMotoMarkerEl(),
          anchor: 'center',
        }).setLngLat([lng, lat]).addTo(map);
      } else {
        userMarkerRef.current.setLngLat([lng, lat]);
      }
      // During active navigation: centre on rider, tilt for perspective, and
      // rotate the map so the road ahead points up the screen.
      //
      // Bearing source priority:
      //   1. GPS heading — most accurate when actually moving
      //   2. Delta from last GPS fix — when GPS heading is null but user moved ≥5 m
      //   3. Route geometry at user's nearest point — keeps the road ahead "up"
      //      even when stopped at a light, just-started, or indoors
      //   4. Last smoothed bearing — final fallback
      if (navModeRef.current) {
        let target = navBearingRef.current;
        if (pos.coords.heading != null && !isNaN(pos.coords.heading) &&
            (pos.coords.speed == null || pos.coords.speed > 0.5)) {
          target = pos.coords.heading;
        } else if (lastNavPosRef.current) {
          const { lat: pLat, lng: pLng } = lastNavPosRef.current;
          if (Math.hypot(lat - pLat, lng - pLng) > 0.00005) { // ~5 m
            target = bearingBetween(pLat, pLng, lat, lng);
          } else {
            const rb = routeBearingAt(routeDataRef.current, lat, lng);
            if (rb != null) target = rb;
          }
        } else {
          const rb = routeBearingAt(routeDataRef.current, lat, lng);
          if (rb != null) target = rb;
        }
        // Low-pass filter so the map doesn't jitter while stopped or on GPS noise.
        const prev = navBearingRef.current;
        const delta = ((target - prev + 540) % 360) - 180;   // shortest signed arc
        const smoothed = (prev + delta * 0.35 + 360) % 360;
        navBearingRef.current = smoothed;
        lastNavPosRef.current = { lat, lng };

        map.easeTo({
          center: [lng, lat],
          zoom: 17,
          bearing: smoothed,
          pitch: 55,
          duration: 800,
        });
      }
    }

    // Turn-by-turn announcements + remaining-progress stats (nav mode only)
    const route = routeDataRef.current;
    if (route && navModeRef.current) {
      const result = findNextTurn(route, lat, lng);
      setNextTurn(result);
      const prog = routeProgress(route, lat, lng);
      if (prog) setNavProgress(prog);

      if (result) {
        const { instruction, dist } = result;
        const bucket = dist < 120 ? 'close' : dist < 350 ? 'far' : null;
        const key = `${instruction.text}-${bucket}`;
        if (bucket && lastAnnouncedRef.current !== key) {
          lastAnnouncedRef.current = key;
          const distPhrase = dist < 120 ? 'Now' : `In ${formatDist(dist)}`;
          speak(`${distPhrase}, ${instruction.text}`);
        }
      }
    }
  }

  // ── Draw route on map ─────────────────────────────────────────────────────
  function drawRouteOnMap(route) {
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) { pendingRoute.current = route; return; }

    if (map.getLayer('route-line')) map.removeLayer('route-line');
    if (map.getLayer('route-casing')) map.removeLayer('route-casing');
    if (map.getSource('route')) map.removeSource('route');
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];

    if (!route?.geometry) return;

    map.addSource('route', { type:'geojson', data:{ type:'Feature', geometry:route.geometry } });
    map.addLayer({ id:'route-casing', type:'line', source:'route',
      layout:{ 'line-join':'round','line-cap':'round' },
      paint:{ 'line-color':'#fff','line-width':6,'line-opacity':0.4 } });
    map.addLayer({ id:'route-line', type:'line', source:'route',
      layout:{ 'line-join':'round','line-cap':'round' },
      paint:{ 'line-color':'#2563eb','line-width':4,'line-opacity':0.95 } });

    route.stops?.forEach(stop => {
      if (!stop.lat || !stop.lng) return;
      const el = document.createElement('div');
      // Pick emoji by stop type keyword
      const t = (stop.type || stop.name || '').toLowerCase();
      const emoji = t.includes('coffee') || t.includes('cafe') || t.includes('espresso') ? '☕'
        : t.includes('lunch') || t.includes('dinner') || t.includes('restaurant') || t.includes('diner') || t.includes('food') || t.includes('eat') ? '🍽️'
        : t.includes('gas') || t.includes('fuel') || t.includes('petrol') ? '⛽'
        : t.includes('bar') || t.includes('pub') || t.includes('beer') || t.includes('brewery') ? '🍺'
        : t.includes('ice cream') || t.includes('dessert') || t.includes('bakery') ? '🍦'
        : t.includes('view') || t.includes('overlook') || t.includes('scenic') ? '📸'
        : '📍';
      el.textContent = emoji;
      // Inline styles — MapLibre overrides external CSS on custom marker elements
      Object.assign(el.style, {
        width: '36px', height: '36px',
        background: '#ffffff',
        border: '2.5px solid #f97316',
        borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '18px', lineHeight: '1',
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
        cursor: 'pointer',
        userSelect: 'none',
      });
      const popup = new maplibregl.Popup({ offset: 16, closeButton: false, maxWidth: '220px' })
        .setHTML(`<div class="map-popup"><strong>${stop.name}</strong>${stop.rating ? `<div class="popup-rating">⭐ ${stop.rating}${stop.ratingCount ? ` (${stop.ratingCount.toLocaleString()})` : ''}</div>` : ''}</div>`);
      markersRef.current.push(
        new maplibregl.Marker({ element: el }).setLngLat([stop.lng, stop.lat]).setPopup(popup).addTo(map)
      );
    });

    const coords = route.geometry.coordinates;
    const bounds = coords.reduce((b,c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
    const padding = isMobile ? { top:60, right:20, bottom:320, left:20 } : { top:60, right:60, bottom:60, left:60 };
    map.fitBounds(bounds, { padding, duration:900, maxZoom:14 });
  }

  // ── Navigation ────────────────────────────────────────────────────────────
  function speak(text) {
    if (voiceMutedRef.current) return;
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickBestVoice();
    if (v) u.voice = v;
    u.rate = 1.0; u.volume = 1.0; u.pitch = 1.0;
    window.speechSynthesis.speak(u);
  }

  function restoreRecentRoute(r) {
    if (r.geometry) {
      setRouteData(r);
      setCurrentIntent(r.intent || null);
      setRouteApproved(false);
      setRefineOpen(false);
      setMessages([{ role:'route', route:r }]);
      drawRouteOnMap(r);
      localStorage.setItem(LAST_ROUTE_KEY, JSON.stringify(r));
      if (isMobile) setSheetMode('collapsed');
    } else {
      setQuery(r.title); submitQuery(r.title);
    }
  }

  function startNavigation() {
    setNavMode(true);
    navModeRef.current = true;
    lastAnnouncedRef.current = null;
    lastNavPosRef.current = null;

    // Prime bearing to the route direction at the rider's position so the
    // very first frame already points up the road (no spin-into-place once
    // the first GPS heading arrives).
    const r = routeData;
    const initialBearing = (r && userLocation)
      ? (routeBearingAt(r, userLocation.lat, userLocation.lng) ?? 0)
      : 0;
    navBearingRef.current = initialBearing;

    navigator.wakeLock?.request('screen')
      .then(lock => { wakeLockRef.current = lock; })
      .catch(() => {});

    if (userLocation && mapRef.current) {
      mapRef.current.easeTo({
        center: [userLocation.lng, userLocation.lat],
        zoom: 17, pitch: 55, bearing: initialBearing,
        duration: 800,
      });
    }

    // Trigger an immediate position fix in case userLocation is stale
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(onGeoPosition, () => {}, { enableHighAccuracy: true });
    }

    if (isMobile) setSheetMode('collapsed');
  }

  function stopNavigation() {
    setNavMode(false);
    navModeRef.current = false;
    setNextTurn(null);
    setNavProgress(null);
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
    // Restore a normal flat north-up view.
    if (mapRef.current) {
      mapRef.current.easeTo({ bearing: 0, pitch: 0, zoom: 13, duration: 600 });
    }
  }

  function centerOnUser() {
    if (userLocation && mapRef.current) {
      mapRef.current.flyTo({ center: [userLocation.lng, userLocation.lat], zoom: 14, duration: 600 });
    }
  }

  // ── Auto scroll ───────────────────────────────────────────────────────────
  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // ── Recover navigation after app is backgrounded and foregrounded ─────────
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !navModeRef.current) return;
      // Re-acquire wake lock (it is automatically released when backgrounded)
      navigator.wakeLock?.request('screen')
        .then(lock => { wakeLockRef.current = lock; })
        .catch(() => {});
      // Reset speech synthesis — iOS leaves it in a broken state after backgrounding
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      // Trigger a fresh GPS fix and re-centre the map
      if (navigator.geolocation && mapRef.current) {
        navigator.geolocation.getCurrentPosition(
          pos => {
            const { latitude: lat, longitude: lng } = pos.coords;
            if (mapRef.current) {
              mapRef.current.easeTo({
                center: [lng, lat], zoom: 17,
                bearing: navBearingRef.current, pitch: 55,
                duration: 600,
              });
            }
          },
          () => {},
          { enableHighAccuracy: true, timeout: 8000 }
        );
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // ── Track keyboard height via visualViewport so sheet stays above keyboard ─
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const kbH = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
      document.documentElement.style.setProperty('--keyboard-height', `${kbH}px`);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      document.documentElement.style.setProperty('--keyboard-height', '0px');
    };
  }, []);

  // ── Generate route ────────────────────────────────────────────────────────
  async function generateRoute(payload, gps = null) {
    setLoading(true); setError(null);
    const cycle = ['Planning your ride…','Finding scenic roads…','Checking stops…','Almost there…'];
    let ci = 0; setLoadingMsg(cycle[0]);
    const ticker = setInterval(() => { ci=(ci+1)%cycle.length; setLoadingMsg(cycle[ci]); }, 2500);

    try {
      const token = session?.access_token || SUPABASE_ANON_KEY;
      const body = { ...payload, user_id: session?.user?.id || null, variant: routeVariant };
      if (gps) { body.userLat = gps.lat; body.userLng = gps.lng; }

      const res = await fetch(EDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      clearInterval(ticker);
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      if (data.clarify) {
        setMessages(prev => [...prev, {
          role:'clarify', question:data.question, options:data.options||[],
          onSelect:(opt) => handleFollowUp(opt),
        }]);
        if (isMobile) setSheetMode('expanded');
        return;
      }

      const r = data.route;
      setRouteData(r);
      setCurrentIntent(r.intent);
      setRouteApproved(false);
      setRefineOpen(false);
      setMessages(prev => [...prev, { role:'route', route:r }]);
      drawRouteOnMap(r);
      if (isMobile) setSheetMode('collapsed');

      // Store full geometry so recent rides can be redrawn without an API call
      const entry = { id:Date.now(), title:r.title, distance_mi:r.distance_mi, duration_str:r.duration_str, geometry:r.geometry, intent:r.intent, stops:r.stops||[], instructions:r.instructions||[] };
      const updated = [entry, ...recent.filter(x=>x.title!==entry.title)].slice(0,5);
      setRecent(updated); localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
      // Persist last active route so it survives tab switches and reloads
      localStorage.setItem(LAST_ROUTE_KEY, JSON.stringify(r));

    } catch(err) { clearInterval(ticker); setError(err.message); }
    finally { setLoading(false); }
  }

  async function submitQuery(q) {
    const text = (q || query).trim();
    if (!text || loading) return;
    setQuery('');
    setMessages([{ role:'user', content:text }]);
    setRouteData(null); setRouteApproved(false);
    // Don't expand the sheet — stay in idle/compact view while loading.
    // Sheet transitions to 'collapsed' automatically when route arrives.

    // Use the always-on watch position instantly if available.
    // Only block on a GPS call if the watch hasn't fired yet — and cap it at 1.5s
    // so the app never hangs. Route generation works fine without GPS (uses query text).
    let gps = userLocation;
    if (!gps) {
      setLoading(true);
      setLoadingMsg('Getting your location…');
      gps = await getCurrentGPS({ timeout: 1500, maximumAge: 30000 });
      setLoading(false);
    }

    generateRoute({ query: text }, gps);
  }

  async function handleFollowUp(text) {
    const t = (text || followUpInput).trim();
    if (!t || loading) return;
    setFollowUpInput(''); setRefineOpen(false);
    if (isApproval(t)) { setRouteApproved(true); if (isMobile) setSheetMode('collapsed'); return; }
    setMessages(prev => [...prev, { role:'user', content:t }]);
    if (isMobile) setSheetMode('expanded');

    const gps = userLocation || await getCurrentGPS({ timeout: 1500, maximumAge: 30000 });
    await generateRoute(currentIntent ? { refine:true, feedback:t, intent:currentIntent } : { query:t }, gps);
  }

  async function submitBug() {
    setBugSubmitting(true);
    try {
      // Capture map screenshot
      let imageData = null;
      try {
        if (mapRef.current) {
          // Trigger a fresh render and wait for it
          mapRef.current.triggerRepaint();
          await new Promise(resolve => {
            const done = () => resolve();
            mapRef.current.once('render', done);
            setTimeout(done, 600); // fallback
          });
          const canvas = mapRef.current.getCanvas();
          console.log('[screenshot] canvas', canvas.width, 'x', canvas.height);
          imageData = canvas.toDataURL('image/jpeg', 0.6);
          console.log('[screenshot] result length:', imageData?.length, 'prefix:', imageData?.slice(0, 40));
          if (!imageData || imageData === 'data:,' || imageData.length < 100) {
            console.warn('[screenshot] blank or empty canvas');
            imageData = null;
          }
        }
      } catch(e) { console.error('[submitBug] screenshot error:', e.name, e.message); }

      const query = messages.find(m=>m.role==='user')?.content || '';
      await fetch(`${SUPABASE_URL}/rest/v1/bug_reports`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'apikey':SUPABASE_ANON_KEY,
          'Authorization':`Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
          'Prefer':'return=minimal' },
        body: JSON.stringify({
          user_id: session?.user?.id || null,
          route_id: routeData?.id || null,
          comment: bugComment,
          image_data: imageData,
          page_context: query || null,
          created_at: new Date().toISOString(),
          route_context: routeData ? {
            title: routeData.title || null,
            destination: routeData.destination || null,
            distance_mi: routeData.distance_mi || null,
            duration_str: routeData.duration_str || null,
            // Claude's routing decisions — the most useful context for lesson extraction
            escape_waypoint: routeData.intent?.escape_waypoint || null,
            escape_via_waypoints: routeData.intent?.escape_via_waypoints || null,
            intermediate_waypoints: routeData.intent?.intermediate_waypoints || null,
            curviness: routeData.intent?.curviness || null,
            // rawIntent.origin and .destination are plain strings, not {query} objects
            origin_query: routeData.intent?.origin || null,
            destination_query: routeData.intent?.destination || null,
          } : null,
        }),
      });
      setBugDone(true); setBugComment('');
      setTimeout(() => { setMenuOpen(false); setBugDone(false); }, 2000);
    } finally { setBugSubmitting(false); }
  }

  // ── Auth gates ────────────────────────────────────────────────────────────
  if (!authReady) return <div className="loading-shell"><span className="dot-spin"/></div>;
  if (!session) return <LoginScreen />;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="app-shell">

      {/* Map panel — always-visible locate button lives here */}
      <div className="map-panel">
        <div ref={mapContainerRef} className="map-canvas"/>
        {/* Always-visible centre-on-me button */}
        <button
          className={`map-locate-btn${userLocation ? '' : ' map-locate-btn--dim'}`}
          onClick={centerOnUser}
          aria-label="Centre on my location"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>
          </svg>
        </button>
      </div>

      {/* ── Navigation overlay ── */}
      {navMode && (
        <div className="nav-overlay">
          <div className="nav-turn-banner">
            <span className="nav-turn-arrow">
              {nextTurn ? turnArrow(nextTurn.instruction.sign) : '↑'}
            </span>
            <div className="nav-turn-info">
              {nextTurn ? (
                <>
                  <span className="nav-turn-dist">{formatDist(nextTurn.dist)}</span>
                  <span className="nav-turn-text">{nextTurn.instruction.text}</span>
                </>
              ) : (
                <span className="nav-turn-text">Follow the route</span>
              )}
            </div>
            <button
              className={`nav-voice-btn${voiceMuted ? ' nav-voice-btn--muted' : ''}`}
              onClick={toggleVoiceMute}
              aria-pressed={voiceMuted}
              aria-label={voiceMuted ? 'Unmute voice directions' : 'Mute voice directions'}
            >
              {voiceMuted ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                  <line x1="22" y1="9"  x2="16" y2="15"/>
                  <line x1="16" y1="9"  x2="22" y2="15"/>
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
                </svg>
              )}
            </button>
            <button className="nav-stop-btn" onClick={stopNavigation} aria-label="Stop navigation">✕</button>
          </div>

          <div className="nav-bottom-bar">
            <div className="nav-progress">
              <span className="nav-stat nav-stat--time">
                {navProgress ? formatRemainingTime(navProgress.timeMs) : '—'}
              </span>
              <span className="nav-stat-sep">·</span>
              <span className="nav-stat">
                {navProgress ? formatMilesShort(navProgress.distM) : (routeData?.distance_mi?.toFixed(0) + ' mi')}
              </span>
              <span className="nav-stat-sep">·</span>
              <span className="nav-stat nav-stat--eta">
                {navProgress ? `ETA ${formatETA(navProgress.timeMs)}` : ''}
              </span>
            </div>
            <span className="nav-route-title">{routeData?.title}</span>
          </div>
        </div>
      )}

      {/* ════════════════ MOBILE bottom sheet ════════════════ */}
      {isMobile && !navMode ? (
        <div className={`sheet sheet--${sheetMode}`}
             style={sheetMode==='idle' ? { '--idle-height': idleSheetHeight + 'px' } : undefined}>

          {/* Handle row: drag bar (centre) + always-visible menu button (right) */}
          <div className="sheet-handle-row">
            <div className="sheet-handle" onClick={() =>
              setSheetMode(m => m==='expanded' ? (routeData?'collapsed':'idle') : 'expanded')
            }>
              <div className="sheet-bar"/>
            </div>
            <button
              className={`sheet-menu-btn${menuOpen ? ' active' : ''}`}
              onClick={() => {
                // Always expand to show full menu
                if (!menuOpen) setSheetMode('expanded');
                setMenuOpen(x => !x);
              }}
              aria-label="Menu"
            >⋯</button>
          </div>

          {!menuOpen && sheetMode === 'idle' && (
            <div className="sheet-idle">
              {/* Hero row: mic + recents toggle, side-by-side, both glove-friendly */}
              <div className="idle-hero-row">
                {loading ? (
                  <div className="hero-btn hero-btn--mic" style={{cursor:'default', pointerEvents:'none'}}>
                    <span className="dot-spin" style={{width:22,height:22,borderWidth:2.5}}/>
                    <span>Working…</span>
                  </div>
                ) : (
                  <button
                    className={`hero-btn hero-btn--mic${voice.listening ? ' hero-btn--listening' : ''}`}
                    onClick={() => {
                      if (query.trim()) { submitQuery(); }
                      else if (voice.supported) { voice.listening ? voice.stop() : voice.start(); }
                    }}
                    aria-label={query.trim() ? 'Submit' : 'Voice input'}
                  >
                    {voice.listening && <span className="mic-pulse"/>}
                    {query.trim() ? (
                      <>
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>
                        </svg>
                        <span>Send</span>
                      </>
                    ) : (
                      <>
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
                          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                          <line x1="12" y1="19" x2="12" y2="23"/>
                        </svg>
                        <span>{voice.listening ? 'Listening…' : 'Record'}</span>
                      </>
                    )}
                  </button>
                )}
                <button
                  className={`hero-btn hero-btn--recents${recentsOpen ? ' hero-btn--active' : ''}`}
                  onClick={() => setRecentsOpen(x => !x)}
                  aria-expanded={recentsOpen}
                  aria-label={recentsOpen ? 'Hide recent rides' : 'Show recent rides'}
                >
                  {recentsOpen ? (
                    <>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>
                      </svg>
                      <span>Close</span>
                    </>
                  ) : (
                    <>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="9"/>
                        <polyline points="12 7 12 12 15.5 14"/>
                      </svg>
                      <span>Recents</span>
                    </>
                  )}
                </button>
              </div>
              {/* Text input — auto-resizing pill; sheet grows with it via --idle-height */}
              <div className="idle-input-row">
                <textarea ref={idleInputRef} rows={1}
                  className="query-input query-input--idle"
                  placeholder={loading ? loadingMsg
                    : voice.listening ? 'Listening…'
                    : 'Where do you want to ride?'}
                  value={query} onChange={e=>setQuery(e.target.value)}
                  onKeyDown={e=>{
                    if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); submitQuery(); }
                  }}
                  disabled={loading}/>
              </div>
              {voice.error && (
                <div className="voice-error">{voice.error}</div>
              )}

              {/* Recents drawer fills the area below the input when open.
                  Mic + input remain visible at the top so the user can still
                  type/speak to filter or replace the query. */}
              {recentsOpen && (
                <div className="idle-recents">
                  <div className="idle-recents-header">Recent rides</div>
                  {recent.length > 0 ? (
                    <div className="idle-recents-list">
                      {recent.map(r => (
                        <button key={r.id} className="idle-recent-item"
                          onClick={() => { setRecentsOpen(false); restoreRecentRoute(r); }}>
                          <span className="idle-recent-title">{r.title}</span>
                          <span className="idle-recent-meta">
                            {r.distance_mi?.toFixed(0)} mi · {r.duration_str}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="idle-recents-empty">
                      <span className="idle-recents-empty-icon">
                        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="9"/>
                          <polyline points="12 7 12 12 15.5 14"/>
                        </svg>
                      </span>
                      <span className="idle-recents-empty-title">No rides yet</span>
                      <span className="idle-recents-empty-sub">Plan your first ride — it’ll show up here for quick re-runs.</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {!menuOpen && sheetMode === 'collapsed' && routeData && (
            <div className="sheet-collapsed-content">
              <div className="collapsed-info">
                <span className="collapsed-title">{routeData.title}</span>
                <span className="collapsed-meta">{routeData.duration_str} · {routeData.distance_mi?.toFixed(0)} mi</span>
              </div>
              <button className="start-nav-btn" onClick={startNavigation}>▶ Navigate</button>
              <div className="route-secondary-actions">
                <button className="route-action-btn" onClick={() => {
                  setRouteData(null); setRouteApproved(false);
                  setMessages([]); setFollowUpInput(''); setQuery('');
                  setRefineOpen(false); setSheetMode('idle');
                  const m = mapRef.current;
                  if (m) {
                    if (m.getLayer('route-line'))   m.removeLayer('route-line');
                    if (m.getLayer('route-casing')) m.removeLayer('route-casing');
                    if (m.getSource('route'))       m.removeSource('route');
                  }
                }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                  </svg>
                  New
                </button>
                <button className="route-action-btn" onClick={() => {
                  setRouteApproved(false); setRefineOpen(true);
                  setSheetMode('expanded');
                }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
                  </svg>
                  Edit
                </button>
                <button className="route-action-btn" onClick={() => {
                  setMenuOpen(true); setSheetMode('expanded');
                }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                  Report
                </button>
              </div>
            </div>
          )}

          {/* ── Overflow menu — shown in all sheet modes via handle ⋯ button ── */}
          {menuOpen && (
            <div className="overflow-menu overflow-menu-sheet">
              <div className="menu-user-row">
                <span className="menu-user-email">{session.user.email}</span>
                <button className="menu-signout" onClick={() => supabase.auth.signOut()}>Sign out</button>
              </div>
              <div className="menu-divider"/>
              {recent.length > 0 && (
                <>
                  <div className="menu-section-label">Recent rides</div>
                  {recent.map(r=>(
                    <button key={r.id} className="menu-item"
                      onClick={()=>{ setMenuOpen(false); restoreRecentRoute(r); }}>
                      {r.title}<span className="menu-item-meta">{r.distance_mi?.toFixed(0)} mi · {r.duration_str}</span>
                    </button>
                  ))}
                  <div className="menu-divider"/>
                </>
              )}
              <div className="menu-section-label">Routing model</div>
              <div className="variant-toggle-row">
                <button
                  className={`variant-btn${routeVariant==='classic'?' variant-btn--active':''}`}
                  onClick={()=>setRouteVariant('classic')}>Classic</button>
                <button
                  className={`variant-btn${routeVariant==='scoring'?' variant-btn--active':''}`}
                  onClick={()=>setRouteVariant('scoring')}>Scoring</button>
              </div>
              <div className="menu-divider"/>
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

          {!menuOpen && sheetMode === 'expanded' && (
            <div className="sheet-expanded-content">
              {error && <div className="error-banner">⚠️ {error}</div>}
              <ConversationThread messages={messages} loading={loading}
                loadingMsg={loadingMsg} messagesEndRef={messagesEnd}/>
              <div className="sheet-input-area">
                {routeData && !routeApproved && refineOpen && (
                  <div className="chips-row">
                    {REFINE_CHIPS.map(c=>(
                      <button key={c} className="chip" onClick={()=>handleFollowUp(c)}>{c}</button>
                    ))}
                    <button className="chip chip-approve" onClick={()=>handleFollowUp('looks good')}>👍 Approve</button>
                  </div>
                )}
                <div className="input-row">
                  {voice.supported && (
                    <button className={`mic-small${voice.listening?' mic-listening':''}`}
                      onClick={voice.listening?voice.stop:voice.start} aria-label="Voice input">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                        <line x1="12" y1="19" x2="12" y2="23"/>
                      </svg>
                    </button>
                  )}
                  <input className="followup-input"
                    placeholder={routeData ? 'Refine or approve…' : 'Where do you want to ride?'}
                    value={followUpInput || query}
                    onChange={e => routeData ? setFollowUpInput(e.target.value) : setQuery(e.target.value)}
                    onKeyDown={e => e.key==='Enter' && (routeData ? handleFollowUp() : submitQuery())}
                    disabled={loading}/>
                  {routeData && !routeApproved && (
                    <button className={`refine-btn${refineOpen?' active':''}`}
                      onClick={()=>setRefineOpen(x=>!x)} aria-label="Refine options">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/>
                      </svg>
                    </button>
                  )}
                  <button className="send-btn"
                    onClick={()=> routeData ? handleFollowUp() : submitQuery()}
                    disabled={loading || (routeData ? !followUpInput.trim() : !query.trim())}>↑</button>
                </div>
              </div>
            </div>
          )}
        </div>

      ) : !navMode ? (
        <div className="sidebar">
          <div className="brand">
            <span className="brand-name">🏍 TwoTired</span>
            <div className="user-row">
              <span className="user-email">{session.user.email}</span>
              <button className="signout-btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
            </div>
          </div>

          <div className="query-row">
            <input className="query-input" placeholder="Where do you want to ride?"
              value={query} onChange={e=>setQuery(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&submitQuery()} disabled={loading}/>
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
                    <button className="start-nav-btn-desktop" onClick={startNavigation}>▶ Start Navigation</button>
                    <div className="chips-row">
                      {REFINE_CHIPS.map(c=>(
                        <button key={c} className="chip" onClick={()=>handleFollowUp(c)}>{c}</button>
                      ))}
                    </div>
                    <div className="input-row">
                      <input className="followup-input" placeholder="Refine or approve…"
                        value={followUpInput} onChange={e=>setFollowUpInput(e.target.value)}
                        onKeyDown={e=>e.key==='Enter'&&handleFollowUp()}/>
                      <button className="send-btn" onClick={()=>handleFollowUp()}
                        disabled={!followUpInput.trim()}>↑</button>
                    </div>
                  </div>
                )}
                {routeApproved && (
                  <div className="desktop-followup">
                    <button className="start-nav-btn-desktop" onClick={startNavigation}>▶ Start Navigation</button>
                    <div className="approved-banner">✅ Route approved — ride safe!</div>
                  </div>
                )}
                {recent.filter(r=>r.title !== routeData?.title).length > 0 && (
                  <div className="recent-sidebar">
                    <div className="recent-label">Recent rides</div>
                    {recent.filter(r=>r.title !== routeData?.title).map(r=>(
                      <button key={r.id} className="recent-item" onClick={()=>restoreRecentRoute(r)}>
                        <span className="recent-title">{r.title}</span>
                        <span className="recent-meta">{r.distance_mi?.toFixed(0)} mi · {r.duration_str}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="empty-state">
                {recent.length > 0 ? (
                  <>
                    <div className="recent-label">Recent rides</div>
                    {recent.map(r=>(
                      <button key={r.id} className="recent-item"
                        onClick={()=>restoreRecentRoute(r)}>
                        <span className="recent-title">{r.title}</span>
                        <span className="recent-meta">{r.distance_mi?.toFixed(0)} mi · {r.duration_str}</span>
                      </button>
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
            <div className="variant-toggle-row">
              <button
                className={`variant-btn${routeVariant==='classic'?' variant-btn--active':''}`}
                onClick={()=>setRouteVariant('classic')}>Classic</button>
              <button
                className={`variant-btn${routeVariant==='scoring'?' variant-btn--active':''}`}
                onClick={()=>setRouteVariant('scoring')}>Scoring</button>
            </div>
            <button className="bug-trigger" onClick={()=>setMenuOpen(x=>!x)}>🐛 Report issue</button>
            {menuOpen && (
              <div className="bug-inline">
                <textarea className="bug-textarea" placeholder="What went wrong?"
                  value={bugComment} onChange={e=>setBugComment(e.target.value)}/>
                {bugDone
                  ? <p className="bug-done">Thanks!</p>
                  : <button className="menu-submit" onClick={submitBug} disabled={bugSubmitting||!bugComment.trim()}>
                      {bugSubmitting?'Sending…':'Submit'}
                    </button>
                }
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
