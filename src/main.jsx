import { StrictMode, Component } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

<<<<<<< HEAD
<<<<<<< Updated upstream
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
=======
=======
>>>>>>> 8f7b89e01cb5848f80e754f6f8ceed6e8a252fdd
// ── ErrorBoundary: catches render errors and shows them on screen ──────────
class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Render error:', error.message)
    console.error('[ErrorBoundary] Stack:', error.stack)
    console.error('[ErrorBoundary] Component stack:', info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: '24px',
          fontFamily: 'monospace',
          background: '#fef2f2',
          color: '#991b1b',
          border: '2px solid #fca5a5',
          borderRadius: '8px',
          margin: '20px',
          maxWidth: '90vw',
        }}>
          <h2 style={{ marginTop: 0, fontSize: '18px' }}>🚨 App crashed — error details:</h2>
          <p style={{ fontWeight: 700, fontSize: '15px' }}>{this.state.error.message}</p>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: '12px', overflow: 'auto', maxHeight: '60vh', background: '#fff5f5', padding: '12px', borderRadius: '4px' }}>
            {this.state.error.stack}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}

// ── Boot logging ───────────────────────────────────────────────────────────
console.log('[BOOT] main.jsx starting, App:', typeof App, 'root:', !!document.getElementById('root'))

window.addEventListener('error', (e) => {
  var t
  console.error('[BOOT] window error:', e.message, e.filename + ':' + e.lineno, (t = e.error) == null ? void 0 : t.stack)
})

window.addEventListener('unhandledrejection', (e) => {
  console.error('[BOOT] unhandled rejection:', e.reason)
})

// ── Render ─────────────────────────────────────────────────────────────────
try {
  const rootEl = document.getElementById('root')
  const root = createRoot(rootEl)
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
  console.log('[BOOT] render() called')
} catch (err) {
  // Synchronous crash fallback — show in DOM directly
  console.error('[BOOT] render threw synchronously:', err)
  const el = document.getElementById('root')
  if (el) {
    el.innerHTML =
      '<div style="padding:20px;font-family:monospace;color:#991b1b;background:#fef2f2;border-radius:8px;margin:20px">' +
      '<b>Sync crash:</b><pre style="white-space:pre-wrap">' + err.message + '\n\n' + err.stack + '</pre></div>'
  }
}
>>>>>>> Stashed changes
