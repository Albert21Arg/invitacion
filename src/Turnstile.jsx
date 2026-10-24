import React, { useEffect, useRef } from 'react';

let scriptPromise;
function loadScript() {
  return (scriptPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  }));
}

// Muestra el widget solo si hay clave pública configurada; llama onToken con el resultado.
export default function Turnstile({ siteKey, onToken }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!siteKey) return;
    let widgetId;
    loadScript().then(() => {
      if (!ref.current || !window.turnstile) return;
      widgetId = window.turnstile.render(ref.current, {
        sitekey: siteKey, callback: onToken,
        'expired-callback': () => onToken(''), 'error-callback': () => onToken('')
      });
    }).catch(() => onToken(''));
    return () => { if (widgetId !== undefined && window.turnstile) window.turnstile.remove(widgetId); };
  }, [siteKey]);
  return siteKey ? <div ref={ref} className="turnstile" /> : null;
}
