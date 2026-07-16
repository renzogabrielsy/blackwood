'use client';

import * as React from 'react';
import { updateUserRole } from '../actions';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { formatDistanceToNow } from 'date-fns';
import { UserStatusBadge } from './UserStatusBadge';
import { RevokeAccessDialog } from './RevokeAccessDialog';
import { InviteUserDialog } from './InviteUserDialog';
import { toast } from 'sonner';
import { errorToast } from '@/lib/toast';
import type { UserRole } from '@/components/providers/auth-context';

interface User {
  id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  role: string;
  status: string;
  created_at: string;
}

interface UserManagementTableProps {
  users: User[];
  currentUserId: string;
}

export function UserManagementTable({
  users,
  currentUserId,
}: UserManagementTableProps) {
  const [selectedUserId, setSelectedUserId] = React.useState<string | null>(null);
  const [revokeDialogOpen, setRevokeDialogOpen] = React.useState(false);
  const [updatingUserId, setUpdatingUserId] = React.useState<string | null>(null);

  const selectedUser = users.find((u) => u.id === selectedUserId);

  const handleRoleChange = async (userId: string, newRole: string) => {
    setUpdatingUserId(userId);
    try {
      const result = await updateUserRole(userId, newRole as UserRole);
      if (result.success) {
        toast.success(result.message);
      } else {
        errorToast(result.message);
      }
    } finally {
      setUpdatingUserId(null);
    }
  };

  return (
    <Card>
      <div className="p-6 border-b border-border">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">User Management</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Invite users, assign roles, and manage access
            </p>
          </div>
          <InviteUserDialog />
        </div>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent border-b border-border">
              <TableHead className="w-[200px] text-xs font-semibold">Email</TableHead>
              <TableHead className="w-[150px] text-xs font-semibold">Name</TableHead>
              <TableHead className="w-[100px] text-xs font-semibold">Role</TableHead>
              <TableHead className="w-[80px] text-xs font-semibold">Status</TableHead>
              <TableHead className="w-[120px] text-xs font-semibold">Joined</TableHead>
              <TableHead className="w-[100px] text-xs font-semibold text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  No users yet. Invite someone to get started.
                </TableCell>
              </TableRow>
            ) : (
              users.map((user) => (
                <TableRow key={user.id} className="border-b border-border">
                  <TableCell className="text-sm text-foreground">
                    {user.email}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {user.display_name || '—'}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={user.role}
                      onValueChange={(newRole) => handleRoleChange(user.id, newRole)}
                      disabled={updatingUserId === user.id}
                    >
                      <SelectTrigger className="w-full text-xs h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Owner">Owner</SelectItem>
                        <SelectItem value="Admin">Admin</SelectItem>
                        <SelectItem value="Dev">Dev</SelectItem>
                        <SelectItem value="Production">Production</SelectItem>
                        <SelectItem value="Accounting">Accounting</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <UserStatusBadge status={user.status} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(user.created_at), { addSuffix: true })}
                  </TableCell>
                  <TableCell className="text-right">
                    {user.id !== currentUserId && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs h-8"
                        onClick={() => {
                          setSelectedUserId(user.id);
                          setRevokeDialogOpen(true);
                        }}
                      >
                        {user.status === 'disabled' ? 'Reactivate' : 'Revoke'}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {selectedUser && (
        <RevokeAccessDialog
          userId={selectedUser.id}
          userEmail={selectedUser.email}
          status={selectedUser.status}
          open={revokeDialogOpen}
          onOpenChange={setRevokeDialogOpen}
        />
      )}
    </Card>
  );
}
