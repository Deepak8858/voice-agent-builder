import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { CrmExecutor } from './crm-executor';
import { ToolsModule } from './tools.module';

describe('ToolsModule', () => {
  it('makes CrmExecutor injectable for importing modules', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ToolsModule) ?? [];
    const exports = Reflect.getMetadata(MODULE_METADATA.EXPORTS, ToolsModule) ?? [];

    expect(providers).toContain(CrmExecutor);
    expect(exports).toContain(CrmExecutor);
  });
});
