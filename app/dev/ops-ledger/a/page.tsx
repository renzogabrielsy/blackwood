import { requireDraftAccess } from '../_shared/gate';
import { LedgerDraftA } from './ledger-a';

// DEV DRAFT. In production this renders only for a signed-in Owner / Admin / Dev; an
// anonymous visitor never gets here (the middleware's login wall), and a signed-in
// under-privileged one gets a 404. See `_shared/gate.ts` for the full reasoning.
export const dynamic = 'force-dynamic';

export default async function OpsLedgerDraftAPage() {
    await requireDraftAccess();
    return <LedgerDraftA />;
}
