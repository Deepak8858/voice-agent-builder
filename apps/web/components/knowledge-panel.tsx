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
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RichTextEditor } from '@/components/ui/rich-text-editor';
import { useApi } from '@/lib/use-api';
import { BookOpen, Search, Trash2, Upload, Link, FileText } from 'lucide-react';

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
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-primary" />
          {headerTitle}
        </CardTitle>
        <Badge variant="secondary">{listQuery.data?.items.length ?? 0}</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <ul className="space-y-2 text-sm">
          {listQuery.data?.items.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between rounded-lg border border-border bg-background px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-foreground">{s.title}</p>
                <p className="text-xs text-muted-foreground">
                  {s.source_type} · {s.status} · {s.chunk_count} chunks
                  {s.agent_id ? '' : ' · workspace'}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => deleteMutation.mutate(s.id)}
                disabled={deleteMutation.isPending}
                className="gap-1 text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </Button>
            </li>
          ))}
          {listQuery.data && listQuery.data.items.length === 0 ? (
            <li className="text-xs text-muted-foreground">No knowledge attached yet.</li>
          ) : null}
        </ul>

        <div className="rounded-lg border border-dashed border-border bg-accent/30 p-5">
          <p className="mb-3 text-xs font-medium text-foreground uppercase tracking-wider">Add new</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label>Title</Label>
              <Input
                className="mt-1.5"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Clinic hours & FAQ"
              />
            </div>
            <div>
              <Label>Type</Label>
              <select
                className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={sourceType}
                onChange={(e) => setSourceType(e.target.value as SourceType)}
              >
                <option value="text">Inline text</option>
                <option value="file">File upload (PDF/CSV/TXT)</option>
                <option value="url">URL</option>
              </select>
            </div>
            {sourceType === 'text' ? (
              <div className="col-span-2">
                <Label>Content</Label>
                <RichTextEditor
                  value={content}
                  onChange={setContent}
                  placeholder="Paste FAQ, policies, hours, pricing..."
                  className="mt-1.5 rich-text-editor"
                  minHeight="120px"
                />
              </div>
            ) : sourceType === 'file' ? (
              <div className="col-span-2">
                <Label>File</Label>
                <input
                  type="file"
                  accept={ACCEPT_FILE_TYPES}
                  onChange={onPickFile}
                  className="mt-1.5 block w-full text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:text-primary-foreground hover:file:bg-primary/90"
                />
                {file ? (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {file.name} · {(file.size / 1024).toFixed(1)} KB
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="col-span-2">
                <Label>URL</Label>
                <Input
                  className="mt-1.5"
                  value={fileUrl}
                  onChange={(e) => setFileUrl(e.target.value)}
                  placeholder="https://..."
                />
              </div>
            )}
          </div>
          <div className="mt-4 flex justify-end">
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!canSubmit || createMutation.isPending}
              className="gap-2"
            >
              {sourceType === 'file' ? <Upload className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
              {createMutation.isPending ? 'Adding…' : 'Add knowledge'}
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-background p-5">
          <p className="mb-3 text-xs font-medium text-foreground uppercase tracking-wider">Test retrieval</p>
          <div className="flex gap-2">
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Ask a question your agent might receive..."
            />
            <Button onClick={() => searchMutation.mutate()} disabled={!canSearch} className="gap-2">
              <Search className="h-4 w-4" />
              {searchMutation.isPending ? 'Searching…' : 'Search'}
            </Button>
          </div>
          {searchResult ? (
            <ul className="mt-4 space-y-2 text-sm">
              {searchResult.hits.length === 0 ? (
                <li className="text-xs text-muted-foreground">No matching chunks.</li>
              ) : (
                searchResult.hits.map((h: KnowledgeSearchHit) => (
                  <li
                    key={h.chunk_id}
                    className="rounded-lg border border-border bg-background px-4 py-3"
                  >
                    <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                      <span>
                        {h.source_title} · chunk #{h.chunk_index}
                      </span>
                      <Badge variant="secondary" className="font-mono">{h.score.toFixed(3)}</Badge>
                    </div>
                    <p className="whitespace-pre-wrap text-foreground">
                      {h.content.length > 400 ? `${h.content.slice(0, 400)}…` : h.content}
                    </p>
                  </li>
                ))
              )}
            </ul>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
