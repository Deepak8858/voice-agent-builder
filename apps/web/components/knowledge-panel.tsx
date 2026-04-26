'use client';

import { useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  KnowledgeSearchHit,
  KnowledgeSearchResult,
  KnowledgeSourceSummary,
} from '@voiceforge/shared';
import { Button } from '@/components/ui/button';
import {
  Badge,
  Card,
  CardTitle,
  Input,
  Label,
  Select,
  Textarea,
} from '@/components/ui/primitives';
import { useApi } from '@/lib/use-api';

interface KnowledgePanelProps {
  workspaceId: string;
  agentId?: string | null;
  title?: string;
}

type SourceType = 'text' | 'url' | 'file';

const ACCEPT_FILE_TYPES = '.pdf,.csv,.txt,.md,application/pdf,text/csv,text/plain,text/markdown';

export function KnowledgePanel({
  workspaceId,
  agentId = null,
  title: headerTitle = 'Knowledge sources',
}: KnowledgePanelProps) {
  const { call } = useApi();
  const qc = useQueryClient();
  const [sourceType, setSourceType] = useState<SourceType>('text');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [fileUrl, setFileUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [searchResult, setSearchResult] = useState<KnowledgeSearchResult | null>(null);

  const listKey = ['knowledge-sources', workspaceId, agentId ?? 'workspace'];
  const listUrl = agentId
    ? `/workspaces/${workspaceId}/agents/${agentId}/knowledge-sources`
    : `/workspaces/${workspaceId}/knowledge-sources?scope=workspace`;

  const listQuery = useQuery({
    queryKey: listKey,
    queryFn: () => call<{ items: KnowledgeSourceSummary[] }>(listUrl),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (sourceType === 'file') {
        if (!file) throw new Error('Pick a file first.');
        const fd = new FormData();
        fd.append('file', file);
        fd.append('title', title);
        if (agentId) fd.append('agent_id', agentId);
        return call<KnowledgeSourceSummary>(
          `/workspaces/${workspaceId}/knowledge-sources/upload`,
          { method: 'POST', body: fd },
        );
      }
      const body: Record<string, unknown> = { title, source_type: sourceType };
      if (agentId) body.agent_id = agentId;
      if (sourceType === 'text') body.content = content;
      else body.file_url = fileUrl;
      return call<KnowledgeSourceSummary>(
        `/workspaces/${workspaceId}/knowledge-sources`,
        { method: 'POST', body: JSON.stringify(body) },
      );
    },
    onSuccess: () => {
      toast.success('Knowledge source added.');
      setTitle('');
      setContent('');
      setFileUrl('');
      setFile(null);
      qc.invalidateQueries({ queryKey: listKey });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (sourceId: string) =>
      call<void>(`/workspaces/${workspaceId}/knowledge-sources/${sourceId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      toast.success('Knowledge source removed.');
      qc.invalidateQueries({ queryKey: listKey });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const searchMutation = useMutation({
    mutationFn: async () => {
      const params = new URLSearchParams({ query: searchInput, k: '5' });
      if (agentId) params.set('agent_id', agentId);
      return call<KnowledgeSearchResult>(
        `/workspaces/${workspaceId}/knowledge-sources/search?${params.toString()}`,
      );
    },
    onSuccess: (data) => setSearchResult(data),
    onError: (err: Error) => toast.error(err.message),
  });

  const onPickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    if (f && title.trim().length === 0) {
      setTitle(f.name.replace(/\.[^.]+$/, ''));
    }
  };

  const canSubmit =
    title.trim().length > 0 &&
    ((sourceType === 'text' && content.trim().length > 0) ||
      (sourceType === 'url' && fileUrl.trim().length > 0) ||
      (sourceType === 'file' && file !== null));

  const canSearch = searchInput.trim().length > 0 && !searchMutation.isPending;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <CardTitle>{headerTitle}</CardTitle>
        <Badge>{listQuery.data?.items.length ?? 0}</Badge>
      </div>

      <ul className="space-y-2 text-sm">
        {listQuery.data?.items.map((s) => (
          <li
            key={s.id}
            className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-zinc-900 dark:text-zinc-50">{s.title}</p>
              <p className="text-xs text-zinc-500">
                {s.source_type} · {s.status} · {s.chunk_count} chunks
                {s.agent_id ? '' : ' · workspace'}
              </p>
            </div>
            <Button
              variant="ghost"
              onClick={() => deleteMutation.mutate(s.id)}
              disabled={deleteMutation.isPending}
            >
              Remove
            </Button>
          </li>
        ))}
        {listQuery.data && listQuery.data.items.length === 0 ? (
          <li className="text-xs text-zinc-500">No knowledge attached yet.</li>
        ) : null}
      </ul>

      <div className="rounded-md border border-dashed border-zinc-300 p-3 dark:border-zinc-700">
        <p className="mb-2 text-xs font-medium text-zinc-700 dark:text-zinc-300">Add new</p>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Label>Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Clinic hours & FAQ"
            />
          </div>
          <div>
            <Label>Type</Label>
            <Select
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value as SourceType)}
            >
              <option value="text">Inline text</option>
              <option value="file">File upload (PDF/CSV/TXT)</option>
              <option value="url">URL</option>
            </Select>
          </div>
          {sourceType === 'text' ? (
            <div className="col-span-2">
              <Label>Content</Label>
              <Textarea
                rows={4}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Paste FAQ, policies, hours, pricing..."
              />
            </div>
          ) : sourceType === 'file' ? (
            <div className="col-span-2">
              <Label>File</Label>
              <input
                type="file"
                accept={ACCEPT_FILE_TYPES}
                onChange={onPickFile}
                className="block w-full text-sm text-zinc-700 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-sm file:text-white hover:file:bg-zinc-800 dark:text-zinc-300"
              />
              {file ? (
                <p className="mt-1 text-xs text-zinc-500">
                  {file.name} · {(file.size / 1024).toFixed(1)} KB
                </p>
              ) : null}
            </div>
          ) : (
            <div className="col-span-2">
              <Label>URL</Label>
              <Input
                value={fileUrl}
                onChange={(e) => setFileUrl(e.target.value)}
                placeholder="https://..."
              />
            </div>
          )}
        </div>
        <div className="mt-3 flex justify-end">
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!canSubmit || createMutation.isPending}
          >
            {createMutation.isPending ? 'Adding…' : 'Add knowledge'}
          </Button>
        </div>
      </div>

      <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
        <p className="mb-2 text-xs font-medium text-zinc-700 dark:text-zinc-300">
          Test retrieval
        </p>
        <div className="flex gap-2">
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Ask a question your agent might receive..."
          />
          <Button onClick={() => searchMutation.mutate()} disabled={!canSearch}>
            {searchMutation.isPending ? 'Searching…' : 'Search'}
          </Button>
        </div>
        {searchResult ? (
          <ul className="mt-3 space-y-2 text-sm">
            {searchResult.hits.length === 0 ? (
              <li className="text-xs text-zinc-500">No matching chunks.</li>
            ) : (
              searchResult.hits.map((h: KnowledgeSearchHit) => (
                <li
                  key={h.chunk_id}
                  className="rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800"
                >
                  <div className="flex items-center justify-between text-xs text-zinc-500">
                    <span>
                      {h.source_title} · chunk #{h.chunk_index}
                    </span>
                    <Badge>{h.score.toFixed(3)}</Badge>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-zinc-800 dark:text-zinc-200">
                    {h.content.length > 400 ? `${h.content.slice(0, 400)}…` : h.content}
                  </p>
                </li>
              ))
            )}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}
