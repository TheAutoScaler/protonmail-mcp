# ProtonMail MCP Server

An MCP (Model Context Protocol) server that connects to ProtonMail via Bridge, enabling AI assistants like Claude to manage your email.

> [!WARNING]
> **This is an unmaintained fork.** It is not affiliated with Proton AG and there
> is no commitment to provide updates, security patches, compatibility fixes, or
> support. Review the code and dependency advisories before each deployment. If
> you use it, keep it bound to loopback and do not expose it directly to a network.

## Quick start with Codex

1. Install and open [Proton Mail Bridge](https://proton.me/mail/bridge), sign in,
   and wait until it says **Connected**.
2. Select your account in Bridge and copy the username and password shown under
   **Mailbox details**. These are **Bridge-generated IMAP/SMTP credentials**.
   The password is **not your Proton Mail account password**.
3. Install and configure the server:

   ```bash
   npm install
   npm run build
   cp config/protonmail.config.example.json config/protonmail.config.json
   openssl rand -hex 32
   ```

4. In `config/protonmail.config.json`, set:
   - `protonmail.auth.user` to the username from Bridge.
   - `protonmail.auth.pass` to the password from Bridge.
   - `server.authToken` to the generated 64-character token.
5. Protect the file and start the server:

   ```bash
   chmod 600 config/protonmail.config.json
   npm start
   ```

6. In another terminal, load the same token, make it available to the Codex
   desktop app, and register the server:

   ```bash
   cd /path/to/protonmail-mcp
   export PROTONMAIL_MCP_TOKEN="$(node -p 'require("./config/protonmail.config.json").server.authToken')"
   launchctl setenv PROTONMAIL_MCP_TOKEN "$PROTONMAIL_MCP_TOKEN"
   test -n "$(launchctl getenv PROTONMAIL_MCP_TOKEN)" && echo "token set" || echo "token missing"
   codex mcp add protonmail \
     --url http://127.0.0.1:3000/mcp \
     --bearer-token-env-var PROTONMAIL_MCP_TOKEN
   codex mcp list --json
   ```

Replace `/path/to/protonmail-mcp` with the repository path. The check must print
`token set`; it does not display the token. `launchctl setenv` is required because
a macOS desktop app does not inherit an `export` from an unrelated terminal.
Fully quit and reopen Codex after running it, then use `/mcp` to confirm that
`protonmail` is connected. Keep Proton Mail
Bridge and `npm start` running while using the tools. If basic commands such as
`codex` or `basename` are missing, restore the standard macOS path first:

```bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin"
hash -r
```

`config/protonmail.config.json` contains secrets. It is excluded from Git and
Docker builds; do not share or commit it. The server listens only on
`127.0.0.1:3000` and requires the bearer token.

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

## Transport

The server uses MCP Streamable HTTP at `http://127.0.0.1:3000/mcp`. Browser
origins are denied unless explicitly allowed in `server.allowedOrigins`.

### Legacy stdio

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
