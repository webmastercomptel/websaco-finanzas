// src/common/publico/segmento-ip.ts
import { createHash } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

/** Expands an IPv6 address (zone already removed) to its eight 16-bit groups. */
function gruposIpv6(ip: string): number[] {
  let texto = ip.toLowerCase();
  // A dotted IPv4 tail (`64:ff9b::192.0.2.33`) is the last two groups.
  const cola = texto.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (cola) {
    const [a, b, c, d] = cola[1].split('.').map(Number);
    texto =
      texto.slice(0, -cola[1].length) +
      `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [cabeza, resto] = texto.split('::');
  const izquierda = cabeza ? cabeza.split(':') : [];
  const derecha = resto === undefined ? [] : resto ? resto.split(':') : [];
  const relleno = Array<string>(8 - izquierda.length - derecha.length).fill(
    '0',
  );
  const todos =
    resto === undefined ? izquierda : [...izquierda, ...relleno, ...derecha];
  return todos.map((g) => parseInt(g, 16));
}

/**
 * The IP part of a per-client rate-limit key. One IPv6 client usually owns a
 * whole /64 (a home or a cloud VM gets one), so counting per full address lets
 * it rotate the low 64 bits and get a fresh budget on every request: an IPv6
 * address counts as its /64 (`v6-` + the 16 hex digits of the prefix). IPv4,
 * and IPv4 mapped in IPv6 (`::ffff:a.b.c.d`), stay the plain IPv4 address.
 *
 * The result never contains `:`, so `LimiteIntentosService`, which logs a
 * failing key's family as everything before its LAST `:`, never prints part of
 * an address. Something that is not an IP is never put in a key as is: it
 * becomes a digest.
 */
export function segmentoIp(ip: string | undefined | null): string {
  if (!ip) return 'desconocida';
  const sinZona = ip.split('%')[0];

  if (isIPv4(sinZona)) return sinZona;
  const mapeada = sinZona.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapeada && isIPv4(mapeada[1])) return mapeada[1];

  if (isIPv6(sinZona)) {
    const prefijo = gruposIpv6(sinZona)
      .slice(0, 4)
      .map((g) => g.toString(16).padStart(4, '0'))
      .join('');
    return `v6-${prefijo}`;
  }
  return `x-${createHash('sha256').update(ip).digest('hex').slice(0, 32)}`;
}
