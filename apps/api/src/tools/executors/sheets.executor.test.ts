import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SheetsExecutor } from './sheets.executor';
import { safeFetch } from '../../common/safe-fetch';

vi.mock('../../common/safe-fetch', () => ({
  safeFetch: vi.fn(),
}));

function makeExecutor() {
  const googleConnection = {
    getUsableAccessToken: vi.fn(async () => 'workspace-access-token'),
  };
  return { executor: new SheetsExecutor(googleConnection as never), googleConnection };
}

function appendOk(): Response {
  return new Response(
    JSON.stringify({ updates: { updatedRange: 'Orders!A2:G2', updatedRows: 1 } }),
    { status: 200 },
  );
}

/**
 * 2026-09-02: a live call took a complete order and lost it here twice over.
 * The model sent `null` for an empty column, and — asked for a spreadsheet id
 * it could not know — invented "Vinod_Medical_Store_Orders". Both are settled
 * below: an empty cell is a value, and the configured target always wins.
 */
describe('SheetsExecutor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes a null cell as an empty string instead of rejecting the row', async () => {
    const { executor } = makeExecutor();
    vi.mocked(safeFetch).mockResolvedValueOnce(appendOk());

    const result = await executor.execute(
      { values: ['Deepak', '7607185834', 'Dry cough syrup', null, 3] },
      { operation: 'append_row', spreadsheet_id: '1AbC', sheet_name: 'Orders' },
      { workspaceId: 'w1' } as never,
    );

    expect(result.success).toBe(true);
    const [, init] = vi.mocked(safeFetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      values: [['Deepak', '7607185834', 'Dry cough syrup', '', 3]],
    });
  });

  it('writes to the configured spreadsheet even when the model names another', async () => {
    const { executor } = makeExecutor();
    vi.mocked(safeFetch).mockResolvedValueOnce(appendOk());

    await executor.execute(
      { values: ['x'], spreadsheet_id: 'Vinod_Medical_Store_Orders', sheet_name: 'Made Up' },
      { operation: 'append_row', spreadsheet_id: '1AbC', sheet_name: 'Orders' },
      { workspaceId: 'w1' } as never,
    );

    const [url] = vi.mocked(safeFetch).mock.calls[0] as unknown as [string];
    expect(url).toContain('/spreadsheets/1AbC/');
    expect(url).toContain(`/values/${encodeURIComponent('Orders!A1')}:append`);
  });

  it('still refuses when neither config nor parameters name a spreadsheet', async () => {
    const { executor } = makeExecutor();

    const result = await executor.execute(
      { values: ['x'] },
      { operation: 'append_row', sheet_name: 'Sheet1' },
      { workspaceId: 'w1' } as never,
    );

    expect(result).toEqual({
      success: false,
      error: 'No spreadsheet configured. Set spreadsheet_id on the tool or pass it as a parameter.',
    });
    expect(safeFetch).not.toHaveBeenCalled();
  });
});
