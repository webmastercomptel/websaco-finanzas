import { IsDateString, IsMongoId } from 'class-validator';

export class ListarAuxiliarCarteraDto {
  @IsMongoId()
  inmuebleId!: string;

  @IsDateString()
  desde!: string;

  @IsDateString()
  hasta!: string;
}
