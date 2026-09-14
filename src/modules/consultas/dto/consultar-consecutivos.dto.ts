import { IsDateString, IsNotEmpty, IsString } from 'class-validator';

/** Query DTO for GET /consultas/consecutivos. */
export class ConsultarConsecutivosDto {
  /** The `code` from the coproperty's own Tabla de Documentos
   *  (ConsecutivoDocumento) — e.g. "RC", "NC", "ND", "NT". */
  @IsString()
  @IsNotEmpty()
  codigo: string;

  @IsDateString()
  desde: string;

  @IsDateString()
  hasta: string;
}
