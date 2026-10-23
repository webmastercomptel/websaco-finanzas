# WebSACO Finanzas — Backend

Esqueleto inicial del backend de WebSACO Finanzas. Stack: Node 22, NestJS 11,
TypeScript, MongoDB/Mongoose, Redis, Firebase Admin.

## Requisitos

- Node.js 22

Nada más. **No hace falta Docker ni instalar bases de datos**: Mongo (Atlas),
Redis (Redis Cloud) y Firebase son servicios en internet. Lo único que necesitás
es pegar sus direcciones de conexión en el archivo `.env`.

## Puesta en marcha

```bash
npm install
cp .env.example .env   # completá los valores (cada uno dice de dónde sale)
npm run start:dev
```

La API queda en `http://localhost:3000/api/v1`.

### ¿Quedó todo bien conectado?

```
GET http://localhost:3000/api/v1/health/ready
```

Responde `ok` solo si el servidor llega a Mongo y a Redis. Si algo falla, la
respuesta dice **cuál** de los dos, que es la forma más rápida de encontrar una
dirección de conexión mal pegada.

También existe `GET /api/v1/health/live`, que solo confirma que el proceso está
vivo y no consulta ninguna dependencia.

`/health/ready` también falla si la configuración de la integración con Comptable
quedó a medias o mal escrita: solo `COMPTABLE_API_URL` o solo
`COMPTABLE_HMAC_SECRET`, o una URL que no termina en `/api/v1`. El mensaje dice
**qué variable** corregir (nunca muestra su valor) y no llama a Comptable: solo
lee la configuración. Si ninguna de las dos variables está definida, la
integración está deshabilitada y el indicador `integracion-comptable` se reporta
como omitido (`"omitido": "integración deshabilitada"`) sin bloquear. Este
chequeo no está en `GET /api/v1/health` (el del `HEALTHCHECK` del Dockerfile): una
URL mala se arregla corrigiendo la variable y redesplegando, no reiniciando.

### Scripts por ambiente (`--env=<ambiente>`)

Los scripts que abren Mongo (`seed:admin`, `seed:demo`, `clear:demo`,
`migrar:nombre-propio`, `limpiar:indices-ingles`, `sembrar:consecutivos`)
**exigen** `--env=<ambiente>` y leen el archivo `.env.<ambiente>` de la raíz del
backend. Sin la bandera no hacen nada: no hay valor por defecto, para no escribir
en la base equivocada.

```bash
npm run seed:admin -- --env=local
npm run migrar:nombre-propio -- --env=production --simular
npm run limpiar:indices-ingles -- --env=production --db=production --aplicar
```

- El `--` antes de `--env` es obligatorio: sin él npm descarta la bandera.
  *Problema reportado, no verificado aquí:* en Windows PowerShell con npm >= 9
  el `--` puede ser consumido antes de llegar al script y `--env` se pierde (el
  script frena con el mensaje de uso). Alternativas a probar:
  `npm.cmd run <script> -- --env=<ambiente>` o entrecomillarlo:
  `npm run <script> '--' --env=<ambiente>`.
- Un archivo por ambiente (`.env.local`, `.env.staging`, `.env.production`…),
  cada uno una copia completa de `.env.example` con SUS valores. Todos están en
  `.gitignore` salvo `.env.example`; nunca se suben. Nombres válidos: minúsculas,
  números y guiones.
- **Ese archivo es la única fuente de variables**: el `.env` común NO se lee, y
  una variable de la app que el archivo no defina no se toma de la terminal ni
  de ningún otro lado (si la terminal la tenía exportada, se descarta y el
  script lo avisa). Si falta una requerida, la validación falla con su nombre;
  las opcionales que falten se listan en un aviso. Ejemplo: `ROOT_ADMIN_EMAIL`
  para `seed:admin` tiene que estar dentro del archivo, y sin las variables
  `COMPTABLE_*` la integración queda deshabilitada.
- Cada archivo debe definir su propio `MONGODB_URI`. Sus valores pisan los que
  la terminal ya tenga exportados.
- El script imprime la base de destino (sin credenciales). Todo ambiente que no
  sea `local`, `dev`, `development` o `test` además exige escribir el nombre de
  la base de datos antes de continuar, y solo en una terminal interactiva: con
  la entrada por pipe o redirección el script se niega. La guarda confía en el
  NOMBRE del ambiente: un `.env.dev` que apunte a producción no se detecta (por
  eso se imprime el destino cada vez).
- `sembrar:consecutivos` y `limpiar:indices-ingles` conservan su propio
  `--db=<base>`: esa base reemplaza a la de la URI y es la que se imprime y se
  pide escribir.
- Los archivos `scripts/*.js` (se corren a mano con `node --env-file=...`) no
  usan este selector.

## Comandos

```bash
npm run start:dev     # servidor con recarga automática
npm run build         # compila con SWC
npm run typecheck     # tsc --noEmit (el build NO chequea tipos, correr esto aparte)
npm run lint          # eslint --fix
npm test              # tests unitarios (*.spec.ts, junto al código)
npm run test:watch
npm run test:cov
npm run seed:admin -- --env=<ambiente>   # scripts: ver "Scripts por ambiente"
```

## Notas de este esqueleto

- Todavía no hay módulos de negocio. Lo que existe es la base: configuración,
  conexiones, salud, autenticación con Firebase, contexto de copropiedad
  (multi-tenancy) y permisos (CASL).
- **Ingreso de usuarios**: el sistema solo *verifica* identidades, nunca crea ni
  modifica usuarios. Las cuentas se dan de alta a mano en la consola de
  Firebase. Por ahora la única cuenta que puede operar es la que figura en
  `ROOT_ADMIN_EMAIL`; cualquier otra entra pero sin ningún permiso.
- Regla dura de configuración: ninguna variable requerida tiene un valor por
  defecto silencioso. Si falta o está mal, la app falla ruidosamente al arrancar
  y te dice qué esperaba (ver `src/config/env.validation.ts`).
- `pdf-lib` está incluido porque Finanzas necesita **generar** PDFs (facturas,
  recibos de caja, notas crédito) — es esencial del dominio. Funciona con el
  runner de Jest estándar, sin el flag `--experimental-vm-modules`.
- `pdfjs-dist` (extracción de texto de PDF) NO se incluye: en este dominio los
  PDF se generan, no se leen.
- **Publicación de lotes a WebSaco3** (opcional, por copropiedad): variables
  `WEBSACO3_*`, orden de despliegue, el `curl` manual de barrido y cómo
  recuperar filas fallidas están en
  [`docs/runbooks/publicacion-websaco3.md`](docs/runbooks/publicacion-websaco3.md).
