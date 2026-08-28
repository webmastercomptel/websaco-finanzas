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

## Comandos

```bash
npm run start:dev     # servidor con recarga automática
npm run build         # compila con SWC
npm run typecheck     # tsc --noEmit (el build NO chequea tipos, correr esto aparte)
npm run lint          # eslint --fix
npm test              # tests unitarios (*.spec.ts, junto al código)
npm run test:watch
npm run test:cov
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
