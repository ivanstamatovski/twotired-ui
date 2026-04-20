import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

console.log('[BOOT] main.jsx starting, App:', typeof App, 'root:', !!document.getElementById('root'))

window.addEventListener('error', (e) => {
  console.error('[BOOT] window error:', e.message, e.filename + ':' + e.lineno, e.error?.stack)
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[BOOT] unhandled rejection:', e.reason)
})

try {
  const rootEl = document.getElementById('root')
  const root = createRoot(rootEl)
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
  console.log('[BOOT] render() called')
} catch (err) {
  console.error('[BOOT] render threw synchronously:', err)
}
