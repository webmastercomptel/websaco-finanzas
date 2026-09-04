# WebSACO Finanzas - Referencia Técnica: Paso de Instalación

> **Propósito**: Documento de referencia para solicitar cambios al módulo de instalación (Entidades, Copropiedades, Usuarios).
> **Última actualización**: 2026-09-02

---

## 1. Stack Tecnológico

| Capa | Backend | Frontend |
|---|---|---|
| Framework | NestJS 11 + TypeScript | React 19 + TypeScript + Vite 8 |
| Base de datos | MongoDB (Mongoose) | - |
| Auth | Firebase Auth (token verification) | Firebase Auth (client SDK) |
| Cache | Redis (ioredis) | - |
| UI | - | Tailwind CSS v4 + shadcn (base-ui) |
| State | - | TanStack Query + React Context |
| AuthZ | CASL (permissions) | CASL permission matrix |
| Multi-tenancy | CLS (Continuation-Local Storage) | `X-CoProperty-Id` header |
| Validación DTOs | class-validator + class-transformer | HTML5 native + server-side |
| API prefix | `api/v1` | - |
| Persistencia (English) | Schemas en inglés | Contratos API en español |

---

## 2. Arquitectura General

```
┌─────────────────────────────────────────────────────────┐
│                    PLATFORM ADMIN LAYER                  │
│  (Solo accessible por PlatformAdminGuard, NO por tenant) │
├─────────────────────────────────────────────────────────┤
│  EntidadAdministradora  │  Copropiedad  │  Usuarios     │
│  ConceptoCobro          │  Inmuebles*   │  Terceros*    │
└─────────────────────────────────────────────────────────┘
                           │
                    ┌──────┴──────┐
                    │   TENANT    │  (X-CoProperty-Id header)
                    │   LAYER     │
                    ├─────────────┤
                    │  Inmuebles  │  (CASL: PoliciesGuard)
                    │  Terceros   │
                    │  Conceptos  │
                    │  Facturas   │
                    │  Recibos    │
                    │  Notas      │
                    └─────────────┘
```

**Regla**: Entidades, Copropiedades y Usuarios están **ARIBA** del tenant. Inmuebles, Terceros y Conceptos están **DENTRO** del tenant.

---

## 3. Modelo de Datos - Entidades Principales

### 3.1 EntidadAdministradora (Empresa Administradora)

**Schema**: `src/database/schemas/entidades/entidad-administradora.schema.ts`
**Colección**: `entidades_administradoras`

| Campo | Tipo | Restricciones | Default | Descripción |
|---|---|---|---|---|
| `code` | string | required, unique, trim | - | Código identificador (ej: "ENT-001") |
| `name` | string | required, trim | - | Nombre de la empresa |
| `taxId` | string | nullable, trim | null | NIT sin dígito verificación |
| `taxIdVerificationDigit` | string | nullable, trim | null | Dígito verificación |
| `email` | string | nullable, trim | null | Email contacto |
| `phone` | string | nullable, trim | null | Teléfono |
| `status` | enum | required | 'active' | `'active'` \| `'inactive'` |

**Índices únicos**: `code` (global)

---

### 3.2 Copropiedad (Edificio/Conjunto Residencial)

**Schema**: `src/database/schemas/copropiedades/copropiedad.schema.ts`
**Colección**: `copropiedades`

| Campo | Tipo | Restricciones | Default | Descripción |
|---|---|---|---|---|
| `code` | string | required, unique, trim | - | Código (ej: "COP-001") |
| `name` | string | required, trim | - | Nombre |
| `taxId` | string | nullable, trim | null | NIT |
| `taxIdVerificationDigit` | string | nullable, trim | null | Dígito verificación |
| `address` | string | nullable, trim | null | Dirección |
| `city` | string | nullable, trim | null | Ciudad |
| `phone` | string | nullable, trim | null | Teléfono |
| `email` | string | nullable, trim | null | Email |
| `managingEntityId` | ObjectId → EntidadAdministradora | nullable, indexed | null | Empresa administradora |
| `administratorName` | string | nullable, trim | null | Administrador interno (si no tiene entidad) |
| `status` | enum | required | 'active' | `'active'` \| `'inactive'` |
| `usesBuildingManagement` | boolean | required | false | Usa sistema de gestión edificios |
| `receivablesAccount` | string | nullable, trim | null | Cuenta contable cartera |
| `advancesAccount` | string | nullable, trim | null | Cuenta anticipos |
| `creditNotesAccount` | string | nullable, trim | null | Cuenta notas crédito |
| `debitNotesAccount` | string | nullable, trim | null | Cuenta notas débito |

**Regla de negocio**: Si se asigna `managingEntityId` → se limpia `administratorName` y viceversa.
**Índices únicos**: `code` (global)

---

### 3.3 Inmueble (Unidad/Local)

**Schema**: `src/database/schemas/copropiedades/inmueble.schema.ts`
**Colección**: `inmuebles`

| Campo | Tipo | Restricciones | Default | Descripción |
|---|---|---|---|---|
| `coPropertyId` | ObjectId → Copropiedad | required, indexed | - | FK tenant |
| `code` | string | required, trim | - | Ej: "301", "Local 2" |
| `block` | string | nullable, trim | null | Torre/bloque |
| `zone` | string | nullable, trim | null | Zona |
| `usage` | string | nullable, trim | null | Uso |
| `costCentre` | string | nullable, trim | null | Centro de costos |
| `area` | number | nullable | null | Metros cuadrados |
| `participationFactor` | number | nullable | null | Coeficiente participación (%) |
| `holderId` | ObjectId → Tercero | nullable, indexed | null | Titular responsable |
| `holderKind` | enum | required | 'propietario' | `'propietario'` \| `'arrendatario'` |
| `holderResides` | boolean | required | true | Reside en el inmueble |
| `collectionStatus` | enum | required | 'al_dia' | `'al_dia'` \| `'juridico'` \| `'dificil_recaudo'` |
| `contactName` | string | nullable, trim | null | Persona de contacto |
| `notes` | string | nullable, trim | null | Observaciones |
| `status` | enum | required | 'active' | `'active'` \| `'inactive'` |

**Índice compuesto único**: `{ coPropertyId: 1, code: 1 }` (código único por copropiedad)

---

### 3.4 Tercero (Persona/Jurídica)

**Schema**: `src/database/schemas/terceros/tercero.schema.ts`
**Colección**: `terceros`

| Campo | Tipo | Restricciones | Default | Descripción |
|---|---|---|---|---|
| `coPropertyId` | ObjectId → Copropiedad | required, indexed | - | FK tenant |
| `personType` | enum | required | 'natural' | `'natural'` \| `'juridica'` |
| `name` | string | required, trim | - | Nombre / Razón social |
| `identificationType` | string | nullable, trim | null | CC, NIT, CE, Pasaporte |
| `identificationNumber` | string | nullable, trim | null | Número identificación |
| `identificationVerificationDigit` | string | nullable, trim | null | Dígito verificación |
| `email` | string | nullable, trim | null | Email (documentos, no login) |
| `phone` | string | nullable, trim | null | Teléfono |
| `address` | string | nullable, trim | null | Dirección |
| `city` | string | nullable, trim | null | Ciudad |
| `einvoiceIdentificationType` | string | nullable, trim | null | Facturación electrónica |
| `einvoiceIdentificationNumber` | string | nullable, trim | null | |
| `einvoiceVerificationDigit` | string | nullable, trim | null | |
| `ciiuCode` | string | nullable, trim | null | Código CIIU |
| `salesRegime` | string | nullable, trim | null | Régimen de ventas |
| `fiscalResponsibilities` | string[] | required | [] | Responsabilidades fiscales |
| `withholdsIncomeTax` | boolean | required | false | Retiene renta |
| `withholdsLocalTax` | boolean | required | false | Retiene ICA |
| `status` | enum | required | 'active' | `'active'` \| `'inactive'` |

**Índice parcial único**: `{ coPropertyId: 1, identificationNumber: 1 }` (donde identificationNumber es string)

---

### 3.5 Account (Cuenta de Usuario)

**Schema**: `src/database/schemas/cuentas/account.schema.ts`
**Colección**: `accounts`

| Campo | Tipo | Restricciones | Default | Descripción |
|---|---|---|---|---|
| `firebaseUid` | string | required, unique, trim | - | UID Firebase (o `pendiente:<email>` antes del 1er login) |
| `email` | string | required, unique, trim, lowercase | - | Email |
| `fullName` | string | required, trim | - | Nombre completo |
| `isPlatformAdmin` | boolean | required | false | Administrador de plataforma |
| `status` | enum | required | 'active' | `'active'` \| `'inactive'` |

---

### 3.6 Asignacion (Concesión de Acceso)

**Schema**: `src/database/schemas/cuentas/asignacion.schema.ts`
**Colección**: `asignaciones`

| Campo | Tipo | Restricciones | Default | Descripción |
|---|---|---|---|---|
| `accountId` | ObjectId → Account | required, indexed | - | FK usuario |
| `scope` | enum | required | - | `'copropiedad'` \| `'entidad'` |
| `coPropertyId` | ObjectId → Copropiedad | nullable, indexed | null | FK copropiedad (scope='copropiedad') |
| `entidadId` | ObjectId → EntidadAdministradora | nullable, indexed | null | FK entidad (scope='entidad') |
| `permissions` | string[] | required | [] | Permisos CASL (ej: `facturas.anular`) |
| `status` | enum | required | 'active' | `'active'` \| `'inactive'` |

**Índices parciales únicos**:
- `{ accountId: 1, coPropertyId: 1 }` donde scope='copropiedad'
- `{ accountId: 1, entidadId: 1 }` donde scope='entidad'

**Hook pre-validate**: Asegura que scope coincida con la presencia del ID correcto.

---

### 3.7 ConceptoCobro (Concepto de Cobro)

**Schema**: `src/database/schemas/conceptos/concepto-cobro.schema.ts`
**Colección**: `conceptos_cobro`

| Campo | Tipo | Restricciones | Default | Descripción |
|---|---|---|---|---|
| `coPropertyId` | ObjectId → Copropiedad | required, indexed | - | FK tenant |
| `name` | string | required, trim | - | Nombre del concepto |
| `kind` | enum | required | 'otro' | `'administracion'` \| `'intereses'` \| `'otro'` |
| `taxRate` | number | required, min:0, max:100 | 0 | Tasa IVA (%) |
| `sortOrder` | number | required | 100 | Orden visualización |
| `accountingIncomeAccount` | string | nullable, trim | null | Cuenta contable ingreso |
| `active` | boolean | required | true | `false` = retirado (no eliminado) |

**Índices únicos**:
- `{ coPropertyId: 1, name: 1 }` (nombre único por copropiedad)
- `{ coPropertyId: 1, kind: 1 }` donde kind ∈ ['administracion', 'intereses'] (máximo uno de cada tipo)

---

### 3.8 ValorRecurrente (Plantilla de Monto Mensual)

**Schema**: `src/database/schemas/conceptos/valor-recurrente.schema.ts`
**Colección**: `valores_recurrentes`

| Campo | Tipo | Restricciones | Default | Descripción |
|---|---|---|---|---|
| `coPropertyId` | ObjectId → Copropiedad | required, indexed | - | Denormalizado de unidad |
| `inmuebleId` | ObjectId → Inmueble | required, indexed | - | FK inmueble |
| `conceptoId` | ObjectId → ConceptoCobro | required, indexed | - | FK concepto |
| `amount` | number | required | 0 | Monto mensual |

**Índice único**: `{ inmuebleId: 1, conceptoId: 1 }`

---

### 3.9 RegistroAuditoria (Log de Auditoría)

**Schema**: `src/database/schemas/auditoria/registro-auditoria.schema.ts`
**Colección**: `audit_log_entries`

| Campo | Tipo | Restricciones | Default | Descripción |
|---|---|---|---|---|
| `actorAccountId` | ObjectId → Account | required, indexed | - | Quién actuó |
| `actorNombre` | string | required, trim | - | Nombre (desnormalizado) |
| `accion` | enum | required | - | `'crear'` \| `'actualizar'` |
| `entidadTipo` | enum | required, indexed | - | `'entidad-administradora'` \| `'copropiedad'` \| `'usuario'` |
| `entidadId` | ObjectId | required, indexed | - | ID entidad afectada |
| `entidadEtiqueta` | string | required, trim | - | Etiqueta desnormalizada |

**Índice**: `{ createdAt: -1 }` para consultas cronológicas.

---

## 4. Diagrama de Relaciones

```
EntidadAdministradora (Empresa)
  │
  ├──< Copropiedad (managingEntityId → EntidadAdministradora)
  │      │
  │      ├──< Inmueble (coPropertyId → Copropiedad)
  │      │      │
  │      │      ├──< ValorRecurrente (inmuebleId → Inmueble)
  │      │      └──> Tercero (holderId → Tercero)  [opcional]
  │      │
  │      ├──< Tercero (coPropertyId → Copropiedad)
  │      │
  │      ├──< ConceptoCobro (coPropertyId → Copropiedad)
  │      │      │
  │      │      └──< ValorRecurrente (conceptoId → ConceptoCobro)
  │      │
  │      └──< Asignacion (coPropertyId → Copropiedad) [scope='copropiedad']
  │
  └──< Asignacion (entidadId → EntidadAdministradora) [scope='entidad']

Account (Cuenta)
  │
  ├──< Asignacion (accountId → Account)
  │
  └──< RegistroAuditoria (actorAccountId → Account)
```

---

## 5. Endpoints API (Backend)

### 5.1 Entidades Administradoras (`/entidades-administradoras`)

| Método | Ruta | Acción | Guard | Descripción |
|---|---|---|---|---|
| `GET` | `/entidades-administradoras` | Listar | PlatformAdmin | Paginado, filtro estado/buscar |
| `GET` | `/entidades-administradoras/:id` | Obtener | PlatformAdmin | |
| `POST` | `/entidades-administradoras` | Crear | PlatformAdmin | Body: `CrearEntidadDto` |
| `PATCH` | `/entidades-administradoras/:id` | Actualizar | PlatformAdmin | Body: `ActualizarEntidadDto` |

**No hay DELETE** → se desactiva con `PATCH { estado: 'inactivo' }`

---

### 5.2 Copropiedades (`/copropiedades`)

| Método | Ruta | Acción | Guard | Descripción |
|---|---|---|---|---|
| `GET` | `/copropiedades` | Listar | PlatformAdmin | Paginado, popula managingEntity |
| `GET` | `/copropiedades/:id` | Obtener | PlatformAdmin | |
| `POST` | `/copropiedades` | Crear | PlatformAdmin | Body: `CrearCopropiedadDto` |
| `PATCH` | `/copropiedades/:id` | Actualizar | PlatformAdmin | Body: `ActualizarCopropiedadDto` |

---

### 5.3 Conceptos de Cobro (`/copropiedades/:copropiedadId/conceptos`)

| Método | Ruta | Acción | Guard | Descripción |
|---|---|---|---|---|
| `GET` | `/copropiedades/:copropiedadId/conceptos` | Listar | PlatformAdmin | Todos los conceptos de una copropiedad |
| `POST` | `/copropiedades/:copropiedadId/conceptos` | Crear | PlatformAdmin | Body: `CrearConceptoDto` |
| `PATCH` | `/copropiedades/:copropiedadId/conceptos/:id` | Actualizar | PlatformAdmin | Body: `ActualizarConceptoDto` |

---

### 5.4 Usuarios (`/usuarios`)

| Método | Ruta | Acción | Guard | Descripción |
|---|---|---|---|---|
| `GET` | `/usuarios` | Listar | PlatformAdmin | Paginado, muestra asignación primaria |
| `GET` | `/usuarios/:id` | Obtener | PlatformAdmin | Con asignación primaria |
| `POST` | `/usuarios` | Crear | PlatformAdmin | Provisiona Firebase + Account + Asignacion |
| `PATCH` | `/usuarios/:id` | Actualizar | PlatformAdmin | Cambia password, desactiva Firebase |

---

### 5.5 Inmuebles (`/inmuebles`) - Tenant-scoped, CASL

| Método | Ruta | Acción | Permiso |
|---|---|---|---|
| `GET` | `/inmuebles` | Listar | `read` |
| `GET` | `/inmuebles/:id` | Obtener | `read` |
| `POST` | `/inmuebles` | Crear | `create` |
| `POST` | `/inmuebles/importar` | Importación masiva | `create` |
| `PATCH` | `/inmuebles/:id` | Actualizar | `update` |

---

### 5.6 Terceros (`/terceros`) - Tenant-scoped, CASL

| Método | Ruta | Acción | Permiso |
|---|---|---|---|
| `GET` | `/terceros` | Listar | `read` |
| `GET` | `/terceros/:id` | Obtener | `read` |
| `POST` | `/terceros` | Crear | `create` |
| `PATCH` | `/terceros/:id` | Actualizar | `update` |

---

### 5.7 Auth (`/auth`)

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/auth/me` | Retorna uid, email, nombre, esAdministradorPlataforma, copropiedades[] |

---

### 5.8 Panel de Control (`/panel-control`)

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/panel-control/resumen` | KPIs: totalEntidades, totalCopropiedadesActivas, totalUsuariosActivos |

---

## 6. DTOs y Validaciones

### 6.1 CrearEntidadDto

```typescript
{
  codigo: string       // required, min:1, max:40
  nombre?: string      // max:120
  nit?: string         // max:20
  digitoVerificacion?: string  // max:2
  email?: string       // max:120
  telefono?: string    // max:30
}
```

### 6.2 ActualizarEntidadDto

```typescript
// Mismos campos que CrearEntidadDto, todos opcionales
{
  ...CrearEntidadDto (optional)
  estado?: 'activo' | 'inactivo'
}
```

### 6.3 CrearCopropiedadDto

```typescript
{
  codigo: string                    // required, min:1, max:40
  nombre?: string                   // max:120
  nit?: string                      // max:20
  digitoVerificacion?: string       // max:2
  direccion?: string                // max:200
  ciudad?: string                   // max:100
  telefono?: string                 // max:30
  email?: string                    // max:120
  entidadAdministradoraId?: MongoId
  nombreAdministrador?: string      // max:120
  usaGestionEdificios?: boolean
  cuentaContableCartera?: string    // max:20
  cuentaAnticipos?: string          // max:20
  cuentaDevoluciones?: string       // max:20
}
```

### 6.4 CrearUsuarioDto

```typescript
{
  nombre: string                    // required, min:1, max:120
  email: string                     // required, @IsEmail
  password: string                  // required, min:6, max:72
  esAdministradorPlataforma?: boolean
  alcance?: 'copropiedad' | 'entidad'  // required when not platform admin
  copropiedadId?: MongoId              // required when alcance='copropiedad'
  entidadId?: MongoId                  // required when alcance='entidad'
  permisos?: string[]                  // keys CASL
}
```

### 6.5 ActualizarUsuarioDto

```typescript
{
  nombre?: string
  esAdministradorPlataforma?: boolean
  alcance?: 'copropiedad' | 'entidad'
  copropiedadId?: MongoId
  entidadId?: MongoId
  permisos?: string[]
  estado?: 'activo' | 'inactivo'
  nuevaPassword?: string           // min:6, max:72
}
```

### 6.6 CrearInmuebleDto

```typescript
{
  codigo: string                   // required, min:1, max:40
  bloque?: string                  // max:60
  zona?: string                    // max:60
  uso?: string                     // max:60
  centroCostos?: string            // max:60
  area?: number                    // min:0
  coeficiente?: number             // min:0, max:100
  titularId?: MongoId
  tipoTitular?: 'propietario' | 'arrendatario'
  resideEnElInmueble?: boolean
  estadoCartera?: 'al_dia' | 'juridico' | 'dificil_recaudo'
  contacto?: string                // max:120
  observaciones?: string           // max:2000
  // coPropertyId viene del tenant context (no del body)
}
```

### 6.7 ImportarInmueblesDto

```typescript
{
  filas: FilaImportarInmuebleDto[]  // min size: 1
  // Cada fila incluye todos los campos de Inmueble +
  // campos inline de titular: nombreTitular, tipoIdentificacionTitular,
  // numeroIdentificacionTitular, digitoVerificacionTitular,
  // emailTitular, telefonoTitular
}
```

### 6.8 CrearTerceroDto

```typescript
{
  tipoPersona: 'natural' | 'juridica'   // required
  nombre: string                         // required, min:1, max:200
  identificationType?: string
  identificationNumber?: string
  identificationVerificationDigit?: string
  email?: string
  phone?: string
  address?: string
  city?: string
  einvoiceIdentificationType?: string
  einvoiceIdentificationNumber?: string
  einvoiceVerificationDigit?: string
  ciiuCode?: string
  salesRegime?: string
  fiscalResponsibilities?: string[]      // default:[]
  withholdsIncomeTax?: boolean           // default:false
  withholdsLocalTax?: boolean            // default:false
}
```

### 6.9 CrearConceptoDto

```typescript
{
  nombre: string                   // required, min:1, max:120
  tipo?: 'administracion' | 'intereses' | 'otro'
  tasaImpuesto?: number            // min:0, max:100
  orden?: number
  cuentaContableIngreso?: string   // max:20
}
```

### 6.10 DTOs de Listado (compartidos)

```typescript
// ListarEntidadesDto, ListarCopropiedadesDto, ListarUsuariosDto
{
  buscar?: string           // regex search
  estado?: 'activo' | 'inactivo' | 'todos'
  pagina?: number           // min:1
  porPagina?: number        // min:1, max:200
}
```

---

## 7. Lógica de Negocio Crítica

### 7.1 Unicidad de Código/Nombre

| Entidad | Campo | Unicidad | Mecanismo |
|---|---|---|---|
| EntidadAdministradora | `code` | Global | Índice unique MongoDB |
| Copropiedad | `code` | Global | Índice unique MongoDB |
| Inmueble | `code` | Por copropiedad | Índice compuesto unique |
| Tercero | `identificationNumber` | Por copropiedad | Índice parcial unique |
| ConceptoCobro | `name` | Por copropiedad | Índice unique |
| ConceptoCobro | `kind=administracion` | Máx 1 por copropiedad | Índice parcial unique |
| ConceptoCobro | `kind=intereses` | Máx 1 por copropiedad | Índice parcial unique |

**Los checks se hacen ANTES de la escritura** → `ConflictException` amigable.

### 7.2 Multi-Tenancy (Ley del Tenant)

| Entidad | ¿Es tenant-scoped? | Mecanismo |
|---|---|---|
| EntidadAdministradora | **NO** | Acceso global (solo PlatformAdmin) |
| Copropiedad | **NO** | Acceso global (solo PlatformAdmin) |
| Account | **NO** | Acceso global |
| Asignacion | **NO** | Acceso global |
| Inmueble | **SÍ** | `TenantContextService.resolveCoPropertyId()` via CLS |
| Tercero | **SÍ** | `TenantContextService.resolveCoPropertyId()` via CLS |
| ConceptoCobro | **SÍ** | `TenantContextService.resolveCoPropertyId()` via CLS |

**Regla**: Nunca usar `findById(x)` sin `coPropertyId` para datos tenant-scoped.

### 7.3 Flujo de Provisionamiento de Usuario

```
1. Verificar unicidad de email local
2. Crear identidad Firebase → FirebaseUsuariosService.crear()
3. Crear Account local con el firebaseUid
4. Si NO es admin plataforma → crear Asignacion (scope + permisos)
5. Escribir registro de auditoría
```

**Nota**: Si Firebase falla después del paso 2 → estado "autenticado pero sin permisos".

### 7.4 Flujo de Desactivación de Usuario

```
1. Actualizar Account: status = 'inactive'
2. FirebaseUsuariosService.establecerHabilitado(uid, false)
3. Verificación inmediata: verifyIdToken(token, { checkRevoked: true })
```

- Desactivación **inmediata** (bloqueo en tiempo real)
- Cuentas `pendiente:` (sin primer login) no tocan Firebase

### 7.5 Resolución de Acceso (AccesoService)

```
acceso = UNION(
  Asignaciones directas (scope='copropiedad'),
  Asignaciones por entidad (scope='entidad') → todas las copropiedades activas de esa entidad
)
```

- Cuando ambas rutas alcanzan la misma copropiedad → permisos se **fusionan**
- Filtros de inactivos en cada salto: asignación, empresa, copropiedad

### 7.6 Bind de Cuenta (Primer Login)

```
1. Buscar Account por firebaseUid
2. Si no existe → buscar por email
3. Si match por email → vincular firebaseUid (primer claim)
4. NUNCA crea una cuenta automáticamente
```

### 7.7 Importación Masiva de Inmuebles

- Filas independientes (una fila mala no aborta las demás)
- Cada fila: verificar código → resolver/crear Tercero → crear Inmueble
- Resolución de Tercero: reutilizar existente por identificación, o crear nuevo si hay nombre
- Retorna `{ total, creados, errores[] }` con errores por fila

### 7.8 Relación Copropiedad ↔ Administrador

- Si se asigna `managingEntityId` → se limpia `administratorName`
- Si se asigna `administratorName` → se limpia `managingEntityId`
- El administrador real siempre es un Account con Asignacion

### 7.9 Restricciones de ConceptoCobro

- `kind='administracion'` → cobro recurrente base del ciclo de facturación
- `kind='intereses'` →计算 desde saldos vencidos
- Máximo uno de cada tipo por copropiedad (índice parcial unique + check en servicio)

---

## 8. Frontend: Páginas de Instalación

### 8.1 Rutas

| Ruta | Componente | Visible en Sidebar | Solo PlatformAdmin |
|---|---|---|---|
| `/entidades-administradoras` | EntidadesPage | ✅ | ✅ |
| `/entidades-administradoras/nueva` | EntidadFormPage | ❌ | ✅ |
| `/entidades-administradoras/:id` | EntidadDetallePage | ❌ | ✅ |
| `/entidades-administradoras/:id/editar` | EntidadFormPage | ❌ | ✅ |
| `/copropiedades` | CopropiedadesPage | ✅ | ✅ |
| `/copropiedades/nueva` | CopropiedadFormPage | ❌ | ✅ |
| `/copropiedades/:id` | CopropiedadDetallePage | ❌ | ✅ |
| `/copropiedades/:id/editar` | CopropiedadFormPage | ❌ | ✅ |
| `/usuarios` | UsuariosPage | ✅ | ✅ |
| `/usuarios/nuevo` | UsuarioFormPage | ❌ | ✅ |
| `/usuarios/:id` | UsuarioDetallePage | ❌ | ✅ |
| `/usuarios/:id/editar` | UsuarioFormPage | ❌ | ✅ |
| `/panel-control` | PanelControlPage | ✅ | ✅ |
| `/logs` | LogsPage | ✅ | ✅ |

### 8.2 Componentes por Funcionalidad

#### Entidades Administradoras

| Página | Funcionalidad |
|---|---|
| `EntidadesPage` | Tabla paginada con búsqueda, acciones ver/editar/toggle estado |
| `EntidadFormPage` | Formulario crear/editar: código, nombre, NIT, email, teléfono |
| `EntidadDetallePage` | Vista solo lectura |

#### Copropiedades

| Página | Funcionalidad |
|---|---|
| `CopropiedadesPage` | Tabla paginada con búsqueda |
| `CopropiedadFormPage` | Formulario crear/editar + **gestión inline de Conceptos/Cargos** |
| `CopropiedadDetallePage` | 4 paneles: Identificación, Contacto, Administración, Integración |

#### Usuarios

| Página | Funcionalidad |
|---|---|
| `UsuariosPage` | Tabla paginada con display de asignación primaria |
| `UsuarioFormPage` | Formulario crear/editar + **matriz CASL completa** (9 módulos × 7 verbos) + gestión contraseña |
| `UsuarioDetallePage` | Paneles: Identificación + Alcance |

#### Panel de Control

| Página | Funcionalidad |
|---|---|
| `PanelControlPage` | 3 KPI cards + tabla actividad reciente (10 filas) + accesos rápidos |

#### Logs de Auditoría

| Página | Funcionalidad |
|---|---|
| `LogsPage` | Filtrado por tipo entidad, acción, rango de fechas + paginación |

---

## 9. TypeScript Interfaces (Frontend)

### 9.1 EntidadAdministradora

```typescript
type EntidadAdministradora = {
  id: string;
  codigo: string;
  nombre: string;
  nit: string | null;
  digitoVerificacion: string | null;
  email: string | null;
  telefono: string | null;
  estado: "activo" | "inactivo";
};

type GuardarEntidad = {
  codigo?: string;
  nombre?: string;
  nit?: string;
  digitoVerificacion?: string;
  email?: string;
  telefono?: string;
  estado?: "activo" | "inactivo";
};
```

### 9.2 Copropiedad

```typescript
type Copropiedad = {
  id: string;
  codigo: string;
  nombre: string;
  nit: string | null;
  digitoVerificacion: string | null;
  direccion: string | null;
  ciudad: string | null;
  telefono: string | null;
  email: string | null;
  entidadAdministradora: { id: string; nombre: string } | null;
  nombreAdministrador: string | null;
  estado: "activo" | "inactivo";
  usaGestionEdificios: boolean;
};

type GuardarCopropiedad = {
  codigo?: string;
  nombre?: string;
  nit?: string;
  digitoVerificacion?: string;
  direccion?: string;
  ciudad?: string;
  telefono?: string;
  email?: string;
  entidadAdministradoraId?: string;
  nombreAdministrador?: string;
  usaGestionEdificios?: boolean;
  estado?: "activo" | "inactivo";
};
```

### 9.3 Usuario

```typescript
type Usuario = {
  id: string;
  nombre: string;
  email: string;
  esAdministradorPlataforma: boolean;
  estado: "activo" | "inactivo";
  asignacion: AsignacionResumen | null;
};

type AsignacionResumen = {
  alcance: "copropiedad" | "entidad";
  copropiedadId: string | null;
  copropiedadNombre: string | null;
  entidadId: string | null;
  entidadNombre: string | null;
  permisos: string[];
};

type CrearUsuario = {
  nombre: string;
  email: string;
  password: string;
  esAdministradorPlataforma?: boolean;
  alcance?: "copropiedad" | "entidad";
  copropiedadId?: string;
  entidadId?: string;
  permisos?: string[];
};

type ActualizarUsuario = {
  nombre?: string;
  esAdministradorPlataforma?: boolean;
  alcance?: "copropiedad" | "entidad";
  copropiedadId?: string;
  entidadId?: string;
  permisos?: string[];
  estado?: "activo" | "inactivo";
  nuevaPassword?: string;
};
```

### 9.4 Inmueble

```typescript
type Inmueble = {
  id: string;
  codigo: string;
  bloque: string | null;
  zona: string | null;
  uso: string | null;
  area: number | null;
  coeficiente: number | null;
  titular: TitularResumen | null;
  tipoTitular: "propietario" | "arrendatario";
  resideEnElInmueble: boolean;
  estadoCartera: "al_dia" | "juridico" | "dificil_recaudo";
  estado: "activo" | "inactivo";
};
```

### 9.5 Tercero

```typescript
type Tercero = {
  id: string;
  tipoPersona: "natural" | "juridica";
  nombre: string;
  tipoIdentificacion: string | null;
  numeroIdentificacion: string | null;
  digitoVerificacion: string | null;
  email: string | null;
  telefono: string | null;
  direccion: string | null;
  ciudad: string | null;
  facturacionElectronica: FacturacionElectronica;
  responsabilidadesFiscales: string[];
  retieneRenta: boolean;
  retieneIca: boolean;
  estado: "activo" | "inactivo";
};
```

### 9.6 ConceptoCobro

```typescript
type ConceptoCobro = {
  id: string;
  copropiedadId: string;
  nombre: string;
  tipo: "administracion" | "intereses" | "otro";
  tasaImpuesto: number;
  orden: number;
  activo: boolean;
};
```

### 9.7 AuthMe

```typescript
type AuthMe = {
  uid: string;
  email: string;
  nombre: string | null;
  esAdministradorPlataforma: boolean;
  copropiedades: CopropiedadResumen[];
};

type CopropiedadResumen = {
  id: string;
  codigo: string;
  nombre: string;
};
```

### 9.8 ResumenPanelControl

```typescript
type ResumenPanelControl = {
  totalEntidades: number;
  totalCopropiedadesActivas: number;
  totalUsuariosActivos: number;
};
```

---

## 10. Archivos Clave del Backend

### Schemas
| Archivo | Descripción |
|---|---|
| `src/database/schemas/entidades/entidad-administradora.schema.ts` | Schema EntidadAdministradora |
| `src/database/schemas/copropiedades/copropiedad.schema.ts` | Schema Copropiedad |
| `src/database/schemas/copropiedades/inmueble.schema.ts` | Schema Inmueble |
| `src/database/schemas/terceros/tercero.schema.ts` | Schema Tercero |
| `src/database/schemas/cuentas/account.schema.ts` | Schema Account |
| `src/database/schemas/cuentas/asignacion.schema.ts` | Schema Asignacion |
| `src/database/schemas/conceptos/concepto-cobro.schema.ts` | Schema ConceptoCobro |
| `src/database/schemas/conceptos/valor-recurrente.schema.ts` | Schema ValorRecurrente |
| `src/database/schemas/auditoria/registro-auditoria.schema.ts` | Schema RegistroAuditoria |

### Controllers
| Archivo | Descripción |
|---|---|
| `src/modules/entidades/entidades.controller.ts` | Controller Entidades |
| `src/modules/copropiedades/copropiedades.controller.ts` | Controller Copropiedades |
| `src/modules/usuarios/usuarios.controller.ts` | Controller Usuarios |
| `src/modules/inmuebles/inmuebles.controller.ts` | Controller Inmuebles |
| `src/modules/terceros/terceros.controller.ts` | Controller Terceros |
| `src/modules/conceptos/conceptos.controller.ts` | Controller Conceptos |
| `src/modules/auth/auth.controller.ts` | Controller Auth |
| `src/modules/panel-control/panel-control.controller.ts` | Controller Panel Control |

### Services
| Archivo | Descripción |
|---|---|
| `src/modules/entidades/entidades.service.ts` | Service Entidades |
| `src/modules/copropiedades/copropiedades.service.ts` | Service Copropiedades |
| `src/modules/usuarios/usuarios.service.ts` | Service Usuarios |
| `src/modules/inmuebles/inmuebles.service.ts` | Service Inmuebles |
| `src/modules/terceros/terceros.service.ts` | Service Terceros |
| `src/modules/conceptos/conceptos.service.ts` | Service Conceptos |
| `src/common/cuentas/cuenta.service.ts` | Service Cuenta (resolución de cuenta) |
| `src/common/acceso/acceso.service.ts` | Service Acceso (resolución de permisos) |
| `src/common/tenant/tenant-context.service.ts` | Service Tenant (CLS context) |
| `src/common/firebase/firebase-usuarios.service.ts` | Service Firebase Usuarios |
| `src/modules/panel-control/panel-control.service.ts` | Service Panel Control |

### DTOs
| Archivo | Descripción |
|---|---|
| `src/modules/entidades/dto/guardar-entidad.dto.ts` | DTO Crear/Actualizar Entidad |
| `src/modules/entidades/dto/listar-entidades.dto.ts` | DTO Listar Entidades |
| `src/modules/copropiedades/dto/guardar-copropiedad.dto.ts` | DTO Crear/Actualizar Copropiedad |
| `src/modules/copropiedades/dto/listar-copropiedades.dto.ts` | DTO Listar Copropiedades |
| `src/modules/usuarios/dto/guardar-usuario.dto.ts` | DTO Crear/Actualizar Usuario |
| `src/modules/usuarios/dto/listar-usuarios.dto.ts` | DTO Listar Usuarios |
| `src/modules/inmuebles/dto/guardar-inmueble.dto.ts` | DTO Crear/Actualizar Inmueble |
| `src/modules/inmuebles/dto/listar-inmuebles.dto.ts` | DTO Listar Inmuebles |
| `src/modules/inmuebles/dto/importar-inmuebles.dto.ts` | DTO Importar Inmuebles |
| `src/modules/terceros/dto/guardar-tercero.dto.ts` | DTO Crear/Actualizar Tercero |
| `src/modules/terceros/dto/listar-terceros.dto.ts` | DTO Listar Terceros |
| `src/modules/conceptos/dto/guardar-concepto.dto.ts` | DTO Crear/Actualizar Concepto |

### Mappers
| Archivo | Descripción |
|---|---|
| `src/modules/entidades/entidades.mapper.ts` | Mapper Entidades |
| `src/modules/copropiedades/copropiedades.mapper.ts` | Mapper Copropiedades |
| `src/modules/usuarios/usuarios.mapper.ts` | Mapper Usuarios |
| `src/modules/inmuebles/inmuebles.mapper.ts` | Mapper Inmuebles |
| `src/modules/terceros/terceros.mapper.ts` | Mapper Terceros |
| `src/modules/conceptos/conceptos.mapper.ts` | Mapper Conceptos |

### Guards y Auth
| Archivo | Descripción |
|---|---|
| `src/common/guards/platform-admin.guard.ts` | Guard PlatformAdmin |
| `src/common/interfaces/request-user.interface.ts` | Interfaz RequestUser |
| `src/modules/casl/casl-ability.constants.ts` | Constantes CASL |
| `src/modules/casl/permission-map.ts` | Mapa de permisos |

### Seeds
| Archivo | Descripción |
|---|---|
| `src/seed/seed-admin.ts` | Seed primer administrador (`npm run seed:admin`) |
| `src/seed/seed-demo.ts` | Seed datos demo (`npm run seed:demo`) |

### Contratos
| Archivo | Descripción |
|---|---|
| `src/contracts/index.ts` | Contratos API (nombres en español) |

---

## 11. Archivos Clave del Frontend

### API Services
| Archivo | Descripción |
|---|---|
| `src/lib/api/auth.ts` | Hooks Auth (useAuthMe) |
| `src/lib/api/entidades.ts` | Hooks Entidades CRUD |
| `src/lib/api/copropiedades.ts` | Hooks Copropiedades CRUD |
| `src/lib/api/usuarios.ts` | Hooks Usuarios CRUD |
| `src/lib/api/inmuebles.ts` | Hooks Inmuebles CRUD + importar |
| `src/lib/api/terceros.ts` | Hooks Terceros CRUD |
| `src/lib/api/conceptos.ts` | Hooks Conceptos CRUD |
| `src/lib/api/panel-control.ts` | Hooks Panel Control |
| `src/lib/api/auditoria.ts` | Hooks Auditoría |
| `src/lib/api/client.ts` | Cliente API (axios, token, headers) |

### Páginas (Plataforma Admin)
| Archivo | Descripción |
|---|---|
| `src/pages/entidades.tsx` | Lista entidades |
| `src/pages/entidad-form.tsx` | Formulario entidad |
| `src/pages/entidad-detalle.tsx` | Detalle entidad |
| `src/pages/copropiedades.tsx` | Lista copropiedades |
| `src/pages/copropiedad-form.tsx` | Formulario copropiedad + conceptos |
| `src/pages/copropiedad-detalle.tsx` | Detalle copropiedad |
| `src/pages/usuarios.tsx` | Lista usuarios |
| `src/pages/usuario-form.tsx` | Formulario usuario + permisos CASL |
| `src/pages/usuario-detalle.tsx` | Detalle usuario |
| `src/pages/panel-control.tsx` | Panel de control KPIs |
| `src/pages/logs.tsx` | Logs de auditoría |

### Auth y State
| Archivo | Descripción |
|---|---|
| `src/lib/auth/auth-state.ts` | AuthContext + AuthState |
| `src/lib/auth/auth-provider.tsx` | Provider Firebase auth |
| `src/lib/auth/use-auth.ts` | Hook useAuth() |
| `src/lib/auth/require-auth.tsx` | Route guard auth |
| `src/lib/copropiedad/copropiedad-state.ts` | CopropiedadContext |
| `src/lib/copropiedad/copropiedad-provider.tsx` | Provider copropiedad activa |
| `src/lib/copropiedad/use-copropiedad.ts` | Hook useCopropiedad() |
| `src/lib/copropiedad/require-copropiedad.tsx` | Route gate copropiedad |

### Layout
| Archivo | Descripción |
|---|---|
| `src/components/layout/sidebar.tsx` | Sidebar navegación |
| `src/components/layout/header.tsx` | Header + coproperty switcher |
| `src/components/layout/coproperty-switcher.tsx` | Selector de copropiedad |
| `src/lib/navigation.tsx` | Manifest de rutas (fuente única de verdad) |

---

## 12. Patrones Arquitectónicos

1. **Sin DELETE físico**: Todas las desactivaciones son `PATCH { estado: 'inactivo' }`.
2. **Envelope de respuesta**: `{ statusCode, data }` en todos los endpoints.
3. **Mapper pattern**: Funciones puras en `<module>.mapper.ts` traducen Mongoose → contrato español.
4. **Fire-and-forget Firebase**: `FirebaseUsuariosService` es la ÚNICA excepción que escribe a Firebase.
5. **Code splitting**: Todas las páginas son `React.lazy()` con `Suspense`.
6. **Separación idioma**: Código/identificadores en inglés, contrato de API y UI en español.
7. **Validación dual**: Frontend HTML5 + Backend class-validator (el backend es el gate real).
8. **Multi-tenancy CLS**: `X-CoProperty-Id` header → CLS → TenantContextService → queries.

---

## 13. Seeders

### seed:admin (`npm run seed:admin`)
- Crea el primer administrador desde `ROOT_ADMIN_EMAIL`
- Idempotente: re-ejecutar re-asserta el flag
- NO toca Firebase (debe crearse manualmente en consola Firebase)
- `firebaseUid: 'pendiente:<email>'` para bind en primer login

### seed:demo (`npm run seed:demo`)
- 1 EntidadAdministradora ("Administraciones Calad", ENT-001)
- 12 Copropiedades (10 bajo la empresa, 2 auto-administradas)
- 5 Conceptos de Cobro base por copropiedad
- 60 Inmuebles en la primera (para paginación), 10 en las demás
- Terceros (propietarios) con datos realistas por inmueble
- Idempotente: keyed by code, nunca sobrescribe

---

## 14. Comandos Útiles

```bash
# Backend
npm run seed:admin          # Crear primer administrador
npm run seed:demo           # Cargar datos demo
npm run build               # Build TypeScript
npm run start:dev           # Servidor desarrollo

# Frontend
npm run dev                 # Servidor desarrollo Vite
npm run build               # Build producción
npm run lint                # ESLint
```
