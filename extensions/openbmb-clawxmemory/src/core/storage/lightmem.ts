import type {
  L0SessionRecord,
  L1WindowRecord,
  L2TimeIndexRecord,
  L2SearchResult,
  GlobalProfileRecord,
  DashboardOverview,
} from "../types.js";
import type { ClearMemoryResult, RepairMemoryResult } from "./sqlite.js";
import { nowIso } from "../utils/id.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const LIGHTMEM_URL = "http://localhost:8000/mcp";
const LIGHTMEM_HEADERS = { "Accept": "application/json, text/event-stream" };

export class LightMemRepository {
  private mcpServerName: string;
  private mcpClient: Client | null = null;
  private initialized = false;

  constructor(mcpServerName = "lightmem") {
    this.mcpServerName = mcpServerName;
  }

  private async callTool(toolName: string, args: Record<string, unknown>): Promise<{ status: string; message: string; details?: Record<string, unknown> }> {
    const client = await this.getMcpClient();
    if (!client) {
      return { status: "error", message: "MCP client not available" };
    }
    try {
      const result = await client.callTool({
        name: toolName,
        arguments: args,
      }) as { content?: Array<{ text?: string }>; isError?: boolean };
      if (result.isError) {
        return { status: "error", message: result.content?.[0] ? String(result.content[0].text || result.content[0]) : "Tool call failed" };
      }
      return { status: "success", message: "ok", details: result.content?.[0]?.text ? JSON.parse(result.content[0].text) : undefined };
    } catch (err) {
      return { status: "error", message: String(err) };
    }
  }

  private async getMcpClient(): Promise<Client | null> {
    if (this.mcpClient) return this.mcpClient;
    try {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

      const transport = new StreamableHTTPClientTransport(new URL(LIGHTMEM_URL), {
        requestInit: { headers: LIGHTMEM_HEADERS },
      });

      const client = new Client({
        name: "clawxmemory-lightmem",
        version: "1.0.0",
      }, {
        capabilities: {},
      });

      await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
      this.mcpClient = client;
      console.log("[LightMem] MCP client connected successfully");
      return this.mcpClient;
    } catch (err) {
      console.warn("[LightMem] MCP runtime not available:", err);
      return null;
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.getMcpClient();
    this.initialized = true;
  }

  close(): void {
    this.mcpClient = null;
    this.initialized = false;
  }

  insertL0Session(record: Omit<L0SessionRecord, "createdAt"> & { createdAt?: string }): void {
    const timestamp = record.createdAt ?? nowIso();
    const messages = record.messages || [];
    const userContent = messages.filter(m => m.role === "user").map(m => m.content).join("\n");
    const assistantContent = messages.filter(m => m.role === "assistant").map(m => m.content).join("\n");

    this.callTool("add_memory", {
      user_input: userContent,
      assistant_reply: assistantContent,
      timestamp,
      force_segment: false,
      force_extract: false,
    }).catch(err => console.error("[LightMem] add_memory error:", err));
  }

  listUnindexedL0Sessions(limit = 20, _sessionKeys?: string[]): L0SessionRecord[] {
    return [];
  }

  markL0Indexed(_ids: string[]): void {
  }

  getL0ByIds(_ids: string[]): L0SessionRecord[] {
    return [];
  }

  searchL0(_query: string, _limit = 8): L0SessionRecord[] {
    return [];
  }

  getL0ByL1Ids(_l1Ids: string[], _limit = 4): L0SessionRecord[] {
    return [];
  }

  listRecentL0(_limit = 20, _offset = 0): L0SessionRecord[] {
    return [];
  }

  listAllL0(): L0SessionRecord[] {
    return [];
  }

  getActiveTopicBuffer(_sessionKey: string): undefined {
    return undefined;
  }

  listActiveTopicBuffers(_sessionKeys?: string[]): never[] {
    return [];
  }

  upsertActiveTopicBuffer(_buffer: unknown): void {
  }

  deleteActiveTopicBuffer(_sessionKey: string): void {
  }

  insertL1Window(window: L1WindowRecord): void {
    this.callTool("add_memory", {
      user_input: window.summary,
      assistant_reply: `Session: ${window.sessionKey}\nTime: ${window.timePeriod}\nFacts: ${window.facts.map(f => `${f.factKey}: ${f.factValue}`).join(", ")}`,
      timestamp: window.createdAt,
      force_segment: false,
      force_extract: true,
    }).catch(err => console.error("[LightMem] add_memory error:", err));
  }

  getL1ByIds(_ids: string[]): L1WindowRecord[] {
    return [];
  }

  searchL1(_query: string, _limit = 10): L1WindowRecord[] {
    return [];
  }

  listRecentL1(_limit = 20, _offset = 0): L1WindowRecord[] {
    return [];
  }

  listAllL1(): L1WindowRecord[] {
    return [];
  }

  getL2TimeByDate(_dateKey: string): L2TimeIndexRecord | undefined {
    return undefined;
  }

  getL2TimeByIds(_ids: string[]): L2TimeIndexRecord[] {
    return [];
  }

  upsertL2TimeIndex(index: L2TimeIndexRecord): void {
    this.callTool("add_memory", {
      user_input: index.summary,
      assistant_reply: `Date: ${index.dateKey}\nRelated sessions: ${index.l1Source.join(", ")}`,
      timestamp: index.createdAt,
      force_segment: false,
      force_extract: true,
    }).catch(err => console.error("[LightMem] add_memory error:", err));
  }

  searchL2TimeIndexes(_query: string, _limit = 10): L2SearchResult[] {
    return [];
  }

  listRecentL2Time(_limit = 20, _offset = 0): L2TimeIndexRecord[] {
    return [];
  }

  listAllL2Time(): L2TimeIndexRecord[] {
    return [];
  }

  getL2ProjectByKey(_projectKey: string): unknown {
    return undefined;
  }

  searchL2ProjectIndexes(_query: string, _limit = 10): unknown[] {
    return [];
  }

  listRecentL2Projects(_limit = 20, _offset = 0): unknown[] {
    return [];
  }

  listAllL2Projects(): unknown[] {
    return [];
  }

  upsertL2ProjectIndex(_index: unknown): void {
  }

  getGlobalProfileRecord(): GlobalProfileRecord {
    return {
      recordId: "global_profile_record" as const,
      profileText: "",
      sourceL1Ids: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  upsertGlobalProfileRecord(record: GlobalProfileRecord): void {
    this.callTool("add_memory", {
      user_input: "User profile update",
      assistant_reply: record.profileText,
      timestamp: record.updatedAt,
      force_segment: false,
      force_extract: true,
    }).catch(err => console.error("[LightMem] add_memory error:", err));
  }

  async search(query: string, limit = 10): Promise<{ context: string; debug?: Record<string, unknown> }> {
    const result = await this.callTool("retrieve_memory", {
      query,
      limit,
      filters: {},
    });

    if (result.status === "success" && result.details) {
      const memories = (result.details as unknown as Array<{ user_input?: string; assistant_reply?: string }>) || [];
      return {
        context: memories.map(m => `[LightMem]\nUser: ${m.user_input || ""}\nAssistant: ${m.assistant_reply || ""}`).join("\n\n"),
        debug: { source: "lightmem", status: result.status },
      };
    }

    return { context: "", debug: { source: "lightmem", error: result.message } };
  }

  getDashboardOverview(): DashboardOverview {
    return {
      totalL0: 0,
      pendingL0: 0,
      openTopics: 0,
      totalL1: 0,
      totalL2Time: 0,
      totalL2Project: 0,
      totalProfiles: 0,
      queuedSessions: 0,
      lastRecallMs: 0,
      recallTimeouts: 0,
      lastRecallMode: "none",
    };
  }

  clearMemory(): ClearMemoryResult {
    return {
      cleared: {
        l0: 0,
        l1: 0,
        l2Time: 0,
        l2Project: 0,
        profile: 0,
        activeTopics: 0,
        links: 0,
        pipelineState: 0,
      },
      clearedAt: nowIso(),
    };
  }

  repairMemory(): RepairMemoryResult {
    return { inspected: 0, updated: 0, removed: 0, rebuilt: false };
  }

  async offlineUpdate(topK = 20, keepTopN = 10, scoreThreshold = 0.8): Promise<void> {
    await this.callTool("offline_update", {
      top_k: topK,
      keep_top_n: keepTopN,
      score_threshold: scoreThreshold,
    });
  }
}

export function isLightMemAvailable(): boolean {
  try {
    return true;
  } catch {
    return false;
  }
}