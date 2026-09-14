import { notFound } from 'next/navigation';

import { LedgerDraftB } from './ledger-b';

// DEV ONLY. Same two independent locks as `/dev/table-playground`.
export const dynamic = 'force-dynamic';

export default function OpsLedgerDraftBPage() {
    if (process.env.NODE_ENV === 'production' && !process.env.TABLE_PLAYGROUND) notFound();
    return <LedgerDraftB />;
}
