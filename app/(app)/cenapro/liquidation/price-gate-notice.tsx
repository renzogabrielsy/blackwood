import { Lock } from 'lucide-react';

import { PRICE_GATE_NOTE } from './types';

/**
 * What a price-denied role sees instead of the liquidation screens.
 *
 * A clean statement, not an error: being unable to see money is a correct outcome of the
 * permission model, and dressing it as a failure would send people to ask an admin to fix
 * something that is not broken. **Production is the only role that cannot see prices.**
 *
 * It is a plain server component with no props by design — it never receives the payload
 * it is standing in for, because that payload was never fetched.
 */
export function PriceGateNotice() {
    return (
        <div className="flex flex-1 items-center justify-center p-8">
            <div className="animate-fade-up max-w-md text-center">
                <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <Lock className="size-4" />
                </div>
                <p className="mt-3 text-sm font-medium">Not available for your role</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{PRICE_GATE_NOTE}</p>
            </div>
        </div>
    );
}
