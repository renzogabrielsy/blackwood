import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getUserRole } from '@/lib/auth'
import { PRIVILEGED_ROLES } from '@/types/auth'
import { listPending } from './actions'
import { ReviewQueueClient } from '@/components/review-queue/ReviewQueueClient'

export const metadata = {
    title: 'Review Queue — Blackwood',
}

export const dynamic = 'force-dynamic'

export default async function ReviewQueuePage() {
    const supabase = await createClient()
    const {
        data: { user },
    } = await supabase.auth.getUser()

    if (!user) redirect('/login')

    const role = await getUserRole(user.id)
    if (!PRIVILEGED_ROLES.includes(role)) {
        redirect('/inventory')
    }

    // Fetch initial list of pending reviews from the backend agent's locked contract.
    // Wrap to a safe array so the client can always render even if the action throws.
    let initial: Awaited<ReturnType<typeof listPending>> = []
    let initialError: string | null = null
    try {
        initial = await listPending()
    } catch (err) {
        initialError =
            err instanceof Error ? err.message : 'Failed to load pending reviews'
    }

    return (
        <div className="flex-1 min-h-0 flex flex-col bg-muted/10">
            <ReviewQueueClient initial={initial} initialError={initialError} />
        </div>
    )
}
