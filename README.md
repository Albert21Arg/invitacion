# Carta Sellada — invitaciones digitales

Plataforma de invitaciones individuales (baby shower) con estilo salvia, crema y arena.
Frontend React + Vite · Worker de Cloudflare · base de datos D1.

## Qué incluye
0. **Revelación de sexo**: tipo de invitación con votación niño/niña y contador en vivo (ver sección abajo).
1. **Carta conectada a D1**: `GET /api/invitation?i=TOKEN` devuelve evento, invitado (nombre, cupos) y su respuesta previa. Sin token se muestra una demo.
2. **Panel privado en `/admin`**: primer acceso con clave de configuración, login con sesión, crear/editar/publicar/cerrar eventos, agregar invitados, generar enlaces únicos (copiar o enviar por WhatsApp), ver respuestas y totales, regenerar enlace, eliminar.
3. **Seguridad y vista previa**: Open Graph dinámico por invitación, Turnstile opcional, rate limiting, `noindex`.

## Desarrollo local
```bash
npm install
npm test                 # pruebas de integración del Worker (Node 22+, sin red)
npm run build
npx wrangler d1 migrations apply carta-sellada-db --local
npx wrangler dev         # sirve Worker + dist en http://localhost:8787
```
Para el primer admin en local, crea `.dev.vars`:
```
ADMIN_SETUP_KEY=una-clave-larga-y-aleatoria
```
(`npm run dev` de Vite solo sirve el frontend; usa `wrangler dev` para probar API y panel.)

## Publicación
```bash
npx wrangler d1 create carta-sellada-db        # copia database_id a wrangler.toml
npx wrangler d1 migrations apply carta-sellada-db --remote   # aplica 0001, 0002 y 0003
npx wrangler secret put ADMIN_SETUP_KEY
npm run build && npx wrangler deploy
```
Luego abre `https://TU-DOMINIO/admin`, crea tu cuenta (contraseña ≥ 12 caracteres) y **elimina el secreto** `ADMIN_SETUP_KEY` (`npx wrangler secret delete ADMIN_SETUP_KEY`); ya no hace falta y, mientras no exista, el alta inicial queda deshabilitada.

### Turnstile (recomendado)
Crea un widget en el panel de Cloudflare y configura:
- `TURNSTILE_SITE_KEY` como variable en `wrangler.toml` (`[vars]`),
- `npx wrangler secret put TURNSTILE_SECRET`.
Con ambos definidos, se exige en el RSVP y en el login. Sin ellos, solo actúa el rate limiting.

## Cómo funciona la seguridad
- **Tokens de invitación**: 192 bits aleatorios; en D1 solo se guarda el hash SHA-256. El enlace en claro se muestra una única vez al crearlo (o al regenerarlo, lo que invalida el anterior).
- **Contraseñas**: PBKDF2-SHA256 con sal (100 000 iteraciones, el máximo que permite Workers). Verificación en tiempo constante y hash ficticio para correos inexistentes.
- **Sesiones**: cookie `HttpOnly`, `SameSite=Strict` (`Secure` y prefijo `__Host-` en HTTPS); se guarda solo el hash en D1; caduca a los 7 días.
- **CSRF**: toda petición que modifica datos exige cabecera `X-CSRF-Token` ligada a la sesión y `Origin` coincidente.
- **Rate limiting** (D1): login por IP y por cuenta, alta inicial, consulta de invitación y RSVP.
- Eventos en `draft` no abren; eventos `closed` se ven pero rechazan confirmaciones.

## Open Graph y WhatsApp
Al abrir `/?i=TOKEN`, el Worker inyecta `og:title`, `og:description`, `og:url` y `og:image` según el evento (sin incluir el nombre del invitado). La imagen es estática: `public/og.png` (1200×630); reemplázala por la tuya. Una imagen distinta por evento requeriría generar PNG en el Worker o subirlas a R2 (pendiente). WhatsApp cachea las vistas previas: si cambias datos, puede tardar en actualizarse.

## Pendiente / decisiones tuyas
- Fijar versiones de dependencias (hoy están en `latest`) y generar el lockfile con `npm install`.
- Exportar respuestas a CSV, recordatorios y varios administradores con roles.
- Política de privacidad: se guardan nombres, celulares y mensajes de invitados.

## Revelación de sexo con votación en vivo
En el panel elige **Tipo de invitación → Revelación de sexo**. Cada invitado abre su carta y vota **Equipo Niño** o **Equipo Niña**; el contador se actualiza solo cada 3 s (en el panel, cada 4 s).

La invitación de revelación se presenta en vistas separadas y en este orden: invitación con cuenta regresiva, votación, resultados en vivo, confirmación de asistencia y agradecimiento. Cada paso tiene un botón explícito para continuar; la asistencia solo se solicita después de votar y ver los resultados, y el agradecimiento aparece al registrar el RSVP. Después de votar, la pantalla de votación muestra únicamente el osito del equipo elegido. En resultados se usa la ilustración del árbol compartida por el usuario; se agrega una hoja azul por cada voto al equipo Niño y una rosa por cada voto al equipo Niña, distribuyéndolas al azar por el tronco, la copa y las puntas de las ramas.

**Un voto por persona invitada.** Cada enlace permite registrar tantos votos como **cupos** tenga; las personas invitadas pueden elegir su equipo desde el mismo teléfono. El total de votos queda limitado en el servidor al número de cupos de ese enlace. La cookie `HttpOnly` y el id en `localStorage` permiten recuperar los votos registrados desde ese navegador, pero no limitan a una persona por dispositivo.
*Límite honesto:* en la web no existe un identificador real de cada asistente. Si se borran las cookies y los datos del sitio, se pierde la asociación de ese navegador con sus votos; el tope de cupos del enlace sigue vigente.

**Revelar.** En el detalle del evento: *Cerrar/Reabrir votación*, *Revelar: es niño/niña* y *Ocultar resultado*. El resultado no se guarda ni se envía a los invitados hasta que pulsas revelar; entonces aparece en todas las pantallas abiertas con confeti y porcentaje de acierto, y la votación se cierra.

Los votos se conservan si borras a un invitado; se eliminan al borrar el evento.

## Pruebas
- `npm test`: pruebas de integración del Worker (votos, topes, resultado oculto, CSRF, CSP…).
- La interfaz se verificó además en Chromium real (alta de admin, evento, enlace, 3 dispositivos votando, contador en vivo y revelación).
