import { notFound } from 'next/navigation';

import { LedgerDraftA } from './ledger-a';

// DEV ONLY. Same two independent locks as `/dev/table-playground`: this `notFound()`, and
// the middleware only adding `/dev/ops-ledger` to `PUBLIC_PATHS` under the same condition.
export const dynamic = 'force-dynamic';

export default function OpsLedgerDraftAPage() {
    if (process.env.NODE_ENV === 'production' && !process.env.TABLE_PLAYGROUND) notFound();
    return <LedgerDraftA />;
}
