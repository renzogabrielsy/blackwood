import "server-only";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { classify, derivePrefix, docType } from "./classify";
import { readiness } from "./requirements";
import type {
  ClassifiedAttachment,
  ShipmentDetail,
  ShipmentSummary,
  TrelloAttachment,
  TrelloChecklist,
} from "./types";

// ── Read-only Trello REST adapter (server-only) ──────────────────────────────
// The credentials are Renzo's and NEVER reach the client. Resolution order:
//   1. Vercel env vars (production): TRELLO_API_KEY / TRELLO_TOKEN / TRELLO_BOARD_ID
//   2. DEV fallback: parse ~/.config/ictc-trello/credentials.env (mode-600 file the
//      CLI already uses), default board id to the known ICTC export board.
// The dev-file fallback runs ONLY when NODE_ENV !== 'production', so a misconfigured
// prod deploy fails loudly instead of trying to read a home directory that isn't there.

const DEFAULT_BOARD_ID = "68157fe83b212306ba0ee381";
const CRED_PATH = join(homedir(), ".config", "ictc-trello", "credentials.env");

interface TrelloCreds {
  key: string;
  token: string;
  boardId: string;
}

/** Parse KEY=VALUE lines from the local credentials.env (dev only). */
function readCredFile(): { key?: string; token?: string } {
  try {
    const raw = readFileSync(CRED_PATH, "utf8");
    let key: string | undefined;
    let token: string | undefined;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("TRELLO_API_KEY=")) key = trimmed.slice("TRELLO_API_KEY=".length).trim();
      else if (trimmed.startsWith("TRELLO_TOKEN=")) token = trimmed.slice("TRELLO_TOKEN=".length).trim();
    }
    return { key, token };
  } catch {
    return {};
  }
}

/** Thrown when creds are absent — surfaced to the UI as a clear, copyable message. */
export class TrelloConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrelloConfigError";
  }
}

let cachedCreds: TrelloCreds | null = null;

function resolveCreds(): TrelloCreds {
  if (cachedCreds) return cachedCreds;

  let key = process.env.TRELLO_API_KEY?.trim();
  let token = process.env.TRELLO_TOKEN?.trim();
  const boardId = process.env.TRELLO_BOARD_ID?.trim() || DEFAULT_BOARD_ID;

  if ((!key || !token) && process.env.NODE_ENV !== "production") {
    const fromFile = readCredFile();
    key = key || fromFile.key;
    token = token || fromFile.token;
  }

  if (!key || !token) {
    throw new TrelloConfigError(
      "Trello credentials are not configured. Set TRELLO_API_KEY, TRELLO_TOKEN " +
        "(and optionally TRELLO_BOARD_ID) in the environment. In local dev they can " +
        `live in ${CRED_PATH}.`
    );
  }

  cachedCreds = { key, token, boardId };
  return cachedCreds;
}

/** The board id in effect (env override or the ICTC default). */
export function getBoardId(): string {
  return resolveCreds().boardId;
}

/** The OAuth header Trello REQUIRES for attachment file downloads (key/token query
 *  params do NOT authorize downloads since 2021). Server-only — never sent to a client. */
export function attachmentAuthHeader(): { Authorization: string } {
  const { key, token } = resolveCreds();
  return { Authorization: `OAuth oauth_consumer_key="${key}", oauth_token="${token}"` };
}

/** GET a Trello JSON endpoint with key/token query auth. */
async function apiGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const { key, token } = resolveCreds();
  const qs = new URLSearchParams({ ...params, key, token });
  const url = `https://api.trello.com${path}?${qs.toString()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Trello API ${res.status} ${res.statusText} for ${path}${body ? ` — ${body.slice(0, 200)}` : ""}`);
  }
  return res.json() as Promise<T>;
}

// ── Raw fetchers ─────────────────────────────────────────────────────────────

interface RawCard {
  id: string;
  name: string;
  idList?: string;
  dateLastActivity?: string | null;
  shortUrl?: string | null;
}

interface RawChecklist {
  id: string;
  name: string;
  checkItems: { name: string; state: string }[];
}

async function fetchCards(): Promise<RawCard[]> {
  return apiGet<RawCard[]>(`/1/boards/${getBoardId()}/cards`, {
    fields: "name,idList,dateLastActivity,shortUrl",
  });
}

async function fetchAttachments(cardId: string): Promise<TrelloAttachment[]> {
  return apiGet<TrelloAttachment[]>(`/1/cards/${cardId}/attachments`, {
    fields: "name,bytes,mimeType,url,date",
  });
}

async function fetchChecklists(cardId: string): Promise<TrelloChecklist[]> {
  const raw = await apiGet<RawChecklist[]>(`/1/cards/${cardId}/checklists`);
  return raw.map((ch) => {
    const items = ch.checkItems.map((i) => ({ name: i.name, complete: i.state === "complete" }));
    return {
      id: ch.id,
      name: ch.name,
      items,
      done: items.filter((i) => i.complete).length,
      total: items.length,
    };
  });
}

// ── High-level adapter API (what the module + digest band consume) ───────────

/** All shipment cards on the board, newest-activity first, with readiness. */
export async function listShipments(): Promise<ShipmentSummary[]> {
  const cards = await fetchCards();

  const summaries = await Promise.all(
    cards.map(async (card): Promise<ShipmentSummary> => {
      const [atts, checklists] = await Promise.all([
        fetchAttachments(card.id),
        fetchChecklists(card.id),
      ]);
      const attNames = atts.map((a) => a.name);
      const done = checklists.reduce((s, c) => s + c.done, 0);
      const total = checklists.reduce((s, c) => s + c.total, 0);
      return {
        cardId: card.id,
        title: card.name,
        shortUrl: card.shortUrl ?? null,
        lastActivity: card.dateLastActivity ?? null,
        prefix: derivePrefix(card.name),
        attachmentCount: atts.length,
        readiness: readiness(card.name, attNames),
        checklist: { done, total },
      };
    })
  );

  // Newest-first by last activity (missing dates sink to the bottom).
  return summaries.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
}

/** One card's full detail: classified attachments (canonical names) + checklists. */
export async function getShipment(cardId: string): Promise<ShipmentDetail | null> {
  const cards = await fetchCards();
  const card = cards.find((c) => c.id === cardId);
  if (!card) return null;

  const [atts, checklists] = await Promise.all([
    fetchAttachments(cardId),
    fetchChecklists(cardId),
  ]);
  const prefix = derivePrefix(card.name);
  const attNames = atts.map((a) => a.name);

  // classify() names off the STEM; docType() classifies off the FULL name (incl.
  // extension) — the two are deliberately fed differently (see classify.ts).
  const attachments: ClassifiedAttachment[] = atts.map((a) => {
    const { canonical, kind } = classify(a.name, prefix);
    return {
      id: a.id,
      originalName: a.name,
      canonicalName: canonical,
      kind,
      docType: docType(a.name),
      bytes: a.bytes,
      mimeType: a.mimeType,
      url: a.url,
    };
  });

  return {
    cardId: card.id,
    title: card.name,
    shortUrl: card.shortUrl ?? null,
    lastActivity: card.dateLastActivity ?? null,
    prefix,
    readiness: readiness(card.name, attNames),
    checklists,
    attachments,
  };
}

/** Raw card lookup used by the ZIP download route (needs card title + attachments). */
export async function getCardForDownload(
  cardId: string
): Promise<{ title: string; prefix: string | null; attachments: TrelloAttachment[] } | null> {
  const cards = await fetchCards();
  const card = cards.find((c) => c.id === cardId);
  if (!card) return null;
  const attachments = await fetchAttachments(cardId);
  return { title: card.name, prefix: derivePrefix(card.name), attachments };
}

/** Single-attachment lookup for the per-file download route. Returns the raw
 *  attachment PLUS its canonical filename (derived off the card-title prefix), or
 *  null when the card or the attachment id doesn't exist on that card. Reuses the
 *  same card+attachment fetchers as the ZIP route; the OAuth download itself is done
 *  by the route via attachmentAuthHeader(). */
export async function getAttachmentForDownload(
  cardId: string,
  attachmentId: string
): Promise<{ attachment: TrelloAttachment; canonicalName: string } | null> {
  const cards = await fetchCards();
  const card = cards.find((c) => c.id === cardId);
  if (!card) return null;
  const attachments = await fetchAttachments(cardId);
  const attachment = attachments.find((a) => a.id === attachmentId);
  if (!attachment) return null;
  const { canonical } = classify(attachment.name, derivePrefix(card.name));
  return { attachment, canonicalName: canonical };
}
