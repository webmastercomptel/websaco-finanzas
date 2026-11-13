import { segmentoIp } from './segmento-ip';

describe('segmentoIp (la parte IP de una clave de límite)', () => {
  it('IPv4 queda igual', () => {
    expect(segmentoIp('203.0.113.7')).toBe('203.0.113.7');
  });

  it('IPv4 mapeada en IPv6 cuenta como la IPv4', () => {
    expect(segmentoIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(segmentoIp('::FFFF:203.0.113.7')).toBe('203.0.113.7');
  });

  it('SEC: toda la /64 de IPv6 comparte un contador (rotar la parte baja no da cupo nuevo)', () => {
    const a = segmentoIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    const b = segmentoIp('2001:0db8:0001:0002::1');
    const c = segmentoIp('2001:DB8:1:2:ffff:ffff:ffff:ffff');
    expect(a).toBe('v6-20010db800010002');
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('otra /64 es otro contador', () => {
    expect(segmentoIp('2001:db8:1:3::1')).not.toBe(
      segmentoIp('2001:db8:1:2::1'),
    );
  });

  it('expande las formas comprimidas y quita la zona', () => {
    expect(segmentoIp('::1')).toBe('v6-0000000000000000');
    expect(segmentoIp('fe80::1%eth0')).toBe('v6-fe80000000000000');
    expect(segmentoIp('64:ff9b::192.0.2.33')).toBe('v6-0064ff9b00000000');
  });

  it('el segmento nunca lleva ":" (el registro del limitador corta en el último ":")', () => {
    for (const ip of ['2001:db8::1', '::1', '203.0.113.7', 'basura:x']) {
      expect(segmentoIp(ip)).not.toContain(':');
    }
  });

  it('sin IP o algo que no es una IP: un valor fijo o un resumen, nunca el texto crudo', () => {
    expect(segmentoIp(undefined)).toBe('desconocida');
    expect(segmentoIp('')).toBe('desconocida');
    const raro = segmentoIp('no-es-ip');
    expect(raro).toMatch(/^x-[0-9a-f]{32}$/);
    expect(raro).not.toContain('no-es-ip');
  });
});
