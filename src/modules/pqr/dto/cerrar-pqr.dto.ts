import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

/** Body of the closing step: the final answer given to the resident. */
export class CerrarPqrDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'La respuesta no puede estar vacía.' })
  @MaxLength(5000)
  mensaje: string;
}
