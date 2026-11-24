import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import AdminApp from './components/admin/AdminApp'

const container = document.getElementById('root')
if (!container) throw new Error('Admin bootstrap failed: no element with id "root" was found.')

const theme = new URLSearchParams(window.location.search).get('theme') === 'dark' ? 'dark' : 'light'
document.documentElement.dataset.theme = theme

createRoot(container).render(
  <StrictMode>
    <AdminApp theme={theme} />
  </StrictMode>
)
