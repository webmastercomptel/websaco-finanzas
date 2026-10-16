// src/modules/integraciones-websaco3/propietarios.vector.ts

/**
 * Golden vector shared with WebSaco3 (its test holds the same values; a JSON
 * copy is handed over for that side). Both sides MUST produce exactly these
 * signed strings and signatures — change one side only by changing both.
 *
 * Test fixture: imported by specs only, never by production code. The secret
 * is a throwaway value that protects nothing.
 */
export const VECTOR_COMPARTIDO = {
  secret: 'propietarios-golden-secret-0123456789abcdef',
  timestamp: '1790000000',
  method: 'GET',
  path: '/api/v1/integraciones/websaco3/propietarios',
  casos: [
    {
      nombre: 'id en mayúscula firmado tal cual se envió',
      rawQuery: 'websaco3CopropiedadId=507F1F77BCF86CD799439011',
      sortedQuery: 'websaco3CopropiedadId=507F1F77BCF86CD799439011',
      cadena:
        'propietarios.v1\n1790000000\nGET\n/api/v1/integraciones/websaco3/propietarios\nwebsaco3CopropiedadId=507F1F77BCF86CD799439011',
      firma:
        'sha256=825e0e307bd2f9d7e47ba7bd2e8d637ebda378b6a4dc517240e20d85baa0c22a',
    },
    {
      nombre: 'canonicalización: orden por clave y valor, encodeURIComponent',
      rawQuery: 'b=2&a=%C3%B1&a=1&c=x+y',
      sortedQuery: 'a=1&a=%C3%B1&b=2&c=x%20y',
      cadena:
        'propietarios.v1\n1790000000\nGET\n/api/v1/integraciones/websaco3/propietarios\na=1&a=%C3%B1&b=2&c=x%20y',
      firma:
        'sha256=c716e3f3391963d754e54b988fdea51e6d3180da5dafff94df798e9bf0ca3596',
    },
    {
      nombre: 'sin query',
      rawQuery: '',
      sortedQuery: '',
      cadena:
        'propietarios.v1\n1790000000\nGET\n/api/v1/integraciones/websaco3/propietarios\n',
      firma:
        'sha256=daae10b2d345c030fada05f1082df5950b1a2e261d58ee5eda25dc3b7d3eab80',
    },
  ],
} as const;
