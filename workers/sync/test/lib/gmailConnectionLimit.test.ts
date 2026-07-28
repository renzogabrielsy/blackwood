/**
 * gmailConnectionLimit.test.ts — BUG-019 Fixes 2, 3 and 4 inside `lib/gmail.ts`.
 *
 * `imapflow` is MOCKED at the module level, so this never resolves a hostname, never
 * opens a socket and never touches the real mailbox (hard constraint: Gmail is at its
 * connection ceiling and every attempt prolongs the outage). `fetch` is stubbed too, so
 * the OAuth token endpoint is never called for real — which is exactly what lets us
 * COUNT token mints and prove the connection-limit case does not re-mint.
 *
 * WHAT IT PROVES
 *   Fix 2 — a "Too many simultaneous connections" refusal is NOT classified as an auth
 *           failure (even though imapflow stamps `authenticationFailed: true` on it), so
 *           connect() does not force-refresh the token and does not immediately open a
 *           second socket. A GENUINE auth failure still gets its one re-mint retry.
 *   Fix 2b— the connection-limit backoff retry is BOUNDED and strictly sequential: the
 *           previous socket is closed before the next attempt, so a retry can never add
 *           to the connection count.
 *   Fix 3 — close() releases the socket of a client whose connect() failed, and of one
 *           whose socket died; it is idempotent and never throws.
 *   Fix 4 — the thrown Error carries responseText / serverResponseCode / responseStatus /
 *           executedCommand, and NEVER the access token, refresh token or app password.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Mock imapflow BEFORE importing lib/gmail.js. `vi.hoisted` is required: the
// vi.mock factory is hoisted above every top-level declaration, so the fake class has
// to be created in a hoisted block or it is "accessed before initialization".
const { FakeImapFlow, behaviour } = vi.hoisted(() => {
  interface FakeBehaviour {
    connect: () => unknown | Promise<unknown>;
  }
  class FakeImapFlowImpl {
    static instances: FakeImapFlowImpl[] = [];
    usable = false;
    closed = 0;
    loggedOut = 0;
    readonly options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeImapFlowImpl.instances.push(this);
    }
    async connect(): Promise<void> {
      const outcome = await behaviourRef.next.connect();
      if (outcome) throw outcome;
      this.usable = true;
    }
    async logout(): Promise<void> {
      this.loggedOut += 1;
      this.usable = false;
    }
    close(): void {
      this.closed += 1;
      this.usable = false;
    }
  }
  const behaviourRef: { next: FakeBehaviour } = { next: { connect: async () => undefined } };
  return { FakeImapFlow: FakeImapFlowImpl, behaviour: behaviourRef };
});

vi.mock("imapflow", () => ({ ImapFlow: FakeImapFlow }));

import {
  GmailClient,
  GmailOperationError,
  isAuthFailure,
  isConnectionLimitFailure,
  isGmailConnectionLimit,
  describeImapError,
  redactImapCommand,
  _resetAccessTokenCacheForTest,
  type GmailAuth,
} from "../../src/lib/gmail.js";

const ACCESS_TOKEN = "ya29.SUPER-SECRET-ACCESS-TOKEN";
const REFRESH_TOKEN = "1//SUPER-SECRET-REFRESH-TOKEN";
const CLIENT_SECRET = "GOCSPX-SUPER-SECRET";
const APP_PASSWORD = "abcdefghijklmnop";

const OAUTH: Extract<GmailAuth, { kind: "oauth" }> = {
  kind: "oauth",
  user: "sync@example.com",
  clientId: "cid.apps.googleusercontent.com",
  clientSecret: CLIENT_SECRET,
  refreshToken: REFRESH_TOKEN,
};

/**
 * The REAL error object Renzo extracted from the outage — imapflow's opaque
 * `Error: Command failed` with the informative fields hanging off it, including the
 * `authenticationFailed: true` that caused the day-long misdiagnosis.
 */
function connectionLimitError(): Error {
  return Object.assign(new Error("Command failed"), {
    response: "3 NO [ALERT] Too many simultaneous connections. (Failure)",
    responseText: "Too many simultaneous connections. (Failure)",
    responseStatus: "NO",
    serverResponseCode: "ALERT",
    executedCommand: `3 AUTHENTICATE "XOAUTH2" "${Buffer.from(`user=xauth=Bearer ${ACCESS_TOKEN}`).toString("base64")}"`,
    authenticationFailed: true,
  });
}

/** A GENUINE token rejection: the XOAUTH2 SASL exchange returned Google's error JSON. */
function genuineAuthError(): Error {
  return Object.assign(new Error("Command failed"), {
    response: "3 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)",
    responseText: "Invalid credentials (Failure)",
    responseStatus: "NO",
    serverResponseCode: "AUTHENTICATIONFAILED",
    authenticationFailed: true,
    oauthError: { status: "401", schemes: "Bearer", scope: "https://mail.google.com/" },
  });
}

let mints = 0;
beforeEach(() => {
  FakeImapFlow.instances = [];
  behaviour.next = { connect: async () => undefined };
  mints = 0;
  _resetAccessTokenCacheForTest();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      mints += 1;
      return new Response(JSON.stringify({ access_token: `${ACCESS_TOKEN}-${mints}`, expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  _resetAccessTokenCacheForTest();
});

// ===========================================================================
// Fix 2 — classification
// ===========================================================================
describe("classification: connection limit is NOT an auth failure (Fix 2)", () => {
  it("recognises Gmail's refusal text", () => {
    expect(isConnectionLimitFailure(connectionLimitError())).toBe(true);
    expect(isConnectionLimitFailure(new Error("Too many connections"))).toBe(true);
    expect(isConnectionLimitFailure(new Error("ECONNRESET"))).toBe(false);
    expect(isConnectionLimitFailure(genuineAuthError())).toBe(false);
  });

  it("refuses to call it an auth failure DESPITE authenticationFailed:true", () => {
    const err = connectionLimitError();
    expect(err).toHaveProperty("authenticationFailed", true); // imapflow really does this
    expect(isAuthFailure(err)).toBe(false); // ...and we no longer believe it
  });

  it("still detects a genuine auth failure — oauthError is the reliable discriminator", () => {
    expect(isAuthFailure(genuineAuthError())).toBe(true);
    // oauthError alone is enough, with no text and no boolean at all.
    expect(isAuthFailure({ oauthError: { status: "401" } })).toBe(true);
    // The weak boolean still works as a last resort for non-connection-limit errors.
    expect(isAuthFailure({ authenticationFailed: true })).toBe(true);
    expect(isAuthFailure(new Error("Invalid credentials (Failure)"))).toBe(true);
    expect(isAuthFailure(new Error("Command failed"))).toBe(false);
  });
});

// ===========================================================================
// Fix 2 — connect() behaviour
// ===========================================================================
describe("connect() on a connection-limit refusal (Fix 2)", () => {
  it("does NOT re-mint the token and does NOT open a second socket", async () => {
    behaviour.next = { connect: async () => connectionLimitError() };
    const client = new GmailClient(OAUTH);

    await expect(
      // Backoff disabled: isolate "no token refresh, no extra socket" from the retry.
      client.connect({ connectionLimitBackoffMs: [] }),
    ).rejects.toBeInstanceOf(GmailOperationError);

    // ONE token mint (the initial one). The old code force-refreshed here — and then
    // opened a SECOND connection, doubling connection burn on a too-many-connections error.
    expect(mints).toBe(1);
    expect(FakeImapFlow.instances).toHaveLength(1);
    // ...and that one socket was released, not leaked.
    expect(FakeImapFlow.instances[0].closed).toBeGreaterThanOrEqual(1);
  });

  it("DOES re-mint exactly once for a genuine auth failure", async () => {
    behaviour.next = { connect: async () => genuineAuthError() };
    const client = new GmailClient(OAUTH);

    await expect(client.connect({ connectionLimitBackoffMs: [] })).rejects.toBeInstanceOf(
      GmailOperationError,
    );

    expect(mints).toBe(2); // initial + ONE forced refresh
    expect(FakeImapFlow.instances).toHaveLength(2); // one retry, no loop
  });

  it("retries the connection limit a BOUNDED number of times, one socket at a time", async () => {
    behaviour.next = { connect: async () => connectionLimitError() };
    const slept: number[] = [];
    const client = new GmailClient(OAUTH);

    await expect(
      client.connect({
        connectionLimitBackoffMs: [10, 20],
        sleep: async (ms) => {
          slept.push(ms);
          // INVARIANT: at the moment we back off, every socket built so far is closed.
          // A retry can therefore never ADD to the simultaneous-connection count.
          expect(FakeImapFlow.instances.every((i) => i.closed >= 1)).toBe(true);
        },
      }),
    ).rejects.toThrow(/Gmail connection limit hit/);

    expect(slept).toEqual([10, 20]); // bounded: 2 retries, then give up
    expect(FakeImapFlow.instances).toHaveLength(3); // 1 initial + 2 retries, never more
    expect(mints).toBe(1); // still no token re-mint
  });

  it("does not back off for a non-connection-limit failure", async () => {
    behaviour.next = { connect: async () => new Error("ECONNRESET") };
    const slept: number[] = [];
    const client = new GmailClient({ kind: "appPassword", user: "u@x.com", appPassword: APP_PASSWORD });

    await expect(
      client.connect({ connectionLimitBackoffMs: [10, 20], sleep: async (ms) => void slept.push(ms) }),
    ).rejects.toBeInstanceOf(GmailOperationError);

    expect(slept).toEqual([]);
    expect(FakeImapFlow.instances).toHaveLength(1);
  });
});

// ===========================================================================
// Fix 3 — close() always releases the socket
// ===========================================================================
describe("close() always releases the socket (Fix 3)", () => {
  it("releases the socket of a client whose connect() failed part-way", async () => {
    behaviour.next = { connect: async () => new Error("ECONNRESET") };
    const client = new GmailClient(OAUTH);
    await expect(client.connect({ connectionLimitBackoffMs: [] })).rejects.toThrow();

    const built = FakeImapFlow.instances[0];
    expect(built.closed).toBeGreaterThanOrEqual(1); // socket released, not leaked
    // The old close() early-returned on `!connected` — a never-connected client kept its
    // file descriptor forever. Calling close() now is a safe no-op, and must not throw.
    await expect(client.close()).resolves.toBeUndefined();
    expect(client.usable).toBe(false);
  });

  it("hard-closes a client whose socket died instead of attempting a doomed logout", async () => {
    const client = new GmailClient(OAUTH);
    await client.connect();
    const sock = FakeImapFlow.instances[0];
    expect(client.usable).toBe(true);

    sock.usable = false; // imapflow dropped it (idle socketTimeout / server BYE)
    await client.close();

    expect(sock.loggedOut).toBe(0); // no LOGOUT on a dead socket
    expect(sock.closed).toBe(1); // but the descriptor IS released
  });

  it("logs out cleanly on a live session and is idempotent", async () => {
    const client = new GmailClient(OAUTH);
    await client.connect();
    const sock = FakeImapFlow.instances[0];

    await client.close();
    expect(sock.loggedOut).toBe(1);
    expect(sock.closed).toBe(1); // close() runs after logout too — belt and braces

    await expect(client.close()).resolves.toBeUndefined(); // second call: no-op
    expect(sock.loggedOut).toBe(1);
    expect(sock.closed).toBe(1);
  });

  it("close() never throws even when the underlying client does", async () => {
    const client = new GmailClient(OAUTH);
    await client.connect();
    const sock = FakeImapFlow.instances[0];
    sock.logout = async () => {
      throw new Error("socket already gone");
    };
    sock.close = () => {
      throw new Error("double free");
    };
    await expect(client.close()).resolves.toBeUndefined();
  });
});

// ===========================================================================
// Fix 4 — observability without leaking credentials
// ===========================================================================
describe("error surfacing (Fix 4)", () => {
  it("puts the SERVER's diagnosis in the message instead of 'Command failed'", async () => {
    behaviour.next = { connect: async () => connectionLimitError() };
    const client = new GmailClient(OAUTH);
    const err = await client.connect({ connectionLimitBackoffMs: [] }).catch((e) => e);

    expect(err).toBeInstanceOf(GmailOperationError);
    expect(isGmailConnectionLimit(err)).toBe(true);
    expect(err.message).not.toBe("Command failed");
    // Operator-readable headline...
    expect(err.message).toMatch(/Gmail connection limit hit/);
    expect(err.message).toMatch(/Wait a few minutes and run the sync again/);
    // ...plus the diagnosable fields that were missing for a full day.
    expect(err.message).toContain("Too many simultaneous connections");
    expect(err.message).toContain("ALERT");
    expect(err.message).toContain("NO");
    expect(err.detail.responseText).toBe("Too many simultaneous connections. (Failure)");
    expect(err.detail.serverResponseCode).toBe("ALERT");
    expect(err.detail.responseStatus).toBe("NO");
    expect(err.detail.authenticationFailed).toBe(true);
  });

  it("NEVER leaks the access token, refresh token, client secret or app password", async () => {
    behaviour.next = { connect: async () => connectionLimitError() };
    const client = new GmailClient(OAUTH);
    const err = await client.connect({ connectionLimitBackoffMs: [] }).catch((e) => e);

    const dump = `${err.message} ${JSON.stringify(err.detail)}`;
    expect(dump).not.toContain(ACCESS_TOKEN);
    expect(dump).not.toContain(REFRESH_TOKEN);
    expect(dump).not.toContain(CLIENT_SECRET);
    expect(dump).not.toContain(APP_PASSWORD);
    // The XOAUTH2 base64 payload is dropped outright, not merely masked by imapflow.
    expect(err.detail.executedCommand).toBe("3 AUTHENTICATE <redacted>");
  });

  it("redactImapCommand strips AUTHENTICATE/LOGIN arguments and caps length", () => {
    expect(redactImapCommand('3 AUTHENTICATE "XOAUTH2" "dXNlcj14"')).toBe("3 AUTHENTICATE <redacted>");
    expect(redactImapCommand('7 LOGIN "u@x.com" "hunter2"')).toBe("7 LOGIN <redacted>");
    // A harmless command is preserved verbatim — that is the diagnostic value.
    expect(redactImapCommand('9 SELECT "[Gmail]/All Mail"')).toBe('9 SELECT "[Gmail]/All Mail"');
    expect(redactImapCommand(undefined)).toBeNull();
    expect(redactImapCommand(`5 SEARCH ${"x".repeat(500)}`)!.length).toBeLessThanOrEqual(301);
  });

  it("describeImapError tolerates a plain Error with none of the fields", () => {
    expect(describeImapError(new Error("boom"))).toEqual({
      responseText: null,
      serverResponseCode: null,
      responseStatus: null,
      executedCommand: null,
      authenticationFailed: null,
      hasOauthError: false,
    });
  });
});
