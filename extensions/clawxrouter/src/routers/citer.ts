import { spawn } from "node:child_process";
import type { ClawXrouterRouter, DetectionContext, RouterDecision } from "../types.js";

export interface CiterConfig {
  enabled: boolean;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshKeyPath?: string;
  sshPassword?: string;
  remoteHost: string;
  remotePort: number;
  localPort: number;
  modelPath?: string;
  tokenizerPath?: string;
  threshold: number;
  tiers?: {
    lowConfidence: { provider: string; model: string };
    highConfidence: { provider: string; model: string };
  };
}

const DEFAULT_CITER_CONFIG: Partial<CiterConfig> = {
  enabled: false,
  sshHost: "localhost",
  sshPort: 22,
  sshUser: "",
  remoteHost: "127.0.0.1",
  remotePort: 8765,
  localPort: 8765,
  threshold: 0.5,
  tiers: {
    lowConfidence: { provider: "zhipu", model: "glm-4.5-air" },
    highConfidence: { provider: "ollama", model: "llama3.2:3b" },
  },
};

export class SSHTunnelManager {
  private process: ReturnType<typeof spawn> | null = null;
  private config: CiterConfig;

  constructor(config: CiterConfig) {
    this.config = config;
  }

  start(): Promise<boolean> {
    return new Promise((resolve) => {
      const args = [
        "-N",
        "-L",
        `${this.config.localPort}:${this.config.remoteHost}:${this.config.remotePort}`,
        "-o", "StrictHostKeyChecking=no",
        "-o", "ServerAliveInterval=60",
      ];

      if (this.config.sshKeyPath) {
        args.push("-i", this.config.sshKeyPath);
      }

      if (this.config.sshPort !== 22) {
        args.push("-p", String(this.config.sshPort));
      }

      const userPrefix = this.config.sshUser ? `${this.config.sshUser}@` : "";
      args.push(`${userPrefix}${this.config.sshHost}`);

      this.process = spawn("ssh", args, {
        stdio: "ignore",
        detached: false,
      });

      this.process.on("error", (err) => {
        console.error("[CITER] SSH tunnel error:", err);
        resolve(false);
      });

      this.process.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          console.warn(`[CITER] SSH tunnel exited with code ${code}`);
        }
      });

      setTimeout(() => resolve(true), 1500);
    });
  }

  stop(): void {
    if (this.process) {
      this.process.terminate();
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
  threshold?: number,
): Promise<{ confidence: number; decision: string }> {
  const response = await fetch(`http://127.0.0.1:${localPort}/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      model_path: modelPath,
      tokenizer_path: tokenizerPath,
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
    sshHost: (options.sshHost as string) ?? DEFAULT_CITER_CONFIG.sshHost!,
    sshPort: (options.sshPort as number) ?? DEFAULT_CITER_CONFIG.sshPort!,
    sshUser: (options.sshUser as string) ?? DEFAULT_CITER_CONFIG.sshUser!,
    sshKeyPath: (options.sshKeyPath as string) ?? DEFAULT_CITER_CONFIG.sshKeyPath,
    sshPassword: (options.sshPassword as string) ?? DEFAULT_CITER_CONFIG.sshPassword,
    remoteHost: (options.remoteHost as string) ?? DEFAULT_CITER_CONFIG.remoteHost!,
    remotePort: (options.remotePort as number) ?? DEFAULT_CITER_CONFIG.remotePort!,
    localPort: (options.localPort as number) ?? DEFAULT_CITER_CONFIG.localPort!,
    modelPath: (options.modelPath as string) ?? DEFAULT_CITER_CONFIG.modelPath,
    tokenizerPath: (options.tokenizerPath as string) ?? DEFAULT_CITER_CONFIG.tokenizerPath,
    threshold: (options.threshold as number) ?? DEFAULT_CITER_CONFIG.threshold!,
    tiers: (options.tiers as CiterConfig["tiers"]) ?? DEFAULT_CITER_CONFIG.tiers,
  };
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

    let tunnel: SSHTunnelManager | null = null;

    try {
      tunnel = await getOrCreateTunnel(config);
      if (!tunnel.isActive()) {
        const started = await tunnel.start();
        if (!started) {
          return {
            level: "S1",
            action: "passthrough",
            reason: "Failed to establish SSH tunnel to CITER server",
          };
        }
      }

      const result = await callCiterApi(
        message,
        config.localPort,
        config.modelPath,
        config.tokenizerPath,
        config.threshold,
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