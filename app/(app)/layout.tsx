'use client';

import dynamic from 'next/dynamic';

const Navbar = dynamic(() => import('@/components/navbar').then(m => m.Navbar), {
    ssr: false,
});

export default function AppLayout({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex flex-col h-screen">
            <Navbar />
            <div className="flex-1 min-h-0 flex flex-col">
                {children}
            </div>
        </div>
    );
}
