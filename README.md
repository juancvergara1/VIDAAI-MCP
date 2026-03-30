# WhatsApp MCP Server

Connect WhatsApp Business to Claude Code and Claude Desktop. Read, search, and send WhatsApp messages directly from Claude with end-to-end encryption.

## How It Works

```
Your WhatsApp → VIDA AI Relay (encrypted) → MCP Server (local) → Your Neon DB
                  ↑                              ↓
           Only sees blobs              Decrypts with your
           Never plaintext              private key (local only)
```

Your messages are encrypted before they hit our servers. We store only encrypted blobs. Only your local MCP server can decrypt them using a private key that never leaves your machine.

## Features

- **9 tools** for Claude: list conversations, read messages, search, send, unread summary, action items
- **E2E encrypted**: Messages encrypted with sealed boxes (X25519 + XSalsa20-Poly1305)
- **Your data, your DB**: Messages stored in your own Neon database
- **Media support**: Images, audio (with Whisper transcription), PDFs
- **Coexistence mode**: Works with WhatsApp Business app alongside the API
- **Action items**: Create follow-up tasks from messages

## Quick Start

### 1. Create your MCP account

Go to [vidaai.co/mcp](https://vidaai.co/mcp), log in, and connect your WhatsApp Business number. Save your API key.

### 2. Run setup

```bash
npx @vidaai/whatsapp-mcp setup
```

The setup wizard will:
- Validate your API key
- Connect to your Neon database (create one free at [neon.tech](https://neon.tech))
- Generate your encryption keypair
- Activate WhatsApp webhooks

### 3. Add to Claude

Add this to `~/.claude/.mcp.json` (Claude Code) or `claude_desktop_config.json` (Claude Desktop):

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "npx",
      "args": ["-y", "@vidaai/whatsapp-mcp"],
      "env": {
        "VIDA_API_KEY": "sk_your_key_here",
        "NEON_DATABASE_URL": "postgresql://user:pass@ep-xxx.neon.tech/dbname",
        "VIDA_KEY_PATH": "~/.vida/private.key"
      }
    }
  }
}
```

### 4. Use it

```
You: "show me my WhatsApp messages from today"
You: "what did Maria send me?"
You: "reply to Juan: confirmed for tomorrow at 3"
You: "create an action item to follow up with Carlos about the contract"
You: "show me my pending action items"
```

## Tools

| Tool | Description |
|------|-------------|
| `whatsapp_sync` | Pull new messages from relay |
| `whatsapp_list_conversations` | List recent conversations with unread counts |
| `whatsapp_read_messages` | Read messages by contact name or conversation |
| `whatsapp_search` | Search messages by keyword, contact, date range |
| `whatsapp_send_message` | Send a message to a contact |
| `whatsapp_unread_summary` | Summary of all unread messages |
| `whatsapp_create_action_item` | Create a follow-up task |
| `whatsapp_list_action_items` | List tasks (pending/done) |
| `whatsapp_complete_action_item` | Mark a task as done |

## Privacy & Security

- **Private key** stays on your machine (`~/.vida/private.key`). Never sent anywhere.
- **Messages** are encrypted with [sealed boxes](https://doc.libsodium.org/public-key_cryptography/sealed_boxes) before leaving WhatsApp's servers. Our relay stores only encrypted blobs.
- **Your database** is your own Neon instance. We don't have the connection string.
- **API key** is SHA-256 hashed on our server. The plaintext is shown once during registration.
- **Audio transcription** happens on our relay (Whisper) and is encrypted before storage. The audio is not persisted.

### What we can see

| Data | Our relay | Your MCP (local) |
|------|-----------|-------------------|
| Message content | No (encrypted blob) | Yes |
| Sender phone | Yes (for routing) | Yes |
| Timestamp | Yes | Yes |
| Private key | Never | Yes |
| Your Neon URL | Never | Yes |

### What about outbound messages?

When you send a message through Claude, the plaintext briefly passes through our relay (WhatsApp requires it). It is **not logged or stored** in plaintext — after sending, we encrypt a copy for your sync history.

## Coexistence Mode

If your WhatsApp number uses coexistence (both the app and API), be aware:

- **Incoming messages**: All visible (100%)
- **Messages you send from your phone**: Not visible to the MCP
- **Messages you send through Claude**: Visible

For full coverage, migrate your number fully to the WhatsApp Business API.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VIDA_API_KEY` | Yes | API key from vidaai.co/mcp |
| `NEON_DATABASE_URL` | Yes | Your Neon PostgreSQL connection string |
| `VIDA_KEY_PATH` | No | Path to private key (default: `~/.vida/private.key`) |

## Development

```bash
git clone https://github.com/juancvergara1/whatsapp-mcp.git
cd whatsapp-mcp
npm install
npm run build
npm run check    # type check without build
```

## License

MIT

## Built by

[VIDA AI](https://vidaai.co) — AI-powered WhatsApp automation for businesses.
