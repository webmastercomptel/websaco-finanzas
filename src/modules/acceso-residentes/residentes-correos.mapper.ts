// src/modules/acceso-residentes/residentes-correos.mapper.ts
import { correoProbado } from '../../common/acceso/residencia.reglas';
import {
  claveCorreo,
  esEmailValido,
  normalizarEmail,
} from '../../common/utils/email.utils';
import type {
  EstadoResidenteCorreo,
  MotivoCorreccionResidente,
  Paginado,
  ResidenteCorreo,
  UnidadDeResidente,
} from '../../contracts';

/** A party as the list reads it: ids as strings. */
export interface TerceroParaFila {
  id: string;
  nombre: string;
  emails: readonly string[];
  /** The legacy `Tercero.accountId` link, if any. Never leaves this module. */
  accountId: string | null;
}

/** An Account as the list reads it. Its id never leaves this module. */
export interface CuentaParaFila {
  id: string;
  email: string;
  correoProbadoClave: string | null;
  ultimoIngresoPortalEn: Date | null;
}

export interface EntradaFilas {
  /** In the order the rows must come out. */
  terceros: readonly TerceroParaFila[];
  /** Units per party id; a party with none is not listed. */
  unidades: ReadonlyMap<string, readonly UnidadDeResidente[]>;
  cuentasPorId: ReadonlyMap<string, CuentaParaFila>;
  /** Accounts keyed by their NORMALIZED address. */
  cuentasPorCorreo: ReadonlyMap<string, CuentaParaFila>;
  /** `clave` of the addresses with an active revocation in this coproperty. */
  revocadas: ReadonlySet<string>;
  /** Generic inboxes keyed by NORMALIZED address (`motivosCorreoGenerico`). */
  genericos: ReadonlyMap<string, 'correo-compartido'>;
}

/** One usable address of a party. */
export interface DireccionDeTercero {
  /** Trimmed, original case. */
  correo: string;
  clave: string;
  /** The stored value carried padding: it matches nothing until the party is saved again. */
  conEspacios: boolean;
}

/**
 * The valid addresses of a party record, in record order, one per `clave`
 * (case variants collapse; the first spelling stays). An address that is not
 * valid has nothing to enter with and is skipped. The `clave` is the one of
 * the TRIMMED value, so a padded legacy value is still found by the actions.
 */
export function direccionesDeTercero(
  emails: readonly string[] | undefined,
): DireccionDeTercero[] {
  const vistas = new Set<string>();
  const resultado: DireccionDeTercero[] = [];
  for (const almacenado of emails ?? []) {
    const correo = almacenado.trim();
    if (!esEmailValido(correo)) continue;
    const clave = claveCorreo(correo);
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    resultado.push({ correo, clave, conEspacios: correo !== almacenado });
  }
  return resultado;
}

/**
 * State of one address, by the documented precedence. `cuentaDelCorreo` is the
 * Account whose e-mail IS the address; `cuentaVinculada` the one linked to the
 * party by the legacy `accountId`.
 */
function estadoDe(
  clave: string,
  revocadas: ReadonlySet<string>,
  cuentaDelCorreo: CuentaParaFila | undefined,
  cuentaVinculada: CuentaParaFila | undefined,
): { estado: EstadoResidenteCorreo; ultimoIngresoEn: string | null } {
  const probada =
    cuentaDelCorreo !== undefined && correoProbado(cuentaDelCorreo)
      ? cuentaDelCorreo
      : undefined;
  const ultimoIngresoEn = probada?.ultimoIngresoPortalEn?.toISOString() ?? null;

  if (revocadas.has(clave)) return { estado: 'revocado', ultimoIngresoEn };
  if (probada) return { estado: 'ingreso', ultimoIngresoEn };
  if (cuentaVinculada && claveCorreo(cuentaVinculada.email) === clave) {
    return { estado: 'heredado', ultimoIngresoEn };
  }
  return { estado: 'sin-ingreso', ultimoIngresoEn };
}

/**
 * The Residentes rows: one per (party, valid address) of the CURRENT holders,
 * plus one `heredado` row for a legacy-linked account whose address left the
 * record (so staff can still revoke it). Pure: the service fetches, this
 * decides. A party with no unit or no usable address has no row.
 */
export function construirFilasResidentes(
  entrada: EntradaFilas,
): ResidenteCorreo[] {
  const filas: ResidenteCorreo[] = [];

  for (const tercero of entrada.terceros) {
    const unidades = entrada.unidades.get(tercero.id) ?? [];
    if (unidades.length === 0) continue;

    const cuentaVinculada = tercero.accountId
      ? entrada.cuentasPorId.get(tercero.accountId)
      : undefined;
    const direcciones = direccionesDeTercero(tercero.emails);

    const nueva = (
      correo: string,
      clave: string,
      motivo: MotivoCorreccionResidente | null,
    ): ResidenteCorreo => ({
      terceroId: tercero.id,
      nombre: tercero.nombre,
      correo,
      clave,
      unidades: [...unidades],
      ...estadoDe(
        clave,
        entrada.revocadas,
        entrada.cuentasPorCorreo.get(normalizarEmail(correo)),
        cuentaVinculada,
      ),
      requiereCorreccion: motivo !== null,
      motivoCorreccion: motivo,
    });

    for (const d of direcciones) {
      const motivo: MotivoCorreccionResidente | null = entrada.genericos.has(
        normalizarEmail(d.correo),
      )
        ? 'correo-compartido'
        : d.conEspacios
          ? 'correo-con-espacios'
          : null;
      filas.push(nueva(d.correo, d.clave, motivo));
    }

    // A legacy link whose account address is no longer on the record: still an
    // access that exists, so it is listed (and can be revoked).
    if (cuentaVinculada) {
      const clave = claveCorreo(cuentaVinculada.email);
      if (!direcciones.some((d) => d.clave === clave)) {
        filas.push(nueva(normalizarEmail(cuentaVinculada.email), clave, null));
      }
    }
  }
  return filas;
}

/** In-memory search and state filter (the rows of one coproperty are bounded). */
export function filtrarFilasResidentes(
  filas: readonly ResidenteCorreo[],
  filtros: { buscar?: string; estado?: EstadoResidenteCorreo | 'todos' },
): ResidenteCorreo[] {
  const buscado = filtros.buscar?.trim().toLowerCase();
  return filas.filter((fila) => {
    if (
      filtros.estado !== undefined &&
      filtros.estado !== 'todos' &&
      fila.estado !== filtros.estado
    ) {
      return false;
    }
    if (!buscado) return true;
    return (
      fila.nombre.toLowerCase().includes(buscado) ||
      fila.correo.toLowerCase().includes(buscado) ||
      fila.unidades.some((u) => u.codigo.toLowerCase().includes(buscado))
    );
  });
}

export function paginarFilas<T>(
  filas: readonly T[],
  pagina: number,
  porPagina: number,
): Paginado<T> {
  const desde = (pagina - 1) * porPagina;
  return {
    items: filas.slice(desde, desde + porPagina),
    total: filas.length,
    pagina,
    porPagina,
  };
}
