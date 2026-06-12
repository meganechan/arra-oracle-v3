#!/usr/bin/env bun
/**
 * Arra Oracle MCP Server
 *
 * Slim entry point: server lifecycle, tool registration, and routing.
 * Handler implementations live in src/tools/.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { Database } from 'bun:sqlite';
import * as schema from './db/schema.ts';
import { createDatabase } from './db/index.ts';
import { createVectorStore } from './vector/factory.ts';
import type { VectorStoreAdapter } from './vector/types.ts';
import path from 'path';
import fs from 'fs';
import { loadToolGroupConfig, getDisabledTools, watchToolGroupConfig, type ToolGroupConfig } from './config/tool-groups.ts';
import { ORACLE_DATA_DIR, DB_PATH, REPO_ROOT } from './config.ts';
import { MCP_SERVER_NAME } from './const.ts';
import { RemoteClient } from './proxy/remote-client.ts';

// Tool handlers (all extracted to src/tools/)
import type { ToolContext } from './tools/types.ts';
import {
  searchToolDef, handleSearch,
  learnToolDef, handleLearn,
  listToolDef, handleList,
  statsToolDef, handleStats,
  conceptsToolDef, handleConcepts,
  supersedeToolDef, handleSupersede,
  handoffToolDef, handleHandoff,
  inboxToolDef, handleInbox,
  readToolDef, handleRead,
  forumToolDefs,
  handleThread, handleThreads, handleThreadRead, handleThreadUpdate,
  traceToolDefs,
  handleTrace, handleTraceList, handleTraceGet, handleTraceLink, handleTraceUnlink, handleTraceChain,
} from './tools/index.ts';

import type {
  OracleSearchInput,
  OracleLearnInput,
  OracleListInput,
  OracleStatsInput,
  OracleConceptsInput,
  OracleSupersededInput,
  OracleHandoffInput,
  OracleInboxInput,
  OracleReadInput,
  OracleThreadInput,
  OracleThreadsInput,
  OracleThreadReadInput,
  OracleThreadUpdateInput,
} from './tools/index.ts';

import type {
  CreateTraceInput,
  ListTracesInput,
  GetTraceInput,
} from './trace/types.ts';

// Write tools that should be disabled in read-only mode
const WRITE_TOOLS = [
  'muninn_learn',
  'muninn_thread',
  'muninn_thread_update',
  'muninn_trace',
  'muninn_supersede',
  'muninn_handoff',
];

class OracleMCPServer {
  private server: Server;
  private sqlite: Database;
  private db: BunSQLiteDatabase<typeof schema>;
  private repoRoot: string;
  private vectorStore: VectorStoreAdapter;
  private vectorStatus: 'unknown' | 'connected' | 'unavailable' = 'unknown';
  private readOnly: boolean;
  private version: string;
  private disabledTools: Set<string>;
  private stopToolGroupsWatch: (() => void) | null = null;
  private remote: RemoteClient | null = null;

  constructor(options: { readOnly?: boolean; toolGroups?: ToolGroupConfig } = {}) {
    this.readOnly = options.readOnly ?? false;
    if (this.readOnly) {
      console.error('[Oracle] Running in READ-ONLY mode');
    }

    const remoteUrl = process.env.ORACLE_REMOTE_URL;
    if (remoteUrl) {
      this.remote = new RemoteClient(remoteUrl);
      console.error(`[Oracle] Remote proxy mode → ${remoteUrl}`);
    }

    // Use safe REPO_ROOT from config.ts: never falls back to process.cwd(),
    // which would create parasitic ψ/ dirs in whatever directory the MCP
    // server was launched from. See #551.
    this.repoRoot = REPO_ROOT;

    const groupConfig = options.toolGroups ?? loadToolGroupConfig(this.repoRoot);
    this.disabledTools = getDisabledTools(groupConfig);
    const disabledGroups = Object.entries(groupConfig)
      .filter(([, v]) => typeof v === 'boolean' && !v)
      .map(([k]) => k);
    if (disabledGroups.length > 0) {
      console.error(`[ToolGroups] Disabled groups: ${disabledGroups.join(', ')}`);
    }
    if (groupConfig.disabled_tools?.length) {
      console.error(`[ToolGroups] disabled_tools: ${groupConfig.disabled_tools.join(', ')}`);
    }
    if (groupConfig.enabled_tools?.length) {
      console.error(`[ToolGroups] enabled_tools (whitelist): ${groupConfig.enabled_tools.join(', ')}`);
    }

    // Hot reload: rebuild the disabled set in place when config changes.
    // The list/call handlers read this.disabledTools at request time, so
    // mutating it is enough — no re-registration of tool definitions needed.
    // Skip when toolGroups was passed explicitly (tests pin a config).
    if (!options.toolGroups && process.env.ORACLE_TOOL_GROUPS_HOT_RELOAD !== '0') {
      this.stopToolGroupsWatch = watchToolGroupConfig((next) => {
        const nextDisabled = getDisabledTools(next);
        this.disabledTools.clear();
        for (const t of nextDisabled) this.disabledTools.add(t);
        const disabledGroups = Object.entries(next)
          .filter(([, v]) => typeof v === 'boolean' && !v)
          .map(([k]) => k);
        const parts: string[] = [];
        if (disabledGroups.length) parts.push(`groups: ${disabledGroups.join(', ')}`);
        if (next.disabled_tools?.length) parts.push(`disabled_tools: ${next.disabled_tools.join(', ')}`);
        if (next.enabled_tools?.length) parts.push(`enabled_tools: ${next.enabled_tools.join(', ')}`);
        console.error(
          parts.length
            ? `[ToolGroups] Reloaded — ${parts.join(' | ')}`
            : '[ToolGroups] Reloaded — all tools enabled',
        );
      }, this.repoRoot);
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname || __dirname, '..', 'package.json'), 'utf-8'));
    this.version = pkg.version;
    this.server = new Server(
      { name: MCP_SERVER_NAME, version: this.version },
      { capabilities: { tools: {} } }
    );

    if (this.remote) {
      this.sqlite = null as any;
      this.db = null as any;
      this.vectorStore = null as any;
    } else {
      this.vectorStore = createVectorStore({
        type: 'lancedb',
        collectionName: 'oracle_knowledge_bge_m3',
        embeddingProvider: 'ollama',
        embeddingModel: 'bge-m3',
      });
      const { sqlite, db } = createDatabase(DB_PATH);
      this.sqlite = sqlite;
      this.db = db;
    }

    this.setupHandlers();
    this.setupErrorHandling();
    this.verifyVectorHealth();
  }

  /** Build ToolContext from server state */
  private get toolCtx(): ToolContext {
    return {
      db: this.db,
      sqlite: this.sqlite,
      repoRoot: this.repoRoot,
      vectorStore: this.vectorStore,
      vectorStatus: this.vectorStatus,
      version: this.version,
    };
  }

  private async verifyVectorHealth(): Promise<void> {
    if (this.remote) return;
    try {
      const stats = await this.vectorStore.getStats();
      if (stats.count > 0) {
        this.vectorStatus = 'connected';
        console.error(`[VectorDB:${this.vectorStore.name}] ✓ oracle_knowledge: ${stats.count} documents`);
      } else {
        // count===0 while the KB has documents = semantic search is DEAD (FTS-only).
        // Surface this loudly + as 'unavailable' so muninn_stats shows it instead of
        // hiding behind a reassuring "connected". This is the failure mode that hid
        // for a month after the ChromaDB→LanceDB migration / a wiped reindex.
        let docCount = 0;
        try {
          docCount = (this.sqlite?.prepare('SELECT COUNT(*) AS n FROM oracle_documents').get() as { n: number } | undefined)?.n ?? 0;
        } catch {}
        if (docCount > 0) {
          this.vectorStatus = 'unavailable';
          console.error(`[VectorDB:${this.vectorStore.name}] ⚠️  VECTOR INDEX EMPTY — 0 vectors but ${docCount} documents in KB. Semantic search disabled (FTS-only). Check dataPath/collection match + run reindex.`);
        } else {
          this.vectorStatus = 'connected';
          console.error(`[VectorDB:${this.vectorStore.name}] ✓ Connected (KB empty — no documents yet)`);
        }
      }
    } catch (e) {
      this.vectorStatus = 'unavailable';
      console.error(`[VectorDB:${this.vectorStore.name}] ✗ Cannot connect:`, e instanceof Error ? e.message : String(e));
    }
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  private async cleanup(): Promise<void> {
    if (this.remote) return;
    this.sqlite.close();
    await this.vectorStore.close();
  }

  private setupHandlers(): void {
    // ================================================================
    // List available tools
    // ================================================================
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const allTools = [
        // Meta-documentation tool
        {
          name: '____IMPORTANT',
          description: `ORACLE WORKFLOW GUIDE (v${this.version}):\n\n1. SEARCH & DISCOVER\n   muninn_search(query) → Find knowledge by keywords/vectors\n   muninn_read(file/id) → Read full document content\n   muninn_list() → Browse all documents\n   muninn_concepts() → See topic coverage\n\n2. LEARN & REMEMBER\n   muninn_learn(pattern) → Add new patterns/learnings\n   muninn_thread(message) → Multi-turn discussions\n   ⚠️ BEFORE adding: search for similar topics first!\n   If updating old info → use muninn_supersede(oldId, newId)\n\n3. TRACE & DISTILL\n   muninn_trace(query) → Log discovery sessions with dig points\n   muninn_trace_list() → Find past traces\n   muninn_trace_get(id) → Explore dig points (files, commits, issues)\n   muninn_trace_link(prevId, nextId) → Chain related traces together\n   muninn_trace_chain(id) → View the full linked chain\n\n4. HANDOFF & INBOX\n   muninn_handoff(content) → Save session context for next session\n   muninn_inbox() → List pending handoffs\n\n5. SUPERSEDE (when info changes)\n   muninn_supersede(oldId, newId, reason) → Mark old doc as outdated\n   "Nothing is Deleted" — old preserved, just marked superseded\n\nPhilosophy: "Nothing is Deleted" — All interactions logged.`,
          inputSchema: { type: 'object', properties: {} }
        },
        // Core tools (from src/tools/)
        searchToolDef,
        readToolDef,
        learnToolDef,
        listToolDef,
        statsToolDef,
        conceptsToolDef,
        // Forum tools (from src/tools/forum.ts)
        ...forumToolDefs,
        // Trace tools (from src/tools/trace.ts)
        ...traceToolDefs,
        // Supersede, Handoff, Inbox, Verify
        supersedeToolDef,
        handoffToolDef,
        inboxToolDef,
      ];

      let tools = allTools.filter(t => !this.disabledTools.has(t.name));
      if (this.readOnly) {
        tools = tools.filter(t => !WRITE_TOOLS.includes(t.name));
      }

      return { tools };
    });

    // ================================================================
    // Handle tool calls — route to extracted handlers
    // ================================================================
    this.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<any> => {
      if (this.disabledTools.has(request.params.name)) {
        return {
          content: [{
            type: 'text',
            text: `Error: Tool "${request.params.name}" is disabled by tool group config. Check ${ORACLE_DATA_DIR}/config.json or arra.config.json.`
          }],
          isError: true
        };
      }

      if (this.readOnly && WRITE_TOOLS.includes(request.params.name)) {
        return {
          content: [{
            type: 'text',
            text: `Error: Tool "${request.params.name}" is disabled in read-only mode. This Oracle instance is configured for read-only access.`
          }],
          isError: true
        };
      }

      const args = request.params.arguments as any;

      try {
        if (this.remote) {
          return await this.dispatchRemote(request.params.name, args);
        }
        return await this.dispatchLocal(request.params.name, args);
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`
          }],
          isError: true
        };
      }
    });
  }

  private async dispatchLocal(name: string, args: any): Promise<any> {
    const ctx = this.toolCtx;
    switch (name) {
      case 'muninn_search':
        return handleSearch(ctx, args as OracleSearchInput);
      case 'muninn_read':
        return handleRead(ctx, args as OracleReadInput);
      case 'muninn_learn':
        return handleLearn(ctx, args as OracleLearnInput);
      case 'muninn_list':
        return handleList(ctx, args as OracleListInput);
      case 'muninn_stats':
        return handleStats(ctx, args as OracleStatsInput);
      case 'muninn_concepts':
        return handleConcepts(ctx, args as OracleConceptsInput);
      case 'muninn_supersede':
        return handleSupersede(ctx, args as OracleSupersededInput);
      case 'muninn_handoff':
        return handleHandoff(ctx, args as OracleHandoffInput);
      case 'muninn_inbox':
        return handleInbox(ctx, args as OracleInboxInput);
      case 'muninn_thread':
        return handleThread(args as OracleThreadInput);
      case 'muninn_threads':
        return handleThreads(args as OracleThreadsInput);
      case 'muninn_thread_read':
        return handleThreadRead(args as OracleThreadReadInput);
      case 'muninn_thread_update':
        return handleThreadUpdate(args as OracleThreadUpdateInput);
      case 'muninn_trace':
        return handleTrace(args as CreateTraceInput);
      case 'muninn_trace_list':
        return handleTraceList(args as ListTracesInput);
      case 'muninn_trace_get':
        return handleTraceGet(args as GetTraceInput);
      case 'muninn_trace_link':
        return handleTraceLink(args as { prevTraceId: string; nextTraceId: string });
      case 'muninn_trace_unlink':
        return handleTraceUnlink(args as { traceId: string; direction: 'prev' | 'next' });
      case 'muninn_trace_chain':
        return handleTraceChain(args as { traceId: string });
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private async dispatchRemote(name: string, args: any): Promise<any> {
    const r = this.remote!;
    switch (name) {
      case 'muninn_search':
        return r.search(args);
      case 'muninn_read':
        return r.read(args);
      case 'muninn_learn':
        return r.learn(args);
      case 'muninn_list':
        return r.list(args);
      case 'muninn_stats':
        return r.stats();
      case 'muninn_concepts':
        return r.concepts(args);
      case 'muninn_supersede':
        return r.supersede(args);
      case 'muninn_handoff':
        return r.handoff(args);
      case 'muninn_inbox':
        return r.inbox(args);
      case 'muninn_thread':
        return r.thread(args);
      case 'muninn_threads':
        return r.threads(args);
      case 'muninn_thread_read':
        return r.threadRead(args);
      case 'muninn_thread_update':
        return r.threadUpdate(args);
      case 'muninn_trace':
        return r.trace(args);
      case 'muninn_trace_list':
        return r.traceList(args);
      case 'muninn_trace_get':
        return r.traceGet(args);
      case 'muninn_trace_link':
        return r.traceLink(args);
      case 'muninn_trace_unlink':
        return r.traceUnlink(args);
      case 'muninn_trace_chain':
        return r.traceChain(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  async preConnectVector(): Promise<void> {
    if (this.remote) return;
    await this.vectorStore.connect();
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Arra Oracle MCP Server running on stdio (FTS5 mode)');
  }
}

async function main() {
  const readOnly = process.env.ORACLE_READ_ONLY === 'true' || process.argv.includes('--read-only');
  const server = new OracleMCPServer({ readOnly });

  try {
    console.error('[Startup] Pre-connecting to vector store...');
    await server.preConnectVector();
    console.error('[Startup] Vector store pre-connected successfully');
  } catch (e) {
    console.error('[Startup] Vector store pre-connect failed:', e instanceof Error ? e.message : e);
  }

  await server.run();
}

main().catch(console.error);
