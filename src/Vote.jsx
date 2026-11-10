import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

const POLL_MS = 3000;
const EMOJI = { boy: '💙', girl: '💗' };
const TREE_LEAF_RADIUS = 4.5;
const TREE_LEAF_MAX_RADIUS = 13;
const TREE_LEAF_SHRINK_START = 30;
const TREE_LEAF_SHRINK_END = 300;
const WHITE_LEAF_RADIUS = 6;
const WHITE_LEAF_INTERVAL_MS = 30_000;
const WHITE_LEAF_CYCLE_SIZE = 120;
const WHITE_LEAF_FALL_MS = 3_200;
const TREE_BRANCHES = [
  [187, 348, 145, 325], [145, 325, 93, 292], [93, 292, 56, 258],
  [164, 310, 125, 276], [125, 276, 80, 243], [80, 243, 52, 205],
  [173, 278, 143, 244], [143, 244, 111, 210], [111, 210, 82, 178],
  [184, 255, 190, 215], [190, 215, 204, 176], [204, 176, 230, 145],
  [202, 330, 247, 307], [247, 307, 295, 281], [295, 281, 338, 248],
  [202, 298, 239, 269], [239, 269, 282, 237], [282, 237, 329, 208],
  [196, 270, 222, 235], [222, 235, 257, 202], [257, 202, 291, 173]
];

function leafRandom(seed) {
  const value = Math.sin((seed + 1) * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function distanceToBranch(x, y) {
  let nearest = Infinity;
  for (const [x1, y1, x2, y2] of TREE_BRANCHES) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const progress = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
    nearest = Math.min(nearest, Math.hypot(x - (x1 + dx * progress), y - (y1 + dy * progress)));
  }
  return nearest;
}

function createLeafSlots() {
  const slots = [];
  const spacing = TREE_LEAF_RADIUS * 2.2;
  const rowSpacing = spacing * Math.sqrt(3) / 2;
  const candidates = [];
  let row = 0;
  for (let y = 125; y <= 510; y += rowSpacing, row += 1) {
    let column = 0;
    for (let x = 12 + (row % 2) * spacing / 2; x <= 362; x += spacing, column += 1) {
      const jitter = leafRandom(row * 1009 + column + 1) * Math.PI * 2;
      const leafX = x + Math.cos(jitter) * TREE_LEAF_RADIUS * 0.055;
      const leafY = y + Math.sin(jitter) * TREE_LEAF_RADIUS * 0.055;
      const canopy = ((leafX - 187) / 171) ** 2 + ((leafY - 310) / 196) ** 2;
      const trunkHalfWidth = leafY < 245 ? 3 : leafY < 300 ? 6 : leafY < 370 ? 7 : leafY < 440 ? 6 : 5;
      const overlapsTrunk = leafY >= 210 && leafY <= 580
        && Math.abs(leafX - 187) < trunkHalfWidth + TREE_LEAF_RADIUS;
      if (canopy <= 0.96 && !overlapsTrunk) {
        candidates.push({ x: leafX, y: leafY, branchDistance: distanceToBranch(leafX, leafY) });
      }
    }
  }

  candidates.sort((a, b) => a.branchDistance - b.branchDistance || a.y - b.y || a.x - b.x);
  slots.push(...candidates);
  return slots;
}

const TREE_LEAF_SLOTS = createLeafSlots();

function getTreeLeafRadius(totalVotes) {
  const shrinkProgress = Math.min(1, Math.max(0,
    (totalVotes - TREE_LEAF_SHRINK_START) / (TREE_LEAF_SHRINK_END - TREE_LEAF_SHRINK_START)
  ));
  return TREE_LEAF_MAX_RADIUS - shrinkProgress * (TREE_LEAF_MAX_RADIUS - TREE_LEAF_RADIUS);
}

function WhiteTreeLeaf({ leaf, arriving, fallElapsed }) {
  const arrivalAnimationRef = useRef(null);
  const dropDistance = Math.max(0, 635 - leaf.y);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (arriving) arrivalAnimationRef.current?.beginElement();
  }, [arriving]);

  const falling = fallElapsed !== null;
  return <g className={`tree-white-leaf${falling ? ' tree-white-leaf-falling' : ''}`}
    style={falling ? { '--fall-delay': `-${Math.min(WHITE_LEAF_FALL_MS / 1000, fallElapsed)}s`, '--drop-distance': `${dropDistance}px` } : undefined}
    transform={`translate(${leaf.x} ${leaf.y})`}>
    <g>
      {arriving && <animateTransform ref={arrivalAnimationRef} attributeName="transform" type="translate"
        values={`0 ${-leaf.y - 40}; 12 ${-leaf.y * 0.62}; -8 ${-leaf.y * 0.24}; 0 0`}
        keyTimes="0;0.35;0.72;1" dur="2.4s" begin="indefinite" fill="freeze" additive="sum"/>}
      <g transform={`scale(${WHITE_LEAF_RADIUS / 25}) rotate(${leaf.angle})`}>
        <path d="M -25 0 Q 0 -25 25 0 Q 0 25 -25 0 Z"/>
      </g>
    </g>
  </g>;
}

export function VotingTree({ boyCount, girlCount, whiteLeaves = [], fallingWhiteLeaves = [], lastVote = null, lastVoteIndex, hideLastLeaf = false, targetLeafRef, treeRef }) {
  const totalVotes = boyCount + girlCount;
  const leafRadius = getTreeLeafRadius(totalVotes);
  const boySlots = TREE_LEAF_SLOTS.filter((_, index) => index % 2 === 0);
  const girlSlots = TREE_LEAF_SLOTS.filter((_, index) => index % 2 === 1);
  const leaves = [
    ...boySlots.slice(0, boyCount).map((leaf, index) => ({ ...leaf, team: 'boy', teamIndex: index })),
    ...girlSlots.slice(0, girlCount).map((leaf, index) => ({ ...leaf, team: 'girl', teamIndex: index }))
  ].sort((a, b) => {
    const aSlot = a.team === 'boy' ? a.teamIndex * 2 : a.teamIndex * 2 + 1;
    const bSlot = b.team === 'boy' ? b.teamIndex * 2 : b.teamIndex * 2 + 1;
    return aSlot - bSlot;
  });
  const targetIndex = lastVoteIndex ?? (lastVote === 'boy' ? boyCount - 1 : girlCount - 1);
  const treeLeaves = leaves.map(leaf => ({
    ...leaf,
    angle: leafRandom(leaf.teamIndex * 6 + (leaf.team === 'boy' ? 5 : 11)) * 90 - 45,
    sway: 20 + leafRandom(leaf.teamIndex * 6 + (leaf.team === 'boy' ? 7 : 13)) * 16,
    swayDelay: leafRandom(leaf.teamIndex * 6 + (leaf.team === 'boy' ? 6 : 12)) * -3
  }));

  return <div ref={treeRef} className="voting-tree" role="img"
    aria-label="Árbol de votos de los equipos Niño y Niña">
    <img className="voting-tree-image" src="/voting-tree.png" alt="" aria-hidden="true"/>
    <svg className="voting-tree-leaves" viewBox="0 0 374 666" aria-hidden="true">
      {whiteLeaves.map(leaf => <WhiteTreeLeaf key={leaf.id} leaf={leaf} arriving={leaf.arriving} fallElapsed={null}/>)}
      {fallingWhiteLeaves.map(leaf => <WhiteTreeLeaf key={leaf.id} leaf={leaf} fallElapsed={leaf.fallElapsed}/>)}
      {treeLeaves.map(leaf => <g key={`${leaf.team}-${leaf.teamIndex}`} transform={`translate(${leaf.x} ${leaf.y}) scale(${leafRadius / 25}) rotate(${leaf.angle})`}
        style={{ '--sway': `${leaf.sway}deg`, '--sway-delay': `${leaf.swayDelay}s` }}>
        <path ref={leaf.team === lastVote && leaf.teamIndex === targetIndex ? targetLeafRef : undefined}
          className={`tree-leaf leaf-${leaf.team}${leaf.team === lastVote && leaf.teamIndex === targetIndex && hideLastLeaf ? ' tree-leaf-pending' : ''}`}
          d="M -25 0 Q 0 -25 25 0 Q 0 25 -25 0 Z"/>
      </g>)}
    </svg>
  </div>;
}

export function useVoteLeafFlight() {
  const [flight, setFlight] = useState(null);
  const queueRef = useRef([]);
  const activeRef = useRef(false);
  const previousCountsRef = useRef(null);
  const targetLeafRef = useRef(null);
  const treeRef = useRef(null);
  const previousMintLeavesRef = useRef(null);
  const [whiteLeaves, setWhiteLeaves] = useState([]);
  const [fallingWhiteLeaves, setFallingWhiteLeaves] = useState([]);

  const createMintLeafLayout = useCallback((count, counts, cycleKey) => {
    const boySlots = TREE_LEAF_SLOTS.filter((_, slotIndex) => slotIndex % 2 === 0);
    const girlSlots = TREE_LEAF_SLOTS.filter((_, slotIndex) => slotIndex % 2 === 1);
    const voteLeaves = [
      ...boySlots.slice(0, counts.boy),
      ...girlSlots.slice(0, counts.girl)
    ];
    const voteRadius = getTreeLeafRadius(counts.boy + counts.girl);
    const cellSize = 20;
    const occupied = new Map();
    const addOccupied = (point, radius) => {
      const cellX = Math.floor(point.x / cellSize);
      const cellY = Math.floor(point.y / cellSize);
      const key = `${cellX}:${cellY}`;
      occupied.set(key, [...(occupied.get(key) || []), { ...point, radius }]);
    };
    const overlapsOccupied = (candidate, radius) => {
      const cellX = Math.floor(candidate.x / cellSize);
      const cellY = Math.floor(candidate.y / cellSize);
      const searchCells = Math.ceil(radius / cellSize);
      for (let x = cellX - searchCells; x <= cellX + searchCells; x += 1) {
        for (let y = cellY - searchCells; y <= cellY + searchCells; y += 1) {
          for (const point of occupied.get(`${x}:${y}`) || []) {
            if (Math.hypot(candidate.x - point.x, candidate.y - point.y) < radius + point.radius) return true;
          }
        }
      }
      return false;
    };
    for (const leaf of voteLeaves) addOccupied(leaf, voteRadius);

    const leaves = [];
    for (let index = 0; index < count; index += 1) {
      const preferredIndex = Math.floor(index * TREE_LEAF_SLOTS.length / WHITE_LEAF_CYCLE_SIZE);
      let slot = null;
      for (let offset = 0; offset < TREE_LEAF_SLOTS.length; offset += 1) {
        const candidate = TREE_LEAF_SLOTS[(preferredIndex + offset) % TREE_LEAF_SLOTS.length];
        if (!overlapsOccupied(candidate, WHITE_LEAF_RADIUS)) {
          slot = candidate;
          break;
        }
      }
      if (!slot) continue;
      addOccupied(slot, WHITE_LEAF_RADIUS);
      leaves.push({
        id: `${cycleKey}:${index}`,
        x: slot.x,
        y: slot.y,
        angle: leafRandom(index + 31) * 90 - 45
      });
    }
    return leaves;
  }, []);

  const syncMintLeaves = useCallback((mintLeafState, counts) => {
    if (!mintLeafState) return;
    const previous = previousMintLeavesRef.current;
    const initialSync = previous === null;
    const sameCycle = previous?.cycleId === mintLeafState.cycleId;
    const currentLeaves = createMintLeafLayout(mintLeafState.leafCount, counts, `cycle-${mintLeafState.cycleId}`)
      .map((leaf, index) => ({
        ...leaf,
        arriving: !initialSync && (!sameCycle || index >= previous.leafCount)
      }));
    const now = Date.now() / 1000;
    const fallingLeaves = (mintLeafState.falls || []).flatMap(fall => {
      const elapsed = Math.max(0, now - fall.startedAt);
      const leaves = createMintLeafLayout(fall.leafCount, { boy: fall.boyCount, girl: fall.girlCount }, `fall-${fall.id}`);
      return leaves.map(leaf => ({ ...leaf, id: `${fall.id}:${leaf.id}`, fallElapsed: elapsed }));
    });
    previousMintLeavesRef.current = { cycleId: mintLeafState.cycleId, leafCount: mintLeafState.leafCount };
    setWhiteLeaves(currentLeaves);
    setFallingWhiteLeaves(fallingLeaves);
  }, [createMintLeafLayout]);

  const launch = useCallback((team, from, teamIndex) => {
    const next = { team, from, teamIndex, wind: Math.random() < 0.5 ? -1 : 1, phase: Math.random() * Math.PI * 2 };
    if (activeRef.current) queueRef.current.push(next);
    else {
      activeRef.current = true;
      setFlight(next);
    }
  }, []);

  const finishFlight = useCallback(() => {
    const next = queueRef.current.shift();
    if (next) setFlight(next);
    else {
      activeRef.current = false;
      setFlight(null);
    }
  }, []);

  const observeCounts = useCallback((counts, animateIncoming = false, mintLeafState = null) => {
    if (!counts) return;
    const previous = previousCountsRef.current;
    previousCountsRef.current = counts;
    syncMintLeaves(mintLeafState, counts);
    if (!previous || !animateIncoming) return;

    const newVotes = [];
    for (const team of ['boy', 'girl']) {
      const increase = Math.min(3 - newVotes.length, Math.max(0, counts[team] - previous[team]));
      for (let index = 0; index < increase; index += 1) {
        newVotes.push({ team, teamIndex: previous[team] + index });
      }
      if (newVotes.length === 3) break;
    }
    const tree = treeRef.current;
    if (!tree) return;
    const bounds = tree.getBoundingClientRect();
    for (const { team, teamIndex } of newVotes) {
      launch(team, {
        x: bounds.left + bounds.width * (0.36 + Math.random() * 0.28),
        y: bounds.top + bounds.height * 0.13
      }, teamIndex);
    }
  }, [launch, syncMintLeaves]);

  return { flight, targetLeafRef, treeRef, launch, finishFlight, observeCounts, whiteLeaves, fallingWhiteLeaves };
}

export function FallingLeaf({ flight, targetRef, onFinish }) {
  const leafRef = useRef(null);

  useEffect(() => {
    if (!flight) return;
    const leaf = leafRef.current;
    const target = targetRef.current;
    if (!leaf || !target || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onFinish();
      return;
    }

    const targetRect = target.getBoundingClientRect();
    const size = 34;
    const startX = flight.from.x - size / 2;
    const startY = flight.from.y - size / 2;
    const endX = targetRect.left + targetRect.width / 2 - size / 2;
    const endY = targetRect.top + targetRect.height / 2 - size / 2;
    const dx = endX - startX;
    const dy = endY - startY;
    const wind = flight.wind;
    const phase = flight.phase;
    const endScale = Math.max(0.2, targetRect.width / 27);
    const keyframes = Array.from({ length: 101 }, (_, index) => {
      const progress = index / 100;
      const envelope = Math.sin(Math.PI * progress);
      const sway = (Math.sin(progress * Math.PI * 4 + phase) - Math.sin(phase)) * envelope;
      const flutter = (Math.sin(progress * Math.PI * 6 + phase) - Math.sin(phase)) * envelope;
      const x = startX + dx * progress + sway * 20 * wind;
      const y = startY + dy * progress - envelope * 10 + flutter * 2.5;
      const rotation = -18 + 260 * progress + flutter * 8;
      const scale = 0.65 + (endScale - 0.65) * progress;
      return {
        offset: progress,
        transform: `translate3d(${x}px, ${y}px, 0) rotate(${rotation}deg) scale(${scale})`
      };
    });
    const animation = leaf.animate(keyframes, { duration: 5000, easing: 'linear', fill: 'forwards' });
    animation.onfinish = onFinish;
    return () => animation.cancel();
  }, [flight, onFinish, targetRef]);

  if (!flight) return null;
  return <svg ref={leafRef} className={`falling-vote-leaf leaf-${flight.team}`} viewBox="0 0 34 34" aria-hidden="true">
    <path d="M3 18Q12 2 30 4Q31 22 16 31Q5 29 3 18Z"/>
  </svg>;
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
  const [voteTreeVisible, setVoteTreeVisible] = useState(false);
  const { flight, targetLeafRef, treeRef, launch, finishFlight, observeCounts, whiteLeaves, fallingWhiteLeaves } = useVoteLeafFlight();
  const deviceId = useRef(localDeviceId());
  const headers = deviceId.current ? { 'X-Device-Id': deviceId.current } : {};

  const refresh = useCallback(async () => {
    try {
      const next = await api(`/api/reveal?i=${encodeURIComponent(token)}`, { headers });
      observeCounts(next.counts, view === 'results', next.mintLeaves);
      setSt(next);
      setOffline(false);
    }
    catch (e) { if (e.status === 404 || e.status === 400) setError(e.message); else setOffline(true); }
  }, [observeCounts, token, view]);

  // Actualización en vivo: consulta cada 3 s mientras la pestaña está visible.
  useEffect(() => {
    let timer;
    const loop = async () => { if (!document.hidden) await refresh(); timer = setTimeout(loop, POLL_MS); };
    loop();
    const onVis = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
  }, [refresh]);

  async function vote(choice, event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const from = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    setBusy(true); setError('');
    try {
      const r = await api('/api/vote', { method: 'POST', body: { token, choice }, headers });
      observeCounts(r.counts, false, r.mintLeaves);
      setSt(r);
      setVoteTreeVisible(true);
      launch(choice, from, r.counts[choice] - 1);
    }
    catch (e) { if (e.data && e.data.counts) setSt(e.data); setError(e.message); }
    finally { setBusy(false); }
  }

  if (error && !st) return <p className="status">{error}</p>;
  if (!st) return <div className="vote-card"><p className="status">Cargando votación…</p></div>;

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
          {['boy', 'girl'].map(c => <button key={c} type="button" className={`reveal-team team-${c}`} disabled={busy} onClick={(event) => vote(c, event)}>
            <span>{c === 'boy' ? '¡Niño!' : '¡Niña!'}</span>
          </button>)}
        </div>
        <p className="vote-anonymity vote-privacy-note">Vota una vez por cada persona de esta invitación. Tu voto será anónimo.</p>
      </>
      : <p className="vote-anonymity">{myVote ? `Ya se registraron los ${st.guestVoteCount} votos de esta invitación.` : !st.voteOpen ? 'La votación está cerrada. Continúa para ver los resultados.' : 'Los votos de esta invitación ya fueron registrados.'}</p>}
    {error && <p className="reveal-note" role="alert">{error}</p>}
    {canContinue && <button className="reveal-primary vote-results-next" type="button" onClick={onShowResults}>Ver resultados en vivo</button>}
    {view === 'vote' && voteTreeVisible && <div className="vote-tree-preview" aria-label="Tu hoja en el árbol de votos">
      <VotingTree boyCount={st.counts.boy} girlCount={st.counts.girl} whiteLeaves={whiteLeaves} fallingWhiteLeaves={fallingWhiteLeaves} lastVote={flight?.team || myVote} lastVoteIndex={flight?.teamIndex} hideLastLeaf={!!flight} targetLeafRef={targetLeafRef} treeRef={treeRef}/>
    </div>}
    {view === 'vote' && <FallingLeaf flight={flight} targetRef={targetLeafRef} onFinish={finishFlight}/>}
  </div>;

  return <div className="reveal-results-content" aria-live="polite">
    {offline && <p className="live reveal-live off"><span className="dot"/>Reconectando…</p>}
    {st.revealed && <div className={`reveal-banner reveal-${st.result}`}>
      <Confetti kind={st.result}/>
      <p className="reveal-small">¡El secreto fue revelado!</p>
      <p className="reveal-big">{st.result === 'boy' ? '¡Es un niño!' : '¡Es una niña!'} {EMOJI[st.result]}</p>
    </div>}
    <VotingTree boyCount={st.counts.boy} girlCount={st.counts.girl} whiteLeaves={whiteLeaves} fallingWhiteLeaves={fallingWhiteLeaves} lastVote={flight?.team || myVote} lastVoteIndex={flight?.teamIndex} hideLastLeaf={!!flight} targetLeafRef={targetLeafRef} treeRef={treeRef}/>
    <p className="reveal-note">{st.revealed ? 'El secreto ya fue revelado.' : st.voteOpen ? 'Los votos se actualizan en tiempo real; la revelación oficial sigue pendiente.' : 'La votación está cerrada. La revelación oficial sigue pendiente.'}</p>
    {canVote && <button className="reveal-primary results-vote-button" type="button" onClick={onShowResults}>{myVotes.length ? 'Votar por otra persona' : 'Votar por tu equipo'}</button>}
  </div>;
}
