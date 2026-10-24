var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker/index.js
var enc = new TextEncoder();
var PBKDF2_ITER = 1e5;
var SESSION_TTL = 7 * 24 * 3600;
var json = /* @__PURE__ */ __name((data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
}), "json");
var uuid = /* @__PURE__ */ __name(() => crypto.randomUUID(), "uuid");
var hex = /* @__PURE__ */ __name((buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""), "hex");
var b64url = /* @__PURE__ */ __name((bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "b64url");
var randomToken = /* @__PURE__ */ __name((n = 24) => b64url(crypto.getRandomValues(new Uint8Array(n))), "randomToken");
async function sha256(value) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(value)));
}
__name(sha256, "sha256");
function safeEqual(a, b) {
  const x = String(a), y = String(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}
__name(safeEqual, "safeEqual");
var clientIp = /* @__PURE__ */ __name((req) => req.headers.get("cf-connecting-ip") || "local", "clientIp");
var esc = /* @__PURE__ */ __name((s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]), "esc");
var clean = /* @__PURE__ */ __name((v, max) => String(v ?? "").trim().slice(0, max), "clean");
async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
}
__name(pbkdf2, "pbkdf2");
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${hex(salt)}$${await pbkdf2(password, salt, PBKDF2_ITER)}`;
}
__name(hashPassword, "hashPassword");
async function verifyPassword(password, stored) {
  const [alg, iter, saltHex, hash] = String(stored).split("$");
  if (alg !== "pbkdf2") return false;
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  return safeEqual(await pbkdf2(password, salt, Number(iter)), hash);
}
__name(verifyPassword, "verifyPassword");
var DUMMY_HASH = "pbkdf2$100000$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000";
async function rateLimit(env, key, limit, windowSec) {
  const now = Math.floor(Date.now() / 1e3);
  const row = await env.DB.prepare(`INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN window_start <= ?3 THEN 1 ELSE count + 1 END,
      window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END
    RETURNING count`).bind(key, now, now - windowSec).first();
  if (Math.random() < 0.01) await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now - 86400).run();
  return row.count <= limit;
}
__name(rateLimit, "rateLimit");
async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  form.append("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    return (await r.json()).success === true;
  } catch {
    return false;
  }
}
__name(verifyTurnstile, "verifyTurnstile");
var isHttps = /* @__PURE__ */ __name((url) => url.protocol === "https:", "isHttps");
var cookieName = /* @__PURE__ */ __name((url) => isHttps(url) ? "__Host-cs_session" : "cs_session", "cookieName");
function readCookie(req, name) {
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}
__name(readCookie, "readCookie");
var sessionCookie = /* @__PURE__ */ __name((url, value, maxAge) => `${cookieName(url)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(url) ? "; Secure" : ""}`, "sessionCookie");
async function createSession(env, url, adminId) {
  const token = randomToken(32), csrf = randomToken(24);
  await env.DB.prepare("INSERT INTO sessions (token_hash, admin_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256(token), adminId, csrf, Math.floor(Date.now() / 1e3) + SESSION_TTL).run();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Math.floor(Date.now() / 1e3)).run();
  return { cookie: sessionCookie(url, token, SESSION_TTL), csrf };
}
__name(createSession, "createSession");
async function getSession(env, req, url) {
  const token = readCookie(req, cookieName(url));
  if (!token) return null;
  const row = await env.DB.prepare(`SELECT s.token_hash, s.csrf_token, s.expires_at, a.id AS admin_id, a.email
    FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ?`).bind(await sha256(token)).first();
  if (!row || row.expires_at < Math.floor(Date.now() / 1e3)) return null;
  return row;
}
__name(getSession, "getSession");
function csrfOk(req, url, session) {
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) return false;
  return safeEqual(req.headers.get("x-csrf-token") || "", session.csrf_token);
}
__name(csrfOk, "csrfOk");
var slugify = /* @__PURE__ */ __name((s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "evento", "slugify");
function parseEvent(body) {
  const title = clean(body.title, 120);
  if (!title) return { error: "El t\xEDtulo es obligatorio." };
  const date = clean(body.event_date, 10), time = clean(body.event_time, 5);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Fecha inv\xE1lida." };
  if (time && !/^\d{2}:\d{2}$/.test(time)) return { error: "Hora inv\xE1lida." };
  const status = ["draft", "published", "closed"].includes(body.status) ? body.status : "draft";
  const event_type = body.event_type === "gender_reveal" ? "gender_reveal" : "baby_shower";
  return { value: {
    title,
    status,
    event_type,
    event_date: date || null,
    event_time: time || null,
    baby_name: clean(body.baby_name, 120) || null,
    parent_names: clean(body.parent_names, 160) || null,
    venue: clean(body.venue, 160) || null,
    address: clean(body.address, 240) || null,
    message: clean(body.message, 600) || null
  } };
}
__name(parseEvent, "parseEvent");
var EVENT_COLS = "id, slug, title, baby_name, parent_names, event_date, event_time, venue, address, message, status, event_type, vote_status, reveal_result, revealed_at, created_at";
async function publicInvitation(env, req, url) {
  const token = clean(url.searchParams.get("i"), 200);
  if (!token) return json({ error: "Falta el enlace de invitaci\xF3n." }, 400);
  if (!await rateLimit(env, `inv:${clientIp(req)}`, 400, 300)) return json({ error: "Demasiados intentos. Intenta m\xE1s tarde." }, 429);
  const row = await env.DB.prepare(`SELECT g.name AS guest_name, g.max_guests, e.title, e.baby_name, e.parent_names, e.event_date, e.event_time,
      e.venue, e.address, e.message, e.status, e.event_type, r.attendance, r.guest_count, r.message AS rsvp_message
    FROM guests g JOIN events e ON e.id = g.event_id LEFT JOIN rsvps r ON r.guest_id = g.id WHERE g.token_hash = ?`).bind(await sha256(token)).first();
  if (!row || row.status === "draft") return json({ error: "El enlace de invitaci\xF3n no es v\xE1lido." }, 404);
  return json({
    guest: { name: row.guest_name, maxGuests: row.max_guests },
    event: { title: row.title, babyName: row.baby_name, parentNames: row.parent_names, date: row.event_date, time: row.event_time, venue: row.venue, address: row.address, message: row.message, closed: row.status === "closed", type: row.event_type },
    rsvp: row.attendance ? { attendance: row.attendance, guestCount: row.guest_count, message: row.rsvp_message || "" } : null
  });
}
__name(publicInvitation, "publicInvitation");
async function publicRsvp(env, req) {
  const ip = clientIp(req);
  if (!await rateLimit(env, `rsvp:${ip}`, 120, 600)) return json({ error: "Demasiados intentos. Intenta m\xE1s tarde." }, 429);
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON inv\xE1lido." }, 400);
  }
  const token = clean(body.token, 200);
  const attendance = body.attendance === "yes" ? "yes" : body.attendance === "no" ? "no" : "";
  const guestCount = Number(body.guestCount ?? 0);
  const message = clean(body.message, 1e3);
  if (!token || !attendance || !Number.isInteger(guestCount) || guestCount < 0 || guestCount > 20) return json({ error: "Revisa los datos ingresados." }, 400);
  if (!await verifyTurnstile(env, body.turnstileToken, ip)) return json({ error: "No pudimos verificar que eres una persona. Intenta de nuevo." }, 403);
  const guest = await env.DB.prepare(`SELECT g.id, g.max_guests, e.status FROM guests g JOIN events e ON e.id = g.event_id WHERE g.token_hash = ?`).bind(await sha256(token)).first();
  if (!guest || guest.status === "draft") return json({ error: "El enlace de invitaci\xF3n no es v\xE1lido." }, 404);
  if (guest.status === "closed") return json({ error: "Las confirmaciones para este evento ya est\xE1n cerradas." }, 403);
  if (attendance === "yes" && (guestCount < 1 || guestCount > guest.max_guests)) return json({ error: `Esta invitaci\xF3n permite entre 1 y ${guest.max_guests} asistentes.` }, 400);
  await env.DB.prepare(`INSERT INTO rsvps (id, guest_id, attendance, guest_count, message, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(guest_id) DO UPDATE SET attendance=excluded.attendance, guest_count=excluded.guest_count, message=excluded.message, updated_at=datetime('now')`).bind(uuid(), guest.id, attendance, attendance === "yes" ? guestCount : 0, message).run();
  return json({ ok: true, message: "Respuesta guardada." });
}
__name(publicRsvp, "publicRsvp");
var deviceCookieName = /* @__PURE__ */ __name((url) => isHttps(url) ? "__Host-cs_device" : "cs_device", "deviceCookieName");
async function guestContext(env, token) {
  return env.DB.prepare(`SELECT g.id AS guest_id, g.max_guests, e.id AS event_id, e.status, e.event_type, e.vote_status, e.reveal_result, e.revealed_at
    FROM guests g JOIN events e ON e.id = g.event_id WHERE g.token_hash = ?`).bind(await sha256(token)).first();
}
__name(guestContext, "guestContext");
async function deviceIds(req, url) {
  let value = readCookie(req, deviceCookieName(url)), isNew = false;
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(value)) {
    value = randomToken(24);
    isNew = true;
  }
  const local = clean(req.headers.get("x-device-id"), 64);
  return {
    cookieHash: await sha256("c:" + value),
    localHash: /^[A-Za-z0-9-]{16,64}$/.test(local) ? await sha256("l:" + local) : null,
    setCookie: isNew ? `${deviceCookieName(url)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${isHttps(url) ? "; Secure" : ""}` : null
  };
}
__name(deviceIds, "deviceIds");
async function voteCounts(env, eventId) {
  const { results } = await env.DB.prepare("SELECT choice, COUNT(*) AS n FROM votes WHERE event_id = ? GROUP BY choice").bind(eventId).all();
  const c = { boy: 0, girl: 0 };
  for (const r of results) c[r.choice] = r.n;
  return c;
}
__name(voteCounts, "voteCounts");
async function voteState(env, ctx, ids) {
  const counts = await voteCounts(env, ctx.event_id);
  const mine = await env.DB.prepare("SELECT choice FROM votes WHERE event_id = ?1 AND (cookie_hash IN (?2, ?3) OR local_hash IN (?2, ?3))").bind(ctx.event_id, ids.cookieHash, ids.localHash || ids.cookieHash).first();
  const revealed = !!ctx.revealed_at;
  return {
    counts,
    total: counts.boy + counts.girl,
    myVote: mine ? mine.choice : null,
    voteOpen: ctx.vote_status === "open" && !revealed,
    revealed,
    result: revealed ? ctx.reveal_result : null
  };
}
__name(voteState, "voteState");
async function publicRevealState(env, req, url) {
  const token = clean(url.searchParams.get("i"), 200);
  if (!token) return json({ error: "Falta el enlace de invitaci\xF3n." }, 400);
  const ctx = await guestContext(env, token);
  if (!ctx || ctx.status === "draft") return json({ error: "El enlace de invitaci\xF3n no es v\xE1lido." }, 404);
  if (ctx.event_type !== "gender_reveal") return json({ error: "Este evento no tiene votaci\xF3n." }, 400);
  const ids = await deviceIds(req, url);
  return json(await voteState(env, ctx, ids), 200, ids.setCookie ? { "set-cookie": ids.setCookie } : {});
}
__name(publicRevealState, "publicRevealState");
async function publicVote(env, req, url) {
  if (!await rateLimit(env, `vote:${clientIp(req)}`, 300, 600)) return json({ error: "Demasiados intentos. Intenta m\xE1s tarde." }, 429);
  let b;
  try {
    b = await req.json();
  } catch {
    return json({ error: "JSON inv\xE1lido." }, 400);
  }
  const token = clean(b.token, 200), choice = b.choice === "boy" ? "boy" : b.choice === "girl" ? "girl" : "";
  if (!token || !choice) return json({ error: "Elige ni\xF1o o ni\xF1a." }, 400);
  const ctx = await guestContext(env, token);
  if (!ctx || ctx.status === "draft") return json({ error: "El enlace de invitaci\xF3n no es v\xE1lido." }, 404);
  if (ctx.event_type !== "gender_reveal") return json({ error: "Este evento no tiene votaci\xF3n." }, 400);
  const ids = await deviceIds(req, url);
  const headers = ids.setCookie ? { "set-cookie": ids.setCookie } : {};
  const state = /* @__PURE__ */ __name(() => voteState(env, ctx, ids), "state");
  if (ctx.revealed_at || ctx.vote_status !== "open") return json({ error: "La votaci\xF3n ya est\xE1 cerrada.", ...await state() }, 403, headers);
  const before = await state();
  if (before.myVote) return json({ error: "Este equipo ya vot\xF3. Solo se permite un voto por dispositivo.", ...before }, 409, headers);
  const used = await env.DB.prepare("SELECT COUNT(*) AS n FROM votes WHERE guest_id = ?").bind(ctx.guest_id).first();
  if (used.n >= ctx.max_guests) return json({ error: `Esta invitaci\xF3n ya us\xF3 sus ${ctx.max_guests} voto${ctx.max_guests > 1 ? "s" : ""}.`, ...before }, 403, headers);
  try {
    await env.DB.prepare("INSERT INTO votes (id, event_id, guest_id, choice, cookie_hash, local_hash) VALUES (?,?,?,?,?,?)").bind(uuid(), ctx.event_id, ctx.guest_id, choice, ids.cookieHash, ids.localHash).run();
  } catch (err) {
    if (/UNIQUE/i.test(String(err && err.message))) return json({ error: "Este equipo ya vot\xF3. Solo se permite un voto por dispositivo.", ...await state() }, 409, headers);
    throw err;
  }
  return json({ ok: true, ...await state() }, 200, headers);
}
__name(publicVote, "publicVote");
async function adminSetup(env, req, url) {
  if (!env.ADMIN_SETUP_KEY) return json({ error: "La configuraci\xF3n inicial est\xE1 deshabilitada." }, 403);
  if (!await rateLimit(env, `setup:${clientIp(req)}`, 5, 900)) return json({ error: "Demasiados intentos." }, 429);
  let b;
  try {
    b = await req.json();
  } catch {
    return json({ error: "JSON inv\xE1lido." }, 400);
  }
  const existing = await env.DB.prepare("SELECT COUNT(*) AS n FROM admins").first();
  if (existing.n > 0) return json({ error: "Ya existe un administrador." }, 403);
  if (!safeEqual(String(b.setupKey || ""), env.ADMIN_SETUP_KEY)) return json({ error: "Clave de configuraci\xF3n incorrecta." }, 403);
  const email = clean(b.email, 200).toLowerCase(), password = String(b.password || "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Correo inv\xE1lido." }, 400);
  if (password.length < 12 || password.length > 200) return json({ error: "La contrase\xF1a debe tener al menos 12 caracteres." }, 400);
  const adminId = uuid();
  await env.DB.prepare("INSERT INTO admins (id, email, password_hash) VALUES (?, ?, ?)").bind(adminId, email, await hashPassword(password)).run();
  const s = await createSession(env, url, adminId);
  return json({ ok: true, email, csrfToken: s.csrf }, 200, { "set-cookie": s.cookie });
}
__name(adminSetup, "adminSetup");
async function adminLogin(env, req, url) {
  const ip = clientIp(req);
  if (!await rateLimit(env, `login:${ip}`, 10, 900)) return json({ error: "Demasiados intentos. Espera unos minutos." }, 429);
  let b;
  try {
    b = await req.json();
  } catch {
    return json({ error: "JSON inv\xE1lido." }, 400);
  }
  const email = clean(b.email, 200).toLowerCase(), password = String(b.password || "").slice(0, 200);
  if (!await rateLimit(env, `loginacct:${email}`, 8, 900)) return json({ error: "Demasiados intentos. Espera unos minutos." }, 429);
  if (!await verifyTurnstile(env, b.turnstileToken, ip)) return json({ error: "Verificaci\xF3n fallida. Intenta de nuevo." }, 403);
  const admin = await env.DB.prepare("SELECT id, email, password_hash FROM admins WHERE email = ?").bind(email).first();
  const ok = await verifyPassword(password, admin ? admin.password_hash : DUMMY_HASH);
  if (!admin || !ok) return json({ error: "Correo o contrase\xF1a incorrectos." }, 401);
  const s = await createSession(env, url, admin.id);
  return json({ ok: true, email: admin.email, csrfToken: s.csrf }, 200, { "set-cookie": s.cookie });
}
__name(adminLogin, "adminLogin");
async function handleAdmin(env, req, url, path) {
  const method = req.method;
  if (path === "/setup" && method === "POST") return adminSetup(env, req, url);
  if (path === "/login" && method === "POST") return adminLogin(env, req, url);
  if (path === "/status" && method === "GET") {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM admins").first();
    return json({ needsSetup: n.n === 0 && !!env.ADMIN_SETUP_KEY });
  }
  const session = await getSession(env, req, url);
  if (!session) return json({ error: "No autorizado." }, 401);
  if (path === "/me" && method === "GET") return json({ email: session.email, csrfToken: session.csrf_token });
  if (method !== "GET" && !csrfOk(req, url, session)) return json({ error: "Solicitud rechazada (CSRF)." }, 403);
  if (path === "/logout" && method === "POST") {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(session.token_hash).run();
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(url, "", 0) });
  }
  const body = /* @__PURE__ */ __name(async () => {
    try {
      return await req.json();
    } catch {
      return null;
    }
  }, "body");
  let m;
  if (path === "/events" && method === "GET") {
    const { results } = await env.DB.prepare(`SELECT e.${EVENT_COLS.split(", ").join(", e.")},
        (SELECT COUNT(*) FROM guests g WHERE g.event_id = e.id) AS guests,
        (SELECT COUNT(*) FROM rsvps r JOIN guests g ON g.id = r.guest_id WHERE g.event_id = e.id) AS responses
      FROM events e ORDER BY e.created_at DESC`).all();
    return json({ events: results });
  }
  if (path === "/events" && method === "POST") {
    const b = await body();
    if (!b) return json({ error: "JSON inv\xE1lido." }, 400);
    const p = parseEvent(b);
    if (p.error) return json({ error: p.error }, 400);
    const v = p.value, eid = uuid(), slug = `${slugify(v.title)}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
    await env.DB.prepare(`INSERT INTO events (id, slug, title, baby_name, parent_names, event_date, event_time, venue, address, message, status, event_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(eid, slug, v.title, v.baby_name, v.parent_names, v.event_date, v.event_time, v.venue, v.address, v.message, v.status, v.event_type).run();
    return json({ ok: true, id: eid }, 201);
  }
  if (m = path.match(/^\/events\/([\w-]+)$/)) {
    const eid = m[1];
    if (method === "GET") {
      const event = await env.DB.prepare(`SELECT ${EVENT_COLS} FROM events WHERE id = ?`).bind(eid).first();
      if (!event) return json({ error: "Evento no encontrado." }, 404);
      const { results } = await env.DB.prepare(`SELECT g.id, g.name, g.phone, g.max_guests, g.created_at, r.attendance, r.guest_count, r.message, r.updated_at AS responded_at
        FROM guests g LEFT JOIN rsvps r ON r.guest_id = g.id WHERE g.event_id = ? ORDER BY g.created_at DESC`).bind(eid).all();
      const votes = await voteCounts(env, eid);
      return json({ event, guests: results, votes });
    }
    if (method === "PUT") {
      const b = await body();
      if (!b) return json({ error: "JSON inv\xE1lido." }, 400);
      const p = parseEvent(b);
      if (p.error) return json({ error: p.error }, 400);
      const v = p.value;
      const r = await env.DB.prepare(`UPDATE events SET title=?, baby_name=?, parent_names=?, event_date=?, event_time=?, venue=?, address=?, message=?, status=?, event_type=? WHERE id=?`).bind(v.title, v.baby_name, v.parent_names, v.event_date, v.event_time, v.venue, v.address, v.message, v.status, v.event_type, eid).run();
      if (!r.meta.changes) return json({ error: "Evento no encontrado." }, 404);
      return json({ ok: true });
    }
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM events WHERE id = ?").bind(eid).run();
      return json({ ok: true });
    }
  }
  if ((m = path.match(/^\/events\/([\w-]+)\/reveal$/)) && method === "POST") {
    const b = await body();
    if (!b) return json({ error: "JSON inv\xE1lido." }, 400);
    const ev = await env.DB.prepare("SELECT id, event_type, revealed_at FROM events WHERE id = ?").bind(m[1]).first();
    if (!ev) return json({ error: "Evento no encontrado." }, 404);
    if (ev.event_type !== "gender_reveal") return json({ error: "Este evento no es una revelaci\xF3n." }, 400);
    if (b.action === "close") await env.DB.prepare("UPDATE events SET vote_status='closed' WHERE id=?").bind(ev.id).run();
    else if (b.action === "open") {
      if (ev.revealed_at) return json({ error: "Primero oculta el resultado para reabrir la votaci\xF3n." }, 400);
      await env.DB.prepare("UPDATE events SET vote_status='open' WHERE id=?").bind(ev.id).run();
    } else if (b.action === "reveal") {
      if (!["boy", "girl"].includes(b.result)) return json({ error: "Resultado inv\xE1lido." }, 400);
      await env.DB.prepare("UPDATE events SET reveal_result=?, revealed_at=datetime('now'), vote_status='closed' WHERE id=?").bind(b.result, ev.id).run();
    } else if (b.action === "hide") {
      await env.DB.prepare("UPDATE events SET reveal_result=NULL, revealed_at=NULL WHERE id=?").bind(ev.id).run();
    } else return json({ error: "Acci\xF3n inv\xE1lida." }, 400);
    return json({ ok: true });
  }
  if ((m = path.match(/^\/events\/([\w-]+)\/guests$/)) && method === "POST") {
    const eid = m[1];
    const ev = await env.DB.prepare("SELECT id FROM events WHERE id = ?").bind(eid).first();
    if (!ev) return json({ error: "Evento no encontrado." }, 404);
    const b = await body();
    if (!b) return json({ error: "JSON inv\xE1lido." }, 400);
    const name = clean(b.name, 120), phone = clean(b.phone, 30) || null, max = Number(b.max_guests ?? 1);
    if (!name) return json({ error: "El nombre es obligatorio." }, 400);
    if (!Number.isInteger(max) || max < 1 || max > 20) return json({ error: "Cupos inv\xE1lidos (1 a 20)." }, 400);
    const token = randomToken(24), gid = uuid();
    await env.DB.prepare("INSERT INTO guests (id, event_id, name, phone, token_hash, max_guests) VALUES (?,?,?,?,?,?)").bind(gid, eid, name, phone, await sha256(token), max).run();
    return json({ ok: true, id: gid, link: `${url.origin}/?i=${token}` }, 201);
  }
  if (m = path.match(/^\/guests\/([\w-]+)$/)) {
    if (method === "PUT") {
      const b = await body();
      if (!b) return json({ error: "JSON inv\xE1lido." }, 400);
      const name = clean(b.name, 120), phone = clean(b.phone, 30) || null, max = Number(b.max_guests ?? 1);
      if (!name || !Number.isInteger(max) || max < 1 || max > 20) return json({ error: "Datos inv\xE1lidos." }, 400);
      const r = await env.DB.prepare("UPDATE guests SET name=?, phone=?, max_guests=? WHERE id=?").bind(name, phone, max, m[1]).run();
      return r.meta.changes ? json({ ok: true }) : json({ error: "Invitado no encontrado." }, 404);
    }
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM guests WHERE id = ?").bind(m[1]).run();
      return json({ ok: true });
    }
  }
  if ((m = path.match(/^\/guests\/([\w-]+)\/regenerate$/)) && method === "POST") {
    const token = randomToken(24);
    const r = await env.DB.prepare("UPDATE guests SET token_hash = ? WHERE id = ?").bind(await sha256(token), m[1]).run();
    return r.meta.changes ? json({ ok: true, link: `${url.origin}/?i=${token}` }) : json({ error: "Invitado no encontrado." }, 404);
  }
  return json({ error: "Ruta no encontrada." }, 404);
}
__name(handleAdmin, "handleAdmin");
function fmtDateEs(iso) {
  if (!iso) return "";
  const [y, mo, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("es-CO", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, mo - 1, d)));
}
__name(fmtDateEs, "fmtDateEs");
async function pageWithOpenGraph(env, req, url) {
  const res = await env.ASSETS.fetch(new Request(new URL("/", url), req));
  const token = clean(url.searchParams.get("i"), 200);
  const headers = new Headers(res.headers);
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "private, no-store");
  if (!token) return new Response(res.body, { status: res.status, headers });
  let row = null;
  try {
    row = await env.DB.prepare(`SELECT e.title, e.baby_name, e.parent_names, e.event_date, e.event_time, e.venue, e.status, e.event_type
      FROM guests g JOIN events e ON e.id = g.event_id WHERE g.token_hash = ?`).bind(await sha256(token)).first();
  } catch {
  }
  if (!row || row.status === "draft") return new Response(res.body, { status: res.status, headers });
  const reveal = row.event_type === "gender_reveal";
  const title = reveal ? row.parent_names ? `${row.parent_names} te invitan: \xBFni\xF1o o ni\xF1a?` : "\xBFNi\xF1o o ni\xF1a? Desc\xFAbrelo con nosotros" : row.parent_names ? `${row.parent_names} te invitan a una celebraci\xF3n especial` : row.title || "Una invitaci\xF3n especial";
  const when = [fmtDateEs(row.event_date), row.event_time].filter(Boolean).join(" \xB7 ");
  const lead = reveal ? "Vota y descubre el secreto con nosotros." : row.baby_name ? `Celebremos la llegada de ${row.baby_name}.` : "";
  const description = [lead, when, row.venue].filter(Boolean).join(" \u2014 ") || "Abre tu carta y confirma tu asistencia.";
  const image = `${url.origin}/og.png`;
  const tags = `<meta property="og:type" content="website"/><meta property="og:locale" content="es_CO"/><meta property="og:site_name" content="Invitaci\xF3n"/>
<meta property="og:title" content="${esc(title)}"/><meta property="og:description" content="${esc(description)}"/>
<meta property="og:url" content="${esc(`${url.origin}/?i=${token}`)}"/><meta property="og:image" content="${esc(image)}"/>
<meta property="og:image:width" content="1200"/><meta property="og:image:height" content="630"/>
<meta name="twitter:card" content="summary_large_image"/>`;
  return new HTMLRewriter().on("title", { element(e) {
    e.setInnerContent(title);
  } }).on('meta[name="description"]', { element(e) {
    e.setAttribute("content", description);
  } }).on("head", { element(e) {
    e.append(tags, { html: true });
  } }).transform(new Response(res.body, { status: res.status, headers }));
}
__name(pageWithOpenGraph, "pageWithOpenGraph");
var CSP = "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-src https://challenges.cloudflare.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
function secure(res) {
  if (!(res.headers.get("content-type") || "").includes("text/html")) return res;
  const h = new Headers(res.headers);
  h.set("Content-Security-Policy", CSP);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
__name(secure, "secure");
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/health" && request.method === "GET") return json({ ok: true, service: "carta-sellada" });
      if (path === "/api/config" && request.method === "GET") return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || null });
      if (path === "/api/invitation" && request.method === "GET") return publicInvitation(env, request, url);
      if (path === "/api/rsvp" && request.method === "POST") return publicRsvp(env, request);
      if (path === "/api/reveal" && request.method === "GET") return publicRevealState(env, request, url);
      if (path === "/api/vote" && request.method === "POST") return publicVote(env, request, url);
      if (path.startsWith("/api/admin/")) return await handleAdmin(env, request, url, path.slice("/api/admin".length));
      if (path.startsWith("/api/")) return json({ error: "Ruta no encontrada." }, 404);
      if (path === "/" && request.method === "GET") return secure(await pageWithOpenGraph(env, request, url));
      const res = await secure(await env.ASSETS.fetch(request));
      if (path === "/admin" || path.startsWith("/admin/")) {
        const h = new Headers(res.headers);
        h.set("X-Robots-Tag", "noindex, nofollow");
        h.set("Cache-Control", "no-store");
        return new Response(res.body, { status: res.status, headers: h });
      }
      return res;
    } catch (err) {
      console.error("worker error", err && err.stack || err);
      return json({ error: "Error interno." }, 500);
    }
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-6b9mbm/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-6b9mbm/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
