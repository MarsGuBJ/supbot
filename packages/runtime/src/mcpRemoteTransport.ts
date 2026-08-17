import type { McpServerConfig } from "@supbot/shared";

export interface McpRemoteTransportCallbacks {
  onMessage(jsonText: string): void;
  onError(message: string): void;
  onClosed(reason: string): void;
}

export interface McpRemoteTransport {
  /** Sent as the MCP-Protocol-Version header once the session is initialized. */
  protocolVersion?: string;
  open(): Promise<void>;
  send(payload: string, expectsResponse: boolean): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createRemoteTransport(
  config: Pick<McpServerConfig, "transport" | "url" | "headers" | "requestTimeoutMs" | "name">,
  callbacks: McpRemoteTransportCallbacks,
): McpRemoteTransport {
  if (!config.url) {
    throw new Error(`MCP server URL is required: ${config.name}`);
  }
  const options = {
    url: config.url,
    headers: config.headers || {},
    timeoutMs: config.requestTimeoutMs || DEFAULT_TIMEOUT_MS,
  };
  return config.transport === "sse"
    ? new LegacySseTransport(options, callbacks)
    : new StreamableHttpTransport(options, callbacks);
}

interface RemoteTransportOptions {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

// Streamable HTTP transport (MCP spec 2025-03-26+): every client message is a
// POST; the server answers with JSON or an SSE-framed body. Server-initiated
// requests over a GET listen stream are not supported.
class StreamableHttpTransport implements McpRemoteTransport {
  protocolVersion?: string;
  private sessionId?: string;

  constructor(
    private readonly options: RemoteTransportOptions,
    private readonly callbacks: McpRemoteTransportCallbacks,
  ) {}

  async open(): Promise<void> {
    // Streamable HTTP has no persistent connection; initialize performs the handshake.
  }

  async send(payload: string, expectsResponse: boolean): Promise<void> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.options.headers,
    };
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }
    if (this.protocolVersion) {
      headers["mcp-protocol-version"] = this.protocolVersion;
    }
    let response: Response;
    try {
      response = await fetch(this.options.url, {
        method: "POST",
        headers,
        body: payload,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw new Error(`MCP HTTP request failed: ${(error as Error).message}`, { cause: error });
    }
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) {
      this.sessionId = sessionId;
    }
    if (!expectsResponse) {
      if (!response.ok) {
        throw new Error(`MCP HTTP notification failed: HTTP ${response.status}`);
      }
      return;
    }
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `MCP HTTP request failed: HTTP ${response.status}${bodyText.trim() ? ` - ${bodyText.trim().slice(0, 300)}` : ""}`,
      );
    }
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const text = await response.text();
    if (contentType.includes("text/event-stream")) {
      for (const event of parseSseEvents(text)) {
        if (event.data.trim()) {
          this.callbacks.onMessage(event.data);
        }
      }
    } else if (text.trim()) {
      this.callbacks.onMessage(text);
    }
  }

  async close(): Promise<void> {
    // Session termination via HTTP DELETE is optional in the spec; sessions expire server-side.
  }
}

// Legacy SSE transport (MCP spec 2024-11-05): a long-lived GET stream emits an
// `endpoint` event with the POST URL; responses arrive on the stream as
// `message` events.
class LegacySseTransport implements McpRemoteTransport {
  protocolVersion?: string;
  private postUrl?: string;
  private readonly abortController = new AbortController();
  private closed = false;
  private endpointReady?: {
    resolve(url: string): void;
    reject(error: Error): void;
  };

  constructor(
    private readonly options: RemoteTransportOptions,
    private readonly callbacks: McpRemoteTransportCallbacks,
  ) {}

  async open(): Promise<void> {
    let response: Response;
    try {
      response = await fetch(this.options.url, {
        headers: { accept: "text/event-stream", ...this.options.headers },
        signal: this.abortController.signal,
      });
    } catch (error) {
      throw new Error(`MCP SSE connect failed: ${(error as Error).message}`, { cause: error });
    }
    if (!response.ok || !response.body) {
      throw new Error(`MCP SSE connect failed: HTTP ${response.status}`);
    }
    const endpointPromise = new Promise<string>((resolve, reject) => {
      this.endpointReady = { resolve, reject };
    });
    void this.readLoop(response.body);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.postUrl = await Promise.race([
        endpointPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("MCP SSE endpoint event timed out.")), this.options.timeoutMs);
        }),
      ]);
    } catch (error) {
      this.abortController.abort();
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async send(payload: string): Promise<void> {
    if (!this.postUrl) {
      throw new Error("MCP SSE endpoint is not ready.");
    }
    let response: Response;
    try {
      response = await fetch(this.postUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.options.headers },
        body: payload,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw new Error(`MCP SSE post failed: ${(error as Error).message}`, { cause: error });
    }
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `MCP SSE post failed: HTTP ${response.status}${bodyText.trim() ? ` - ${bodyText.trim().slice(0, 300)}` : ""}`,
      );
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.endpointReady?.reject(new Error("MCP SSE transport closed."));
    this.abortController.abort();
  }

  private async readLoop(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          this.handleEvent(rawEvent);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!this.closed) {
        this.endpointReady?.reject(error as Error);
        this.callbacks.onClosed(`MCP SSE stream failed: ${(error as Error).message}`);
      }
      return;
    }
    if (!this.closed) {
      this.endpointReady?.reject(new Error("MCP SSE stream ended before the endpoint event."));
      this.callbacks.onClosed("MCP SSE stream ended.");
    }
  }

  private handleEvent(rawEvent: string): void {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith(":")) {
        continue;
      }
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).replace(/^ /, ""));
      }
    }
    const data = dataLines.join("\n");
    if (event === "endpoint") {
      try {
        this.postUrl = new URL(data, this.options.url).toString();
        this.endpointReady?.resolve(this.postUrl);
        this.endpointReady = undefined;
      } catch {
        this.endpointReady?.reject(new Error(`MCP SSE endpoint is invalid: ${data}`));
        this.endpointReady = undefined;
      }
      return;
    }
    if (data.trim()) {
      this.callbacks.onMessage(data);
    }
  }
}

export function parseSseEvents(text: string): Array<{ event: string; data: string }> {
  const events: Array<{ event: string; data: string }> = [];
  for (const rawEvent of text.replace(/\r/g, "").split("\n\n")) {
    if (!rawEvent.trim()) {
      continue;
    }
    let event = "message";
    const dataLines: string[] = [];
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith(":")) {
        continue;
      }
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).replace(/^ /, ""));
      }
    }
    events.push({ event, data: dataLines.join("\n") });
  }
  return events;
}
