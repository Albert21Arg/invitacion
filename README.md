# Carta Sellada — invitaciones digitales

Plataforma de invitaciones individuales (baby shower) con estilo salvia, crema y arena.
Frontend React + Vite · Worker de Cloudflare · base de datos D1.

## Qué incluye
0. **Revelación de sexo**: tipo de invitación con votación niño/niña; las primeras hojas caen junto a las ramas y las posiciones estables se extienden gradualmente por el árbol a medida que llegan votos.
1. **Carta conectada a D1**: `GET /api/invitation?i=TOKEN` devuelve evento, invitado (nombre, cupos) y su respuesta previa. Los enlaces individuales usan `/?i=TOKEN`.
2. **Votación compartida**: crea una votación Niño/Niña desde `/admin`; todos usan el mismo enlace, sin información de invitación individual, votan una vez por dispositivo, ven su hoja caer en el árbol y consultan los resultados en vivo.
3. **Panel privado en la ruta principal `/`** (también disponible en `/admin`): primer acceso con clave de configuración, login con sesión, crear/editar/publicar/cerrar eventos, agregar invitados, generar enlaces únicos (copiar o enviar por WhatsApp), ver quién abrió cada invitación, respuestas y totales, regenerar enlace, eliminar y administrar votaciones compartidas.
4. **Seguridad y vista previa**: Open Graph dinámico por invitación y votación, Turnstile opcional, rate limiting, `noindex`.

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
(`npm run dev` de Vite solo sirve el frontend; usa `wrangler dev` para probar API y panel. La raíz sin parámetros abre el login; `/?i=TOKEN` abre una invitación y `/?poll=SLUG` una votación compartida.)

## Publicación
```bash
npx wrangler d1 migrations apply carta-sellada-db --remote   # aplica todas las migraciones pendientes
npx wrangler secret put ADMIN_SETUP_KEY
npm run deploy
```
Luego abre `https://TU-DOMINIO/`, crea tu cuenta (contraseña ≥ 12 caracteres) y **elimina el secreto** `ADMIN_SETUP_KEY` (`npx wrangler secret delete ADMIN_SETUP_KEY`); ya no hace falta y, mientras no exista, el alta inicial queda deshabilitada.

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
- **Votación compartida**: el servidor limita a un voto por votación usando una cookie `HttpOnly` y un identificador local del navegador; los resultados son accesibles desde el mismo enlace.
- Eventos en `draft` no abren; eventos `closed` se ven pero rechazan confirmaciones.

## Open Graph y WhatsApp
Al abrir `/?i=TOKEN`, el Worker inyecta título, descripción, URL e imagen Open Graph según el tipo de evento, sin incluir el nombre del invitado. Las tarjetas estáticas PNG son horizontales de 1200×630: `public/og.png` para baby shower, `public/og-reveal.png` para revelación y `public/og-voting.png` para votaciones compartidas. Sus composiciones vectoriales están en `public/og-baby.svg`, `public/og-reveal.svg` y `public/og-voting.svg`. WhatsApp puede guardar en caché la vista previa; después de cambiarla, puede tardar en mostrar la nueva versión.

## Pendiente / decisiones tuyas
- Fijar versiones de dependencias (hoy están en `latest`) y generar el lockfile con `npm install`.
- Exportar respuestas a CSV, recordatorios y varios administradores con roles.
- Política de privacidad: se guardan nombres, celulares y mensajes de invitados.

## Revelación de sexo con votación en vivo
En el panel elige **Tipo de invitación → Revelación de sexo**. Cada invitado abre su carta y vota **Equipo Niño** o **Equipo Niña**; el contador se actualiza solo cada 3 s (en el panel, cada 4 s).

La invitación de revelación se presenta en vistas separadas y en este orden: invitación con cuenta regresiva, votación, resultados en vivo, confirmación de asistencia y agradecimiento. Cada paso tiene un botón explícito para continuar; la asistencia solo se solicita después de votar y ver los resultados, y el agradecimiento aparece al registrar el RSVP. Después de votar, la pantalla de votación muestra únicamente el osito del equipo elegido. En resultados se usa la ilustración del árbol compartida por el usuario; se agrega una hoja azul por cada voto al equipo Niño y una rosa por cada voto al equipo Niña, conservando posiciones estables que se extienden gradualmente desde las ramas.

En el árbol también cae una hoja verde menta cada 30 segundos. El ciclo y las hojas acumuladas se guardan en D1, de modo que todos los visitantes ven el mismo estado incluso después de recargar. Las hojas ocupan espacios libres para no tapar los votos; al completar una hora o registrar un voto nuevo, las acumuladas caen hasta la base y comienza un ciclo compartido.

Las vistas públicas (invitación, voto, resultados, confirmación y agradecimiento) se ajustan a pantallas móviles desde 320×568 sin desplazamiento de página. El flujo de baby shower se presenta en pasos separados: carta de invitación, ubicación y mapa cuando están disponibles, confirmación de asistencia y agradecimiento después de enviar la respuesta. Las listas y formularios administrativos pueden desplazarse cuando su contenido excede la pantalla.

**Un voto por persona invitada.** Cada enlace permite registrar tantos votos como **cupos** tenga; las personas invitadas pueden elegir su equipo desde el mismo teléfono. El total de votos queda limitado en el servidor al número de cupos de ese enlace. La cookie `HttpOnly` y el id en `localStorage` permiten recuperar los votos registrados desde ese navegador, pero no limitan a una persona por dispositivo.
*Límite honesto:* en la web no existe un identificador real de cada asistente. Si se borran las cookies y los datos del sitio, se pierde la asociación de ese navegador con sus votos; el tope de cupos del enlace sigue vigente.

### Votación compartida sin invitación
En `/admin`, pulsa **Nueva votación** y crea la pregunta. Se genera un único enlace público, sin datos de anfitriones, evento ni invitado. Cualquiera que tenga el enlace puede elegir Niño o Niña, y los resultados se muestran en vivo. El servidor permite un voto por dispositivo/navegador y conserva la asociación con una cookie y un identificador local. Como en cualquier web, borrar cookies y datos del sitio o usar otro navegador puede permitir volver a votar; no es una verificación de identidad.

**Revelar.** En el detalle del evento: *Cerrar/Reabrir votación*, *Revelar: es niño/niña* y *Ocultar resultado*. El resultado no se guarda ni se envía a los invitados hasta que pulsas revelar; entonces aparece en todas las pantallas abiertas con confeti y porcentaje de acierto, y la votación se cierra.

Los votos se conservan si borras a un invitado; se eliminan al borrar el evento.

## Pruebas
- `npm test`: pruebas de integración del Worker (votos, topes, resultado oculto, CSRF, CSP…).
- La interfaz se verificó además en Chromium real (alta de admin, evento, enlace, 3 dispositivos votando, contador en vivo y revelación).
