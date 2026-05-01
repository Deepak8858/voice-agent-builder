'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useApi } from '@/lib/use-api';

interface WorkspaceItem {
  id: string;
  name: string;
  slug: string;
  role: string;
  type: string;
  is_active: boolean;
}

export function WorkspaceSwitcher({ activeName }: { activeName: string }) {
  const { call } = useApi();
  const qc = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const list = useQuery({
    queryKey: ['me', 'workspaces'],
    queryFn: () => call<{ items: WorkspaceItem[] }>('/me/workspaces'),
    enabled: open,
  });

  const switchTo = useMutation({
    mutationFn: async (workspaceId: string) =>
      call<{ active_workspace_id: string }>('/me/active-workspace', {
        method: 'POST',
        body: JSON.stringify({ workspace_id: workspaceId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries();
      setOpen(false);
      router.refresh();
    },
  });

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
      >
        <span className="truncate font-medium text-zinc-900 dark:text-zinc-50">{activeName}</span>
        <span className="text-xs text-zinc-500">▾</span>
      </button>

      {open ? (
        <div className="absolute left-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-950">
          {list.isLoading ? (
            <div className="px-3 py-2 text-xs text-zinc-500">Loading…</div>
          ) : list.data?.items.length ? (
            <ul className="max-h-72 overflow-auto py-1">
              {list.data.items.map((ws) => (
                <li key={ws.id}>
                  <button
                    onClick={() => switchTo.mutate(ws.id)}
                    disabled={ws.is_active || switchTo.isPending}
                    className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900 ${
                      ws.is_active ? 'bg-zinc-50 font-medium dark:bg-zinc-900' : ''
                    }`}
                  >
                    <span className="flex flex-col">
                      <span className="truncate text-zinc-900 dark:text-zinc-50">{ws.name}</span>
                      <span className="text-xs text-zinc-500">
                        {ws.role} · {ws.type}
                      </span>
                    </span>
                    {ws.is_active ? <span className="text-xs text-emerald-500">●</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-3 py-2 text-xs text-zinc-500">No workspaces.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
