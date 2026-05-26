'use client';

import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';
import type { RcMovementData } from '../actions';

const RcMovementTable = dynamic(
    () => import('../rc-movement-table').then(m => m.RcMovementTable),
    {
        ssr: false,
        loading: () => (
            <div className="h-full w-full flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        ),
    }
);

interface RcMovementTableWrapperProps {
    data: RcMovementData;
    year: number;
    month: number;
    loading: boolean;
    onChangeMonth: (year: number, month: number) => void;
}

export function RcMovementTableWrapper(props: RcMovementTableWrapperProps) {
    return <RcMovementTable {...props} />;
}
