// src/modules/documentos/documento-correo.ts
import { renderPlantillaCorreo } from '../../common/correo/plantilla-correo';
import { escapeHtml } from '../../common/correo/texto-correo';

/** What the "new document" email needs to say. */
export interface DatosCorreoDocumentoNuevo {
  nombreDestinatario: string;
  nombreCopropiedad: string;
  nombreDocumento: string;
  /** Folder path text ("A / B"); empty when unknown. */
  carpetaRuta: string;
  autor?: string;
  /** Access link for the button; null when none may be issued (no button then). */
  enlace: string | null;
}

/**
 * Subject and HTML of the email that tells somebody with access to a folder that
 * a new document was uploaded to it. Every user-typed string is escaped here,
 * in the one place that interpolates it into markup.
 */
export const construirCorreoDocumentoNuevo = (
  datos: DatosCorreoDocumentoNuevo,
): { asunto: string; html: string } => ({
  asunto: `Nuevo documento en ${datos.nombreCopropiedad}: ${datos.nombreDocumento}`,
  html: renderPlantillaCorreo({
    heading: escapeHtml(datos.nombreDocumento),
    bodyHtml: `
      <p style="margin: 0;">
        ${escapeHtml(datos.nombreDestinatario)}, se subió un documento nuevo${datos.autor ? ` (por ${escapeHtml(datos.autor)})` : ''} en ${datos.carpetaRuta ? `la carpeta <strong>${escapeHtml(datos.carpetaRuta)}</strong> a la que` : 'una carpeta a la que'} tenés acceso en <strong>${escapeHtml(datos.nombreCopropiedad)}</strong>.
      </p>
    `,
    cta: datos.enlace
      ? { url: datos.enlace, label: 'Ver el documento' }
      : undefined,
  }),
});
