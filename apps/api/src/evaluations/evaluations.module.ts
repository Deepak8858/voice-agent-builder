import { Global, Module } from '@nestjs/common';
import { EvaluationsService } from './evaluations.service';

@Global()
@Module({
  providers: [EvaluationsService],
  exports: [EvaluationsService],
})
export class EvaluationsModule {}
