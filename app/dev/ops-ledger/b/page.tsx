import { requireDraftAccess } from '../_shared/gate';
import { LedgerDraftB } from './ledger-b';

// DEV DRAFT. In production this renders only for a signed-in Owner / Admin / Dev.
// See `_shared/gate.ts`.
export const dynamic = 'force-dynamic';

export default async function OpsLedgerDraftBPage() {
    await requireDraftAccess();
    return <LedgerDraftB />;
}
