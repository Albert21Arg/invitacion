import React, { useEffect, useState } from 'react';
import { MapPin, CalendarDays, Clock, Heart, Check, X, ArrowDown, ArrowRight, Sparkles } from 'lucide-react';
import { api, getConfig, formatDate, formatTime } from './api.js';
import Turnstile from './Turnstile.jsx';
import Vote from './Vote.jsx';

// Datos demostrativos: solo se muestran al abrir la página sin enlace individual.
const DEMO = { guest: { name: '', maxGuests: 4 }, demo: true, rsvp: null,
  event: { babyName: 'Nuestro pequeño milagro', parentNames: 'Laura y Daniel', date: '2027-05-24', time: '16:00', venue: 'Jardín Los Robles', address: 'Medellín, Antioquia', message: '', closed: false, type: 'baby_shower' } };

function EventCountdown({ date, time }) {
  const getTimeLeft = () => {
    const target = new Date(`${date}T${time || '00:00'}:00`).getTime();
    const remaining = Math.max(0, target - Date.now());
    return [
      ['Días', Math.floor(remaining / 86400000)],
      ['Horas', Math.floor((remaining / 3600000) % 24)],
      ['Min', Math.floor((remaining / 60000) % 60)],
      ['Seg', Math.floor((remaining / 1000) % 60)]
    ];
  };
  const [parts, setParts] = useState(getTimeLeft);

  useEffect(() => {
    const timer = setInterval(() => setParts(getTimeLeft()), 1000);
    return () => clearInterval(timer);
  }, [date, time]);

  return <div className="reveal-countdown" aria-label="Cuenta regresiva para el evento">
    {parts.map(([label, value]) => <div className="countdown-part" key={label}><strong>{String(value).padStart(2, '0')}</strong><span>{label}</span></div>)}
  </div>;
}

export default function Invitation() {
  const params = new URLSearchParams(location.search);
  const token = params.get('i');
  const previewReveal = params.get('preview') === 'revelacion';
  const [data, setData] = useState(token ? null : previewReveal
    ? { ...DEMO, event: { ...DEMO.event, type: 'gender_reveal' } }
    : DEMO);
  const [loadError, setLoadError] = useState('');
  const [siteKey, setSiteKey] = useState(null);
  const [opened, setOpened] = useState(previewReveal);
  const [opening, setOpening] = useState(false);
  const [revealScreen, setRevealScreen] = useState('invitation');
  const [babyScreen, setBabyScreen] = useState('invitation');
  const [answer, setAnswer] = useState('yes');
  const [guests, setGuests] = useState(1);
  const [message, setMessage] = useState('');
  const [tsToken, setTsToken] = useState('');
  const [status, setStatus] = useState({ text: '', ok: false });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getConfig().then(c => setSiteKey(c.turnstileSiteKey || null));
    if (!token) return;
    api(`/api/invitation?i=${encodeURIComponent(token)}`).then(d => {
      setData(d);
      if (d.rsvp) { setAnswer(d.rsvp.attendance); setGuests(Math.max(1, d.rsvp.guestCount || 1)); setMessage(d.rsvp.message || ''); }
    }).catch(e => setLoadError(e.message));
  }, [token]);

  function openInvitation() {
    if (opening) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setOpened(true);
      return;
    }
    setOpening(true);
    window.setTimeout(() => setOpened(true), 800);
  }

  async function submitRSVP(e) {
    e.preventDefault();
    if (data.demo) { setStatus({ text: 'Modo de demostración: abre un enlace individual para confirmar.', ok: false }); return; }
    if (siteKey && !tsToken) { setStatus({ text: 'Completa la verificación antes de enviar.', ok: false }); return; }
    setBusy(true); setStatus({ text: 'Enviando…', ok: false });
    try {
      await api('/api/rsvp', { method: 'POST', body: { token, attendance: answer, guestCount: answer === 'yes' ? guests : 0, message, turnstileToken: tsToken } });
      setStatus({ text: '¡Gracias! Tu respuesta quedó registrada. Puedes volver a este enlace para cambiarla.', ok: true });
      setData(d => ({ ...d, rsvp: { attendance: answer, guestCount: answer === 'yes' ? guests : 0, message } }));
      if (data.event.type === 'gender_reveal') setRevealScreen('thanks');
      else setBabyScreen('thanks');
    } catch (err) { setStatus({ text: err.message, ok: false }); }
    finally { setBusy(false); }
  }

  const frame = (children, pageClass = '') => <main className={`page ${pageClass}`.trim()}><div className="sprig sprig-one">✦</div><div className="sprig sprig-two">❧</div>{children}<footer>HECHO CON AMOR <Sparkles size={12}/></footer></main>;

  if (loadError) return frame(<section className="cover"><div className="mini-seal">♡</div><h1>Ups</h1><p className="intro">{loadError}</p><p className="micro">Revisa que el enlace esté completo o pide uno nuevo a quien te invitó.</p></section>, 'cover-page');
  if (!data) return frame(<section className="cover"><div className="mini-seal">♡</div><p className="tap">Preparando tu carta…</p></section>, 'cover-page');

  const { event, guest } = data;
  const maps = event.venue || event.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([event.venue, event.address].filter(Boolean).join(', '))}` : null;
  const answered = !!data.rsvp;
  const reveal = event.type === 'gender_reveal';
  const guestName = guest.name ? guest.name.split(' ')[0] : '';
  const renderRsvpForm = (className, buttonClass) => <form className={className} onSubmit={submitRSVP}>
    <h3>{guestName ? `${guestName}, ¿nos acompañas?` : '¿Nos acompañas?'}</h3>
    <div className="choices"><button type="button" className={answer==='yes'?'selected':''} onClick={()=>setAnswer('yes')}><Check size={16}/> Sí, asistiré</button><button type="button" className={answer==='no'?'selected':''} onClick={()=>setAnswer('no')}><X size={16}/> No podré asistir</button></div>
    {answer==='yes' && guest.maxGuests > 1 && <label>Personas que asistirán (máximo {guest.maxGuests})<div className="counter"><button type="button" aria-label="Menos" onClick={()=>setGuests(Math.max(1,guests-1))}>−</button><strong>{guests}</strong><button type="button" aria-label="Más" onClick={()=>setGuests(Math.min(guest.maxGuests,guests+1))}>+</button></div></label>}
    <label>Mensaje (opcional)<textarea value={message} maxLength={1000} onChange={e=>setMessage(e.target.value)} placeholder="Déjanos unas palabras…" rows="3"/></label>
    <Turnstile siteKey={siteKey} onToken={setTsToken}/>
    <button className={buttonClass} type="submit" disabled={busy}>{busy ? 'Enviando…' : 'Enviar respuesta'} <Heart size={16}/></button>
    {status.text && <p className="status" role="status">{status.ok && reveal ? '¡Respuesta registrada!' : status.text}</p>}
  </form>;

  if (!opened) return frame(<section className="cover" aria-label="Invitación cerrada">
    <p className="eyebrow">{reveal ? 'UN SECRETO POR DESCUBRIR' : 'UNA SORPRESA ESPECIAL'}</p>
    <button className="envelope" type="button" onClick={openInvitation} aria-label="Abrir invitación">
      <div className="envelope-back"></div><div className="letter-peek">{reveal ? <><span>Hay un secreto</span><span>por revelar…</span></> : <><span>Hay una alegría</span><span>en camino…</span></>}<Heart size={17}/></div>
      <div className="envelope-babies" aria-hidden="true">
        <span className="envelope-sparkle sparkle-one">✦</span>
        <span className="envelope-sparkle sparkle-two">✧</span>
        <span className="envelope-sparkle sparkle-three">✦</span>
        <img className="envelope-baby-pair" src="/baby-pair.png" alt="" />
      </div>
      <div className="envelope-flap"></div><div className="envelope-front"></div><div className="ribbon"></div><div className="wax">♡</div>
    </button>
    <h1>{guest.name ? guest.name.split(' ')[0] : 'Invitación'}</h1><p className="tap">Toca para abrir</p>
    <button className="primary" onClick={openInvitation}>Abrir mi carta <ArrowDown size={16}/></button>
    <p className="micro">Con cariño, para alguien especial</p>
  </section>, `cover-page ${opening ? 'cover-opening' : ''}`);

  const babyHasLocation = !!(event.venue || event.address);
  const babySteps = ['Invitación', ...(babyHasLocation ? ['Ubicación'] : []), 'Confirmación'];
  const babyScreenStep = babyScreen === 'location' ? 'Ubicación' : babyScreen === 'attendance' ? 'Confirmación' : 'Invitación';

  if (reveal) return <main className={`page gender-page reveal-page ${revealScreen === 'invitation' ? 'reveal-cover-screen' : ''}`}>
    <div className="gender-shell reveal-shell">
      <img className="reveal-floral floral-top-left" src="/reveal-botanical.svg" alt="" aria-hidden="true"/>
      <img className="reveal-floral floral-top-right" src="/reveal-botanical.svg" alt="" aria-hidden="true"/>
      <img className="reveal-floral floral-bottom-left" src="/reveal-botanical.svg" alt="" aria-hidden="true"/>
      <img className="reveal-floral floral-bottom-right" src="/reveal-botanical.svg" alt="" aria-hidden="true"/>
      {revealScreen === 'invitation' && <section className="reveal-screen reveal-invitation" aria-labelledby="reveal-invitation-title">
        <h1 id="reveal-invitation-title">Revelación<br/><em>de nuestro bebé</em></h1>
        <span className="tiny-heart" aria-hidden="true">♥</span>
        <img className="reveal-art invitation-art" src="/reveal-bears.png" alt="Ositos con globos azules y rosados"/>
        <h2 className="invitation-question">¿Niño o Niña?</h2>
        <p className="reveal-copy">{event.message || 'Acompáñanos a descubrirlo'}</p>
        <aside className="reveal-team-gifts" aria-label="Qué traer según tu equipo">
          <p>¡Trae algo para celebrar!</p>
          <div>
            <span className="gift-team-boy"><strong>Team niño</strong> · pañales</span>
            <span className="gift-team-girl"><strong>Team niña</strong> · pañitos</span>
          </div>
        </aside>
        <div className="reveal-event-details">
          {event.date && <p><CalendarDays/><span>{formatDate(event.date)}</span></p>}
          {event.time && <p><Clock/><span>{formatTime(event.time)}</span></p>}
          {(event.venue || event.address) && <p><MapPin/><a className="reveal-location" href={maps || undefined} target={maps ? '_blank' : undefined} rel={maps ? 'noopener noreferrer' : undefined}><span>{event.venue}{event.address && <small>{event.address}</small>}{maps && <small className="reveal-map-hint">Toca aquí para abrir Maps</small>}</span></a></p>}
        </div>
        {event.date && <EventCountdown date={event.date} time={event.time}/>}
        {answered && <p className="reveal-note">Tu respuesta: {data.rsvp.attendance === 'yes' ? `asistirás (${data.rsvp.guestCount})` : 'no podrás asistir'}.</p>}
        {event.closed && <p className="reveal-note">Las confirmaciones para este evento ya están cerradas.</p>}
        <button className="reveal-primary invitation-next" type="button" onClick={() => setRevealScreen('vote')}>Continuar a votar <ArrowRight size={16}/></button>
      </section>}
      {revealScreen === 'vote' && <section className="reveal-screen reveal-vote" aria-labelledby="reveal-vote-title">
        <h1 id="reveal-vote-title">¿Qué crees que será?</h1>
        <p className="vote-subtitle">Vota por tu equipo</p>
        <span className="tiny-heart" aria-hidden="true">♥</span>
        {!data.demo
          ? <Vote token={token} view="vote" onShowResults={() => setRevealScreen('results')}/>
          : <p className="reveal-note">La votación estará disponible al abrir un enlace individual.</p>}
        <button className="vote-bottom-heart" type="button" aria-label="Volver a la invitación" onClick={() => setRevealScreen('invitation')}><Heart size={16} fill="currentColor"/></button>
      </section>}
      {revealScreen === 'results' && <section className="reveal-screen reveal-results" aria-labelledby="reveal-results-title">
        <h1 id="reveal-results-title">Resultados en vivo</h1>
        {!data.demo
          ? <Vote token={token} view="results" onShowResults={() => setRevealScreen('vote')}/>
          : <p className="reveal-note">Los resultados aparecerán al abrir un enlace individual.</p>}
        <button className="reveal-primary results-attendance-next" type="button" onClick={() => setRevealScreen('attendance')}>Continuar a confirmar asistencia <ArrowRight size={16}/></button>
      </section>}
      {revealScreen === 'attendance' && <section className="reveal-screen reveal-attendance" aria-labelledby="reveal-attendance-title">
        <p className="thanks-overline">UN ÚLTIMO PASO</p>
        <h1 id="reveal-attendance-title">¿Nos<br/><em>acompañas?</em></h1>
        <div className="attendance-summary">
          {event.date && <p><CalendarDays/><span>{formatDate(event.date)}</span></p>}
          {event.time && <p><Clock/><span>{formatTime(event.time)}</span></p>}
          {(event.venue || event.address) && <p><MapPin/><span>{event.venue}<small>{event.address}</small></span></p>}
        </div>
        {event.closed
          ? <p className="reveal-note">Las confirmaciones para este evento ya están cerradas.{answered && ` Tu respuesta registrada: ${data.rsvp.attendance === 'yes' ? `asistirás (${data.rsvp.guestCount})` : 'no podrás asistir'}.`}</p>
          : renderRsvpForm('rsvp reveal-rsvp attendance-rsvp', 'reveal-primary')}
        <button className="reveal-text-button attendance-back" type="button" onClick={() => setRevealScreen('results')}>Volver a resultados</button>
      </section>}
      {revealScreen === 'thanks' && <section className="reveal-screen reveal-thanks" aria-labelledby="reveal-thanks-title">
        <p className="thanks-overline">UN MOMENTO ESPECIAL</p>
        <h1 id="reveal-thanks-title">¡Gracias<br/><em>por confirmar!</em></h1>
        <span className="tiny-heart" aria-hidden="true">♥</span>
        <img className="reveal-art thanks-art" src="/reveal-bears.png" alt="Ositos celebrando juntos"/>
        <p className="thanks-copy">Tu participación hace este momento aún más especial.</p>
        <span className="tiny-heart thanks-heart" aria-hidden="true">♥</span>
        <p className="thanks-copy thanks-closing">Nos vemos pronto para descubrirlo juntos.</p>
        <button className="reveal-text-button" type="button" onClick={() => setRevealScreen('results')}>Ver resultados <ArrowRight size={14}/></button>
      </section>}
    </div>
  </main>;

  const goToAttendance = () => setBabyScreen('attendance');
  const goToNextStep = () => setBabyScreen(babyHasLocation ? 'location' : 'attendance');
  if (babyScreen === 'thanks') return <main className="page gender-page baby-page">
    <div className="gender-shell baby-shell">
      <img className="reveal-floral floral-top-left" src="/reveal-botanical.svg" alt="" aria-hidden="true"/>
      <img className="reveal-floral floral-top-right" src="/reveal-botanical.svg" alt="" aria-hidden="true"/>
      <section className="reveal-screen reveal-thanks baby-screen baby-thanks" aria-labelledby="baby-thanks-title">
        <p className="thanks-overline">UN MOMENTO ESPECIAL</p>
        <h1 id="baby-thanks-title">¡Gracias<br/><em>por confirmar!</em></h1>
        <span className="tiny-heart" aria-hidden="true">♥</span>
        <div className="baby-thanks-art" aria-hidden="true">🧸</div>
        <p className="thanks-copy">{data.rsvp?.attendance === 'yes' ? '¡Nos alegra mucho que nos acompañes!' : 'Gracias por contarnos. Valoramos mucho tu respuesta.'}</p>
        <span className="tiny-heart thanks-heart" aria-hidden="true">♥</span>
        <p className="thanks-copy thanks-closing">Gracias por ser parte de este momento tan especial.</p>
        <button className="reveal-text-button" type="button" onClick={() => setBabyScreen('invitation')}>Volver a la invitación <ArrowRight size={14}/></button>
      </section>
    </div>
  </main>;

  return <main className="page gender-page baby-page">
    <div className="gender-shell baby-shell">
      <img className="reveal-floral floral-top-left" src="/reveal-botanical.svg" alt="" aria-hidden="true"/>
      <img className="reveal-floral floral-top-right" src="/reveal-botanical.svg" alt="" aria-hidden="true"/>
      <div className="baby-progress" aria-label={`Paso ${babySteps.indexOf(babyScreenStep) + 1} de ${babySteps.length}: ${babyScreenStep}`}>
        {babySteps.map((step, index) => <div className={`baby-progress-step ${step === babyScreenStep ? 'active' : ''} ${babySteps.indexOf(babyScreenStep) > index ? 'complete' : ''}`} key={step}>
          <span>{babySteps.indexOf(babyScreenStep) > index ? '✓' : index + 1}</span>{step}
        </div>)}
      </div>
      {babyScreen === 'invitation' && <section className="reveal-screen baby-screen baby-invitation" aria-labelledby="baby-invitation-title">
        <p className="thanks-overline">UNA NUEVA HISTORIA COMIENZA</p>
        <h1 id="baby-invitation-title">Baby shower<br/><em>un gran amor está por llegar</em></h1>
        <span className="tiny-heart" aria-hidden="true">♥</span>
        <div className="baby-invitation-art" aria-hidden="true">🧸</div>
        <p className="baby-greeting">{guestName ? `${guestName}, ` : ''}{event.parentNames ? `${event.parentNames} te invitan a celebrar` : 'Te invitamos a celebrar'}</p>
        {event.babyName && <p className="baby-name">la llegada de <strong>{event.babyName}</strong></p>}
        {event.message && <p className="baby-invitation-message">{event.message}</p>}
        <div className="baby-event-details">
          {event.date && <p><CalendarDays/><span>{formatDate(event.date)}</span></p>}
          {event.time && <p><Clock/><span>{formatTime(event.time)}</span></p>}
        </div>
        {event.date && <EventCountdown date={event.date} time={event.time}/>}
        {answered && <p className="baby-previous-answer">Tu respuesta: {data.rsvp.attendance === 'yes' ? `asistirás (${data.rsvp.guestCount})` : 'no podrás asistir'}.</p>}
        <button className="reveal-primary baby-next" type="button" onClick={goToNextStep}>{babyHasLocation ? 'Ver ubicación' : answered ? 'Cambiar mi respuesta' : 'Confirmar asistencia'} <ArrowRight size={16}/></button>
        {answered && !event.closed && <button className="reveal-text-button baby-change-answer" type="button" onClick={goToAttendance}>Cambiar mi respuesta</button>}
      </section>}
      {babyScreen === 'location' && <section className="reveal-screen baby-screen baby-location" aria-labelledby="baby-location-title">
        <p className="thanks-overline">EL ENCUENTRO</p>
        <h1 id="baby-location-title">¿Cómo<br/><em>llegar?</em></h1>
        <span className="tiny-heart" aria-hidden="true">♥</span>
        <div className="baby-map-card">
          <div className="baby-map-art" aria-hidden="true"><MapPin size={54}/></div>
          <h2>{event.venue || 'Ubicación del evento'}</h2>
          {event.address && <p>{event.address}</p>}
          {maps && <a className="reveal-primary baby-map-link" href={maps} target="_blank" rel="noopener noreferrer"><MapPin size={16}/> Abrir en Google Maps</a>}
        </div>
        <button className="reveal-primary baby-next" type="button" onClick={goToAttendance}>{event.closed ? 'Ver confirmación' : 'Confirmar asistencia'} <ArrowRight size={16}/></button>
        <button className="reveal-text-button baby-back" type="button" onClick={() => setBabyScreen('invitation')}>Volver a la invitación</button>
      </section>}
      {babyScreen === 'attendance' && <section className="reveal-screen baby-screen baby-attendance" aria-labelledby="baby-attendance-title">
        <p className="thanks-overline">UN ÚLTIMO PASO</p>
        <h1 id="baby-attendance-title">¿Nos<br/><em>acompañas?</em></h1>
        {event.closed
          ? <p className="reveal-note">Las confirmaciones para este evento ya están cerradas.{answered && ` Tu respuesta registrada: ${data.rsvp.attendance === 'yes' ? `asistirás (${data.rsvp.guestCount})` : 'no podrás asistir'}.`}</p>
          : renderRsvpForm('rsvp reveal-rsvp attendance-rsvp baby-rsvp', 'reveal-primary')}
        <button className="reveal-text-button baby-back" type="button" onClick={() => setBabyScreen(babyHasLocation ? 'location' : 'invitation')}>Volver</button>
      </section>}
    </div>
  </main>;
}
