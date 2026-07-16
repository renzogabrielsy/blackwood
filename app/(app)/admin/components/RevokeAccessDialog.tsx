'use client';

import * as React from 'react';
import { revokeUserAccess, reactivateUser } from '../actions';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { errorToast } from '@/lib/toast';

interface RevokeAccessDialogProps {
  userId: string;
  userEmail: string;
  status: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RevokeAccessDialog({
  userId,
  userEmail,
  status,
  open,
  onOpenChange,
}: RevokeAccessDialogProps) {
  const [isLoading, setIsLoading] = React.useState(false);

  const isDisabled = status === 'disabled';

  const handleAction = async () => {
    setIsLoading(true);
    try {
      const result = isDisabled
        ? await reactivateUser(userId)
        : await revokeUserAccess(userId);

      if (result.success) {
        toast.success(result.message);
        onOpenChange(false);
      } else {
        errorToast(result.message);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const title = isDisabled ? 'Reactivate User?' : 'Revoke Access?';
  const description = isDisabled
    ? `Are you sure you want to reactivate access for ${userEmail}? They will be able to use the system again.`
    : `Are you sure you want to revoke access for ${userEmail}? They will not be able to access the system.`;
  const actionLabel = isDisabled ? 'Reactivate' : 'Revoke Access';

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex gap-3">
          <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleAction}
            disabled={isLoading}
            className={isDisabled ? '' : 'bg-destructive hover:bg-destructive/90'}
          >
            {isLoading ? 'Processing...' : actionLabel}
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
