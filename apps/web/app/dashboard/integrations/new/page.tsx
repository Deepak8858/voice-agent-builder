'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AgentSummary, SessionUser, ToolDetail } from '@voiceforge/shared';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useApi } from '@/lib/use-api';
import { Plug, Save, X } from 'lucide-react';

const DEFAULT_INPUT_SCHEMA = `{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    "phone": { "type": "string" },
    "appointment_at": { "type": "string" }
  },
  "required": ["name", "phone"]
}`;

const DEFAULT_HEADERS = '{}';

function tryParseJson(label: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} must be valid JSON: ${(err as Error).message}`);
  }
}

export default function NewToolPage() {
  const router = useRouter();
  const { call } = useApi();

  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [name, setName] = useState('create_booking');
  const [description, setDescription] = useState('Creates a booking via partner CRM webhook.');
  const [agentId, setAgentId] = useState('');
  const [url, setUrl] = useState('https://example.com/webhook');
  const [method, setMethod] = useState('POST');
  const [hmacSecret, setHmacSecret] = useState('');
  const [timeoutMs, setTimeoutMs] = useState(10_000);
  const [headersText, setHeadersText] = useState(DEFAULT_HEADERS);
  const [schemaText, setSchemaText] = useState(DEFAULT_INPUT_SCHEMA);

  useEffect(() => {
    call<SessionUser>('/auth/me')
      .then((me) => setWorkspaceId(me.active_workspace_id))
      .catch((err) => toast.error(`Session: ${err.message}`));
  }, [call]);

  const agentsQuery = useQuery({
    queryKey: ['agents', workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () => call<{ items: AgentSummary[] }>(`/workspaces/${workspaceId}/agents`),
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!workspaceId) throw new Error('No workspace');
      const headers = tryParseJson('Headers', headersText);
      const inputSchema = tryParseJson('Input schema', schemaText);
      return call<ToolDetail>(`/workspaces/${workspaceId}/tools`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          description,
          tool_type: 'webhook',
          agent_id: agentId || null,
          config: {
            url,
            method,
            headers,
            hmac_secret: hmacSecret || undefined,
            timeout_ms: timeoutMs,
          },
          input_schema: inputSchema,
          enabled: true,
        }),
      });
    },
    onSuccess: (tool) => {
      toast.success('Tool created.');
      router.push(`/dashboard/integrations/${tool.id}`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">New tool</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Webhook tool. Agent calls signed HTTP request with JSON args. HMAC signature lives
          in <code className="text-xs bg-muted px-1 py-0.5 rounded font-mono">X-VoiceForge-Signature</code>.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Plug className="h-4 w-4 text-primary" />
              Basics
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div>
              <Label htmlFor="name">Name (snake_case)</Label>
              <Input
                id="name"
                className="mt-1.5"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="create_booking"
              />
            </div>
            <div>
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                className="mt-1.5"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div>
              <Label>Attach to agent (optional)</Label>
              <select
                className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
              >
                <option value="">Workspace-wide</option>
                {agentsQuery.data?.items.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Plug className="h-4 w-4 text-primary" />
              HTTP request
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div>
              <Label htmlFor="url">URL</Label>
              <Input
                id="url"
                className="mt-1.5"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://your-api.example.com/hook"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Method</Label>
                <select
                  className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                >
                  <option>POST</option>
                  <option>PUT</option>
                  <option>PATCH</option>
                  <option>GET</option>
                  <option>DELETE</option>
                </select>
              </div>
              <div>
                <Label htmlFor="timeout">Timeout (ms)</Label>
                <Input
                  id="timeout"
                  className="mt-1.5"
                  type="number"
                  min={100}
                  max={30_000}
                  value={timeoutMs}
                  onChange={(e) => setTimeoutMs(Number(e.target.value))}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="hmac">HMAC secret (optional)</Label>
              <Input
                id="hmac"
                className="mt-1.5"
                type="password"
                value={hmacSecret}
                onChange={(e) => setHmacSecret(e.target.value)}
                placeholder="Leave empty to skip signing"
              />
            </div>
            <div>
              <Label htmlFor="headers">Extra headers (JSON)</Label>
              <Textarea
                id="headers"
                className="mt-1.5 font-mono text-xs"
                rows={3}
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
              />
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Input schema (JSON Schema subset)</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              Subset supported: <code className="bg-muted px-1 py-0.5 rounded font-mono text-[10px]">type: object</code> with{' '}
              <code className="bg-muted px-1 py-0.5 rounded font-mono text-[10px]">properties</code> +{' '}
              <code className="bg-muted px-1 py-0.5 rounded font-mono text-[10px]">required</code>. Each property may set{' '}
              <code className="bg-muted px-1 py-0.5 rounded font-mono text-[10px]">type</code> (string, number,
              integer, boolean, array, object) and <code className="bg-muted px-1 py-0.5 rounded font-mono text-[10px]">enum</code>.
            </p>
            <Textarea
              rows={12}
              className="font-mono text-xs"
              value={schemaText}
              onChange={(e) => setSchemaText(e.target.value)}
            />
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={() => create.mutate()} disabled={create.isPending || !workspaceId} className="gap-2">
          <Save className="h-4 w-4" />
          {create.isPending ? 'Creating…' : 'Create tool'}
        </Button>
        <Button variant="outline" onClick={() => router.push('/dashboard/integrations')} className="gap-2">
          <X className="h-4 w-4" />
          Cancel
        </Button>
      </div>
    </div>
  );
}
