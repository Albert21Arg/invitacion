import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { FallingLeaf, useVoteLeafFlight, VotingTree } from './Vote.jsx';

const POLL_INTERVAL = 3000;

function localDeviceId() {
  try {
    let id = localStorage.getItem('cs_device');
    if (!id || !/^[A-Za-z0-9-]{16,64}$/.test(id)) {
      id = crypto.randomUUID();
      localStorage.setItem('cs_device', id);
    }
    return id;
  } catch {
    return '';
  }
}

export default function PublicPoll() {
  const slug = new URLSearchParams(location.search).get('poll') || '';
  const deviceId = useRef(localDeviceId());
  const headers = useRef(deviceId.current ? { 'X-Device-Id': deviceId.current } : {});
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const { flight, targetLeafRef, treeRef, launch, finishFlight, observeCounts, whiteLeaves, fallingWhiteLeaves } = useVoteLeafFlight();

  const refresh = useCallback(async () => {
    try {
      const next = await api(`/api/polls/${encodeURIComponent(slug)}`, { headers: headers.current });
      observeCounts(next.counts, true, next.mintLeaves);
      setState(next);
      setOffline(false);
    } catch (err) {
      if (err.status === 404) setError(err.message);
      else setOffline(true);
    }
  }, [observeCounts, slug]);

  useEffect(() => {
    let timer;
    let active = true;
    const loop = async () => {
      if (!document.hidden && active) await refresh();
      if (active) timer = setTimeout(loop, POLL_INTERVAL);
    };
    loop();
    const onVisibility = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  async function vote(choice, event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const from = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    setBusy(true);
    setError('');
    try {
      const next = await api(`/api/polls/${encodeURIComponent(slug)}/votes`, { method: 'POST', body: { choice }, headers: headers.current });
      observeCounts(next.counts, false, next.mintLeaves);
      setState(next);
      launch(choice, from, next.counts[choice] - 1);
    } catch (err) {
      if (err.data?.counts) setState(err.data);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const frame = (content) => <main className="page poll-page">
    <section className="standalone-poll" aria-live="polite">
      <span className="poll-heart" aria-hidden="true">♥</span>
      {content}
    </section>
    <footer>HECHO CON AMOR</footer>
  </main>;

  if (error && !state) return frame(<><h1>No disponible</h1><p className="poll-message" role="alert">{error}</p></>);
  if (!state) return frame(<><h1>Cargando votación…</h1><p className="poll-message">Un momento, por favor.</p></>);

  const canVote = state.voteOpen && !state.myVote;
  return frame(<>
    <p className="poll-overline">INVITACIÓN A VOTAR</p>
    <h1>{state.poll.title}</h1>
    <p className="poll-subtitle">{state.myVote ? '¡Gracias por participar!' : state.voteOpen ? 'Elige tu opción' : 'La votación está cerrada'}</p>
    {state.revealed && <div className={`standalone-poll-result reveal-${state.result}`} role="status">
      <p>Resultado anunciado</p>
      <strong>{state.result === 'boy' ? '¡Es un niño! 💙' : '¡Es una niña! 💗'}</strong>
    </div>}
    {canVote && <div className="standalone-poll-options">
      <button className="poll-option poll-option-boy" type="button" disabled={busy} onClick={(event) => vote('boy', event)}>Niño 💙</button>
      <button className="poll-option poll-option-girl" type="button" disabled={busy} onClick={(event) => vote('girl', event)}>Niña 💗</button>
    </div>}
    {state.myVote && <p className="poll-message poll-voted">Tu voto quedó registrado. Desde este dispositivo no se puede volver a votar.</p>}
    {error && <p className="poll-message" role="alert">{error}</p>}
    {offline && <p className="poll-message" role="status">Reconectando para actualizar los resultados…</p>}
    <VotingTree boyCount={state.counts.boy} girlCount={state.counts.girl} whiteLeaves={whiteLeaves} fallingWhiteLeaves={fallingWhiteLeaves} lastVote={flight?.team || state.myVote} lastVoteIndex={flight?.teamIndex} hideLastLeaf={!!flight} targetLeafRef={targetLeafRef} treeRef={treeRef}/>
    <FallingLeaf flight={flight} targetRef={targetLeafRef} onFinish={finishFlight}/>
    <p className="poll-device-note">Un voto por dispositivo. El enlace es el mismo para todos.</p>
  </>);
}
