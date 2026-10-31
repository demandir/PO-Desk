import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

document.documentElement.classList.add('js')
const storedTheme = window.localStorage.getItem('po-desk-theme')
const initialTheme = storedTheme === 'dark' || storedTheme === 'light'
  ? storedTheme
  : window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
document.documentElement.dataset.theme = initialTheme

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
