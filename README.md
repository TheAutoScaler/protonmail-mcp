# ProtonMail MCP Server

An MCP (Model Context Protocol) server that connects to ProtonMail via Bridge, enabling AI assistants like Claude to manage your email.

> [!WARNING]
> **This is an unmaintained fork.** It is not affiliated with Proton AG and there
> is no commitment to provide updates, security patches, compatibility fixes, or
> support. Review the code and dependency advisories before each deployment. If
> you use it, keep it bound to loopback and do not expose it directly to a network.

## Security audit and hardening

This fork received a source-level security audit on **19 August 2026**, covering
the HTTP/MCP boundary, authentication and authorization, credential handling,
IMAP/SMTP inputs, TLS configuration, resource-exhaustion risks, Docker packaging,
and production dependencies. The review applied to commit
`dc638cc367323f81d50c07e53db4e4beabf56f33` of the upstream repository; the
hardening changes described below were then implemented in this fork.

The audit identified and fixed the following issues:

- Unauthenticated `/mcp` and `/emails` endpoints were replaced with mandatory,
  constant-time-checked bearer-token authentication.
- The HTTP server now binds only to loopback and validates `Host` and `Origin`
  headers to reduce network exposure and DNS-rebinding risk.
- Per-client request limits and a global concurrency limit were added.
- IMAP UIDs must now be positive decimal integers. Sequence expressions such as
  `1:*` are rejected before they reach IMAP operations.
- Tool inputs, recipient lists, request bodies, parsed messages, and attachments
  are bounded to reduce memory and CPU denial-of-service risk.
- TLS certificate verification is enabled by default and may be disabled only
  for a loopback Proton Mail Bridge endpoint.
- Docker builds no longer copy the credential-bearing configuration file into
  image layers, and the runtime process uses the unprivileged `node` user.
- Known vulnerable direct and transitive dependencies were updated or overridden;
  the resulting production lockfile reported zero advisories at audit time.
- Regression tests were added for secure configuration and UID handling.
- Internal HTTP failures no longer return underlying exception details to clients.

After hardening, a clean install, TypeScript build, security regression suite,
Mailparser compatibility smoke test, diff validation, and production dependency
audit all passed. This is a point-in-time review, not a guarantee that the software
is vulnerability-free. New vulnerabilities may be discovered after the date above,
especially because this fork is unmaintained.

## Features

- **Email Management**: Read, search, send, reply, forward, and delete emails
- **Folder Management**: List, create, rename, and delete folders
- **Label Management**: Apply and remove labels from emails
- **Trend Analysis**: Analyze email patterns, identify important emails, track sender statistics

## Requirements

- Node.js >= 18
- [ProtonMail Bridge](https://proton.me/mail/bridge) installed and running
- ProtonMail account (Plus, Unlimited, or Business)

## Installation

```bash
git clone https://github.com/robotben/protonmail-mcp.git
cd protonmail-mcp
npm install
npm run build
```

## Configuration

1. Copy the example config:
   ```bash
   cp config/protonmail.config.example.json config/protonmail.config.json
   ```

2. Generate an MCP bearer token and edit `config/protonmail.config.json`:
   ```bash
   openssl rand -hex 32
   ```

   Add the generated value together with your Bridge credentials:
   ```json
   {
     "protonmail": {
       "auth": {
         "user": "your-email@protonmail.com",
         "pass": "your-bridge-password"
       }
     },
     "server": {
       "authToken": "paste-the-generated-token-here"
     }
   }
   ```

   > **Note**: Use the Bridge password from ProtonMail Bridge app (not your account password).

## Running the Server

```bash
npm start
```

The server listens only on `127.0.0.1:3000` by default. Change `server.httpPort`
in the configuration file to use another port. The server deliberately rejects
non-loopback bind addresses; put an authenticated TLS reverse proxy in front of
it if remote access is required.

```bash
MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
PROTONMAIL_USER="you@example.com" \
PROTONMAIL_PASS="your-bridge-password" \
PROTONMAIL_TLS_REJECT_UNAUTHORIZED=false \
npm start
```

MCP endpoint: `http://localhost:3000/mcp`

## Usage with Claude Desktop

The server uses the **MCP Streamable HTTP transport** (spec 2025-03-26), so configure Claude Desktop with a URL instead of a command:

```json
{
  "mcpServers": {
    "protonmail": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer paste-the-same-generated-token-here"
      }
    }
  }
}
```

> **Note**: Start the server before launching Claude Desktop (`npm start`).

Every `/mcp` and `/emails` request requires the bearer token. Browser-originated
requests are rejected unless their exact origin is listed in
`server.allowedOrigins`, which is empty by default. Keep the configuration file
private; it contains both the Bridge password and MCP token.

### Legacy stdio (not supported)

This server no longer supports stdio transport. If you need stdio, use an earlier version.

## Available Tools (22)

### Email Reading
| Tool | Description |
|------|-------------|
| `list_emails` | List emails from a folder with pagination |
| `get_email` | Get full email content by UID |
| `get_email_headers` | Get email headers only (lightweight) |
| `search_emails` | Search emails with query, date range, filters |
| `get_unread_count` | Get unread count for folders |
| `mark_as_read` | Mark emails as read |
| `mark_as_unread` | Mark emails as unread |

### Email Sending
| Tool | Description |
|------|-------------|
| `send_email` | Send a new email |
| `reply_to_email` | Reply to an email |
| `forward_email` | Forward an email |

### Folder Management
| Tool | Description |
|------|-------------|
| `list_folders` | List all folders |
| `create_folder` | Create a new folder |
| `delete_folder` | Delete a folder |
| `rename_folder` | Rename a folder |
| `move_emails` | Move emails between folders |

### Label Management
| Tool | Description |
|------|-------------|
| `list_labels` | List all labels |
| `create_label` | Create a new label |
| `apply_labels` | Apply labels to emails |
| `remove_labels` | Remove labels from emails |

### Analytics
| Tool | Description |
|------|-------------|
| `analyze_email_trends` | Analyze email patterns over time |
| `analyze_label_distribution` | Analyze email distribution across folders |
| `identify_important_emails` | Find important emails based on criteria |

### Utility
| Tool | Description |
|------|-------------|
| `delete_emails` | Permanently delete emails |

## Resources

| URI | Description |
|-----|-------------|
| `protonmail://inbox/summary` | Inbox statistics |
| `protonmail://folders` | Folder list with counts |
| `protonmail://labels` | Label summary |
| `protonmail://recent` | Recent 24h activity |
| `protonmail://stats` | Email analytics |

## Development

```bash
# Build
npm run build

# Build and run security/regression tests
npm test

# Watch mode
npm run dev

# Run directly with tsx
npx tsx src/server.ts
```

## License

MIT
