// Prueba de integración del Worker contra SQLite (node:sqlite) simulando D1. Ejecutar: npm test
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
for (const f of readdirSync('migrations').sort()) db.exec(readFileSync(`migrations/${f}`, 'utf8'));
const wrap = (sql, args = []) => ({
  bind: (...a) => wrap(sql, a),
  first: async () => db.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } })
});
class FakeRewriter { // HTMLRewriter no existe en Node: se emula lo mínimo para ejercitar la ruta
  constructor() { this.h = []; } on(sel, handler) { this.h.push([sel, handler]); return this; }
  async transform(res) {
    let html = await res.text();
    for (const [selector, handler] of this.h) {
      if (selector === 'title') {
        html = html.replace(/<title>(.*?)<\/title>/i, (_match, content) => {
          let replacement = content;
          handler.element({ setInnerContent: value => { replacement = String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); } });
          return `<title>${replacement}</title>`;
        });
      } else if (selector === 'meta[name="description"]') {
        html = html.replace(/<meta\s+name="description"\s+content="([^"]*)"\s*\/?>/i, (tag, content) => {
          let replacement = content;
          handler.element({ setAttribute: (_name, value) => { replacement = value; } });
          return tag.replace(content, replacement);
        });
      } else if (selector === 'head') {
        html = html.replace(/<head[^>]*>/i, tag => {
          let appended = '';
          handler.element({ append: value => { appended += value; } });
          return tag + appended;
        });
      }
    }
    return new Response(html, { status: res.status, statusText: res.statusText, headers: res.headers });
  }
}
globalThis.HTMLRewriter = FakeRewriter;
const env = {
  DB: {
    prepare: (sql) => wrap(sql),
    batch: async (statements) => {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  }, ADMIN_SETUP_KEY: 'setup-secret',
  ASSETS: { fetch: async () => new Response('<html><head><title>x</title></head></html>', { headers: { 'content-type': 'text/html' } }) }
};
const ORIGIN = 'http://localhost:8787';
let cookie = '', csrf = '';
async function call(method, path, body, { auth = true, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', origin: ORIGIN, 'cf-connecting-ip': '1.1.1.1', ...headers };
  if (auth && cookie) h.cookie = cookie;
  if (auth && csrf && method !== 'GET') h['x-csrf-token'] = csrf;
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env);
  const sc = res.headers.get('set-cookie'); if (sc && /cs_session/.test(sc)) cookie = sc.split(';')[0];
  let data = null; try { data = await res.clone().json(); } catch {}
  return { status: res.status, data, res };
}
const t = async (name, fn) => { await fn(); console.log('ok  -', name); };

await t('sin sesión, el admin responde 401', async () => assert.equal((await call('GET', '/api/admin/events', null, { auth: false })).status, 401));
await t('setup: clave incorrecta', async () => assert.equal((await call('POST', '/api/admin/setup', { setupKey: 'x', email: 'a@b.co', password: 'unaclavelarga123' }, { auth: false })).status, 403));
await t('setup: contraseña corta rechazada', async () => assert.equal((await call('POST', '/api/admin/setup', { setupKey: 'setup-secret', email: 'a@b.co', password: 'corta' }, { auth: false })).status, 400));
await t('setup: crea el primer admin y abre sesión', async () => {
  const r = await call('POST', '/api/admin/setup', { setupKey: 'setup-secret', email: 'Admin@Ejemplo.co', password: 'unaclavelarga123' }, { auth: false });
  assert.equal(r.status, 200); csrf = r.data.csrfToken; assert.ok(cookie.startsWith('cs_session='));
  assert.match(r.res.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
});
await t('setup: no se puede repetir', async () => assert.equal((await call('POST', '/api/admin/setup', { setupKey: 'setup-secret', email: 'o@b.co', password: 'unaclavelarga123' }, { auth: false })).status, 403));
await t('CSRF: POST sin token es rechazado', async () => {
  const saved = csrf; csrf = '';
  assert.equal((await call('POST', '/api/admin/events', { title: 'X' })).status, 403); csrf = saved;
});
await t('CSRF: Origin ajeno es rechazado', async () => assert.equal((await call('POST', '/api/admin/events', { title: 'X' }, { headers: { origin: 'https://evil.example' } })).status, 403));

let eventId, link, guestId;
await t('crear evento (borrador)', async () => {
  const r = await call('POST', '/api/admin/events', { title: 'Baby shower', baby_name: 'Mateo', parent_names: 'Laura y Daniel', event_date: '2027-05-24', event_time: '16:00', venue: 'Jardín', address: 'Medellín', status: 'draft' });
  assert.equal(r.status, 201); eventId = r.data.id;
});
await t('validación: fecha inválida', async () => assert.equal((await call('POST', '/api/admin/events', { title: 'X', event_date: '24/05/2027' })).status, 400));
await t('crear invitado devuelve enlace; BD guarda solo el hash', async () => {
  const r = await call('POST', `/api/admin/events/${eventId}/guests`, { name: 'Ana Pérez', phone: '300', max_guests: 3 });
  assert.equal(r.status, 201); link = r.data.link; guestId = r.data.id;
  const token = new URL(link).searchParams.get('i');
  const row = db.prepare('SELECT token_hash FROM guests WHERE id=?').get(guestId);
  assert.notEqual(row.token_hash, token); assert.equal(row.token_hash.length, 64);
  assert.ok(token.length >= 30);
});
const token = () => new URL(link).searchParams.get('i');
await t('invitación de evento en borrador: 404', async () => assert.equal((await call('GET', `/api/invitation?i=${token()}`, null, { auth: false })).status, 404));
await t('publicar evento', async () => {
  const r = await call('PUT', `/api/admin/events/${eventId}`, { title: 'Baby shower', baby_name: 'Mateo', parent_names: 'Laura y Daniel', event_date: '2027-05-24', event_time: '16:00', venue: 'Jardín', address: 'Medellín', status: 'published' });
  assert.equal(r.status, 200);
});
let crawlerLink, crawlerGuestId;
await t('la vista previa no marca una invitación como abierta', async () => {
  const r = await call('POST', `/api/admin/events/${eventId}/guests`, { name: 'Vista previa', max_guests: 1 });
  crawlerLink = r.data.link; crawlerGuestId = r.data.id;
  const preview = await worker.fetch(new Request(crawlerLink), env);
  assert.equal(preview.status, 200);
  assert.equal(db.prepare('SELECT opened_at FROM guests WHERE id=?').get(crawlerGuestId).opened_at, null);
});
await t('la primera consulta de una invitación registra su apertura una sola vez', async () => {
  const opened = await call('GET', `/api/invitation?i=${new URL(crawlerLink).searchParams.get('i')}`, null, { auth: false });
  assert.equal(opened.status, 200);
  const firstOpenedAt = db.prepare('SELECT opened_at FROM guests WHERE id=?').get(crawlerGuestId).opened_at;
  assert.ok(firstOpenedAt);
  await call('GET', `/api/invitation?i=${new URL(crawlerLink).searchParams.get('i')}`, null, { auth: false });
  assert.equal(db.prepare('SELECT opened_at FROM guests WHERE id=?').get(crawlerGuestId).opened_at, firstOpenedAt);
  const admin = await call('GET', `/api/admin/events/${eventId}`);
  assert.equal(admin.data.guests.find(g => g.id === crawlerGuestId).opened_at, firstOpenedAt);
  assert.equal(admin.data.guests.find(g => g.id === guestId).opened_at, null);
});
await t('una invitación en borrador no se registra como abierta', async () => {
  const draft = await call('POST', '/api/admin/events', { title: 'Borrador', event_type: 'baby_shower', status: 'draft' });
  const guest = await call('POST', `/api/admin/events/${draft.data.id}/guests`, { name: 'Invitado borrador', max_guests: 1 });
  const id = guest.data.id;
  const result = await call('GET', `/api/invitation?i=${new URL(guest.data.link).searchParams.get('i')}`, null, { auth: false });
  assert.equal(result.status, 404);
  assert.equal(db.prepare('SELECT opened_at FROM guests WHERE id=?').get(id).opened_at, null);
});
await t('GET /api/invitation devuelve evento e invitado', async () => {
  const r = await call('GET', `/api/invitation?i=${token()}`, null, { auth: false });
  assert.equal(r.status, 200); assert.equal(r.data.guest.name, 'Ana Pérez'); assert.equal(r.data.guest.maxGuests, 3); assert.equal(r.data.event.babyName, 'Mateo'); assert.equal(r.data.rsvp, null);
});
await t('token inválido: 404', async () => assert.equal((await call('GET', '/api/invitation?i=nope', null, { auth: false })).status, 404));
await t('RSVP: excede cupos', async () => assert.equal((await call('POST', '/api/rsvp', { token: token(), attendance: 'yes', guestCount: 4 }, { auth: false })).status, 400));
await t('RSVP: guarda y actualiza sin duplicar', async () => {
  assert.equal((await call('POST', '/api/rsvp', { token: token(), attendance: 'yes', guestCount: 2, message: 'Allí estaremos' }, { auth: false })).status, 200);
  assert.equal((await call('POST', '/api/rsvp', { token: token(), attendance: 'no', guestCount: 0 }, { auth: false })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rsvps').get().n, 1);
  const r = await call('GET', `/api/invitation?i=${token()}`, null, { auth: false });
  assert.equal(r.data.rsvp.attendance, 'no');
});
await t('panel muestra respuestas', async () => {
  const r = await call('GET', `/api/admin/events/${eventId}`);
  assert.equal(r.data.guests[0].attendance, 'no');
  const list = await call('GET', '/api/admin/events'); assert.equal(list.data.events[0].responses, 1);
});
await t('Open Graph: ruta / con token no falla', async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/?i=${token()}`), env);
  assert.equal(res.status, 200); assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
});
await t('regenerar enlace invalida el anterior', async () => {
  const old = token();
  const r = await call('POST', `/api/admin/guests/${guestId}/regenerate`); assert.equal(r.status, 200); link = r.data.link;
  assert.equal((await call('GET', `/api/invitation?i=${old}`, null, { auth: false })).status, 404);
  assert.equal((await call('GET', `/api/invitation?i=${token()}`, null, { auth: false })).status, 200);
});
await t('evento cerrado rechaza RSVP', async () => {
  await call('PUT', `/api/admin/events/${eventId}`, { title: 'Baby shower', status: 'closed' });
  assert.equal((await call('POST', '/api/rsvp', { token: token(), attendance: 'yes', guestCount: 1 }, { auth: false })).status, 403);
});
let poll;
const pollDevice = (localId, cookieValue) => ({
  auth: false,
  headers: {
    ...(cookieValue ? { cookie: `cs_device=${cookieValue}` } : {}),
    ...(localId ? { 'x-device-id': localId } : {}),
    'cf-connecting-ip': '3.3.3.3'
  }
});
await t('crear votación abierta independiente y mostrar enlace compartido', async () => {
  const result = await call('POST', '/api/admin/polls', { title: '¿Qué crees que será?' });
  assert.equal(result.status, 201);
  poll = result.data;
  const listed = await call('GET', '/api/admin/polls');
  assert.equal(listed.data.polls[0].slug, poll.slug);
  assert.equal(listed.data.polls[0].votes, 0);
});
await t('la vista previa del enlace compartido invita a votar sin datos personales', async () => {
  const response = await worker.fetch(new Request(`${ORIGIN}/?poll=${poll.slug}`), env);
  const html = await response.text();
  assert.match(html, /<title>Invitación a votar · ¿Qué crees que será\?<\/title>/);
  assert.match(html, /property="og:description" content=""/);
  assert.match(html, new RegExp(`property="og:url" content="${ORIGIN.replaceAll('.', '\\.')}\\/\\?poll=${poll.slug}"`));
  assert.doesNotMatch(html, /og:title[^>]*Laura|og:title[^>]*Ana/);
});
await t('el enlace público de votación funciona sin invitación y genera cookie de dispositivo', async () => {
  const result = await call('GET', `/api/polls/${poll.slug}`, null, pollDevice('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'));
  assert.equal(result.status, 200);
  assert.equal(result.data.poll.title, '¿Qué crees que será?');
  assert.equal(result.data.myVote, null);
  assert.equal(result.data.voteOpen, true);
  assert.equal(result.data.mintLeaves.leafCount, 0);
  assert.equal(result.data.mintLeaves.cycleId, 0);
  assert.match(result.res.headers.get('set-cookie'), /cs_device=.*HttpOnly/);
});
await t('votación independiente acepta un voto por dispositivo y deja ver los resultados', async () => {
  const localId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  db.prepare('UPDATE mint_leaf_cycles SET cycle_started_at = ? WHERE scope_key = ?')
    .run(Math.floor(Date.now() / 1000) - 30, `poll:${poll.id}`);
  const first = await call('GET', `/api/polls/${poll.slug}`, null, pollDevice(localId));
  assert.equal(first.data.mintLeaves.leafCount, 1);
  const deviceCookie = first.res.headers.get('set-cookie').split(';')[0].split('=')[1];
  const voted = await call('POST', `/api/polls/${poll.slug}/votes`, { choice: 'boy' }, pollDevice(localId, deviceCookie));
  assert.equal(voted.status, 200);
  assert.equal(voted.data.myVote, 'boy');
  assert.equal(voted.data.counts.boy, 1);
  assert.equal(voted.data.mintLeaves.cycleId, 1);
  assert.equal(voted.data.mintLeaves.leafCount, 0);
  assert.equal(voted.data.mintLeaves.falls[0].leafCount, 1);
  const cookieOnly = await call('POST', `/api/polls/${poll.slug}/votes`, { choice: 'girl' }, pollDevice('abababab-abab-abab-abab-abababababab', deviceCookie));
  assert.equal(cookieOnly.status, 409);
  assert.equal(cookieOnly.data.mintLeaves.cycleId, 1);
  const localOnly = await call('POST', `/api/polls/${poll.slug}/votes`, { choice: 'girl' }, pollDevice(localId, 'other-device-cookie-value'));
  assert.equal(localOnly.status, 409);
  const publicResults = await call('GET', `/api/polls/${poll.slug}`, null, pollDevice('cccccccc-dddd-eeee-ffff-000000000000'));
  assert.equal(publicResults.data.total, 1);
  assert.equal(publicResults.data.counts.boy, 1);
  assert.equal(publicResults.data.mintLeaves.cycleId, 1);
  assert.equal(publicResults.data.mintLeaves.leafCount, 0);
});
await t('hojas menta compartidas se reinician al cumplir una hora', async () => {
  db.prepare('UPDATE mint_leaf_cycles SET cycle_started_at = ? WHERE scope_key = ?')
    .run(Math.floor(Date.now() / 1000) - 3600, `poll:${poll.id}`);
  const result = await call('GET', `/api/polls/${poll.slug}`, null, pollDevice('dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb'));
  assert.equal(result.data.mintLeaves.cycleId, 2);
  assert.equal(result.data.mintLeaves.leafCount, 0);
  assert.ok(result.data.mintLeaves.falls.some(fall => fall.leafCount === 120));
});
await t('cerrar votación independiente bloquea nuevos votos, conserva resultados y permite reabrir', async () => {
  await call('PUT', `/api/admin/polls/${poll.id}`, { status: 'closed' });
  const closed = await call('POST', `/api/polls/${poll.slug}/votes`, { choice: 'girl' }, pollDevice('11111111-2222-3333-4444-555555555555'));
  assert.equal(closed.status, 403);
  assert.equal(closed.data.total, 1);
  await call('PUT', `/api/admin/polls/${poll.id}`, { status: 'open' });
  assert.equal((await call('GET', `/api/polls/${poll.slug}`, null, pollDevice('66666666-7777-8888-9999-aaaaaaaaaaaa'))).data.voteOpen, true);
});
// ---------- Revelación de sexo: votación por equipo ----------
let rev, rlink, rg;
const rtoken = () => new URL(rlink).searchParams.get('i');
const dev = (cookieJar, localId) => ({ auth: false, headers: { ...(cookieJar.v ? { cookie: cookieJar.v } : {}), ...(localId ? { 'x-device-id': localId } : {}), 'cf-connecting-ip': '2.2.2.2' } });
const keep = (jar, r) => { const sc = r.res.headers.get('set-cookie'); if (sc) jar.v = sc.split(';')[0]; };
await t('crear evento de revelación y publicar', async () => {
  const r = await call('POST', '/api/admin/events', { title: 'Revelación', event_type: 'gender_reveal', status: 'published', parent_names: 'Laura y Daniel' });
  assert.equal(r.status, 201); rev = r.data.id;
  const g = await call('POST', `/api/admin/events/${rev}/guests`, { name: 'Familia Gómez', max_guests: 3 });
  rlink = g.data.link; rg = g.data.id;
  const inv = await call('GET', `/api/invitation?i=${rtoken()}`, null, { auth: false });
  assert.equal(inv.data.event.type, 'gender_reveal');
});
await t('Open Graph de revelación solo presenta título, descripción vacía, imagen y URL', async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/?i=${rtoken()}`), env);
  const html = await res.text();
  assert.match(html, /<title>Laura y Daniel: Revelación<\/title>/);
  assert.match(html, /property="og:description" content=""/);
  assert.match(html, new RegExp(`property="og:url" content="${ORIGIN.replaceAll('.', '\\.')}\\/\\?i=${rtoken()}"`));
  assert.match(html, new RegExp(`property="og:image" content="${ORIGIN.replaceAll('.', '\\.')}\\/og\\.png"`));
});
const A = {}, B = {}, C = {};
const idA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', idB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', idC = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const idD = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
await t('estado inicial: 0 votos, cookie de dispositivo emitida', async () => {
  const r = await call('GET', `/api/reveal?i=${rtoken()}`, null, dev(A, idA)); keep(A, r);
  assert.equal(r.status, 200); assert.equal(r.data.total, 0); assert.equal(r.data.myVote, null); assert.equal(r.data.voteOpen, true); assert.ok(A.v);
  assert.equal(r.data.mintLeaves.leafCount, 0);
  assert.match(r.res.headers.get('set-cookie'), /HttpOnly/);
});
await t('equipo A vota niño', async () => {
  db.prepare('UPDATE mint_leaf_cycles SET cycle_started_at = ? WHERE scope_key = ?')
    .run(Math.floor(Date.now() / 1000) - 30, `event:${rev}`);
  const r = await call('POST', '/api/vote', { token: rtoken(), choice: 'boy' }, dev(A, idA)); keep(A, r);
  assert.equal(r.status, 200); assert.equal(r.data.counts.boy, 1); assert.equal(r.data.myVote, 'boy'); assert.deepEqual(r.data.guestCounts, { boy: 1, girl: 0 });
  assert.equal(r.data.mintLeaves.cycleId, 1); assert.equal(r.data.mintLeaves.leafCount, 0); assert.equal(r.data.mintLeaves.falls[0].leafCount, 1);
});
await t('borrar solo la cookie permite recuperar el voto con localStorage', async () => {
  const r = await call('GET', `/api/reveal?i=${rtoken()}`, null, dev({}, idA));
  assert.equal(r.status, 200); assert.equal(r.data.myVote, 'boy'); assert.deepEqual(r.data.myVotes, ['boy']);
});
await t('una invitación puede registrar varios votos desde el mismo dispositivo', async () => {
  const r = await call('POST', '/api/vote', { token: rtoken(), choice: 'girl' }, dev(A, idA)); keep(A, r);
  assert.equal(r.status, 200); assert.deepEqual(r.data.myVotes, ['boy', 'girl']); assert.equal(r.data.guestVoteCount, 2); assert.deepEqual(r.data.guestCounts, { boy: 1, girl: 1 });
});
await t('borrar solo la cookie permite recuperar todos los votos del dispositivo', async () => {
  const r = await call('GET', `/api/reveal?i=${rtoken()}`, null, dev({}, idA));
  assert.equal(r.status, 200); assert.deepEqual(r.data.myVotes, ['boy', 'girl']);
});
await t('borrar solo localStorage permite recuperar todos los votos con la cookie', async () => {
  const r = await call('GET', `/api/reveal?i=${rtoken()}`, null, dev(A, null));
  assert.equal(r.status, 200); assert.deepEqual(r.data.myVotes, ['boy', 'girl']);
});
await t('el último cupo acepta solo un voto aunque dos dispositivos voten a la vez', async () => {
  const votes = await Promise.all([
    call('POST', '/api/vote', { token: rtoken(), choice: 'girl' }, dev(B, idB)),
    call('POST', '/api/vote', { token: rtoken(), choice: 'girl' }, dev(C, idC))
  ]);
  assert.deepEqual(votes.map(r => r.status).sort(), [200, 403]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM votes WHERE guest_id=?').get(rg).n, 3);
});
await t('la invitación no permite más votos que los cupos asignados', async () => {
  const r = await call('POST', '/api/vote', { token: rtoken(), choice: 'boy' }, dev(C, idC)); assert.equal(r.status, 403); assert.equal(r.data.guestVoteCount, 3);
});
await t('sin cookies ni localStorage, los cupos usados se informan para permitir ver resultados', async () => {
  const r = await call('GET', `/api/reveal?i=${rtoken()}`, null, dev({}, null));
  assert.equal(r.status, 200); assert.equal(r.data.myVote, null); assert.equal(r.data.guestVoteCount, 3); assert.equal(r.data.guestVoteLimit, 3);
});
await t('el contador en vivo lo ve cualquier equipo', async () => {
  const r = await call('GET', `/api/reveal?i=${rtoken()}`, null, dev({}, idD)); assert.equal(r.data.total, 3); assert.equal(r.data.myVote, null);
});
await t('token inválido no vota ni consulta', async () => {
  assert.equal((await call('POST', '/api/vote', { token: 'x', choice: 'boy' }, dev({}, idC))).status, 404);
  assert.equal((await call('GET', '/api/reveal?i=x', null, dev({}, idC))).status, 404);
});
await t('evento baby_shower no tiene votación', async () => {
  const e = await call('POST', '/api/admin/events', { title: 'Shower', status: 'published' });
  const g = await call('POST', `/api/admin/events/${e.data.id}/guests`, { name: 'X' });
  const tk = new URL(g.data.link).searchParams.get('i');
  assert.equal((await call('POST', '/api/vote', { token: tk, choice: 'boy' }, dev({}, idC))).status, 400);
  assert.equal((await call('GET', `/api/reveal?i=${tk}`, null, dev({}, idC))).status, 400);
});
await t('panel: detalle muestra votos; cerrar votación bloquea', async () => {
  const d = await call('GET', `/api/admin/events/${rev}`); assert.deepEqual(d.data.votes, { boy: 1, girl: 2 });
  assert.equal((await call('POST', `/api/admin/events/${rev}/reveal`, { action: 'close' })).status, 200);
  const g2 = await call('POST', `/api/admin/events/${rev}/guests`, { name: 'Otra', max_guests: 3 });
  const r = await call('POST', '/api/vote', { token: new URL(g2.data.link).searchParams.get('i'), choice: 'boy' }, dev({}, idC)); assert.equal(r.status, 403);
  assert.equal((await call('POST', `/api/admin/events/${rev}/reveal`, { action: 'open' })).status, 200);
});
await t('el resultado NO se filtra antes de revelar', async () => {
  const r = await call('GET', `/api/reveal?i=${rtoken()}`, null, dev(A, idA)); assert.equal(r.data.revealed, false); assert.equal(r.data.result, null);
  assert.ok(!JSON.stringify((await call('GET', `/api/invitation?i=${rtoken()}`, null, { auth: false })).data).includes('reveal_result'));
});
await t('revelar: se publica el resultado y se cierra la votación', async () => {
  assert.equal((await call('POST', `/api/admin/events/${rev}/reveal`, { action: 'reveal', result: 'girl' })).status, 200);
  const r = await call('GET', `/api/reveal?i=${rtoken()}`, null, dev(A, idA)); assert.equal(r.data.revealed, true); assert.equal(r.data.result, 'girl'); assert.equal(r.data.voteOpen, false);
  assert.equal((await call('POST', `/api/admin/events/${rev}/reveal`, { action: 'open' })).status, 400);
  assert.equal((await call('POST', `/api/admin/events/${rev}/reveal`, { action: 'reveal', result: 'otro' })).status, 400);
});
await t('ocultar resultado lo retira', async () => {
  await call('POST', `/api/admin/events/${rev}/reveal`, { action: 'hide' });
  const r = await call('GET', `/api/reveal?i=${rtoken()}`, null, dev(A, idA)); assert.equal(r.data.revealed, false); assert.equal(r.data.result, null);
});
await t('rutas de revelación exigen sesión y CSRF', async () => {
  assert.equal((await call('POST', `/api/admin/events/${rev}/reveal`, { action: 'close' }, { auth: false })).status, 401);
});
await t('eliminar el invitado conserva los votos (contador estable)', async () => {
  await call('DELETE', `/api/admin/guests/${rg}`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM votes WHERE event_id=?').get(rev).n, 3);
});
await t('CSP en las páginas HTML', async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/admin`), env);
  assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
});
await t('logout destruye la sesión', async () => {
  assert.equal((await call('POST', '/api/admin/logout')).status, 200);
  assert.equal((await call('GET', '/api/admin/me')).status, 401);
});
await t('login: contraseña incorrecta 401 y correcta 200', async () => {
  cookie = ''; csrf = '';
  assert.equal((await call('POST', '/api/admin/login', { email: 'admin@ejemplo.co', password: 'incorrecta12345' }, { auth: false })).status, 401);
  const ok = await call('POST', '/api/admin/login', { email: 'admin@ejemplo.co', password: 'unaclavelarga123' }, { auth: false });
  assert.equal(ok.status, 200); csrf = ok.data.csrfToken;
});
await t('rate limit de login (429 tras abuso)', async () => {
  let last; for (let i = 0; i < 12; i++) last = await call('POST', '/api/admin/login', { email: 'x@y.co', password: 'malamalamala' }, { auth: false, headers: { 'cf-connecting-ip': '9.9.9.9' } });
  assert.equal(last.status, 429);
});
await t('borrar evento elimina invitados y respuestas (cascade)', async () => {
  assert.equal((await call('DELETE', `/api/admin/events/${eventId}`)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM guests WHERE event_id=?').get(eventId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM votes WHERE event_id=?').get(rev).n, 3); // otros eventos no se tocan
});
console.log('\nTodas las pruebas pasaron.');
