import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { JsonFileStorage, SupbotRuntime, ensureRuntimeDirs, type RuntimeState, type StorageAdapter } from "@supbot/runtime";
import type { McpConfigTransfer, McpServerInput, McpServerUpdate, MemoryAddInput, MemoryImportInput, MemoryRecallFeedbackInput, MemoryReplayRecallInput, MemorySearchQuery, MemoryUpdateInput, ModelConfigUpdate, PermissionMode, PermissionRule, PersonalityConfig, RemoteBridgeConfig, ScheduledJobInput, SendPromptInput, SubagentConfig, ToolMarketConfigUpdate, ToolMarketQuery } from "@supbot/shared";

let mainWindow: BrowserWindow | null = null;
let runtime: SupbotRuntime | null = null;

async function createRuntime(): Promise<SupbotRuntime> {
  const userDataPath = process.env.SUPBOT_USER_DATA_DIR || app.getPath("userData");
  const dataDir = join(userDataPath, "data");
  await ensureRuntimeDirs(dataDir);
  const storage = new EncryptedStorage(new JsonFileStorage(dataDir), userDataPath);
  const service = new SupbotRuntime(storage, {
    secretStorageKind: storage.secretStorageKind(),
    marketSecretStorageKind: storage.secretStorageKind()
  });
  await service.init();
  service.startScheduler();
  service.onEvent((event) => {
    mainWindow?.webContents.send("supbot:event", event);
  });
  return service;
}

class EncryptedStorage implements StorageAdapter {
  constructor(private readonly inner: JsonFileStorage, private readonly userDataPath: string) {}

  getDataDir(): string {
    return this.inner.getDataDir();
  }

  secretStorageKind(): "safeStorage" | "file" {
    return safeStorage.isEncryptionAvailable() ? "safeStorage" : "file";
  }

  async load(): Promise<RuntimeState> {
    const state = await this.inner.load();
    if (state.modelSecret) {
      const decoded = this.decryptSecret(state.modelSecret);
      state.modelSecret = decoded.value;
      state.modelConfig.apiKeyStorage = decoded.kind;
      state.modelConfig.apiKeySaved = true;
    }
    if (state.toolMarketSecret) {
      const decoded = this.decryptSecret(state.toolMarketSecret);
      state.toolMarketSecret = decoded.value;
      state.toolMarketConfig.tokenStorage = decoded.kind;
      state.toolMarketConfig.accessTokenSaved = true;
    }
    if (state.toolMarketPasswordSecret) {
      const decoded = this.decryptSecret(state.toolMarketPasswordSecret);
      state.toolMarketPasswordSecret = decoded.value;
      state.toolMarketConfig.passwordStorage = decoded.kind;
      state.toolMarketConfig.passwordSaved = true;
    }
    return state;
  }

  async save(state: RuntimeState): Promise<void> {
    const copy: RuntimeState = {
      ...state,
      modelConfig: { ...state.modelConfig },
      toolMarketConfig: { ...state.toolMarketConfig }
    };
    if (copy.modelSecret) {
      const encoded = this.encryptSecret(copy.modelSecret);
      copy.modelSecret = encoded.value;
      copy.modelConfig.apiKeyStorage = encoded.kind;
      copy.modelConfig.apiKeySaved = true;
    }
    if (copy.toolMarketSecret) {
      const encoded = this.encryptSecret(copy.toolMarketSecret);
      copy.toolMarketSecret = encoded.value;
      copy.toolMarketConfig.tokenStorage = encoded.kind;
      copy.toolMarketConfig.accessTokenSaved = true;
    }
    if (copy.toolMarketPasswordSecret) {
      const encoded = this.encryptSecret(copy.toolMarketPasswordSecret);
      copy.toolMarketPasswordSecret = encoded.value;
      copy.toolMarketConfig.passwordStorage = encoded.kind;
      copy.toolMarketConfig.passwordSaved = true;
    }
    await this.inner.save(copy);
  }

  private encryptSecret(secret: string): { value: string; kind: "safeStorage" | "file" } {
    if (safeStorage.isEncryptionAvailable()) {
      return {
        value: `safe:v1:${Buffer.from(safeStorage.encryptString(secret)).toString("base64")}`,
        kind: "safeStorage"
      };
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.fileKey(), iv);
    const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      value: `file:v1:${Buffer.concat([iv, tag, encrypted]).toString("base64")}`,
      kind: "file"
    };
  }

  private decryptSecret(secret: string): { value: string; kind: "safeStorage" | "file" } {
    if (secret.startsWith("safe:v1:")) {
      return {
        value: safeStorage.decryptString(Buffer.from(secret.slice("safe:v1:".length), "base64")),
        kind: "safeStorage"
      };
    }
    if (secret.startsWith("file:v1:")) {
      const payload = Buffer.from(secret.slice("file:v1:".length), "base64");
      const iv = payload.subarray(0, 12);
      const tag = payload.subarray(12, 28);
      const encrypted = payload.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", this.fileKey(), iv);
      decipher.setAuthTag(tag);
      return {
        value: Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"),
        kind: "file"
      };
    }
    return { value: secret, kind: "file" };
  }

  private fileKey(): Buffer {
    const username = safeUserName();
    return createHash("sha256").update(`supbot:${this.userDataPath}:${hostname()}:${username}`).digest();
  }
}

function safeUserName(): string {
  try {
    return userInfo().username;
  } catch {
    return "local-user";
  }
}

function getRuntime(): SupbotRuntime {
  if (!runtime) {
    throw new Error("Supbot runtime is not ready.");
  }
  return runtime;
}

async function createWindow(): Promise<void> {
  runtime = await createRuntime();
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1060,
    minHeight: 720,
    backgroundColor: "#0a0f16",
    title: "Supbot",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const devServerUrl = process.env.SUPBOT_DEV_SERVER_URL;
  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerIpc(): void {
  ipcMain.handle("snapshot", () => getRuntime().snapshot());
  ipcMain.handle("conversation:create", (_event, title?: string) => getRuntime().createConversation(title));
  ipcMain.handle("conversation:delete", (_event, id: string) => getRuntime().deleteConversation(id));
  ipcMain.handle("prompt:send", (_event, input: SendPromptInput) => getRuntime().sendPrompt(input));
  ipcMain.handle("job:cancel", (_event, id: string) => getRuntime().cancelJob(id));
  ipcMain.handle("tool:approve", (_event, id: string) => getRuntime().approveToolPermission(id));
  ipcMain.handle("tool:deny", (_event, id: string) => getRuntime().denyToolPermission(id));
  ipcMain.handle("permission:setMode", (_event, mode: PermissionMode) => getRuntime().setPermissionMode(mode));
  ipcMain.handle("permission:addRule", (_event, rule: Omit<PermissionRule, "id" | "createdAt" | "scope"> & { id?: string }) => getRuntime().addPermissionRule(rule));
  ipcMain.handle("permission:removeRule", (_event, id: string) => getRuntime().removePermissionRule(id));
  ipcMain.handle("conversation:compact", (_event, id: string) => getRuntime().compactConversation(id));
  ipcMain.handle("conversation:loadTranscript", (_event, id: string) => getRuntime().loadTranscript(id));
  ipcMain.handle("worktree:list", () => getRuntime().listWorktrees());
  ipcMain.handle("worktree:getDiff", (_event, id: string) => getRuntime().getWorktreeDiff(id));
  ipcMain.handle("worktree:apply", (_event, id: string) => getRuntime().applyWorktree(id));
  ipcMain.handle("worktree:discard", (_event, id: string) => getRuntime().discardWorktree(id));
  ipcMain.handle("worktree:openFolder", async (_event, id: string) => {
    const worktree = (await getRuntime().listWorktrees()).find((item) => item.id === id);
    if (!worktree) {
      throw new Error(`Worktree not found: ${id}`);
    }
    await shell.openPath(worktree.path);
  });
  ipcMain.handle("remoteBridge:getConfig", () => getRuntime().remoteBridgeConfig());
  ipcMain.handle("remoteBridge:updateConfig", (_event, input: Partial<RemoteBridgeConfig> & { token?: string; clearToken?: boolean }) => getRuntime().updateRemoteBridgeConfig(input));
  ipcMain.handle("remoteBridge:listSessions", () => getRuntime().listRemoteBridgeSessions());
  ipcMain.handle("remoteBridge:revokeSession", (_event, id: string) => getRuntime().revokeRemoteBridgeSession(id));
  ipcMain.handle("remoteBridge:listAudit", () => getRuntime().listRemoteBridgeAudit());
  ipcMain.handle("memory:list", (_event, query?: MemorySearchQuery) => getRuntime().listMemory(query));
  ipcMain.handle("memory:search", (_event, query?: MemorySearchQuery) => getRuntime().searchMemory(query));
  ipcMain.handle("memory:add", (_event, input: MemoryAddInput) => getRuntime().addMemory(input));
  ipcMain.handle("memory:update", (_event, id: string, input: MemoryUpdateInput) => getRuntime().updateMemory(id, input));
  ipcMain.handle("memory:delete", (_event, id: string) => getRuntime().deleteMemory(id));
  ipcMain.handle("memory:approveCandidate", (_event, id: string) => getRuntime().approveMemoryCandidate(id));
  ipcMain.handle("memory:denyCandidate", (_event, id: string) => getRuntime().denyMemoryCandidate(id));
  ipcMain.handle("memory:export", () => getRuntime().exportMemory());
  ipcMain.handle("memory:import", (_event, input: MemoryImportInput) => getRuntime().importMemory(input));
  ipcMain.handle("memory:backup", () => getRuntime().backupMemory());
  ipcMain.handle("memory:restore", (_event, filePath?: string) => getRuntime().restoreMemory(filePath));
  ipcMain.handle("memory:replayRecall", (_event, input: MemoryReplayRecallInput) => getRuntime().replayMemoryRecall(input));
  ipcMain.handle("memory:evaluateRecall", (_event, input: MemoryReplayRecallInput) => getRuntime().replayMemoryRecall(input));
  ipcMain.handle("memory:addRecallFeedback", (_event, input: MemoryRecallFeedbackInput) => getRuntime().addMemoryRecallFeedback(input));
  ipcMain.handle("model:update", (_event, input: ModelConfigUpdate) => getRuntime().updateModelConfig(input));
  ipcMain.handle("model:test", (_event, input?: Partial<ModelConfigUpdate>) => getRuntime().testModelConfig(input));
  ipcMain.handle("market-config:update", (_event, input: ToolMarketConfigUpdate) => getRuntime().updateToolMarketConfig(input));
  ipcMain.handle("personality:update", (_event, input: PersonalityConfig) => getRuntime().updatePersonality(input));
  ipcMain.handle("subagent:save", (_event, input: SubagentConfig) => getRuntime().saveSubagent(input));
  ipcMain.handle("subagent:delete", (_event, id: string) => getRuntime().deleteSubagent(id));
  ipcMain.handle("market:list", (_event, query?: ToolMarketQuery) => getRuntime().listToolMarket(query));
  ipcMain.handle("market:install", (_event, id: string) => getRuntime().installToolMarketProduct(id));
  ipcMain.handle("market:uninstall", (_event, id: string) => getRuntime().uninstallToolMarketProduct(id));
  ipcMain.handle("mcp:listServers", () => getRuntime().listMcpServers());
  ipcMain.handle("mcp:addServer", (_event, input: McpServerInput) => getRuntime().addMcpServer(input));
  ipcMain.handle("mcp:updateServer", (_event, id: string, input: McpServerUpdate) => getRuntime().updateMcpServer(id, input));
  ipcMain.handle("mcp:removeServer", (_event, id: string) => getRuntime().removeMcpServer(id));
  ipcMain.handle("mcp:connect", (_event, id: string) => getRuntime().connectMcpServer(id));
  ipcMain.handle("mcp:disconnect", (_event, id: string) => getRuntime().disconnectMcpServer(id));
  ipcMain.handle("mcp:refreshTools", (_event, id: string) => getRuntime().refreshMcpTools(id));
  ipcMain.handle("mcp:getLogs", (_event, id: string) => getRuntime().getMcpLogs(id));
  ipcMain.handle("mcp:listPresets", () => getRuntime().listMcpPresets());
  ipcMain.handle("mcp:export", () => getRuntime().exportMcpConfig());
  ipcMain.handle("mcp:import", (_event, input: McpConfigTransfer) => getRuntime().importMcpConfig(input));
  ipcMain.handle("mcp:diagnoseServer", (_event, input: McpServerInput) => getRuntime().diagnoseMcpServer(input));
  ipcMain.handle("schedule:create", (_event, input: ScheduledJobInput) => getRuntime().createScheduledJob(input));
  ipcMain.handle("schedule:update", (_event, id: string, input: Partial<ScheduledJobInput>) => getRuntime().updateScheduledJob(id, input));
  ipcMain.handle("schedule:delete", (_event, id: string) => getRuntime().deleteScheduledJob(id));
  ipcMain.handle("attachment:pick", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openFile", "multiSelections"]
    });
    if (result.canceled) {
      return [];
    }
    return Promise.all(result.filePaths.map((filePath) => getRuntime().importAttachment(filePath)));
  });
  ipcMain.handle("file:open", async (_event, filePath: string) => {
    await shell.openPath(filePath);
  });
  ipcMain.handle("path:userData", () => process.env.SUPBOT_USER_DATA_DIR || app.getPath("userData"));
}

app.whenReady().then(async () => {
  registerIpc();
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
}).catch((error) => {
  dialog.showErrorBox("Supbot failed to start", error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  void runtime?.shutdown();
});
