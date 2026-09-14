import { requireDraftAccess } from '../_shared/gate';
import { LedgerDraftC } from './ledger-c';

// DEV DRAFT. In production this renders only for a signed-in Owner / Admin / Dev.
// See `_shared/gate.ts`.
export const dynamic = 'force-dynamic';

export default async function OpsLedgerDraftCPage() {
    await requireDraftAccess();
    return <LedgerDraftC />;
}
