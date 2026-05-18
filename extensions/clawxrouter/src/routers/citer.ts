import { spawn, ChildProcess } from "node:child_process";
import type { ClawXrouterRouter, DetectionContext, RouterDecision } from "../types.js";

export interface CiterConfig {
  enabled: boolean;
  localPort: number;
  modelPath?: string;
  tokenizerPath?: string;
  mlpModelPath?: string;
  threshold: number;
  tiers?: {
    lowConfidence: { provider: string; model: string };
    highConfidence: { provider: string; model: string };
  };
}

const DEFAULT_CITER_CONFIG: Partial<CiterConfig> = {
  enabled: false,
  localPort: 8765,
  threshold: 0.5,
  tiers: {
    lowConfidence: { provider: "ollama", model: "qwen3.5:9b" },
    highConfidence: { provider: "ollama", model: "qwen3.5:4b" },
  },
};

export class SSHTunnelManager {
  private process: ChildProcess | null = null;
  private config: CiterConfig;
  constructor(config: CiterConfig) {
    this.config = config;
  }
  start():void {
     // 启动
  }
  stop(): void {
    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
  }

  isActive(): boolean {
    return this.process !== null && !this.process.killed;
  }
}

const globalTunnel: { manager: SSHTunnelManager | null; refCount: number } = {
  manager: null,
  refCount: 0,
};

async function getOrCreateTunnel(config: CiterConfig): Promise<SSHTunnelManager> {
  if (!globalTunnel.manager) {
    globalTunnel.manager = new SSHTunnelManager(config);
  }
  globalTunnel.refCount++;
  return globalTunnel.manager;
}

function releaseTunnel(): void {
  globalTunnel.refCount--;
  if (globalTunnel.refCount <= 0 && globalTunnel.manager) {
    globalTunnel.manager.stop();
    globalTunnel.manager = null;
    globalTunnel.refCount = 0;
  }
}

async function callCiterApi(
  prompt: string,
  localPort: number,
  modelPath?: string,
  tokenizerPath?: string,
  mlpModelPath?: string,
  threshold?: number,
): Promise<{ confidence: number; decision: string }> {
  const response = await fetch(`http://127.0.0.1:${localPort}/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      model_path: modelPath,
      tokenizer_path: tokenizerPath,
      mlp_model_path: mlpModelPath,
      threshold: threshold ?? 0.5,
    }),
  });

  if (!response.ok) {
    throw new Error(`CITER API error: ${response.status}`);
  }

  return response.json();
}

function resolveConfig(pluginConfig: Record<string, unknown>): CiterConfig {
  const routers = (pluginConfig?.privacy as Record<string, unknown>)?.routers as
    | Record<string, { options?: Record<string, unknown>; enabled?: boolean }>
    | undefined;
  const citerConfig = routers?.["citer"];
  const options = (citerConfig?.options ?? {}) as Record<string, unknown>;

  return {
    enabled: (citerConfig?.enabled as boolean) ?? DEFAULT_CITER_CONFIG.enabled!,
    localPort: (options.localPort as number) ?? DEFAULT_CITER_CONFIG.localPort!,
    modelPath: (options.modelPath as string) ?? DEFAULT_CITER_CONFIG.modelPath,
    tokenizerPath: (options.tokenizerPath as string) ?? DEFAULT_CITER_CONFIG.tokenizerPath,
    mlpModelPath: (options.mlpModelPath as string) ?? undefined,
    threshold: (options.threshold as number) ?? DEFAULT_CITER_CONFIG.threshold!,
    tiers: (options.tiers as CiterConfig["tiers"]) ?? DEFAULT_CITER_CONFIG.tiers,
  };
}

let mlpConfigured = false;

async function configureMlp(localPort: number, mlpPath?: string, hiddenSize?: number): Promise<void> {
  if (mlpConfigured || !mlpPath) return;
  try {
    const response = await fetch(`http://127.0.0.1:${localPort}/configure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mlp_model_path: mlpPath,
        hidden_size: hiddenSize ?? 2048,
      }),
    });
    if (response.ok) {
      mlpConfigured = true;
      console.log("[CITER] MLP model configured successfully");
    }
  } catch (err) {
    console.warn("[CITER] Failed to configure MLP model:", err);
  }
}

export const citerRouter: ClawXrouterRouter = {
  id: "citer",

  async detect(
    context: DetectionContext,
    pluginConfig: Record<string, unknown>,
  ): Promise<RouterDecision> {
    const config = resolveConfig(pluginConfig);

    if (!config.enabled && !context.dryRun) {
      return { level: "S1", action: "passthrough", reason: "CITER router disabled" };
    }

    const message = context.message ?? "";

    if (!message.trim()) {
      return { level: "S1", action: "passthrough", reason: "Empty message" };
    }

    try {
      const result = await callCiterApi(
        message,
        config.localPort,
        config.modelPath,
        config.tokenizerPath,
        config.mlpModelPath,
        config.threshold
      );

      const tiers = config.tiers ?? DEFAULT_CITER_CONFIG.tiers!;
      const useLargeModel = result.decision === "large";

      return {
        level: "S1",
        action: "redirect",
        target: {
          provider: useLargeModel ? tiers.lowConfidence.provider : tiers.highConfidence.provider,
          model: useLargeModel ? tiers.lowConfidence.model : tiers.highConfidence.model,
        },
        reason: `confidence=${result.confidence.toFixed(3)}, threshold=${config.threshold}`,
        confidence: result.confidence,
        routerId: "citer",
      };
    } catch (err) {
      console.error("[CITER] Router error:", err);
      return {
        level: "S1",
        action: "passthrough",
        reason: `CITER API call failed: ${String(err)}`,
      };
    } finally {
      releaseTunnel();
    }
  },
};