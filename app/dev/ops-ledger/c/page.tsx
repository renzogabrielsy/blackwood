import { notFound } from 'next/navigation';

import { LedgerDraftC } from './ledger-c';

// DEV ONLY. Same two independent locks as `/dev/table-playground`.
export const dynamic = 'force-dynamic';

export default function OpsLedgerDraftCPage() {
    if (process.env.NODE_ENV === 'production' && !process.env.TABLE_PLAYGROUND) notFound();
    return <LedgerDraftC />;
}
