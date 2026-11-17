# Runbook: PQRS en cuatro etapas (conversión de estados)

Código: `src/modules/pqr/pqr-etapas.ts` (etapa de cada valor guardado), el script
`src/seed/migrar-estados-pqr.ts` (reglas en `src/seed/migrar-estados-pqr.nucleo.ts`)
y el indicador de readiness `src/modules/health/pqr-estados.health.ts`.

## Qué cambia en los datos

Las PQRS pasan del modelo de cinco estados a cuatro etapas
(`radicada`, `clasificada`, `en_gestion`, `cerrada`):

| Estado anterior | Etapa nueva | Además |
| --- | --- | --- |
| `pendiente` | `radicada` | |
| `en_revision` | `en_gestion` | |
| `urgente` | `en_gestion` | `prioridad: 'alta'` (era un estado, ahora es prioridad) |
| `resuelto` | `cerrada` | `cerradaEn` = el que ya tenga, o `updatedAt` |
| `cerrado` | `cerrada` | `cerradaEn` = el que ya tenga, o `updatedAt` |

Cada PQR convertida recibe una entrada en la bitácora (`tipo: 'migrada'`, actor
«Sistema», detalle `Estado anterior: «<etiqueta>»`). El script es idempotente: lo
ya convertido no vuelve a coincidir.

## Pasos por ambiente

`<ambiente>` es el `--env=<ambiente>` del script (`.env.<ambiente>` en
`backend/`). El `--` antes de las banderas es obligatorio; en PowerShell de
Windows, probar `npm.cmd run ...`.

1. **Desplegar el backend.** Entiende ambos modelos (los valores anteriores
   siguen siendo válidos en el esquema y `pqr-etapas.ts` los lee como su etapa).
2. **Revisar, solo lectura:**
   `npm run migrar:estados-pqr -- --env=<ambiente>`.
   Cuenta las PQRS por estado anterior y no escribe nada. Código de salida 1 si
   hay pendientes, 0 si no. Guardar la salida en el ticket del despliegue.
3. **Convertir:**
   `npm run migrar:estados-pqr -- --env=<ambiente> --aplicar`.
   Código de salida 0. Se puede repetir sin riesgo.
4. **Desplegar el frontend** (los cuatro pasos de etapa y la prioridad).

## Qué reporta readiness

`GET /api/v1/health/ready` incluye `pqr-estados`, y **nunca falla**:
`/health/ready` es el sondeo de arranque (startup probe) de Cloud Run
(`docs/runbooks/despliegue-fusion.md`) y el backend nuevo lee correctamente los
estados anteriores, así que tener PQRS sin convertir no es un mal funcionamiento
ni puede impedir que la revisión nueva quede lista. Mientras el script no se haya
ejecutado, readiness sigue en verde y el indicador muestra la nota
`pendiente`: «Hay PQRS con estados anteriores: ejecuta npm run migrar:estados-pqr -- --env=<ambiente> --aplicar».
Tras el paso 3 la nota desaparece. Si la lectura falla o tarda más de 2 s, el
indicador sigue en verde con `omitido` («No se pudo comprobar los estados de
PQRS.»), sin mostrar el error ni valores. Si la nota reaparece después del paso 3,
entró una PQR con estado anterior (un cliente viejo guardando): repetir el paso 3.

## Rollback

- El enum del backend anterior no rechaza nada al leer, así que volver atrás el
  backend no rompe la lectura de PQRS ya convertidas.
- El frontend anterior mostraría texto de etapa desconocido para `radicada`,
  `clasificada`, `en_gestion` y `cerrada` hasta que se despliegue el frontend
  nuevo: por eso el frontend va al final, después de convertir.
- Tras la conversión, el backend anterior no contaría las PQRS abiertas
  convertidas en el contador de abiertas del panel y trataría `cerrada` como
  activa al eliminar un técnico (solo esos contadores se ven afectados; los datos
  quedan intactos).
- La conversión no se deshace con un script: la bitácora conserva el estado
  anterior de cada PQR (`Estado anterior: «...»`) por si hubiera que
  reconstruirlo a mano.
