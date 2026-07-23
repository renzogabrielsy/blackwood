"use server";

// Server actions wrapping the read-only Trello adapter for the Shipments module.
// FRONTEND SCOPE NOTE: these are thin read-only pass-throughs to the adapter in
// lib/shipments/trello.ts (no DB, no mutations, no Supabase). They exist so client
// components (and future refresh handlers) have a stable server entry point; the
// page/detail server components import the adapter directly for the initial render.

import { listShipments as _list, getShipment as _get } from "@/lib/shipments/trello";
import type { ShipmentDetail, ShipmentSummary } from "@/lib/shipments/types";

export async function listShipments(): Promise<ShipmentSummary[]> {
  return _list();
}

export async function getShipment(cardId: string): Promise<ShipmentDetail | null> {
  return _get(cardId);
}
