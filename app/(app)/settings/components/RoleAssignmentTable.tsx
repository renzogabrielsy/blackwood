'use client';

import { useState } from 'react';
import { updateUserRole } from '../actions';
import type { UserRole } from '@/components/providers/auth-context';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { errorToast } from '@/lib/toast';

interface Profile {
  id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  role: string;
  created_at: string;
}

const roles: UserRole[] = ['Owner', 'Admin', 'Dev', 'Production', 'Accounting'];

export function RoleAssignmentTable({ profiles }: { profiles: Profile[] }) {
  const [updating, setUpdating] = useState<string | null>(null);

  const handleRoleChange = async (userId: string, newRole: UserRole) => {
    setUpdating(userId);
    const result = await updateUserRole(userId, newRole);
    if (result.success) {
      toast.success('Role updated');
    } else {
      errorToast(result.message ?? 'Failed to update role');
    }
    setUpdating(null);
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="px-2 py-2 font-medium">User</th>
            <th className="px-2 py-2 font-medium">Email</th>
            <th className="px-2 py-2 font-medium w-[160px]">Role</th>
          </tr>
        </thead>
        <tbody>
          {profiles.map((profile) => (
            <tr key={profile.id} className="border-b">
              <td className="px-2 py-2 flex items-center gap-2">
                {profile.avatar_url && (
                  <img
                    src={profile.avatar_url}
                    alt=""
                    className="h-6 w-6 rounded-full"
                  />
                )}
                <span>{profile.display_name ?? '—'}</span>
              </td>
              <td className="px-2 py-2 text-muted-foreground">
                {profile.email}
              </td>
              <td className="px-2 py-2">
                <Select
                  value={profile.role}
                  onValueChange={(value) =>
                    handleRoleChange(profile.id, value as UserRole)
                  }
                  disabled={updating === profile.id}
                >
                  <SelectTrigger className="h-8 w-[140px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
