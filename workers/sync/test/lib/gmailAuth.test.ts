/**
 * gmailAuth.test.ts — the 2026-07-27 OAuth/XOAUTH2 auth swap in src/lib/gmail.ts.
 *
 * Covers exactly two things, both offline (global fetch is stubbed — this test NEVER
 * touches the network and never opens an IMAP socket):
 *   1. gmailCredsFromEnv() precedence: OAuth trio wins → App Password fallback →
 *      throw when neither set (and GMAIL_USER required in both branches).
 *   2. getGmailAccessToken() cache/expiry: mints once, reuses while valid, re-mints
 *      past the 5-minute safety margin, honours forceRefresh, and raises a
 *      secret-safe error on a non-2xx from Google.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  gmailCredsFromEnv,
  getGmailAccessToken,
  isAuthFailure,
  _resetAccessTokenCacheForTest,
  GMAIL_OAUTH_SCOPE,
  type GmailAuth,
} from "../../src/lib/gmail.js";

const OAUTH_ENV = {
  GMAIL_USER: "sync@example.com",
  GMAIL_OAUTH_CLIENT_ID: "cid.apps.googleusercontent.com",
  GMAIL_OAUTH_CLIENT_SECRET: "csecret",
  GMAIL_OAUTH_REFRESH_TOKEN: "rtoken",
} as unknown as NodeJS.ProcessEnv;

describe("gmailCredsFromEnv precedence (OAuth → App Password → throw)", () => {
  it("resolves OAuth when the full trio is present", () => {
    const auth = gmailCredsFromEnv(OAUTH_ENV);
    expect(auth.kind).toBe("oauth");
    if (auth.kind !== "oauth") throw new Error("unreachable");
    expect(auth.user).toBe("sync@example.com");
    expect(auth.clientId).toBe("cid.apps.googleusercontent.com");
    expect(auth.refreshToken).toBe("rtoken");
  });

  it("prefers OAuth over an App Password when BOTH are set", () => {
    const auth = gmailCredsFromEnv({
      ...OAUTH_ENV,
      GMAIL_APP_PASSWORD: "xxxxxxxxxxxxxxxx",
    } as unknown as NodeJS.ProcessEnv);
    expect(auth.kind).toBe("oauth");
  });

  it("falls back to App Password when the OAuth trio is incomplete", () => {
    const auth = gmailCredsFromEnv({
      GMAIL_USER: "sync@example.com",
      // client id present but secret/refresh missing → NOT a usable OAuth config
      GMAIL_OAUTH_CLIENT_ID: "cid",
      GMAIL_APP_PASSWORD: "xxxxxxxxxxxxxxxx",
    } as unknown as NodeJS.ProcessEnv);
    expect(auth.kind).toBe("appPassword");
    if (auth.kind !== "appPassword") throw new Error("unreachable");
    expect(auth.appPassword).toBe("xxxxxxxxxxxxxxxx");
  });

  it("throws naming BOTH option sets when neither credential set is present", () => {
    expect(() =>
      gmailCredsFromEnv({ GMAIL_USER: "sync@example.com" } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/GMAIL_OAUTH_CLIENT_ID[\s\S]*GMAIL_APP_PASSWORD/);
  });

  it("requires GMAIL_USER in both branches", () => {
    expect(() =>
      gmailCredsFromEnv({
        GMAIL_OAUTH_CLIENT_ID: "cid",
        GMAIL_OAUTH_CLIENT_SECRET: "cs",
        GMAIL_OAUTH_REFRESH_TOKEN: "rt",
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/GMAIL_USER/);
    expect(() =>
      gmailCredsFromEnv({ GMAIL_APP_PASSWORD: "pw" } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/GMAIL_USER/);
  });

  it("pins the broad IMAP scope (narrower scopes cannot STORE the label)", () => {
    expect(GMAIL_OAUTH_SCOPE).toBe("https://mail.google.com/");
  });
});

describe("getGmailAccessToken cache + expiry", () => {
  const auth: Extract<GmailAuth, { kind: "oauth" }> = {
    kind: "oauth",
    user: "sync@example.com",
    clientId: "cid",
    clientSecret: "csecret",
    refreshToken: "rtoken",
  };

  let fetchMock: ReturnType<typeof vi.fn>;
  let minted = 0;

  function okToken(expiresIn = 3600): Response {
    minted += 1;
    return new Response(
      JSON.stringify({ access_token: `tok-${minted}`, expires_in: expiresIn }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  beforeEach(() => {
    minted = 0;
    _resetAccessTokenCacheForTest();
    fetchMock = vi.fn(async () => okToken());
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _resetAccessTokenCacheForTest();
  });

  it("posts form-encoded refresh_token grant to Google's token endpoint", async () => {
    const tok = await getGmailAccessToken(auth, { now: () => 0 });
    expect(tok).toBe("tok-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );
    const form = new URLSearchParams(init.body as string);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("client_id")).toBe("cid");
    expect(form.get("client_secret")).toBe("csecret");
    expect(form.get("refresh_token")).toBe("rtoken");
  });

  it("reuses the cached token while it is still valid", async () => {
    await getGmailAccessToken(auth, { now: () => 0 });
    const again = await getGmailAccessToken(auth, { now: () => 60_000 });
    expect(again).toBe("tok-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-mints once inside the 5-minute safety margin before real expiry", async () => {
    // expires_in 3600s → cache is good until 3600s − 300s = 3300s.
    await getGmailAccessToken(auth, { now: () => 0 });
    expect(await getGmailAccessToken(auth, { now: () => 3_299_000 })).toBe("tok-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 3301s: inside the margin, still before Google's own expiry → must re-mint.
    expect(await getGmailAccessToken(auth, { now: () => 3_301_000 })).toBe("tok-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache on forceRefresh", async () => {
    await getGmailAccessToken(auth, { now: () => 0 });
    const forced = await getGmailAccessToken(auth, { now: () => 0, forceRefresh: true });
    expect(forced).toBe("tok-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws a secret-safe error carrying status + Google's error fields", async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "Token has been expired or revoked.",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        )
    );
    let caught: unknown;
    try {
      await getGmailAccessToken(auth, { now: () => 0 });
    } catch (err) {
      caught = err;
    }
    const msg = caught instanceof Error ? caught.message : String(caught);
    expect(msg).toContain("HTTP 400");
    expect(msg).toContain("invalid_grant");
    expect(msg).toContain("Token has been expired or revoked.");
    // Never leak the secret material.
    expect(msg).not.toContain("csecret");
    expect(msg).not.toContain("rtoken");
  });

  it("does not cache a failed mint", async () => {
    fetchMock.mockImplementationOnce(
      async () => new Response("gateway blew up", { status: 502 })
    );
    await expect(getGmailAccessToken(auth, { now: () => 0 })).rejects.toThrow(/HTTP 502/);
    expect(await getGmailAccessToken(auth, { now: () => 0 })).toBe("tok-1");
  });
});

describe("isAuthFailure (drives the ONE forced-refresh retry in connect())", () => {
  it("detects imapflow's AuthenticationFailure shape", () => {
    expect(isAuthFailure({ authenticationFailed: true })).toBe(true);
    expect(isAuthFailure({ serverResponseCode: "AUTHENTICATIONFAILED" })).toBe(true);
    expect(isAuthFailure(new Error("Invalid credentials (Failure)"))).toBe(true);
  });
  it("does NOT treat network/protocol failures as auth failures", () => {
    expect(isAuthFailure(new Error("Command failed"))).toBe(false);
    expect(isAuthFailure(new Error("ECONNRESET"))).toBe(false);
    expect(isAuthFailure(null)).toBe(false);
  });
});
