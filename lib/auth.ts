import { createClient } from '@/lib/supabase/server';
import { UserRole, PRIVILEGED_ROLES } from '@/types/auth';
import { cookies } from 'next/headers';

export async function getUserRole(userId: string): Promise<UserRole> {
    const supabase = await createClient();
    const { data } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', userId)
        .single();

    const realRole = (data?.role as UserRole) || 'Production';

    // Only allow overrides for privileged users
    if (PRIVILEGED_ROLES.includes(realRole)) {
        const cookieStore = await cookies();
        const override = cookieStore.get('dev_mock_role');
        if (override?.value) {
            return override.value as UserRole;
        }
    }

    return realRole;
}
