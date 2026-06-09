import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { WorkspaceGuard } from '../common/workspace.guard';
import { WorkspaceCrmController } from './workspace-crm.controller';

describe('WorkspaceCrmController', () => {
  it('is protected by the workspace guard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, WorkspaceCrmController) ?? [];

    expect(guards).toContain(WorkspaceGuard);
  });
});
