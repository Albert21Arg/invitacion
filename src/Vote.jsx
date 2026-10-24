import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

const POLL_MS = 3000;
const LABEL = { boy: 'Niño', girl: 'Niña' };
const EMOJI = { boy: '💙', girl: '💗' };
const TREE_LEAF_AREA = 82_000;

function leafRandom(seed) {
  const value = Math.sin((seed + 1) * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function leafPositions(total) {
  let radius = Math.min(25, Math.max(0.35, 0.44 * Math.sqrt(TREE_LEAF_AREA / total)));
  let candidates = [];

  while (candidates.length < total && radius >= 0.35) {
    const spacing = radius * 2.2;
    const rowSpacing = spacing * Math.sqrt(3) / 2;
    candidates = [];
    let row = 0;

    for (let y = 125; y <= 510; y += rowSpacing, row += 1) {
      let column = 0;
      for (let x = 12 + (row % 2) * spacing / 2; x <= 362; x += spacing, column += 1) {
        const seed = row * 1009 + column;
        const jitter = leafRandom(seed + 1) * Math.PI * 2;
        const distance = radius * 0.055;
        const leafX = x + Math.cos(jitter) * distance;
        const leafY = y + Math.sin(jitter) * distance;
        const canopy = ((leafX - 187) / 171) ** 2 + ((leafY - 310) / 196) ** 2;
        const overlapsTrunk = leafY >= 210 && leafY <= 580 && leafX > 155 - radius && leafX < 218 + radius;
        if (canopy <= 0.96 && !overlapsTrunk) {
          candidates.push({ x: leafX, y: leafY, order: leafRandom(seed + 2) });
        }
      }
    }

    if (candidates.length < total) radius *= 0.9;
  }

  candidates.sort((a, b) => a.order - b.order);
  return { radius, leaves: candidates.slice(0, total) };
}

function VotingTree({ boyCount, girlCount }) {
  const total = boyCount + girlCount;
  const { radius, leaves } = total ? leafPositions(total) : { radius: 25, leaves: [] };
  const scale = radius / 25;
  const boyLeaves = leaves.map((leaf, i) => ({
    ...leaf,
    angle: leafRandom(i * 6 + 5) * 90 - 45,
    sway: 20 + leafRandom(i * 6 + 7) * 16,
    swayDelay: leafRandom(i * 6 + 6) * -3,
    team: Math.floor((i + 1) * boyCount / total) > Math.floor(i * boyCount / total) ? 'boy' : 'girl'
  }));

  return <div className="voting-tree" role="img"
    aria-label={`Árbol de votos: ${boyCount} hojas azules del equipo niño y ${girlCount} hojas rosas del equipo niña`}>
    <img className="voting-tree-image" src="/voting-tree.png" alt="" aria-hidden="true"/>
    <svg className="voting-tree-leaves" viewBox="0 0 374 666" aria-hidden="true">
      {boyLeaves.map((leaf, i) => <g key={i} transform={`translate(${leaf.x} ${leaf.y}) scale(${scale}) rotate(${leaf.angle})`}>
        <path className={`tree-leaf leaf-${leaf.team}`}
          d="M -25 0 Q 0 -25 25 0 Q 0 25 -25 0 Z"
          style={{ '--sway': `${leaf.sway}deg`, '--sway-delay': `${leaf.swayDelay}s` }}/>
      </g>)}
    </svg>
  </div>;
}

// Id guardado en el navegador para recuperar los votos asociados a este dispositivo.
function localDeviceId() {
  try {
    let id = localStorage.getItem('cs_device');
    if (!id || !/^[A-Za-z0-9-]{16,64}$/.test(id)) { id = crypto.randomUUID(); localStorage.setItem('cs_device', id); }
    return id;
  } catch { return ''; }
}

function Confetti({ kind }) {
  // posiciones deterministas (no cambian entre actualizaciones del contador)
  return <div className={`confetti confetti-${kind}`} aria-hidden="true">{Array.from({ length: 28 }, (_, i) =>
    <span key={i} style={{ '--x': `${(i * 37) % 100}%`, '--d': `${((i * 13) % 20) / 10}s`, '--t': `${3 + ((i * 7) % 25) / 10}s`, '--r': `${(i * 53) % 360}deg` }}/>)}</div>;
}

export default function Vote({ token, view, onShowResults }) {
  const [st, setSt] = useState(null);
  const [error, setError] = useState('');
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const deviceId = useRef(localDeviceId());
  const headers = deviceId.current ? { 'X-Device-Id': deviceId.current } : {};

  const refresh = useCallback(async () => {
    try { setSt(await api(`/api/reveal?i=${encodeURIComponent(token)}`, { headers })); setOffline(false); }
    catch (e) { if (e.status === 404 || e.status === 400) setError(e.message); else setOffline(true); }
  }, [token]);

  // Actualización en vivo: consulta cada 3 s mientras la pestaña está visible.
  useEffect(() => {
    let timer;
    const loop = async () => { if (!document.hidden) await refresh(); timer = setTimeout(loop, POLL_MS); };
    loop();
    const onVis = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
  }, [refresh]);

  async function vote(choice) {
    setBusy(true); setError('');
    try { const r = await api('/api/vote', { method: 'POST', body: { token, choice }, headers }); setSt(r); }
    catch (e) { if (e.data && e.data.counts) setSt(e.data); setError(e.message); }
    finally { setBusy(false); }
  }

  if (error && !st) return <p className="status">{error}</p>;
  if (!st) return <div className="vote-card"><p className="status">Cargando votación…</p></div>;

  const total = st.total || 0;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  const myVotes = st.myVotes || (st.myVote ? [st.myVote] : []);
  const myVote = myVotes.at(-1) || null;
  const guestCounts = st.guestCounts || { boy: myVote === 'boy' ? 1 : 0, girl: myVote === 'girl' ? 1 : 0 };
  const guestHasBoyVote = guestCounts.boy > 0;
  const guestHasGirlVote = guestCounts.girl > 0;
  const guestQuotaFull = st.guestVoteLimit > 0 && st.guestVoteCount >= st.guestVoteLimit;
  const canVote = st.voteOpen && !guestQuotaFull;
  const canContinue = myVotes.length > 0 || guestQuotaFull || !st.voteOpen;

  if (view === 'vote') return <div className="reveal-vote-content" aria-live="polite">
    {guestHasBoyVote || guestHasGirlVote
      ? guestHasBoyVote && guestHasGirlVote
        ? <div className="voted-bears-pair" role="img" aria-label="Ositos de los equipos niño y niña"><div className="voted-bear-frame voted-bear-boy"><img src="/reveal-bears.png" alt=""/></div><div className="voted-bear-frame voted-bear-girl"><img src="/reveal-bears.png" alt=""/></div></div>
        : <div className={`voted-bear-frame voted-bear-${guestHasBoyVote ? 'boy' : 'girl'}`}><img src="/reveal-bears.png" alt={`Osito del equipo ${guestHasBoyVote ? 'niño' : 'niña'}`}/></div>
      : !guestQuotaFull && <img className="reveal-art vote-art" src="/reveal-bears.png" alt="Ositos con globos azules y rosados"/>}
    {canVote
      ? <>
        <p className="vote-anonymity">{myVote ? 'Registra el voto de otra persona' : 'Elige el equipo de una persona'} · Voto {st.guestVoteCount + 1} de {st.guestVoteLimit}</p>
        <div className="reveal-vote-buttons">
          {['boy', 'girl'].map(c => <button key={c} type="button" className={`reveal-team team-${c}`} disabled={busy} onClick={() => vote(c)}>
            <span>{c === 'boy' ? '¡Niño!' : '¡Niña!'}</span>
          </button>)}
        </div>
        <p className="vote-anonymity vote-privacy-note">Vota una vez por cada persona de esta invitación. Tu voto será anónimo.</p>
      </>
      : <p className="vote-anonymity">{myVote ? `Ya se registraron los ${st.guestVoteCount} votos de esta invitación.` : !st.voteOpen ? 'La votación está cerrada. Continúa para ver los resultados.' : 'Los votos de esta invitación ya fueron registrados.'}</p>}
    {error && <p className="reveal-note" role="alert">{error}</p>}
    {canContinue && <button className="reveal-primary vote-results-next" type="button" onClick={onShowResults}>Ver resultados en vivo</button>}
  </div>;

  return <div className="reveal-results-content" aria-live="polite">
    {offline && <p className="live reveal-live off"><span className="dot"/>Reconectando…</p>}
    {st.revealed && <div className={`reveal-banner reveal-${st.result}`}>
      <Confetti kind={st.result}/>
      <p className="reveal-small">¡El secreto fue revelado!</p>
      <p className="reveal-big">{st.result === 'boy' ? '¡Es un niño!' : '¡Es una niña!'} {EMOJI[st.result]}</p>
      {total > 0 && <p className="reveal-small">{pct(st.counts[st.result])}% acertó ({st.counts[st.result]} de {total})</p>}
    </div>}
    <VotingTree boyCount={st.counts.boy} girlCount={st.counts.girl}/>
    <div className="reveal-results-summary">
      {['boy', 'girl'].map(c => <div className={`legend-team legend-${c}`} key={c}>
        <span className="legend-dot"/><span className="legend-label">Equipo {LABEL[c]}</span><strong>{st.counts[c]} {st.counts[c] === 1 ? 'voto' : 'votos'} ({pct(st.counts[c])}%)</strong>
      </div>)}
    </div>
    <p className="reveal-total">Total de votos <strong>{total}</strong></p>
    <p className="reveal-note">{st.revealed ? 'El secreto ya fue revelado.' : st.voteOpen ? 'Los resultados se actualizan en tiempo real.' : 'La votación está cerrada.'}</p>
    {canVote && <button className="reveal-primary results-vote-button" type="button" onClick={onShowResults}>{myVotes.length ? 'Votar por otra persona' : 'Votar por tu equipo'}</button>}
  </div>;
}
