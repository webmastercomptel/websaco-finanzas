// src/seed/claves-finanzas-latentes.nucleo.ts
//
// The pure core of `claves-finanzas-latentes.ts` (the conversion that has to run
// per environment around the equipo-delegacion release). No Nest, no Mongo, no
// I/O of its own: the runner hands it what it read through `AlmacenClaves`, so
// every rule below is unit-tested with an in-memory store and the script itself
// is never needed to prove them. It lives in its own file so importing it never
// runs a `main` (the script does, on import, like the other seeds).
import {
  MODULE_TO_SUBJECT,
  MODULE_TO_SUBJECT_ADMINISTRACION,
  VERB_TO_ACTION,
  VERB_TO_ACTION_ADMINISTRACION,
} from '../modules/casl/permission-map';
import {
  esPermisoAdministracion,
  PERMISOS_FINANZAS,
} from '../modules/casl/permisos-catalogo';

/* ── Keys ──────────────────────────────────────────────────── */

const SEGMENTOS_FINANZAS: ReadonlySet<string> = new Set(
  Object.keys(MODULE_TO_SUBJECT),
);
const SEGMENTOS_ADMINISTRACION: ReadonlySet<string> = new Set(
  Object.keys(MODULE_TO_SUBJECT_ADMINISTRACION),
);

/** `segmento.verbo`, or null when the key is not exactly two non-empty parts. */
function partirClave(
  clave: string,
): { segmento: string; verbo: string } | null {
  const partes = clave.split('.');
  if (partes.length !== 2 || !partes[0] || !partes[1]) return null;
  return { segmento: partes[0], verbo: partes[1] };
}

/**
 * Whether the key belongs to a Finanzas SEGMENT, whatever its verb. Detection by
 * segment and not by `moduloDePermiso` on purpose: since the Finanzas
 * vocabulary lost `gestionar`, `moduloDePermiso('facturas.gestionar')` is null,
 * which would hide exactly the keys this script exists to convert.
 */
function esClaveFinanciera(clave: string): boolean {
  const partes = partirClave(clave);
  return partes !== null && SEGMENTOS_FINANZAS.has(partes.segmento);
}

/** A Finanzas `x.gestionar`: the retired "every action of x" key. */
function esGestionarFinanciero(clave: string): boolean {
  const partes = partirClave(clave);
  return (
    partes !== null &&
    partes.verbo === 'gestionar' &&
    SEGMENTOS_FINANZAS.has(partes.segmento)
  );
}

/** The Finanzas-segment keys of a list, in their order. */
export function clavesFinancierasPorSegmento(
  claves: readonly string[],
): string[] {
  return claves.filter(esClaveFinanciera);
}

/** The list without any Finanzas-segment key (`gestionar` included). */
export function quitarClavesFinancieras(claves: readonly string[]): string[] {
  return claves.filter((clave) => !esClaveFinanciera(clave));
}

/**
 * The real keys of a Finanzas segment in the NEW catalog (`PERMISOS_FINANZAS`):
 * what `x.gestionar` used to stand for. Read from the code that ships with this
 * script, so a segment with no action (`anulaciones`) expands to nothing.
 */
export function clavesRealesDe(segmento: string): string[] {
  return PERMISOS_FINANZAS.filter((clave) => clave.startsWith(`${segmento}.`));
}

/**
 * Additive expansion: every `x.gestionar` (Finanzas) adds the real keys of `x`
 * the list does not have yet, at the end and in catalog order. Nothing is
 * removed, `x.gestionar` included, so the old backend keeps working until the
 * deploy. Idempotent: a second pass finds nothing missing.
 */
export function expandirGestionar(claves: readonly string[]): string[] {
  const resultado = [...claves];
  const presentes = new Set(claves);
  for (const clave of claves) {
    if (!esGestionarFinanciero(clave)) continue;
    const { segmento } = partirClave(clave)!;
    for (const real of clavesRealesDe(segmento)) {
      if (presentes.has(real)) continue;
      presentes.add(real);
      resultado.push(real);
    }
  }
  return resultado;
}

/**
 * A stored `recibos.aprobar` that predates this release was dead (no route
 * asked for `approve Recibo`); with the new vocabulary it opens
 * `POST /lotes-recibos/:id/aplicar`. Whoever holds it WITHOUT `recibos.gestionar`
 * never had that power, so it goes; with `recibos.gestionar` it is the very key
 * the expansion gives, and stays. The decision is taken on the array as read.
 */
export function quitarAprobarMuerto(claves: readonly string[]): string[] {
  const presentes = new Set(claves);
  if (!presentes.has('recibos.aprobar') || presentes.has('recibos.gestionar')) {
    return [...claves];
  }
  return claves.filter((clave) => clave !== 'recibos.aprobar');
}

/**
 * Grammar-valid Administración keys the catalog does not offer
 * (`usuarios.gestionar`, `pqr.crear`): the read side drops them. Only reported,
 * never converted: whether they were meant to grant something is a human call.
 */
export function clavesAdministracionNoCatalogadas(
  claves: readonly string[],
): string[] {
  const encontradas = claves.filter((clave) => {
    const partes = partirClave(clave);
    if (!partes || !SEGMENTOS_ADMINISTRACION.has(partes.segmento)) return false;
    const verboConocido =
      Object.hasOwn(VERB_TO_ACTION, partes.verbo) ||
      Object.hasOwn(VERB_TO_ACTION_ADMINISTRACION, partes.verbo);
    return verboConocido && !esPermisoAdministracion(clave);
  });
  return [...new Set(encontradas)];
}

/* ── What the runner reads ─────────────────────────────────── */

/** An assignment as read, with the labels the report prints. */
export interface AsignacionLeida {
  id: string;
  email: string;
  /** Absent on legacy rows, which read as `administrativo`. */
  perfil?: string | null;
  alcance: string;
  /** Code of the coproperty or entity the row targets. */
  destino: string;
  estado: string;
  /** Exactly as stored (order included): the conditional write matches on it. */
  permisos: readonly string[];
}

/** A role as read. */
export interface RolLeido {
  id: string;
  /** Code of the coproperty that owns it. */
  copropiedad: string;
  nombre: string;
  permisos: readonly string[];
  titularesActivos: number;
}

/**
 * What says the new backend already ran. Neither source is proof of the
 * absence: see `hayEvidenciaDeDespliegue` for the blind spot.
 */
export interface EvidenciaDespliegue {
  /** When `--aplicar --retirar-gestionar` started (the marker), or null. */
  retiroEn: Date | null;
  /**
   * Audit entries only the new backend writes: `entidadTipo: 'rol'` (roles were
   * not audited before) or any entry carrying `detalle`.
   */
  entradasAuditoria: number;
  /** `createdAt` of the oldest such entry, or null when there are none. */
  primeraEntradaAuditoria: Date | null;
}

/**
 * The only door to the database. `reemplazarPermisos` is the conditional write:
 * it applies only while the stored keys still equal `esperadas`, and answers
 * false when the document changed under the script (or is gone).
 */
export interface AlmacenClaves {
  leerEvidenciaDespliegue(): Promise<EvidenciaDespliegue>;
  /**
   * Records that the post-deploy cleanup was started, so a later pre-deploy
   * `--aplicar` refuses. Idempotent: a second call keeps the first date.
   */
  marcarRetiroGestionar(): Promise<void>;
  leerAsignaciones(): Promise<AsignacionLeida[]>;
  leerRoles(): Promise<RolLeido[]>;
  reemplazarPermisos(
    tipo: 'asignacion' | 'rol',
    id: string,
    esperadas: readonly string[],
    nuevas: readonly string[],
  ): Promise<boolean>;
}

/* ── Plans ─────────────────────────────────────────────────── */

export type Motivo =
  | 'quitar-personal'
  | 'quitar-rol'
  | 'aprobar-muerta'
  | 'expandir'
  | 'retirar-gestionar';

interface CambioBase {
  /** What the document would hold after the write. */
  despues: string[];
  /** Keys in `despues` and not in the array read, sorted. */
  agregadas: string[];
  /** Keys in the array read and not in `despues`, sorted. */
  quitadas: string[];
  motivos: Motivo[];
}

export interface CambioAsignacion extends CambioBase {
  tipo: 'asignacion';
  fila: AsignacionLeida;
}

export interface CambioRol extends CambioBase {
  tipo: 'rol';
  fila: RolLeido;
}

export type Cambio = CambioAsignacion | CambioRol;

export interface PlanConversion {
  cambios: Cambio[];
  /** Report only; never part of `cambios`, never part of the exit code. */
  sinCatalogar: Array<{ fila: AsignacionLeida; claves: string[] }>;
}

export interface PlanRetiro {
  cambios: CambioAsignacion[];
  /** Rows that lack some real key of an `x.gestionar` they hold: not touched. */
  omitidas: Array<{
    fila: AsignacionLeida;
    faltantes: Array<{ gestionar: string; faltan: string[] }>;
  }>;
}

/**
 * Whether the data shows the new backend (or the post-deploy cleanup) already
 * ran. A heuristic with a known blind spot: right after the deploy, before
 * anyone writes a role or a key change from Equipo, there is no audit entry and
 * no marker yet, and nothing here can tell that state from the pre-deploy one.
 */
export function hayEvidenciaDeDespliegue(e: EvidenciaDespliegue): boolean {
  return e.retiroEn !== null || e.entradasAuditoria > 0;
}

const diferencia = (a: readonly string[], b: readonly string[]): string[] => {
  const excluidas = new Set(b);
  return [...new Set(a.filter((clave) => !excluidas.has(clave)))].sort();
};

/**
 * The pre-deploy conversion, decided per document and per profile (a `personal`
 * row is never expanded: its Finanzas keys were inert, and expanding them first
 * would switch access on):
 *
 * - `personal` assignment (any scope, any `estado`): every Finanzas-segment key
 *   goes, `gestionar` included.
 * - any other assignment (legacy no-`perfil` too): the dead `recibos.aprobar`
 *   goes, then each Finanzas `x.gestionar` is expanded additively.
 * - role: every Finanzas-segment key goes.
 *
 * The dead-key decision and the expansion both read the array AS READ, so the
 * removal can never undo what the expansion legitimately adds.
 */
export function planificarConversion(
  asignaciones: readonly AsignacionLeida[],
  roles: readonly RolLeido[],
): PlanConversion {
  const cambios: Cambio[] = [];

  for (const fila of asignaciones) {
    const antes = fila.permisos;
    const motivos: Motivo[] = [];
    let despues: string[];

    if ((fila.perfil ?? 'administrativo') === 'personal') {
      despues = quitarClavesFinancieras(antes);
      if (despues.length !== antes.length) motivos.push('quitar-personal');
    } else {
      const sinMuerta = quitarAprobarMuerto(antes);
      if (sinMuerta.length !== antes.length) motivos.push('aprobar-muerta');
      despues = expandirGestionar(sinMuerta);
      if (despues.length !== sinMuerta.length) motivos.push('expandir');
    }

    if (motivos.length === 0) continue;
    cambios.push({
      tipo: 'asignacion',
      fila,
      despues,
      agregadas: diferencia(despues, antes),
      quitadas: diferencia(antes, despues),
      motivos,
    });
  }

  for (const fila of roles) {
    const despues = quitarClavesFinancieras(fila.permisos);
    if (despues.length === fila.permisos.length) continue;
    cambios.push({
      tipo: 'rol',
      fila,
      despues,
      agregadas: [],
      quitadas: diferencia(fila.permisos, despues),
      motivos: ['quitar-rol'],
    });
  }

  const sinCatalogar = asignaciones
    .map((fila) => ({
      fila,
      claves: clavesAdministracionNoCatalogadas(fila.permisos),
    }))
    .filter(({ claves }) => claves.length > 0);

  return { cambios, sinCatalogar };
}

/**
 * The post-deploy cleanup (`--retirar-gestionar`): removes the leftover
 * Finanzas `x.gestionar` from non-`personal` assignments and nothing else (the
 * dead-`recibos.aprobar` rule belongs to the pre-deploy modes: after the deploy
 * that key is legitimate). A row is only touched when it holds every real key of
 * each `x.gestionar` it carries: otherwise the removal would strand it on a
 * rollback, so it is reported and left as it is. Direct keys only: roles cannot
 * carry a `gestionar` any more and say nothing about this conversion.
 */
export function planificarRetiro(
  asignaciones: readonly AsignacionLeida[],
): PlanRetiro {
  const cambios: CambioAsignacion[] = [];
  const omitidas: PlanRetiro['omitidas'] = [];

  for (const fila of asignaciones) {
    if ((fila.perfil ?? 'administrativo') === 'personal') continue;
    const gestionar = [...new Set(fila.permisos.filter(esGestionarFinanciero))];
    if (gestionar.length === 0) continue;

    const presentes = new Set(fila.permisos);
    const faltantes = gestionar
      .map((clave) => ({
        gestionar: clave,
        faltan: clavesRealesDe(partirClave(clave)!.segmento).filter(
          (real) => !presentes.has(real),
        ),
      }))
      .filter(({ faltan }) => faltan.length > 0);

    if (faltantes.length > 0) {
      omitidas.push({ fila, faltantes });
      continue;
    }
    const despues = fila.permisos.filter((c) => !esGestionarFinanciero(c));
    cambios.push({
      tipo: 'asignacion',
      fila,
      despues,
      agregadas: [],
      quitadas: diferencia(fila.permisos, despues),
      motivos: ['retirar-gestionar'],
    });
  }

  return { cambios, omitidas };
}

/* ── Running ───────────────────────────────────────────────── */

export interface ModoScript {
  /** Without it nothing is ever written. */
  aplicar: boolean;
  /** The post-deploy cleanup (preview unless combined with `aplicar`). */
  retirarGestionar: boolean;
}

const BANDERAS_PROPIAS = ['--aplicar', '--retirar-gestionar'];

/**
 * Reads the script's flags. `--env=<name>` is consumed by `load-script-env`. Any
 * other `--flag` stops the script before it opens a connection: a typo of
 * `--retirar-gestionar` must not silently run the pre-deploy listing instead.
 */
export function leerModo(argv: readonly string[]): ModoScript {
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    if (arg.startsWith('--env=') || BANDERAS_PROPIAS.includes(arg)) continue;
    throw new Error(
      `Bandera desconocida: ${arg}. Usa: --env=<ambiente> [--aplicar] [--retirar-gestionar]`,
    );
  }
  return {
    aplicar: argv.includes('--aplicar'),
    retirarGestionar: argv.includes('--retirar-gestionar'),
  };
}

export interface ResultadoEjecucion {
  modo: ModoScript;
  /** Present in the pre-deploy modes. */
  conversion?: PlanConversion;
  /** Present with `--retirar-gestionar`. */
  retiro?: PlanRetiro;
  /** Present in the pre-deploy modes: what the guard looked at. */
  evidencia?: EvidenciaDespliegue;
  /**
   * A pre-deploy mode found evidence that the new backend already ran: nothing
   * was planned or written (the default listing reports it, `--aplicar` refuses).
   */
  rechazadoPorDespliegue?: boolean;
  aplicados: Cambio[];
  conflictos: Cambio[];
  /**
   * Read-only modes: 1 when something is pending (so a runbook can gate on it).
   * Writing modes: 1 when some document changed under the script.
   * 2 in either pre-deploy mode when the deploy already happened (see
   * `rechazadoPorDespliegue`): distinct, so a runbook can tell "refused" from
   * "pending" and from "conflict".
   */
  codigoSalida: 0 | 1 | 2;
}

/**
 * Plans (and, with `aplicar`, writes) one document at a time through a
 * conditional write. Read-only unless `modo.aplicar`; never throws for a
 * document that moved, it reports it.
 */
export async function ejecutar(
  modo: ModoScript,
  almacen: AlmacenClaves,
): Promise<ResultadoEjecucion> {
  const resultado: ResultadoEjecucion = {
    modo,
    aplicados: [],
    conflictos: [],
    codigoSalida: 0,
  };

  if (!modo.retirarGestionar) {
    // The guard runs before anything is read or planned: after the deploy the
    // pre-deploy rules would list (and `--aplicar` strip) legitimate grants.
    resultado.evidencia = await almacen.leerEvidenciaDespliegue();
    if (hayEvidenciaDeDespliegue(resultado.evidencia)) {
      resultado.rechazadoPorDespliegue = true;
      resultado.codigoSalida = 2;
      return resultado;
    }
  } else if (modo.aplicar) {
    // Before the first write, so a run that fails midway still leaves it.
    await almacen.marcarRetiroGestionar();
  }

  const asignaciones = await almacen.leerAsignaciones();

  let cambios: Cambio[];
  if (modo.retirarGestionar) {
    resultado.retiro = planificarRetiro(asignaciones);
    cambios = resultado.retiro.cambios;
  } else {
    resultado.conversion = planificarConversion(
      asignaciones,
      await almacen.leerRoles(),
    );
    cambios = resultado.conversion.cambios;
  }

  if (!modo.aplicar) {
    resultado.codigoSalida = cambios.length > 0 ? 1 : 0;
    return resultado;
  }

  for (const cambio of cambios) {
    const escrito = await almacen.reemplazarPermisos(
      cambio.tipo,
      cambio.fila.id,
      cambio.fila.permisos,
      cambio.despues,
    );
    (escrito ? resultado.aplicados : resultado.conflictos).push(cambio);
  }
  resultado.codigoSalida = resultado.conflictos.length > 0 ? 1 : 0;
  return resultado;
}

/* ── Report ────────────────────────────────────────────────── */

const lista = (claves: readonly string[]): string =>
  claves.length > 0 ? claves.join(', ') : '(ninguna)';

function lineaDeFila(cambio: Cambio): string {
  const identidad =
    cambio.tipo === 'asignacion'
      ? `${cambio.fila.id} | ${cambio.fila.email} | ${cambio.fila.alcance} ${cambio.fila.destino} | estado ${cambio.fila.estado} | perfil ${cambio.fila.perfil ?? 'sin perfil'}`
      : `${cambio.fila.id} | ${cambio.fila.copropiedad} | "${cambio.fila.nombre}" | titulares activos ${cambio.fila.titularesActivos}`;
  const partes = [
    identidad,
    `claves: ${lista(cambio.fila.permisos)}`,
    ...(cambio.quitadas.length > 0 ? [`quita: ${lista(cambio.quitadas)}`] : []),
    ...(cambio.agregadas.length > 0
      ? [`agrega: ${lista(cambio.agregadas)}`]
      : []),
  ];
  return `  - ${partes.join(' | ')}`;
}

function seccion(
  titulo: string,
  cambios: readonly Cambio[],
  motivo: Motivo,
): string[] {
  const delMotivo = cambios.filter((c) => c.motivos.includes(motivo));
  return [`${titulo} (${delMotivo.length})`, ...delMotivo.map(lineaDeFila)];
}

const fechaIso = (fecha: Date | null): string =>
  fecha ? fecha.toISOString().slice(0, 10) : 'fecha desconocida';

/** Why the guard fired, one line per piece of evidence. */
function lineasDeEvidencia(e: EvidenciaDespliegue): string[] {
  const lineas: string[] = [];
  if (e.retiroEn) {
    lineas.push(
      `  - Marca de --aplicar --retirar-gestionar escrita el ${fechaIso(e.retiroEn)}: el paso posterior al despliegue ya se ejecutó.`,
    );
  }
  if (e.entradasAuditoria > 0) {
    lineas.push(
      `  - ${e.entradasAuditoria} entrada(s) de auditoría de las que solo escribe el backend nuevo (de un rol o con detalle de claves), la primera el ${fechaIso(e.primeraEntradaAuditoria)}.`,
    );
  }
  return lineas;
}

/** The operator-facing report (Spanish, like the other scripts), line by line. */
export function informe(resultado: ResultadoEjecucion): string[] {
  const { modo } = resultado;
  const etiquetaModo = modo.retirarGestionar
    ? modo.aplicar
      ? 'APLICAR --retirar-gestionar (escribe)'
      : 'VISTA PREVIA de --retirar-gestionar (solo lectura, no escribe nada)'
    : modo.aplicar
      ? 'APLICAR (escribe)'
      : 'LECTURA (solo lectura, no escribe nada)';
  const lineas = [`== Claves de Finanzas latentes: ${etiquetaModo} ==`];

  if (resultado.rechazadoPorDespliegue && resultado.evidencia) {
    lineas.push(
      modo.aplicar
        ? 'SE NIEGA: hay evidencia de que el backend nuevo ya corrió, y --aplicar (modo previo al despliegue) quitaría ahora claves legítimas de Finanzas en filas personal y roles.'
        : 'Hay evidencia de que el backend nuevo ya corrió: los modos previos al despliegue (por defecto y --aplicar) ya no aplican.',
      ...lineasDeEvidencia(resultado.evidencia),
      'Lo único que sigue vigente es --retirar-gestionar (vista previa) y --aplicar --retirar-gestionar.',
      'No se escribió nada.',
      `Código de salida: ${resultado.codigoSalida}.`,
    );
    return lineas;
  }

  if (resultado.evidencia) {
    lineas.push(
      'Sin evidencia de que el backend nuevo ya corrió (ninguna marca de --retirar-gestionar ni auditoría de roles o con detalle). Ojo: esta comprobación no ve un despliegue reciente en el que nadie ha escrito aún un rol ni un cambio de claves; no sustituye a saber si el despliegue ya ocurrió.',
    );
  }

  if (modo.retirarGestionar) {
    lineas.push(
      'AVISO: es el paso de DESPUÉS del despliegue, y solo cuando ya no se quiera volver atrás: tras él, volver al backend anterior deja sin las cuatro rutas (DELETE /conceptos/:id, DELETE /lotes/:id, DELETE /inmuebles/:id, POST /lotes-recibos/:id/aplicar) a quien las tenía por x.gestionar.',
    );
  } else {
    lineas.push(
      'AVISO: este script es para correr ANTES del despliegue del backend. Después, una clave de Finanzas en una fila personal es legítima y recibos.aprobar es real: volver a aplicar estos pasos se las quitaría.',
    );
  }

  if (resultado.retiro) {
    const { cambios, omitidas } = resultado.retiro;
    lineas.push(
      `${modo.aplicar ? 'Se quitó' : 'Se quitaría'} x.gestionar de ${cambios.length} fila(s):`,
      ...cambios.map(lineaDeFila),
      `Omitidas por falta de alguna clave real (perdería acceso al volver atrás; no se tocan) (${omitidas.length}):`,
    );
    for (const { fila, faltantes } of omitidas) {
      lineas.push(
        `  - ${fila.id} | ${fila.email} | ${fila.alcance} ${fila.destino} | estado ${fila.estado} | claves: ${lista(fila.permisos)}`,
      );
      for (const { gestionar, faltan } of faltantes) {
        lineas.push(`      ${gestionar} -> le faltan: ${lista(faltan)}`);
      }
    }
  }

  if (resultado.conversion) {
    const { cambios, sinCatalogar } = resultado.conversion;
    lineas.push(
      ...seccion(
        'Asignaciones personal a despojar de claves de Finanzas',
        cambios,
        'quitar-personal',
      ),
      ...seccion(
        'Asignaciones a las que se les expande x.gestionar (se conserva x.gestionar)',
        cambios,
        'expandir',
      ),
      ...seccion(
        'Asignaciones con un recibos.aprobar anterior a B0 (sin recibos.gestionar) a quitar',
        cambios,
        'aprobar-muerta',
      ),
      ...seccion(
        'Roles a despojar de claves de Finanzas',
        cambios,
        'quitar-rol',
      ),
      `Informativo, sin cambios: claves de Administración con forma válida que el catálogo no ofrece (el sistema las ignora) (${sinCatalogar.length}):`,
      ...sinCatalogar.map(
        ({ fila, claves }) =>
          `  - ${fila.id} | ${fila.email} | ${fila.alcance} ${fila.destino} | estado ${fila.estado} | ${lista(claves)}`,
      ),
    );
  }

  if (modo.aplicar) {
    lineas.push(
      `Aplicados: ${resultado.aplicados.length}. Conflictos (cambiaron mientras corría el script; no se pisaron, vuelve a ejecutar): ${resultado.conflictos.length}.`,
      ...resultado.conflictos.map(lineaDeFila),
    );
  } else {
    const pendientes =
      resultado.retiro?.cambios.length ??
      resultado.conversion?.cambios.length ??
      0;
    lineas.push(
      `Pendientes: ${pendientes}. No se escribió nada (usa --aplicar para escribir).`,
    );
  }
  lineas.push(`Código de salida: ${resultado.codigoSalida}.`);
  return lineas;
}
