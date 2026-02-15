import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getUserRole } from '@/lib/auth';
import { PRIVILEGED_ROLES } from '@/types/auth';

export default async function AdminLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
        redirect('/login');
    }

    const role = await getUserRole(user.id);

    if (!PRIVILEGED_ROLES.includes(role)) {
        redirect('/inventory');
    }

    return <>{children}</>;
}
