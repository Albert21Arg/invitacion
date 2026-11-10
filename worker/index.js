// Carta Sellada — Worker: invitación pública, RSVP, panel admin y Open Graph.
const enc = new TextEncoder();
const PBKDF2_ITER = 100000; // máximo permitido por WebCrypto en Workers
const SESSION_TTL = 7 * 24 * 3600; // segundos

/* ---------- utilidades ---------- */
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
});
const uuid = () => crypto.randomUUID();
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomToken = (n = 24) => b64url(crypto.getRandomValues(new Uint8Array(n)));
async function sha256(value) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(value))); }
function safeEqual(a, b) {
  const x = String(a), y = String(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}
const clientIp = (req) => req.headers.get('cf-connecting-ip') || 'local';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (v, max) => String(v ?? '').trim().slice(0, max);

/* ---------- contraseñas (PBKDF2-SHA256) ---------- */
async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${hex(salt)}$${await pbkdf2(password, salt, PBKDF2_ITER)}`;
}
async function verifyPassword(password, stored) {
  const [alg, iter, saltHex, hash] = String(stored).split('$');
  if (alg !== 'pbkdf2') return false;
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  return safeEqual(await pbkdf2(password, salt, Number(iter)), hash);
}
const DUMMY_HASH = 'pbkdf2$100000$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000';

/* ---------- rate limiting en D1 ---------- */
async function rateLimit(env, key, limit, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(`INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN window_start <= ?3 THEN 1 ELSE count + 1 END,
      window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END
    RETURNING count`).bind(key, now, now - windowSec).first();
  if (Math.random() < 0.01) await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - 86400).run();
  return row.count <= limit;
}

/* ---------- Turnstile (opcional: se activa si existe TURNSTILE_SECRET) ---------- */
async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET); form.append('response', token); form.append('remoteip', ip);
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    return (await r.json()).success === true;
  } catch { return false; }
}

/* ---------- sesiones ---------- */
const isHttps = (url) => url.protocol === 'https:';
const cookieName = (url) => (isHttps(url) ? '__Host-cs_session' : 'cs_session');
function readCookie(req, name) {
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
const sessionCookie = (url, value, maxAge) =>
  `${cookieName(url)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(url) ? '; Secure' : ''}`;

async function createSession(env, url, adminId) {
  const token = randomToken(32), csrf = randomToken(24);
  await env.DB.prepare('INSERT INTO sessions (token_hash, admin_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), adminId, csrf, Math.floor(Date.now() / 1000) + SESSION_TTL).run();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Math.floor(Date.now() / 1000)).run();
  return { cookie: sessionCookie(url, token, SESSION_TTL), csrf };
}
async function getSession(env, req, url) {
  const token = readCookie(req, cookieName(url));
  if (!token) return null;
  const row = await env.DB.prepare(`SELECT s.token_hash, s.csrf_token, s.expires_at, a.id AS admin_id, a.email
    FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ?`).bind(await sha256(token)).first();
  if (!row || row.expires_at < Math.floor(Date.now() / 1000)) return null;
  return row;
}
// Defensa CSRF: Origin debe coincidir + cabecera personalizada con token de sesión.
function csrfOk(req, url, session) {
  const origin = req.headers.get('origin');
  if (origin && origin !== url.origin) return false;
  return safeEqual(req.headers.get('x-csrf-token') || '', session.csrf_token);
}

/* ---------- validación de eventos ---------- */
const slugify = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'evento';
function parseEvent(body) {
  const title = clean(body.title, 120);
  if (!title) return { error: 'El título es obligatorio.' };
  const date = clean(body.event_date, 10), time = clean(body.event_time, 5);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Fecha inválida.' };
  if (time && !/^\d{2}:\d{2}$/.test(time)) return { error: 'Hora inválida.' };
  const status = ['draft', 'published', 'closed'].includes(body.status) ? body.status : 'draft';
  const event_type = body.event_type === 'gender_reveal' ? 'gender_reveal' : 'baby_shower';
  return { value: {
    title, status, event_type, event_date: date || null, event_time: time || null,
    baby_name: clean(body.baby_name, 120) || null, parent_names: clean(body.parent_names, 160) || null,
    venue: clean(body.venue, 160) || null, address: clean(body.address, 240) || null, message: clean(body.message, 600) || null
  } };
}
const EVENT_COLS = 'id, slug, title, baby_name, parent_names, event_date, event_time, venue, address, message, status, event_type, vote_status, reveal_result, revealed_at, created_at';

/* ---------- API pública ---------- */
async function publicInvitation(env, req, url) {
  const token = clean(url.searchParams.get('i'), 200);
  if (!token) return json({ error: 'Falta el enlace de invitación.' }, 400);
  if (!(await rateLimit(env, `inv:${clientIp(req)}`, 400, 300))) return json({ error: 'Demasiados intentos. Intenta más tarde.' }, 429);
  const row = await env.DB.prepare(`SELECT g.name AS guest_name, g.max_guests, e.title, e.baby_name, e.parent_names, e.event_date, e.event_time,
      e.venue, e.address, e.message, e.status, e.event_type, r.attendance, r.guest_count, r.message AS rsvp_message
    FROM guests g JOIN events e ON e.id = g.event_id LEFT JOIN rsvps r ON r.guest_id = g.id WHERE g.token_hash = ?`).bind(await sha256(token)).first();
  if (!row || row.status === 'draft') return json({ error: 'El enlace de invitación no es válido.' }, 404);
  await env.DB.prepare("UPDATE guests SET opened_at = COALESCE(opened_at, datetime('now')) WHERE token_hash = ?").bind(await sha256(token)).run();
  return json({
    guest: { name: row.guest_name, maxGuests: row.max_guests },
    event: { title: row.title, babyName: row.baby_name, parentNames: row.parent_names, date: row.event_date, time: row.event_time, venue: row.venue, address: row.address, message: row.message, closed: row.status === 'closed', type: row.event_type },
    rsvp: row.attendance ? { attendance: row.attendance, guestCount: row.guest_count, message: row.rsvp_message || '' } : null
  });
}

async function publicRsvp(env, req) {
  const ip = clientIp(req);
  if (!(await rateLimit(env, `rsvp:${ip}`, 120, 600))) return json({ error: 'Demasiados intentos. Intenta más tarde.' }, 429);
  let body; try { body = await req.json(); } catch { return json({ error: 'JSON inválido.' }, 400); }
  const token = clean(body.token, 200);
  const attendance = body.attendance === 'yes' ? 'yes' : body.attendance === 'no' ? 'no' : '';
  const guestCount = Number(body.guestCount ?? 0);
  const message = clean(body.message, 1000);
  if (!token || !attendance || !Number.isInteger(guestCount) || guestCount < 0 || guestCount > 20) return json({ error: 'Revisa los datos ingresados.' }, 400);
  if (!(await verifyTurnstile(env, body.turnstileToken, ip))) return json({ error: 'No pudimos verificar que eres una persona. Intenta de nuevo.' }, 403);
  const guest = await env.DB.prepare(`SELECT g.id, g.max_guests, e.status FROM guests g JOIN events e ON e.id = g.event_id WHERE g.token_hash = ?`).bind(await sha256(token)).first();
  if (!guest || guest.status === 'draft') return json({ error: 'El enlace de invitación no es válido.' }, 404);
  if (guest.status === 'closed') return json({ error: 'Las confirmaciones para este evento ya están cerradas.' }, 403);
  if (attendance === 'yes' && (guestCount < 1 || guestCount > guest.max_guests)) return json({ error: `Esta invitación permite entre 1 y ${guest.max_guests} asistentes.` }, 400);
  await env.DB.prepare(`INSERT INTO rsvps (id, guest_id, attendance, guest_count, message, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(guest_id) DO UPDATE SET attendance=excluded.attendance, guest_count=excluded.guest_count, message=excluded.message, updated_at=datetime('now')`)
    .bind(uuid(), guest.id, attendance, attendance === 'yes' ? guestCount : 0, message).run();
  return json({ ok: true, message: 'Respuesta guardada.' });
}

/* ---------- Votación de la revelación (niño / niña) ---------- */
const deviceCookieName = (url) => (isHttps(url) ? '__Host-cs_device' : 'cs_device');
async function guestContext(env, token) {
  return env.DB.prepare(`SELECT g.id AS guest_id, g.max_guests, e.id AS event_id, e.status, e.event_type, e.vote_status, e.reveal_result, e.revealed_at
    FROM guests g JOIN events e ON e.id = g.event_id WHERE g.token_hash = ?`).bind(await sha256(token)).first();
}
// Se conserva la identidad del dispositivo para recuperar los votos que ya registró.
async function deviceIds(req, url) {
  let value = readCookie(req, deviceCookieName(url)), isNew = false;
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(value)) { value = randomToken(24); isNew = true; }
  const local = clean(req.headers.get('x-device-id'), 64);
  return {
    cookieHash: await sha256('c:' + value), localHash: /^[A-Za-z0-9-]{16,64}$/.test(local) ? await sha256('l:' + local) : null,
    setCookie: isNew ? `${deviceCookieName(url)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${isHttps(url) ? '; Secure' : ''}` : null
  };
}
async function voteCounts(env, eventId) {
  const { results } = await env.DB.prepare('SELECT choice, COUNT(*) AS n FROM votes WHERE event_id = ? GROUP BY choice').bind(eventId).all();
  const c = { boy: 0, girl: 0 };
  for (const r of results) c[r.choice] = r.n;
  return c;
}
const MINT_LEAF_INTERVAL_SECONDS = 30;
const MINT_LEAF_CYCLE_SECONDS = 3600;
const MINT_LEAF_CYCLE_SIZE = MINT_LEAF_CYCLE_SECONDS / MINT_LEAF_INTERVAL_SECONDS;
const MINT_LEAF_FALL_WINDOW_SECONDS = 10;

async function ensureMintLeafCycle(env, scopeKey) {
  await env.DB.prepare('INSERT OR IGNORE INTO mint_leaf_cycles (scope_key, cycle_started_at) VALUES (?, ?)')
    .bind(scopeKey, Math.floor(Date.now() / 1000)).run();
}

async function mintLeafState(env, scopeKey, counts) {
  const now = Math.floor(Date.now() / 1000);
  await ensureMintLeafCycle(env, scopeKey);
  let cycle = await env.DB.prepare('SELECT cycle_id, cycle_started_at FROM mint_leaf_cycles WHERE scope_key = ?')
    .bind(scopeKey).first();
  const elapsed = now - cycle.cycle_started_at;
  if (elapsed >= MINT_LEAF_CYCLE_SECONDS) {
    const completedCycles = Math.floor(elapsed / MINT_LEAF_CYCLE_SECONDS);
    const nextCycleId = cycle.cycle_id + completedCycles;
    const nextStart = cycle.cycle_started_at + completedCycles * MINT_LEAF_CYCLE_SECONDS;
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO mint_leaf_falls
        (id, scope_key, cycle_id, leaf_count, boy_count, girl_count, started_at)
        SELECT ?, scope_key, cycle_id, MIN(?, CAST((? - cycle_started_at) / ? AS INTEGER)), ?, ?, ?
        FROM mint_leaf_cycles WHERE scope_key = ? AND cycle_id = ? AND cycle_started_at = ?
          AND (? - cycle_started_at) >= ?`)
        .bind(uuid(), MINT_LEAF_CYCLE_SIZE, now, MINT_LEAF_INTERVAL_SECONDS, counts.boy, counts.girl, now,
          scopeKey, cycle.cycle_id, cycle.cycle_started_at, now, MINT_LEAF_CYCLE_SECONDS),
      env.DB.prepare(`UPDATE mint_leaf_cycles SET cycle_id = ?, cycle_started_at = ?
        WHERE scope_key = ? AND cycle_id = ? AND cycle_started_at = ?`)
        .bind(nextCycleId, nextStart, scopeKey, cycle.cycle_id, cycle.cycle_started_at)
    ]);
    cycle = await env.DB.prepare('SELECT cycle_id, cycle_started_at FROM mint_leaf_cycles WHERE scope_key = ?')
      .bind(scopeKey).first();
  }

  await env.DB.prepare('DELETE FROM mint_leaf_falls WHERE scope_key = ? AND started_at < ?')
    .bind(scopeKey, now - 60).run();
  const { results: falls } = await env.DB.prepare(`SELECT id, leaf_count AS leafCount, boy_count AS boyCount,
      girl_count AS girlCount, started_at AS startedAt
    FROM mint_leaf_falls WHERE scope_key = ? AND started_at >= ? ORDER BY started_at`)
    .bind(scopeKey, now - MINT_LEAF_FALL_WINDOW_SECONDS).all();
  return {
    cycleId: cycle.cycle_id,
    leafCount: Math.min(MINT_LEAF_CYCLE_SIZE, Math.floor(Math.max(0, now - cycle.cycle_started_at) / MINT_LEAF_INTERVAL_SECONDS)),
    falls
  };
}

async function resetMintLeafCycle(env, scopeKey, counts) {
  const now = Math.floor(Date.now() / 1000);
  await ensureMintLeafCycle(env, scopeKey);
  const cycle = await env.DB.prepare('SELECT cycle_id, cycle_started_at FROM mint_leaf_cycles WHERE scope_key = ?')
    .bind(scopeKey).first();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO mint_leaf_falls
      (id, scope_key, cycle_id, leaf_count, boy_count, girl_count, started_at)
      SELECT ?, scope_key, cycle_id, MIN(?, CAST((? - cycle_started_at) / ? AS INTEGER)), ?, ?, ?
      FROM mint_leaf_cycles WHERE scope_key = ? AND cycle_id = ? AND cycle_started_at = ?
        AND (? - cycle_started_at) >= ?`)
      .bind(uuid(), MINT_LEAF_CYCLE_SIZE, now, MINT_LEAF_INTERVAL_SECONDS, counts.boy, counts.girl, now,
        scopeKey, cycle.cycle_id, cycle.cycle_started_at, now, MINT_LEAF_INTERVAL_SECONDS),
    env.DB.prepare(`UPDATE mint_leaf_cycles SET cycle_id = cycle_id + 1, cycle_started_at = ?
      WHERE scope_key = ? AND cycle_id = ? AND cycle_started_at = ?`)
      .bind(now, scopeKey, cycle.cycle_id, cycle.cycle_started_at)
  ]);
}

async function voteState(env, ctx, ids) {
  const counts = await voteCounts(env, ctx.event_id);
  const { results: guestVoteResults } = await env.DB.prepare('SELECT choice, COUNT(*) AS n FROM votes WHERE guest_id = ? GROUP BY choice').bind(ctx.guest_id).all();
  const guestCounts = { boy: 0, girl: 0 };
  for (const row of guestVoteResults) guestCounts[row.choice] = row.n;
  const guestVoteCount = guestCounts.boy + guestCounts.girl;
  const mine = await env.DB.prepare(`SELECT choice FROM votes WHERE event_id = ?1
    AND (cookie_hash = ?2 OR (?3 IS NOT NULL AND local_hash = ?3)) ORDER BY rowid`)
    .bind(ctx.event_id, ids.cookieHash, ids.localHash).all();
  const myVotes = mine.results.map((row) => row.choice);
  const revealed = !!ctx.revealed_at;
  return { counts, total: counts.boy + counts.girl, guestCounts, myVotes, myVote: myVotes.at(-1) || null,
    guestVoteCount, guestVoteLimit: ctx.max_guests, voteOpen: ctx.vote_status === 'open' && !revealed,
    revealed, result: revealed ? ctx.reveal_result : null,
    mintLeaves: await mintLeafState(env, `event:${ctx.event_id}`, counts) };
}
async function publicRevealState(env, req, url) {
  const token = clean(url.searchParams.get('i'), 200);
  if (!token) return json({ error: 'Falta el enlace de invitación.' }, 400);
  const ctx = await guestContext(env, token);
  if (!ctx || ctx.status === 'draft') return json({ error: 'El enlace de invitación no es válido.' }, 404);
  if (ctx.event_type !== 'gender_reveal') return json({ error: 'Este evento no tiene votación.' }, 400);
  const ids = await deviceIds(req, url);
  return json(await voteState(env, ctx, ids), 200, ids.setCookie ? { 'set-cookie': ids.setCookie } : {});
}
async function publicVote(env, req, url) {
  if (!(await rateLimit(env, `vote:${clientIp(req)}`, 300, 600))) return json({ error: 'Demasiados intentos. Intenta más tarde.' }, 429);
  let b; try { b = await req.json(); } catch { return json({ error: 'JSON inválido.' }, 400); }
  const token = clean(b.token, 200), choice = b.choice === 'boy' ? 'boy' : b.choice === 'girl' ? 'girl' : '';
  if (!token || !choice) return json({ error: 'Elige niño o niña.' }, 400);
  const ctx = await guestContext(env, token);
  if (!ctx || ctx.status === 'draft') return json({ error: 'El enlace de invitación no es válido.' }, 404);
  if (ctx.event_type !== 'gender_reveal') return json({ error: 'Este evento no tiene votación.' }, 400);
  const ids = await deviceIds(req, url);
  const headers = ids.setCookie ? { 'set-cookie': ids.setCookie } : {};
  const state = () => voteState(env, ctx, ids);
  if (ctx.revealed_at || ctx.vote_status !== 'open') return json({ error: 'La votación ya está cerrada.', ...(await state()) }, 403, headers);
  const before = await state();
  if (before.guestVoteCount >= before.guestVoteLimit) return json({ error: `Esta invitación ya usó sus ${before.guestVoteLimit} voto${before.guestVoteLimit > 1 ? 's' : ''}.`, ...before }, 403, headers);
  const inserted = await env.DB.prepare(`INSERT INTO votes (id, event_id, guest_id, choice, cookie_hash, local_hash)
    SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM votes WHERE guest_id = ?) < ?`)
    .bind(uuid(), ctx.event_id, ctx.guest_id, choice, ids.cookieHash, ids.localHash, ctx.guest_id, ctx.max_guests).run();
  if (!inserted.meta.changes) {
    const latest = await state();
    return json({ error: `Esta invitación ya usó sus ${before.guestVoteLimit} voto${before.guestVoteLimit > 1 ? 's' : ''}.`, ...latest }, 403, headers);
  }
  await resetMintLeafCycle(env, `event:${ctx.event_id}`, await voteCounts(env, ctx.event_id));
  return json({ ok: true, ...(await state()) }, 200, headers);
}

async function standalonePollState(env, poll, ids) {
  const { results } = await env.DB.prepare('SELECT choice, COUNT(*) AS n FROM standalone_poll_votes WHERE poll_id = ? GROUP BY choice').bind(poll.id).all();
  const counts = { boy: 0, girl: 0 };
  for (const row of results) counts[row.choice] = row.n;
  const mine = await env.DB.prepare(`SELECT choice FROM standalone_poll_votes WHERE poll_id = ?1
    AND (cookie_hash = ?2 OR (?3 IS NOT NULL AND local_hash = ?3))`).bind(poll.id, ids.cookieHash, ids.localHash).first();
  const total = counts.boy + counts.girl;
  const revealed = !!poll.revealed_at;
  return { poll: { title: poll.title, status: poll.status }, counts, total, myVote: mine?.choice || null, voteOpen: poll.status === 'open',
    revealed, result: revealed ? poll.reveal_result : null,
    mintLeaves: await mintLeafState(env, `poll:${poll.id}`, counts) };
}
async function publicPollState(env, req, url, slug) {
  const poll = await env.DB.prepare('SELECT id, title, status, reveal_result, revealed_at FROM standalone_polls WHERE slug = ?').bind(slug).first();
  if (!poll) return json({ error: 'No encontramos esta votación.' }, 404);
  const ids = await deviceIds(req, url);
  return json(await standalonePollState(env, poll, ids), 200, ids.setCookie ? { 'set-cookie': ids.setCookie } : {});
}
async function publicPollVote(env, req, url, slug) {
  if (!(await rateLimit(env, `poll-vote:${clientIp(req)}`, 120, 600))) return json({ error: 'Demasiados intentos. Intenta más tarde.' }, 429);
  let body; try { body = await req.json(); } catch { return json({ error: 'JSON inválido.' }, 400); }
  const choice = body.choice === 'boy' ? 'boy' : body.choice === 'girl' ? 'girl' : '';
  if (!choice) return json({ error: 'Elige una opción para votar.' }, 400);
  const poll = await env.DB.prepare('SELECT id, title, status, reveal_result, revealed_at FROM standalone_polls WHERE slug = ?').bind(slug).first();
  if (!poll) return json({ error: 'No encontramos esta votación.' }, 404);
  const ids = await deviceIds(req, url);
  const headers = ids.setCookie ? { 'set-cookie': ids.setCookie } : {};
  if (poll.status !== 'open') return json({ error: 'La votación está cerrada.', ...(await standalonePollState(env, poll, ids)) }, 403, headers);
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO standalone_poll_votes (id, poll_id, choice, cookie_hash, local_hash)
    SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM standalone_poll_votes WHERE poll_id = ?
        AND (cookie_hash = ? OR (? IS NOT NULL AND local_hash = ?))
    )`).bind(uuid(), poll.id, choice, ids.cookieHash, ids.localHash, poll.id, ids.cookieHash, ids.localHash, ids.localHash).run();
  const state = await standalonePollState(env, poll, ids);
  if (!inserted.meta.changes) return json({ error: 'Este dispositivo ya registró su voto.', ...state }, 409, headers);
  await resetMintLeafCycle(env, `poll:${poll.id}`, state.counts);
  return json({ ok: true, ...(await standalonePollState(env, poll, ids)) }, 200, headers);
}

/* ---------- API de administración ---------- */
async function adminSetup(env, req, url) {
  if (!env.ADMIN_SETUP_KEY) return json({ error: 'La configuración inicial está deshabilitada.' }, 403);
  if (!(await rateLimit(env, `setup:${clientIp(req)}`, 5, 900))) return json({ error: 'Demasiados intentos.' }, 429);
  let b; try { b = await req.json(); } catch { return json({ error: 'JSON inválido.' }, 400); }
  const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM admins').first();
  if (existing.n > 0) return json({ error: 'Ya existe un administrador.' }, 403);
  if (!safeEqual(String(b.setupKey || ''), env.ADMIN_SETUP_KEY)) return json({ error: 'Clave de configuración incorrecta.' }, 403);
  const email = clean(b.email, 200).toLowerCase(), password = String(b.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Correo inválido.' }, 400);
  if (password.length < 12 || password.length > 200) return json({ error: 'La contraseña debe tener al menos 12 caracteres.' }, 400);
  const adminId = uuid();
  await env.DB.prepare('INSERT INTO admins (id, email, password_hash) VALUES (?, ?, ?)').bind(adminId, email, await hashPassword(password)).run();
  const s = await createSession(env, url, adminId);
  return json({ ok: true, email, csrfToken: s.csrf }, 200, { 'set-cookie': s.cookie });
}

async function adminLogin(env, req, url) {
  const ip = clientIp(req);
  if (!(await rateLimit(env, `login:${ip}`, 10, 900))) return json({ error: 'Demasiados intentos. Espera unos minutos.' }, 429);
  let b; try { b = await req.json(); } catch { return json({ error: 'JSON inválido.' }, 400); }
  const email = clean(b.email, 200).toLowerCase(), password = String(b.password || '').slice(0, 200);
  if (!(await rateLimit(env, `loginacct:${email}`, 8, 900))) return json({ error: 'Demasiados intentos. Espera unos minutos.' }, 429);
  if (!(await verifyTurnstile(env, b.turnstileToken, ip))) return json({ error: 'Verificación fallida. Intenta de nuevo.' }, 403);
  const admin = await env.DB.prepare('SELECT id, email, password_hash FROM admins WHERE email = ?').bind(email).first();
  const ok = await verifyPassword(password, admin ? admin.password_hash : DUMMY_HASH); // costo constante
  if (!admin || !ok) return json({ error: 'Correo o contraseña incorrectos.' }, 401);
  const s = await createSession(env, url, admin.id);
  return json({ ok: true, email: admin.email, csrfToken: s.csrf }, 200, { 'set-cookie': s.cookie });
}

async function handleAdmin(env, req, url, path) {
  const method = req.method;
  if (path === '/setup' && method === 'POST') return adminSetup(env, req, url);
  if (path === '/login' && method === 'POST') return adminLogin(env, req, url);
  if (path === '/status' && method === 'GET') {
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM admins').first();
    return json({ needsSetup: n.n === 0 && !!env.ADMIN_SETUP_KEY });
  }
  const session = await getSession(env, req, url);
  if (!session) return json({ error: 'No autorizado.' }, 401);
  if (path === '/me' && method === 'GET') return json({ email: session.email, csrfToken: session.csrf_token });
  if (method !== 'GET' && !csrfOk(req, url, session)) return json({ error: 'Solicitud rechazada (CSRF).' }, 403);
  if (path === '/logout' && method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.token_hash).run();
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(url, '', 0) });
  }
  const body = async () => { try { return await req.json(); } catch { return null; } };
  let m;

  if (path === '/events' && method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT e.${EVENT_COLS.split(', ').join(', e.')},
        (SELECT COUNT(*) FROM guests g WHERE g.event_id = e.id) AS guests,
        (SELECT COUNT(*) FROM rsvps r JOIN guests g ON g.id = r.guest_id WHERE g.event_id = e.id) AS responses
      FROM events e ORDER BY e.created_at DESC`).all();
    return json({ events: results });
  }
  if (path === '/polls' && method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT p.id, p.slug, p.title, p.status, p.reveal_result, p.revealed_at, p.created_at,
        COUNT(v.id) AS votes,
        SUM(CASE WHEN v.choice = 'boy' THEN 1 ELSE 0 END) AS boy_votes,
        SUM(CASE WHEN v.choice = 'girl' THEN 1 ELSE 0 END) AS girl_votes
      FROM standalone_polls p LEFT JOIN standalone_poll_votes v ON v.poll_id = p.id
      GROUP BY p.id ORDER BY p.created_at DESC`).all();
    return json({ polls: results });
  }
  if (path === '/polls' && method === 'POST') {
    const b = await body(); if (!b) return json({ error: 'JSON inválido.' }, 400);
    const title = clean(b.title, 120);
    if (!title) return json({ error: 'Escribe la pregunta de la votación.' }, 400);
    const id = uuid(), slug = `${slugify(title)}-${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    await env.DB.prepare('INSERT INTO standalone_polls (id, slug, title) VALUES (?, ?, ?)').bind(id, slug, title).run();
    return json({ ok: true, id, slug }, 201);
  }
  if ((m = path.match(/^\/polls\/([\w-]+)$/))) {
    const poll = await env.DB.prepare('SELECT id, status, revealed_at FROM standalone_polls WHERE id = ?').bind(m[1]).first();
    if (!poll) return json({ error: 'Votación no encontrada.' }, 404);
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM standalone_polls WHERE id = ?').bind(m[1]).run();
      return json({ ok: true });
    }
    if (method === 'PUT') {
      const b = await body(); if (!b) return json({ error: 'JSON inválido.' }, 400);
      if (b.action === 'reveal') {
        if (!['boy', 'girl'].includes(b.result)) return json({ error: 'Resultado inválido.' }, 400);
        await env.DB.prepare("UPDATE standalone_polls SET reveal_result = ?, revealed_at = datetime('now'), status = 'closed' WHERE id = ?").bind(b.result, m[1]).run();
        return json({ ok: true });
      }
      if (b.action === 'hide') {
        await env.DB.prepare('UPDATE standalone_polls SET reveal_result = NULL, revealed_at = NULL WHERE id = ?').bind(m[1]).run();
        return json({ ok: true });
      }
      if (!['open', 'closed'].includes(b.status)) return json({ error: 'Estado inválido.' }, 400);
      if (b.status === 'open' && poll.revealed_at) return json({ error: 'Oculta el resultado antes de reabrir la votación.' }, 400);
      await env.DB.prepare('UPDATE standalone_polls SET status = ? WHERE id = ?').bind(b.status, m[1]).run();
      return json({ ok: true });
    }
  }
  if (path === '/events' && method === 'POST') {
    const b = await body(); if (!b) return json({ error: 'JSON inválido.' }, 400);
    const p = parseEvent(b); if (p.error) return json({ error: p.error }, 400);
    const v = p.value, eid = uuid(), slug = `${slugify(v.title)}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    await env.DB.prepare(`INSERT INTO events (id, slug, title, baby_name, parent_names, event_date, event_time, venue, address, message, status, event_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(eid, slug, v.title, v.baby_name, v.parent_names, v.event_date, v.event_time, v.venue, v.address, v.message, v.status, v.event_type).run();
    return json({ ok: true, id: eid }, 201);
  }
  if ((m = path.match(/^\/events\/([\w-]+)$/))) {
    const eid = m[1];
    if (method === 'GET') {
      const event = await env.DB.prepare(`SELECT ${EVENT_COLS} FROM events WHERE id = ?`).bind(eid).first();
      if (!event) return json({ error: 'Evento no encontrado.' }, 404);
      const { results } = await env.DB.prepare(`SELECT g.id, g.name, g.phone, g.max_guests, g.created_at, g.opened_at, r.attendance, r.guest_count, r.message, r.updated_at AS responded_at
        FROM guests g LEFT JOIN rsvps r ON r.guest_id = g.id WHERE g.event_id = ? ORDER BY g.created_at DESC`).bind(eid).all();
      const votes = await voteCounts(env, eid);
      return json({ event, guests: results, votes });
    }
    if (method === 'PUT') {
      const b = await body(); if (!b) return json({ error: 'JSON inválido.' }, 400);
      const p = parseEvent(b); if (p.error) return json({ error: p.error }, 400);
      const v = p.value;
      const r = await env.DB.prepare(`UPDATE events SET title=?, baby_name=?, parent_names=?, event_date=?, event_time=?, venue=?, address=?, message=?, status=?, event_type=? WHERE id=?`)
        .bind(v.title, v.baby_name, v.parent_names, v.event_date, v.event_time, v.venue, v.address, v.message, v.status, v.event_type, eid).run();
      if (!r.meta.changes) return json({ error: 'Evento no encontrado.' }, 404);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM events WHERE id = ?').bind(eid).run();
      return json({ ok: true });
    }
  }
  if ((m = path.match(/^\/events\/([\w-]+)\/reveal$/)) && method === 'POST') {
    const b = await body(); if (!b) return json({ error: 'JSON inválido.' }, 400);
    const ev = await env.DB.prepare('SELECT id, event_type, revealed_at FROM events WHERE id = ?').bind(m[1]).first();
    if (!ev) return json({ error: 'Evento no encontrado.' }, 404);
    if (ev.event_type !== 'gender_reveal') return json({ error: 'Este evento no es una revelación.' }, 400);
    if (b.action === 'close') await env.DB.prepare("UPDATE events SET vote_status='closed' WHERE id=?").bind(ev.id).run();
    else if (b.action === 'open') {
      if (ev.revealed_at) return json({ error: 'Primero oculta el resultado para reabrir la votación.' }, 400);
      await env.DB.prepare("UPDATE events SET vote_status='open' WHERE id=?").bind(ev.id).run();
    } else if (b.action === 'reveal') {
      if (!['boy', 'girl'].includes(b.result)) return json({ error: 'Resultado inválido.' }, 400);
      await env.DB.prepare("UPDATE events SET reveal_result=?, revealed_at=datetime('now'), vote_status='closed' WHERE id=?").bind(b.result, ev.id).run();
    } else if (b.action === 'hide') {
      await env.DB.prepare('UPDATE events SET reveal_result=NULL, revealed_at=NULL WHERE id=?').bind(ev.id).run();
    } else return json({ error: 'Acción inválida.' }, 400);
    return json({ ok: true });
  }
  if ((m = path.match(/^\/events\/([\w-]+)\/guests$/)) && method === 'POST') {
    const eid = m[1];
    const ev = await env.DB.prepare('SELECT id FROM events WHERE id = ?').bind(eid).first();
    if (!ev) return json({ error: 'Evento no encontrado.' }, 404);
    const b = await body(); if (!b) return json({ error: 'JSON inválido.' }, 400);
    const name = clean(b.name, 120), phone = clean(b.phone, 30) || null, max = Number(b.max_guests ?? 1);
    if (!name) return json({ error: 'El nombre es obligatorio.' }, 400);
    if (!Number.isInteger(max) || max < 1 || max > 20) return json({ error: 'Cupos inválidos (1 a 20).' }, 400);
    const token = randomToken(24), gid = uuid();
    await env.DB.prepare('INSERT INTO guests (id, event_id, name, phone, token_hash, max_guests) VALUES (?,?,?,?,?,?)')
      .bind(gid, eid, name, phone, await sha256(token), max).run();
    return json({ ok: true, id: gid, link: `${url.origin}/?i=${token}` }, 201); // el token en claro solo se muestra aquí
  }
  if ((m = path.match(/^\/guests\/([\w-]+)$/))) {
    if (method === 'PUT') {
      const b = await body(); if (!b) return json({ error: 'JSON inválido.' }, 400);
      const name = clean(b.name, 120), phone = clean(b.phone, 30) || null, max = Number(b.max_guests ?? 1);
      if (!name || !Number.isInteger(max) || max < 1 || max > 20) return json({ error: 'Datos inválidos.' }, 400);
      const r = await env.DB.prepare('UPDATE guests SET name=?, phone=?, max_guests=? WHERE id=?').bind(name, phone, max, m[1]).run();
      return r.meta.changes ? json({ ok: true }) : json({ error: 'Invitado no encontrado.' }, 404);
    }
    if (method === 'DELETE') { await env.DB.prepare('DELETE FROM guests WHERE id = ?').bind(m[1]).run(); return json({ ok: true }); }
  }
  if ((m = path.match(/^\/guests\/([\w-]+)\/regenerate$/)) && method === 'POST') {
    const token = randomToken(24); // invalida el enlace anterior
    const r = await env.DB.prepare('UPDATE guests SET token_hash = ? WHERE id = ?').bind(await sha256(token), m[1]).run();
    return r.meta.changes ? json({ ok: true, link: `${url.origin}/?i=${token}` }) : json({ error: 'Invitado no encontrado.' }, 404);
  }
  return json({ error: 'Ruta no encontrada.' }, 404);
}

/* ---------- Open Graph dinámico ---------- */
function fmtDateEs(iso) {
  if (!iso) return '';
  const [y, mo, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, mo - 1, d)));
}
async function pageWithOpenGraph(env, req, url) {
  const res = await env.ASSETS.fetch(new Request(new URL('/', url), req));
  const token = clean(url.searchParams.get('i'), 200);
  const headers = new Headers(res.headers);
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Cache-Control', 'private, no-store');
  const pollSlug = clean(url.searchParams.get('poll'), 100);
  if (!token && pollSlug) {
    const poll = await env.DB.prepare('SELECT title FROM standalone_polls WHERE slug = ?').bind(pollSlug).first();
    if (poll) {
      const title = `Invitación a votar · ${poll.title}`;
      const description = 'Vota y sé parte de esta dulce sorpresa.';
      const image = `${url.origin}/og-voting.png`;
      const tags = `<meta property="og:type" content="website"/><meta property="og:locale" content="es_CO"/><meta property="og:site_name" content="Invitación"/>
<meta property="og:title" content="${esc(title)}"/><meta property="og:description" content="${esc(description)}"/>
<meta property="og:url" content="${esc(`${url.origin}/?poll=${pollSlug}`)}"/><meta property="og:image" content="${esc(image)}"/>
<meta property="og:image:width" content="1200"/><meta property="og:image:height" content="630"/><meta property="og:image:type" content="image/png"/><meta property="og:image:alt" content="Ositos celebrando una revelación de bebé"/>
<meta name="twitter:card" content="summary_large_image"/><meta name="twitter:image" content="${esc(image)}"/>`;
      return new HTMLRewriter()
        .on('title', { element(e) { e.setInnerContent(title); } })
        .on('meta[name="description"]', { element(e) { e.setAttribute('content', description); } })
        .on('head', { element(e) { e.append(tags, { html: true }); } })
        .transform(new Response(res.body, { status: res.status, headers }));
    }
  }
  if (!token) return new Response(res.body, { status: res.status, headers });
  let row = null;
  try {
    row = await env.DB.prepare(`SELECT e.title, e.baby_name, e.parent_names, e.event_date, e.event_time, e.venue, e.status, e.event_type
      FROM guests g JOIN events e ON e.id = g.event_id WHERE g.token_hash = ?`).bind(await sha256(token)).first();
  } catch { /* si D1 falla, se sirve la página sin metadatos */ }
  if (!row || row.status === 'draft') return new Response(res.body, { status: res.status, headers });
  const reveal = row.event_type === 'gender_reveal';
  const title = reveal ? `${row.parent_names ? `${row.parent_names}: ` : ''}Revelación`
    : row.parent_names ? `${row.parent_names} te invitan a una celebración especial` : (row.title || 'Una invitación especial');
  const when = [fmtDateEs(row.event_date), row.event_time].filter(Boolean).join(' · ');
  const lead = reveal ? 'Vota por tu equipo y acompáñanos a descubrir el secreto.' : (row.baby_name ? `Celebremos la llegada de ${row.baby_name}.` : '');
  const description = [lead, ...(!reveal ? [when, row.venue] : [])].filter(Boolean).join(' — ') || 'Abre tu carta y confirma tu asistencia.';
  const image = `${url.origin}/${reveal ? 'og-reveal.png' : 'og.png'}`;
  const tags = `<meta property="og:type" content="website"/><meta property="og:locale" content="es_CO"/><meta property="og:site_name" content="Invitación"/>
<meta property="og:title" content="${esc(title)}"/><meta property="og:description" content="${esc(description)}"/>
<meta property="og:url" content="${esc(`${url.origin}/?i=${token}`)}"/><meta property="og:image" content="${esc(image)}"/>
<meta property="og:image:width" content="1200"/><meta property="og:image:height" content="630"/><meta property="og:image:type" content="image/png"/><meta property="og:image:alt" content="${esc(reveal ? 'Invitación para descubrir si será niño o niña' : 'Una invitación especial para celebrar la llegada de un bebé')}"/>
<meta name="twitter:card" content="summary_large_image"/><meta name="twitter:image" content="${esc(image)}"/>`;
  return new HTMLRewriter()
    .on('title', { element(e) { e.setInnerContent(title); } })
    .on('meta[name="description"]', { element(e) { e.setAttribute('content', description); } })
    .on('head', { element(e) { e.append(tags, { html: true }); } })
    .transform(new Response(res.body, { status: res.status, headers }));
}

/* ---------- cabeceras de seguridad ---------- */
const CSP = "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-src https://challenges.cloudflare.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
function secure(res) {
  if (!(res.headers.get('content-type') || '').includes('text/html')) return res;
  const h = new Headers(res.headers);
  h.set('Content-Security-Policy', CSP); h.set('X-Content-Type-Options', 'nosniff'); h.set('X-Frame-Options', 'DENY');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

/* ---------- enrutador ---------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/api/health' && request.method === 'GET') return json({ ok: true, service: 'carta-sellada' });
      if (path === '/api/config' && request.method === 'GET') return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || null });
      if (path === '/api/invitation' && request.method === 'GET') return publicInvitation(env, request, url);
      if (path === '/api/rsvp' && request.method === 'POST') return publicRsvp(env, request);
      if (path === '/api/reveal' && request.method === 'GET') return publicRevealState(env, request, url);
      if (path === '/api/vote' && request.method === 'POST') return publicVote(env, request, url);
      const pollMatch = path.match(/^\/api\/polls\/([\w-]+)(\/votes)?$/);
      if (pollMatch && !pollMatch[2] && request.method === 'GET') return publicPollState(env, request, url, pollMatch[1]);
      if (pollMatch && pollMatch[2] && request.method === 'POST') return publicPollVote(env, request, url, pollMatch[1]);
      if (path.startsWith('/api/admin/')) return await handleAdmin(env, request, url, path.slice('/api/admin'.length));
      if (path.startsWith('/api/')) return json({ error: 'Ruta no encontrada.' }, 404);
      if (path === '/' && request.method === 'GET') return secure(await pageWithOpenGraph(env, request, url));
      const res = await secure(await env.ASSETS.fetch(request));
      if (path === '/admin' || path.startsWith('/admin/')) {
        const h = new Headers(res.headers); h.set('X-Robots-Tag', 'noindex, nofollow'); h.set('Cache-Control', 'no-store');
        return new Response(res.body, { status: res.status, headers: h });
      }
      return res;
    } catch (err) {
      console.error('worker error', err && err.stack || err);
      return json({ error: 'Error interno.' }, 500);
    }
  }
};
