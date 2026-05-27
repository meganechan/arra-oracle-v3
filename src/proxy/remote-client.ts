/**
 * Remote HTTP Proxy Client for MCP Tool Handlers
 *
 * When ORACLE_REMOTE_URL is set, MCP tool calls proxy to a remote
 * KB server instead of using the local SQLite database.
 */

import type { ToolResponse } from '../tools/types.ts';
import type {
  OracleSearchInput,
  OracleLearnInput,
  OracleListInput,
  OracleConceptsInput,
  OracleSupersededInput,
  OracleHandoffInput,
  OracleInboxInput,
  OracleReadInput,
} from '../tools/types.ts';
import type {
  OracleThreadInput,
  OracleThreadsInput,
  OracleThreadReadInput,
  OracleThreadUpdateInput,
} from '../tools/forum.ts';
import type {
  CreateTraceInput,
  ListTracesInput,
  GetTraceInput,
} from '../trace/types.ts';

function ok(data: unknown): ToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function err(msg: string): ToolResponse {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

export class RemoteClient {
  constructor(private baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async get(path: string, params?: Record<string, string | number | undefined>): Promise<any> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
    return res.json();
  }

  private async post(path: string, body: Record<string, any>): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json();
  }

  private async patch(path: string, body: Record<string, any>): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json();
  }

  private async del(path: string, params?: Record<string, string | undefined>): Promise<any> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url.toString(), { method: 'DELETE' });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json();
  }

  // ===========================================================================
  // MCP Tool Handlers → HTTP API
  // ===========================================================================

  async search(input: OracleSearchInput): Promise<ToolResponse> {
    try {
      const data = await this.get('/api/search', {
        q: input.query,
        type: input.type,
        limit: input.limit,
        offset: input.offset,
        mode: input.mode,
        project: input.project,
        cwd: input.cwd,
        model: input.model,
      });
      return ok(data);
    } catch (e: any) {
      return err(e.message);
    }
  }

  async learn(input: OracleLearnInput): Promise<ToolResponse> {
    try {
      const data = await this.post('/api/learn', {
        pattern: input.pattern,
        source: input.source,
        concepts: input.concepts,
        project: input.project,
      });
      return ok(data);
    } catch (e: any) {
      return err(e.message);
    }
  }

  async list(input: OracleListInput): Promise<ToolResponse> {
    try {
      const data = await this.get('/api/list', {
        type: input.type,
        limit: input.limit,
        offset: input.offset,
      });
      return ok(data);
    } catch (e: any) {
      return err(e.message);
    }
  }

  async stats(): Promise<ToolResponse> {
    try {
      const data = await this.get('/api/stats');
      return ok(data);
    } catch (e: any) {
      return err(e.message);
    }
  }

  async concepts(input: OracleConceptsInput): Promise<ToolResponse> {
    try {
      const data = await this.get('/api/stats');
      return ok(data);
    } catch (e: any) {
      return err(e.message);
    }
  }

  async read(input: OracleReadInput): Promise<ToolResponse> {
    try {
      const data = await this.get('/api/read', {
        file: input.file,
        id: input.id,
      });
      return ok(data);
    } catch (e: any) {
      return err(e.message);
    }
  }

  async supersede(input: OracleSupersededInput): Promise<ToolResponse> {
    try {
      const data = await this.post('/api/supersede', {
        old_id: input.oldId,
        new_id: input.newId,
        reason: input.reason,
      });
      return ok(data);
    } catch (e: any) {
      return err(e.message);
    }
  }

  async handoff(input: OracleHandoffInput): Promise<ToolResponse> {
    try {
      const data = await this.post('/api/handoff', {
        content: input.content,
        slug: input.slug,
      });
      return ok(data);
    } catch (e: any) {
      return err(e.message);
    }
  }

  async inbox(input: OracleInboxInput): Promise<ToolResponse> {
    try {
      const data = await this.get('/api/inbox', {
        limit: input.limit,
        offset: input.offset,
        type: input.type,
      });
      return ok(data);
    } catch (e: any) {
      return err(e.message);
    }
  }

  // ===========================================================================
  // Forum
  // ===========================================================================

  async thread(input: OracleThreadInput): Promise<ToolResponse> {
    try {
      const data = await this.post('/api/thread', {
        message: input.message,
        thread_id: input.threadId,
        title: input.title,
        role: input.role,
        model: input.model,
      });
      return ok(data);
    } catch (e: any) {
      return err(e.message);
    }
  }

  async threads(input: OracleThreadsInput): Promise<ToolResponse> {
    try {
      const data = await this.get('/api/threads', {
        status: input.status,
        limit: input.limit,
        offset: input.offset,
      });
      return ok(data);
    } catch (e: any) {
      return err(e.message);
    }
  }

  async threadRead(input: OracleThreadReadInput): Promise<ToolResponse> {
    try {
      const data = await this.get(`/api/thread/${input.threadId}`, {
        limit: input.limit,
      });
      return ok(data);
    } catch (e: any) {
      return err(e.message);
    }
  }

  async threadUpdate(input: OracleThreadUpdateInput): Promise<ToolResponse> {
    try {
      const data = await this.patch(`/api/thread/${input.threadId}/status`, {
        status: input.status,
      });
      return ok(data);
    } catch (e: any) {
      return err(e.message);
    }
  }

  // ===========================================================================
  // Traces
  // ===========================================================================

  async trace(input: CreateTraceInput): Promise<ToolResponse> {
    try {
      const data = await this.post('/api/traces', {
        query: input.query,
        queryType: input.queryType,
        foundFiles: input.foundFiles,
        foundCommits: input.foundCommits,
        foundIssues: input.foundIssues,
        foundRetrospectives: input.foundRetrospectives,
        foundLearnings: input.foundLearnings,
        foundResonance: input.foundResonance,
        scope: input.scope,
        parentTraceId: input.parentTraceId,
        project: input.project,
        sessionId: input.sessionId,
        agentCount: input.agentCount,
        durationMs: input.durationMs,
      });
      return ok(data);
    } catch (e: any) {
      return err(e.message);
    }
  }

  async traceList(input: ListTracesInput): Promise<ToolResponse> {
    try {
      const data = await this.get('/api/traces', {
        query: input.query,
        project: input.project,
        status: input.status,
        limit: input.limit,
        offset: input.offset,
      });
      return ok(data);
    } catch (e: any) {
      return err(e.message);
    }
  }

  async traceGet(input: GetTraceInput): Promise<ToolResponse> {
    try {
      const data = await this.get(`/api/traces/${input.traceId}`, {
        includeChain: input.includeChain ? 'true' : undefined,
      });
      return ok(data);
    } catch (e: any) {
      return err(e.message);
    }
  }

  async traceLink(input: { prevTraceId: string; nextTraceId: string }): Promise<ToolResponse> {
    try {
      const data = await this.post(`/api/traces/${input.prevTraceId}/link`, {
        nextId: input.nextTraceId,
      });
      return ok(data);
    } catch (e: any) {
      return err(e.message);
    }
  }

  async traceUnlink(input: { traceId: string; direction: 'prev' | 'next' }): Promise<ToolResponse> {
    try {
      const data = await this.del(`/api/traces/${input.traceId}/link`, {
        direction: input.direction,
      });
      return ok(data);
    } catch (e: any) {
      return err(e.message);
    }
  }

  async traceChain(input: { traceId: string }): Promise<ToolResponse> {
    try {
      const data = await this.get(`/api/traces/${input.traceId}/chain`);
      return ok(data);
    } catch (e: any) {
      return err(e.message);
    }
  }
}
