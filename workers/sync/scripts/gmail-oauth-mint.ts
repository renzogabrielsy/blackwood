/**
 * gmail-oauth-mint.ts — ONE-TIME, LOCAL mint of the Gmail OAuth2 refresh token the
 * sync worker uses for XOAUTH2 IMAP (see src/lib/gmail.ts).
 *
 * Run this on your own Mac, once. It opens the Google consent flow in a browser,
 * catches the redirect on a loopback server, exchanges the code, and PRINTS the
 * refresh token. YOU then put that token into Fly secrets + your local creds file —
 * the token never leaves this terminal otherwise.
 *
 *   npm run gmail:mint            # reads GMAIL_OAUTH_CLIENT_ID / _SECRET from env
 *   npm run gmail:mint -- --client-id=… --client-secret=… --port=8765
 *
 * Prerequisites in Google Cloud Console (see the printed follow-up steps):
 *   • a project with the Gmail API enabled,
 *   • an OAuth consent screen with your sync Gmail account as a Test user
 *     (or the app published),
 *   • an OAuth 2.0 Client ID of type **Desktop app** — Google killed the OOB
 *     ("urn:ietf:wg:oauth:2.0:oob") flow, so a loopback redirect is required and
 *     Desktop clients are the type allowed to use arbitrary 127.0.0.1 ports.
 *
 * Scope: https://mail.google.com/ — the BROAD IMAP scope. Anything narrower cannot
 * do IMAP STORE, which would break the Blackwood-Processed label write.
 *
 * Zero new dependencies: node:http + global fetch only.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SCOPE = "https://mail.google.com/";
const DEFAULT_PORT = 8765;
const TIMEOUT_MS = 5 * 60 * 1000;

interface Args {
  clientId?: string;
  clientSecret?: string;
  port: number;
  open: boolean;
  /**
   * When set, the refresh token is written straight into this env file (mode 0600)
   * and NEVER printed. Lets the mint run in a session where stdout is visible to a
   * third party (e.g. an agent's tool output) without leaking the secret.
   */
  writeEnv?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { port: DEFAULT_PORT, open: true };
  for (const raw of argv) {
    const [key, ...rest] = raw.split("=");
    const val = rest.join("=");
    switch (key) {
      case "--client-id":
        out.clientId = val;
        break;
      case "--client-secret":
        out.clientSecret = val;
        break;
      case "--port":
        out.port = Number(val) || DEFAULT_PORT;
        break;
      case "--no-open":
        out.open = false;
        break;
      case "--write-env":
        out.writeEnv = val;
        break;
      default:
        break;
    }
  }
  out.clientId ??= process.env.GMAIL_OAUTH_CLIENT_ID;
  out.clientSecret ??= process.env.GMAIL_OAUTH_CLIENT_SECRET;
  return out;
}

function usage(): void {
  // eslint-disable-next-line no-console
  console.error(
    [
      "",
      "gmail-oauth-mint — mint the sync worker's Gmail OAuth refresh token (run once).",
      "",
      "USAGE",
      "  npm run gmail:mint -- --client-id=<ID> --client-secret=<SECRET> [--port=8765] [--no-open]",
      "",
      "  …or export the values first and run with no flags:",
      "  export GMAIL_OAUTH_CLIENT_ID=…",
      "  export GMAIL_OAUTH_CLIENT_SECRET=…",
      "  npm run gmail:mint",
      "",
      "BEFORE RUNNING, in https://console.cloud.google.com :",
      "  1. Create/pick a project, then APIs & Services → Library → enable 'Gmail API'.",
      "  2. APIs & Services → OAuth consent screen → External → add your sync Gmail",
      "     address as a Test user (or Publish the app).",
      "  3. APIs & Services → Credentials → Create credentials → OAuth client ID →",
      "     Application type = 'Desktop app'. Copy the Client ID + Client secret.",
      "",
    ].join("\n")
  );
}

function html(title: string, body: string): string {
  return (
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<body style="font-family:system-ui;padding:3rem;max-width:32rem">` +
    `<h2>${title}</h2><p>${body}</p></body>`
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.clientId || !args.clientSecret) {
    usage();
    // eslint-disable-next-line no-console
    console.error("ERROR: missing client id and/or client secret.\n");
    process.exit(1);
    return;
  }
  const clientId = args.clientId;
  const clientSecret = args.clientSecret;

  const redirectUri = `http://127.0.0.1:${args.port}`;
  const state = randomBytes(24).toString("hex");
  const consentUrl =
    `${AUTH_ENDPOINT}?` +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      // Forces Google to hand back a refresh_token even on a repeat consent.
      prompt: "consent",
      state,
    }).toString();

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }
      const gotState = url.searchParams.get("state");
      const gotCode = url.searchParams.get("code");
      const gotError = url.searchParams.get("error");

      if (gotError) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(html("Consent denied", `Google returned: <code>${gotError}</code>`));
        server.close();
        reject(new Error(`Google returned error=${gotError}`));
        return;
      }
      if (gotState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(html("State mismatch", "Refusing this callback. Re-run the mint."));
        server.close();
        reject(new Error("OAuth state mismatch — callback rejected"));
        return;
      }
      if (!gotCode) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(html("No code", "The callback carried no authorization code."));
        server.close();
        reject(new Error("No authorization code in callback"));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        html(
          "Authorized ✓",
          "You can close this tab — the refresh token was printed in your terminal."
        )
      );
      server.close();
      resolve(gotCode);
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`Timed out after ${TIMEOUT_MS / 60000} minutes with no callback`));
    }, TIMEOUT_MS);
    timer.unref?.();

    server.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    server.on("close", () => clearTimeout(timer));

    server.listen(args.port, "127.0.0.1", () => {
      // eslint-disable-next-line no-console
      console.log(
        [
          "",
          `Listening for the OAuth callback on ${redirectUri}`,
          "",
          "OPEN THIS URL and sign in as the sync Gmail account:",
          "",
          consentUrl,
          "",
          "(Waiting up to 5 minutes…)",
          "",
        ].join("\n")
      );
      if (args.open && process.platform === "darwin") {
        try {
          spawn("open", [consentUrl], { stdio: "ignore", detached: true }).unref();
        } catch {
          /* printing the URL is the contract; auto-open is a nicety */
        }
      }
    });
  });

  // ── Exchange the authorization code for tokens. ───────────────────────────
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }).toString(),
  });
  const raw = await res.text();
  let payload: {
    refresh_token?: string;
    access_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  } = {};
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    payload = {};
  }
  if (!res.ok) {
    const desc = payload.error_description ? ` — ${payload.error_description}` : "";
    throw new Error(
      `Token exchange failed (HTTP ${res.status}): ${payload.error ?? "unknown_error"}${desc}`
    );
  }
  if (!payload.refresh_token) {
    throw new Error(
      "Token exchange succeeded but returned NO refresh_token. Re-run with a fresh " +
        "consent (this script already sends prompt=consent), or revoke the app at " +
        "https://myaccount.google.com/permissions and try again."
    );
  }

  // --write-env: put the token straight in the env file, print NOTHING secret.
  if (args.writeEnv) {
    const target = args.writeEnv.startsWith("~")
      ? join(homedir(), args.writeEnv.slice(1))
      : resolve(args.writeEnv);
    await mkdir(dirname(target), { recursive: true });
    let existing = "";
    try {
      existing = await readFile(target, "utf8");
    } catch {
      existing = ""; // first write — file does not exist yet.
    }
    // Replace any prior value for these keys rather than appending a duplicate
    // (a later duplicate would win on `source`, but leaving both is confusing).
    const keys = [
      "GMAIL_OAUTH_CLIENT_ID",
      "GMAIL_OAUTH_CLIENT_SECRET",
      "GMAIL_OAUTH_REFRESH_TOKEN",
    ];
    const kept = existing
      .split("\n")
      .filter((line) => !keys.some((k) => line.trimStart().startsWith(`${k}=`)));
    while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
    const next =
      kept.join("\n") +
      (kept.length ? "\n" : "") +
      `GMAIL_OAUTH_CLIENT_ID=${clientId}\n` +
      `GMAIL_OAUTH_CLIENT_SECRET=${clientSecret}\n` +
      `GMAIL_OAUTH_REFRESH_TOKEN=${payload.refresh_token}\n`;
    await writeFile(target, next, { mode: 0o600 });
    await chmod(target, 0o600);
    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        `[gmail-oauth-mint] OK — wrote ${keys.length} vars to ${target} (mode 0600).`,
        `[gmail-oauth-mint] granted scope: ${payload.scope ?? "(not reported)"}`,
        "[gmail-oauth-mint] The refresh token was NOT printed.",
        "",
        "NEXT: verify with `npm run gmail:check`, then push to Fly WITHOUT retyping",
        "the values (reads the same file, sends only these three keys):",
        "",
        `  grep -E '^GMAIL_OAUTH_' ${target} | flyctl secrets import -a blackwood-sync`,
        "",
      ].join("\n")
    );
    process.exit(0);
  }

  // eslint-disable-next-line no-console
  console.log(
    [
      "",
      "════════════════════════════════════════════════════════════════",
      "  REFRESH TOKEN (copy it now — Google will not show it again)",
      "════════════════════════════════════════════════════════════════",
      "",
      payload.refresh_token,
      "",
      `granted scope: ${payload.scope ?? "(not reported)"}`,
      "",
      "NEXT STEPS — run these YOURSELF (nothing below has been executed):",
      "",
      "  1. Fly secrets for the worker (from workers/sync):",
      "",
      "     flyctl secrets set -a blackwood-sync \\",
      "       GMAIL_OAUTH_CLIENT_ID='<your client id>' \\",
      "       GMAIL_OAUTH_CLIENT_SECRET='<your client secret>' \\",
      "       GMAIL_OAUTH_REFRESH_TOKEN='<the token printed above>'",
      "",
      "  2. Local dev creds (~/.config/sync-ictc/credentials.env, mode 0600) —",
      "     append these three lines, keeping the existing GMAIL_USER line:",
      "",
      "       GMAIL_OAUTH_CLIENT_ID=<your client id>",
      "       GMAIL_OAUTH_CLIENT_SECRET=<your client secret>",
      "       GMAIL_OAUTH_REFRESH_TOKEN=<the token printed above>",
      "",
      "  3. Verify locally:  npm run gmail:check",
      "",
      "  4. Once the worker is confirmed green on OAuth, retire the old secret:",
      "       flyctl secrets unset -a blackwood-sync GMAIL_APP_PASSWORD",
      "",
    ].join("\n")
  );
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("\n[gmail-oauth-mint] ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});
