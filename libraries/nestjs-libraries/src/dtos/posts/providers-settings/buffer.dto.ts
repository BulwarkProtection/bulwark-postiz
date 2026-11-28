import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
export class BufferDto {
  @IsOptional()
  @IsString()
  @MaxLength(90)
  title?: string;
  @IsOptional()
  @IsBoolean()
  isAiGenerated?: boolean;
}
