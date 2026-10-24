import React, { useEffect, useState, useCallback } from 'react';
import { api, setCsrf, getConfig, formatDate } from './api.js';
import Turnstile from './Turnstile.jsx';

const STATUS_LABEL = { draft: 'Borrador', published: 'Publicado', closed: 'Cerrado' };
const TYPE_LABEL = { baby_shower: 'Baby shower', gender_reveal: 'Revelación' };
const EMPTY_EVENT = { event_type: 'baby_shower', title: '', baby_name: '', parent_names: '', event_date: '', event_time: '', venue: '', address: '', message: '', status: 'draft' };

function waLink(phone, text) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10 && d.startsWith('3')) d = '57' + d; // celulares colombianos sin indicativo
  return `https://wa.me/${d}?text=${encodeURIComponent(text)}`;
}

/* ---------- Acceso ---------- */
function Auth({ needsSetup, onDone }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [setupKey, setSetupKey] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [siteKey, setSiteKey] = useState(null); const [ts, setTs] = useState('');
  useEffect(() => { getConfig().then(c => setSiteKey(c.turnstileSiteKey || null)); }, []);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const r = needsSetup
        ? await api('/api/admin/setup', { method: 'POST', body: { email, password, setupKey } })
        : await api('/api/admin/login', { method: 'POST', body: { email, password, turnstileToken: ts } });
      setCsrf(r.csrfToken); onDone(r.email);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return <div className="admin-auth"><form className="admin-card" onSubmit={submit}>
    <div className="mini-seal">♡</div>
    <h1 className="admin-h1">{needsSetup ? 'Crear administrador' : 'Panel privado'}</h1>
    {needsSetup && <p className="admin-note">Primera vez: crea tu cuenta con la clave de configuración (<code>ADMIN_SETUP_KEY</code>). Solo funciona mientras no exista ningún administrador.</p>}
    <label>Correo<input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" required/></label>
    <label>Contraseña{needsSetup && ' (mín. 12 caracteres)'}<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete={needsSetup ? 'new-password' : 'current-password'} minLength={needsSetup ? 12 : undefined} required/></label>
    {needsSetup && <label>Clave de configuración<input type="password" value={setupKey} onChange={e => setSetupKey(e.target.value)} required/></label>}
    {!needsSetup && <Turnstile siteKey={siteKey} onToken={setTs}/>}
    <button className="primary" disabled={busy || (!needsSetup && siteKey && !ts)}>{busy ? 'Un momento…' : needsSetup ? 'Crear y entrar' : 'Entrar'}</button>
    {error && <p className="admin-error" role="alert">{error}</p>}
  </form></div>;
}

/* ---------- Formulario de evento ---------- */
function EventForm({ initial, onSave, onCancel }) {
  const [f, setF] = useState({ ...EMPTY_EVENT, ...Object.fromEntries(Object.entries(initial || {}).map(([k, v]) => [k, v ?? ''])) });
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try { await onSave(f); } catch (err) { setError(err.message); setBusy(false); }
  }
  return <form className="admin-card admin-form" onSubmit={submit}>
    <h2>{initial?.id ? 'Editar evento' : 'Nuevo evento'}</h2>
    <label>Tipo de invitación<select value={f.event_type} onChange={set('event_type')}><option value="baby_shower">Baby shower</option><option value="gender_reveal">Revelación de sexo (con votación en vivo)</option></select></label>
    <label>Título interno *<input value={f.title} onChange={set('title')} maxLength={120} required placeholder="Revelación de Laura y Daniel"/></label>
    <label>Nombre del bebé<input value={f.baby_name} onChange={set('baby_name')} maxLength={120} placeholder="Mateo"/></label>
    <label>Anfitriones<input value={f.parent_names} onChange={set('parent_names')} maxLength={160} placeholder="Laura y Daniel"/></label>
    <div className="row2"><label>Fecha<input type="date" value={f.event_date} onChange={set('event_date')}/></label><label>Hora<input type="time" value={f.event_time} onChange={set('event_time')}/></label></div>
    <label>Lugar<input value={f.venue} onChange={set('venue')} maxLength={160}/></label>
    <label>Dirección<input value={f.address} onChange={set('address')} maxLength={240}/></label>
    <label>Mensaje de la carta (opcional)<textarea rows="3" value={f.message} onChange={set('message')} maxLength={600} placeholder="Si lo dejas vacío se usa el texto por defecto."/></label>
    <label>Estado<select value={f.status} onChange={set('status')}><option value="draft">Borrador (las invitaciones no abren)</option><option value="published">Publicado</option><option value="closed">Cerrado (se ve, pero no recibe confirmaciones)</option></select></label>
    {error && <p className="admin-error" role="alert">{error}</p>}
    <div className="admin-actions"><button className="primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button><button type="button" className="ghost" onClick={onCancel}>Cancelar</button></div>
  </form>;
}

/* ---------- Panel de revelación: votos en vivo y control ---------- */
function RevealPanel({ event, votes, onChange, onError }) {
  const total = votes.boy + votes.girl, pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  const revealed = !!event.revealed_at, open = event.vote_status === 'open' && !revealed;
  async function act(action, result) {
    const msg = action === 'reveal' ? `¿Revelar que es ${result === 'boy' ? 'NIÑO' : 'NIÑA'}? Todos los invitados lo verán en sus pantallas al instante y se cerrará la votación.` : null;
    if (msg && !confirm(msg)) return;
    try { await api(`/api/admin/events/${event.id}/reveal`, { method: 'POST', body: { action, result } }); onChange(); } catch (e) { onError(e.message); }
  }
  return <div className="admin-card reveal-admin">
    <div className="admin-title-row"><h3>Votación en vivo</h3><span className={`pill ${revealed ? 'pill-closed' : open ? 'pill-published' : 'pill-draft'}`}>{revealed ? `Revelado: ${event.reveal_result === 'boy' ? 'niño' : 'niña'}` : open ? 'Abierta' : 'Cerrada'}</span></div>
    {['boy', 'girl'].map(c => <div key={c} className="tally-row"><div className="tally-head"><span>{c === 'boy' ? 'Niño 💙' : 'Niña 💗'}</span><strong>{votes[c]}</strong></div><div className="bar"><div className={`bar-fill bar-${c}`} style={{ width: `${pct(votes[c])}%` }}/></div><small>{pct(votes[c])}%</small></div>)}
    <p className="admin-note">{total} {total === 1 ? 'voto' : 'votos'} · se actualiza cada 4 s. Cada invitación permite un voto por persona, hasta el número de cupos.</p>
    <div className="reveal-actions">
      {!revealed && (open ? <button className="ghost" onClick={() => act('close')}>Cerrar votación</button> : <button className="ghost" onClick={() => act('open')}>Reabrir votación</button>)}
      {!revealed && <><button className="ghost btn-boy" onClick={() => act('reveal', 'boy')}>Revelar: es niño 💙</button><button className="ghost btn-girl" onClick={() => act('reveal', 'girl')}>Revelar: es niña 💗</button></>}
      {revealed && <button className="ghost" onClick={() => act('hide')}>Ocultar resultado</button>}
    </div>
    {event.status === 'draft' && <p className="admin-note warn">El evento está en borrador: nadie puede abrir su invitación aún.</p>}
  </div>;
}

/* ---------- Detalle de evento: invitados y respuestas ---------- */
function EventDetail({ id, onBack, onEdit, onDeleted }) {
  const [data, setData] = useState(null); const [error, setError] = useState('');
  const [guest, setGuest] = useState({ name: '', phone: '', max_guests: 1 });
  const [fresh, setFresh] = useState(null); // { name, phone, link } — se muestra una sola vez
  const [copied, setCopied] = useState(false); const [busy, setBusy] = useState(false);
  const load = useCallback(() => api(`/api/admin/events/${id}`).then(setData).catch(e => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  const live = data && data.event.event_type === 'gender_reveal';
  useEffect(() => { // contador en vivo también en el panel
    if (!live) return;
    const t = setInterval(() => { if (!document.hidden) load(); }, 4000);
    return () => clearInterval(t);
  }, [live, load]);
  if (error && !data) return <div className="admin-card"><p className="admin-error">{error}</p><button className="ghost" onClick={onBack}>Volver</button></div>;
  if (!data) return <p className="admin-note">Cargando…</p>;
  const { event, guests } = data;
  const yes = guests.filter(g => g.attendance === 'yes'), no = guests.filter(g => g.attendance === 'no');
  const people = yes.reduce((n, g) => n + g.guest_count, 0);
  const isReveal = event.event_type === 'gender_reveal';
  const intro = (name) => `Hola ${name.split(' ')[0]} 💛 ${event.parent_names ? `${event.parent_names} te invitan` : 'Te invitamos'} ${isReveal ? 'a descubrir si será niño o niña 💙💗. Abre tu carta, vota y confirma tu asistencia aquí:' : 'a una celebración muy especial. Abre tu carta y confirma tu asistencia aquí:'}`;

  async function addGuest(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const r = await api(`/api/admin/events/${id}/guests`, { method: 'POST', body: { ...guest, max_guests: Number(guest.max_guests) } });
      setFresh({ name: guest.name, phone: guest.phone, link: r.link }); setGuest({ name: '', phone: '', max_guests: 1 }); load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function regenerate(g) {
    if (!confirm(`Se creará un enlace nuevo para ${g.name} y el anterior dejará de funcionar. ¿Continuar?`)) return;
    try { const r = await api(`/api/admin/guests/${g.id}/regenerate`, { method: 'POST' }); setFresh({ name: g.name, phone: g.phone, link: r.link }); } catch (err) { setError(err.message); }
  }
  async function removeGuest(g) {
    if (!confirm(`¿Eliminar a ${g.name}? Se borrará también su respuesta.`)) return;
    try { await api(`/api/admin/guests/${g.id}`, { method: 'DELETE' }); load(); } catch (err) { setError(err.message); }
  }
  async function removeEvent() {
    if (!confirm('¿Eliminar este evento con todos sus invitados y respuestas? No se puede deshacer.')) return;
    try { await api(`/api/admin/events/${id}`, { method: 'DELETE' }); onDeleted(); } catch (err) { setError(err.message); }
  }
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { prompt('Copia el enlace:', text); } };

  return <div>
    <button className="ghost back" onClick={onBack}>← Eventos</button>
    <div className="admin-card">
      <div className="admin-title-row"><h2>{event.title}</h2><span className={`pill pill-${event.status}`}>{STATUS_LABEL[event.status]}</span></div>
      <p className="admin-note"><span className="pill type-pill">{TYPE_LABEL[event.event_type]}</span> {[event.event_date && formatDate(event.event_date), event.venue].filter(Boolean).join(' · ') || 'Sin fecha ni lugar todavía'}</p>
      {event.status === 'draft' && <p className="admin-note warn">Está en borrador: los enlaces no abrirán hasta que lo publiques.</p>}
      <div className="admin-actions"><button className="ghost" onClick={onEdit}>Editar</button><button className="ghost danger" onClick={removeEvent}>Eliminar</button></div>
    </div>
    {isReveal && <RevealPanel event={event} votes={data.votes} onChange={load} onError={setError}/>}
    <div className="stats"><div><strong>{people}</strong><span>asistentes</span></div><div><strong>{yes.length}</strong><span>confirmaron</span></div><div><strong>{no.length}</strong><span>no asisten</span></div><div><strong>{guests.length - yes.length - no.length}</strong><span>pendientes</span></div></div>

    {fresh && <div className="admin-card fresh" role="status">
      <h3>Enlace para {fresh.name}</h3>
      <p className="admin-note warn">Guárdalo o envíalo ahora: por seguridad no se vuelve a mostrar (si lo pierdes, genera uno nuevo).</p>
      <input readOnly value={fresh.link} onFocus={e => e.target.select()} aria-label="Enlace de invitación"/>
      <div className="admin-actions">
        <button className="primary" onClick={() => copy(fresh.link)}>{copied ? '¡Copiado!' : 'Copiar enlace'}</button>
        {fresh.phone && <a className="ghost as-btn" target="_blank" rel="noopener noreferrer" href={waLink(fresh.phone, `${intro(fresh.name)} ${fresh.link}`)}>Enviar por WhatsApp</a>}
        <button className="ghost" onClick={() => setFresh(null)}>Cerrar</button>
      </div>
    </div>}

    <form className="admin-card admin-form" onSubmit={addGuest}>
      <h3>Agregar invitado</h3>
      <label>Nombre *<input value={guest.name} onChange={e => setGuest({ ...guest, name: e.target.value })} maxLength={120} required/></label>
      <div className="row2"><label>Celular (opcional)<input type="tel" value={guest.phone} onChange={e => setGuest({ ...guest, phone: e.target.value })} maxLength={30} placeholder="300 123 4567"/></label>
        <label>Cupos<input type="number" min="1" max="20" value={guest.max_guests} onChange={e => setGuest({ ...guest, max_guests: e.target.value })} required/></label></div>
      {error && <p className="admin-error" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? 'Creando…' : 'Crear invitación y enlace'}</button>
    </form>

    <div className="admin-card">
      <h3>Invitados ({guests.length})</h3>
      {guests.length === 0 && <p className="admin-note">Aún no hay invitados.</p>}
      <ul className="guest-list">{guests.map(g => <li key={g.id}>
        <div className="g-main"><strong>{g.name}</strong>
          <span className={`pill ${g.attendance ? (g.attendance === 'yes' ? 'pill-published' : 'pill-closed') : 'pill-draft'}`}>{g.attendance === 'yes' ? `Asiste (${g.guest_count}/${g.max_guests})` : g.attendance === 'no' ? 'No asiste' : `Pendiente · ${g.max_guests} cupo${g.max_guests > 1 ? 's' : ''}`}</span></div>
        {g.message && <p className="g-msg">“{g.message}”</p>}
        <div className="g-actions"><button className="link" onClick={() => regenerate(g)}>Nuevo enlace</button><button className="link danger" onClick={() => removeGuest(g)}>Eliminar</button></div>
      </li>)}</ul>
    </div>
  </div>;
}

/* ---------- Aplicación ---------- */
export default function Admin() {
  const [auth, setAuth] = useState({ loading: true, email: null, needsSetup: false });
  const [view, setView] = useState({ name: 'list' });
  const [events, setEvents] = useState(null); const [error, setError] = useState('');

  useEffect(() => {
    api('/api/admin/me').then(r => { setCsrf(r.csrfToken); setAuth({ loading: false, email: r.email }); })
      .catch(async () => { const s = await api('/api/admin/status').catch(() => ({})); setAuth({ loading: false, email: null, needsSetup: !!s.needsSetup }); });
  }, []);
  const loadEvents = useCallback(() => api('/api/admin/events').then(r => setEvents(r.events)).catch(e => { if (e.status === 401) setAuth({ loading: false, email: null }); else setError(e.message); }), []);
  useEffect(() => { if (auth.email) loadEvents(); }, [auth.email, loadEvents]);

  async function logout() { try { await api('/api/admin/logout', { method: 'POST' }); } catch {} setCsrf(''); setEvents(null); setView({ name: 'list' }); setAuth({ loading: false, email: null }); }
  if (auth.loading) return <p className="admin-note" style={{ padding: 24 }}>Cargando…</p>;
  if (!auth.email) return <Auth needsSetup={auth.needsSetup} onDone={(email) => setAuth({ loading: false, email })}/>;

  async function saveEvent(f) {
    let id;
    if (view.name === 'edit') { id = view.event.id; await api(`/api/admin/events/${id}`, { method: 'PUT', body: f }); }
    else { id = (await api('/api/admin/events', { method: 'POST', body: f })).id; }
    await loadEvents(); setView({ name: 'detail', id });
  }

  return <div className="admin">
    <header className="admin-bar"><strong>Carta Sellada</strong><span>{auth.email}</span><button className="link" onClick={logout}>Salir</button></header>
    <div className="admin-body">
      {view.name === 'list' && <>
        <div className="admin-title-row"><h1 className="admin-h1 left">Eventos</h1><button className="primary" onClick={() => setView({ name: 'new' })}>+ Nuevo</button></div>
        {error && <p className="admin-error">{error}</p>}
        {!events ? <p className="admin-note">Cargando…</p> : events.length === 0 ? <div className="admin-card"><p className="admin-note">Todavía no tienes eventos. Crea el primero para empezar a generar invitaciones.</p></div> :
          events.map(e => <button key={e.id} className="admin-card event-row" onClick={() => setView({ name: 'detail', id: e.id })}>
            <div className="admin-title-row"><strong>{e.title}</strong><span className={`pill pill-${e.status}`}>{STATUS_LABEL[e.status]}</span></div>
            <span className="admin-note">{TYPE_LABEL[e.event_type]} · {e.event_date ? formatDate(e.event_date) : 'Sin fecha'} · {e.responses}/{e.guests} respuestas</span>
          </button>)}
      </>}
      {view.name === 'new' && <EventForm onSave={saveEvent} onCancel={() => setView({ name: 'list' })}/>}
      {view.name === 'edit' && <EventForm initial={view.event} onSave={saveEvent} onCancel={() => setView({ name: 'detail', id: view.event.id })}/>}
      {view.name === 'detail' && <EventDetail key={view.id} id={view.id} onBack={() => { loadEvents(); setView({ name: 'list' }); }}
        onEdit={async () => { const r = await api(`/api/admin/events/${view.id}`); setView({ name: 'edit', event: r.event }); }}
        onDeleted={() => { loadEvents(); setView({ name: 'list' }); }}/>}
    </div>
  </div>;
}
