import { useEffect, useRef } from 'react'
import { turnstileSiteKey } from '../lib/config'

declare global {
  interface Window {
    turnstile?: {
      render: (
        element: HTMLElement,
        options: { sitekey: string; callback: (token: string) => void; theme: 'auto'; 'expired-callback': () => void; 'error-callback': () => void },
      ) => string
      remove: (widgetId: string) => void
    }
  }
}

export function Turnstile({ onToken }: { onToken: (token: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!turnstileSiteKey || !containerRef.current) return
    let widgetId = ''
    let cancelled = false
    const renderWidget = () => {
      if (cancelled || !containerRef.current || !window.turnstile) return
      widgetId = window.turnstile.render(containerRef.current, {
        sitekey: turnstileSiteKey,
        callback: onToken,
        theme: 'auto',
        'expired-callback': () => onToken(''),
        'error-callback': () => onToken(''),
      })
    }
    const existing = document.querySelector<HTMLScriptElement>('script[data-po-turnstile]')
    if (existing) {
      if (window.turnstile) renderWidget()
      else existing.addEventListener('load', renderWidget, { once: true })
    } else {
      const script = document.createElement('script')
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      script.async = true
      script.defer = true
      script.dataset.poTurnstile = 'true'
      script.addEventListener('load', renderWidget, { once: true })
      document.head.appendChild(script)
    }
    return () => {
      cancelled = true
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId)
    }
  }, [onToken])

  if (!turnstileSiteKey) return null
  return <div className="turnstile" ref={containerRef} aria-label="Spam prevention check" />
}
