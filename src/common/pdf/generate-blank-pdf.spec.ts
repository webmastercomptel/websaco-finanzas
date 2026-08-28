import { generateBlankPdf } from './generate-blank-pdf';

describe('generateBlankPdf', () => {
  it('genera un PDF de una página en memoria usando pdf-lib', async () => {
    const bytes = await generateBlankPdf();

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    // La firma "%PDF-" confirma que se generó un PDF real, no bytes al azar.
    const header = Buffer.from(bytes.slice(0, 5)).toString('utf-8');
    expect(header).toBe('%PDF-');
  });
});
