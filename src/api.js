let csrfToken = '';
export const setCsrf = (t) => { csrfToken = t || ''; };

export async function api(path, { method = 'GET', body, headers: extra } = {}) {
  const headers = { Accept: 'application/json', ...extra };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(path, { method, headers, credentials: 'same-origin', cache: 'no-store', body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* sin cuerpo JSON */ }
  if (!res.ok) { const err = new Error((data && data.error) || 'Ocurrió un error. Intenta de nuevo.'); err.status = res.status; err.data = data; throw err; }
  return data;
}

let configPromise;
export const getConfig = () => (configPromise ||= api('/api/config').catch(() => ({ turnstileSiteKey: null })));

export function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const s = new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(y, m - 1, d));
  return s.charAt(0).toUpperCase() + s.slice(1);
}
export function formatTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(2000, 0, 1, h, m));
}
