/**
 * HTTP client for the VIDA AI MCP relay API.
 * All communication is authenticated via API key (x-mcp-api-key header).
 */

const DEFAULT_RELAY_URL = "https://api.vidaai.co";

interface RelayMessage {
  id: string;
  senderPhone: string;
  direction: "inbound" | "outbound";
  encryptedBlob: string;
  mediaEncryptedBlob: string | null;
  mediaType: string | null;
  audioTranscriptionBlob: string | null;
  waMessageId: string | null;
  createdAt: string;
}

interface PullResponse {
  count: number;
  messages: RelayMessage[];
}

interface SendResult {
  success: boolean;
  waMessageId?: string;
  error?: string;
}

export class RelayClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || DEFAULT_RELAY_URL).replace(/\/$/, "");
  }

  private async request(method: string, path: string, body?: any): Promise<any> {
    const url = `${this.baseUrl}/api/mcp${path}`;
    const headers: Record<string, string> = {
      "x-mcp-api-key": this.apiKey,
      "Content-Type": "application/json",
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    let data: any;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Relay unreachable or returned invalid response (HTTP ${res.status})`);
    }

    if (!res.ok) {
      throw new Error(data.error || `Relay API error: ${res.status}`);
    }

    return data;
  }

  /**
   * Register public key and activate webhooks.
   */
  async registerKey(publicKey: string): Promise<void> {
    await this.request("POST", "/auth/register-key", { publicKey });
  }

  /**
   * Connect WhatsApp (called from CLI setup with Embedded Signup data).
   */
  async connectWhatsApp(data: {
    code: string;
    wabaId: string;
    phoneNumberId: string;
    isCoexistence?: boolean;
  }): Promise<any> {
    return this.request("POST", "/whatsapp/connect", data);
  }

  /**
   * Get WhatsApp connection status.
   */
  async getWhatsAppStatus(): Promise<{
    connected: boolean;
    displayPhone?: string;
    isCoexistence?: boolean;
    isWebhookActive?: boolean;
  }> {
    return this.request("GET", "/whatsapp/status");
  }

  /**
   * Pull encrypted messages since a timestamp.
   */
  async pullMessages(since?: string, limit?: number): Promise<PullResponse> {
    const params = new URLSearchParams();
    if (since) params.set("since", since);
    if (limit) params.set("limit", String(limit));
    const qs = params.toString();
    return this.request("GET", `/relay/pull${qs ? `?${qs}` : ""}`);
  }

  /**
   * Acknowledge synced messages (so relay can clean them up).
   */
  async ackMessages(messageIds: string[]): Promise<{ ackedCount: number }> {
    return this.request("POST", "/relay/ack", { messageIds });
  }

  /**
   * Send a WhatsApp message via the relay.
   */
  async sendMessage(to: string, text: string, mediaUrl?: string, mediaType?: string): Promise<SendResult> {
    return this.request("POST", "/relay/send", { to, text, mediaUrl, mediaType });
  }
}
