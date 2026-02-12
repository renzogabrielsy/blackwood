'use client';

import * as React from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import { Send, Loader2, CheckCircle2, ArrowUpDown, Clock } from 'lucide-react';
import type { AuditLogRow, AuditComment } from '@/types/rc-in';
import { DiffDisplay, OperationBadge, getUserInitials, getUserName } from '../../components/audit-shared';
import {
  addAuditComment,
  getAuditComments,
  resolveAuditLog,
  requestResolveAuditLog,
  approveResolveRequest,
  denyResolveRequest,
} from '../../actions';
import { useAuth } from '@/components/providers/auth-context';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

const SYSTEM_MESSAGES = [
  'marked this edit as resolved',
  'reopened this edit',
  'requested to resolve this edit',
  'requested to reopen this edit',
  'approved the resolve request',
  'approved the reopen request',
];

function isSystemMessage(body: string) {
  return SYSTEM_MESSAGES.some(m => body === m) || body.startsWith('denied the resolve request:') || body.startsWith('denied the reopen request:');
}

export function EditDiscussion({
  log,
  delivery,
  initialComments,
}: {
  log: AuditLogRow;
  delivery: Record<string, any> | null;
  initialComments: AuditComment[];
}) {
  const { role, isLoading: authLoading } = useAuth();
  const isPrivileged = role === 'Owner' || role === 'Admin' || role === 'Dev';

  const [comments, setComments] = React.useState<AuditComment[]>(initialComments);
  const [body, setBody] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [resolving, startResolveTransition] = React.useTransition();
  const [sortNewestFirst, setSortNewestFirst] = React.useState(true);
  const [denyReason, setDenyReason] = React.useState('');
  const [reviewDialogOpen, setReviewDialogOpen] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const resolved = log.resolved;
  const hasPendingRequest = log.resolve_requested;
  const requestType = log.resolve_request_type;

  const sortedComments = React.useMemo(() => {
    const sorted = [...comments].sort((a, b) => {
      const diff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      return sortNewestFirst ? -diff : diff;
    });
    return sorted;
  }, [comments, sortNewestFirst]);

  async function refreshComments() {
    const updated = await getAuditComments(log.id);
    setComments(updated);
  }

  async function handleSubmit() {
    if (!body.trim()) return;
    setSubmitting(true);
    const result = await addAuditComment(log.id, body);
    if (result.success) {
      setBody('');
      await refreshComments();
    }
    setSubmitting(false);
  }

  // Admin/Owner/Dev: direct resolve toggle
  function handleResolveToggle() {
    startResolveTransition(async () => {
      const result = await resolveAuditLog(log.id);
      if (result.success) {
        await refreshComments();
      } else {
        console.error('Failed to resolve audit log:', result.message);
      }
    });
  }

  // Employee: request resolve/reopen
  function handleRequestResolve(type: 'resolve' | 'reopen') {
    startResolveTransition(async () => {
      const result = await requestResolveAuditLog(log.id, type);
      if (result.success) {
        await refreshComments();
      } else {
        console.error('Failed to request resolve:', result.message);
      }
    });
  }

  // Admin/Owner/Dev: approve pending request
  function handleApprove() {
    startResolveTransition(async () => {
      const result = await approveResolveRequest(log.id);
      setReviewDialogOpen(false);
      if (result.success) {
        await refreshComments();
      } else {
        console.error('Failed to approve request:', result.message);
      }
    });
  }

  // Admin/Owner/Dev: deny pending request
  function handleDeny() {
    if (!denyReason.trim()) return;
    startResolveTransition(async () => {
      const result = await denyResolveRequest(log.id, denyReason);
      setReviewDialogOpen(false);
      if (result.success) {
        setDenyReason('');
        await refreshComments();
      } else {
        console.error('Failed to deny request:', result.message);
      }
    });
  }

  // Render the resolve/request controls based on role and state
  function renderResolveControls() {
    // Wait for auth to load before showing role-specific controls
    if (authLoading) {
      return <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />;
    }

    // --- PRIVILEGED: Admin/Owner/Dev ---
    if (isPrivileged) {
      // Pending request exists: show approve/deny
      if (hasPendingRequest) {
        return (
          <>
            <Badge variant="outline" className="text-orange-600 border-orange-300 dark:border-orange-700 dark:text-orange-400 gap-1 text-[10px]">
              <Clock className="h-3 w-3" />
              Pending {requestType === 'resolve' ? 'Resolve' : 'Reopen'}
            </Badge>
            <AlertDialog open={reviewDialogOpen} onOpenChange={(open) => {
              setReviewDialogOpen(open);
              if (!open) setDenyReason('');
            }}>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs gap-1 border-orange-300 text-orange-600 hover:bg-orange-50 dark:border-orange-700 dark:text-orange-400 dark:hover:bg-orange-950"
                  disabled={resolving}
                >
                  {resolving ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Review Request'}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Pending {requestType === 'resolve' ? 'Resolve' : 'Reopen'} Request
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    A team member has requested to {requestType} this edit. You can approve or deny this request.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="space-y-3 py-2">
                  <div className="text-xs text-muted-foreground">
                    To deny, provide a reason:
                  </div>
                  <Textarea
                    placeholder="Reason for denying (required to deny)..."
                    className="text-sm min-h-[60px] resize-none"
                    value={denyReason}
                    onChange={(e) => setDenyReason(e.target.value)}
                  />
                </div>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={!denyReason.trim() || resolving}
                    onClick={handleDeny}
                  >
                    Deny
                  </Button>
                  <Button
                    size="sm"
                    disabled={resolving}
                    onClick={handleApprove}
                  >
                    Approve
                  </Button>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        );
      }

      // No pending request: direct resolve/unresolve (same as before)
      return (
        <>
          {resolved && (
            <Badge variant="outline" className="text-green-600 border-green-300 dark:border-green-700 dark:text-green-400 gap-1 text-[10px]">
              <CheckCircle2 className="h-3 w-3" />
              Resolved
            </Badge>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant={resolved ? 'outline' : 'default'}
                size="sm"
                className="h-7 text-xs gap-1"
                disabled={resolving}
              >
                {resolving ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : resolved ? (
                  'Unresolve'
                ) : (
                  <>
                    <CheckCircle2 className="h-3 w-3" />
                    Resolve
                  </>
                )}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {resolved ? 'Unresolve this edit?' : 'Resolve this edit?'}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {resolved
                    ? 'This will reopen the edit for further discussion.'
                    : 'This will mark the edit as resolved and grey out the discussion.'}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleResolveToggle}>
                  {resolved ? 'Unresolve' : 'Resolve'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      );
    }

    // --- EMPLOYEE ---
    // Pending request: show disabled badge
    if (hasPendingRequest) {
      return (
        <Badge variant="outline" className="text-orange-600 border-orange-300 dark:border-orange-700 dark:text-orange-400 gap-1 text-[10px]">
          <Clock className="h-3 w-3" />
          Pending {requestType === 'resolve' ? 'Resolve' : 'Reopen'} Request
        </Badge>
      );
    }

    // No pending request: show request button
    const actionType = resolved ? 'reopen' : 'resolve';
    return (
      <>
        {resolved && (
          <Badge variant="outline" className="text-green-600 border-green-300 dark:border-green-700 dark:text-green-400 gap-1 text-[10px]">
            <CheckCircle2 className="h-3 w-3" />
            Resolved
          </Badge>
        )}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1"
              disabled={resolving}
            >
              {resolving ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : resolved ? (
                'Request Reopen'
              ) : (
                'Request Resolve'
              )}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {resolved ? 'Request to reopen this edit?' : 'Request to resolve this edit?'}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {resolved
                  ? 'This will send a request to an admin to reopen this edit for further discussion.'
                  : 'This will send a request to an admin to mark this edit as resolved.'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => handleRequestResolve(actionType)}>
                Send Request
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  }

  return (
    <div className="max-w-2xl mx-auto flex flex-col h-full gap-3">
      {/* Edit Details — compact, no scroll */}
      <div className="shrink-0 border rounded-md p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Avatar className="h-6 w-6">
              <AvatarImage src={log.profiles?.avatar_url ?? undefined} />
              <AvatarFallback className="text-[10px]">
                {getUserInitials(log.profiles)}
              </AvatarFallback>
            </Avatar>
            <span className="text-xs font-medium">{getUserName(log)}</span>
            <OperationBadge op={log.operation} />
            <span className="text-[10px] text-muted-foreground">
              {format(new Date(log.performed_at), 'MMM d, yyyy h:mm a')}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {renderResolveControls()}
          </div>
        </div>

        {log.comment && (
          <div className="text-xs bg-amber-50 dark:bg-amber-950/30 px-2 py-1.5 rounded border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200">
            <span className="font-semibold text-[10px] uppercase tracking-wider opacity-70 mr-1.5">Reason:</span>
            {log.comment}
          </div>
        )}

        <div className="border rounded p-2 bg-muted/20">
          <span className="text-[10px] font-bold text-muted-foreground uppercase mb-1 block tracking-wider">Changes</span>
          <DiffDisplay entry={log} />
        </div>
      </div>

      {/* Discussion — fills remaining space */}
      <div className="flex-1 min-h-0 flex flex-col border rounded-md">
        <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
          <span className="text-xs font-medium">
            Discussion ({comments.length})
          </span>
          {comments.length > 1 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[11px] gap-1 text-muted-foreground px-2"
              onClick={() => setSortNewestFirst((prev) => !prev)}
            >
              <ArrowUpDown className="h-3 w-3" />
              {sortNewestFirst ? 'Newest' : 'Oldest'}
            </Button>
          )}
        </div>

        <div
          ref={scrollRef}
          className={`flex-1 min-h-0 overflow-y-auto px-3 py-2 ${resolved ? 'opacity-50' : ''}`}
        >
          {sortedComments.length > 0 ? (
            <div className="space-y-3">
              {sortedComments.map((c) => (
                <div key={c.id} className="flex gap-2 text-xs">
                  <Avatar className="h-5 w-5 shrink-0 mt-0.5">
                    <AvatarImage src={c.profiles?.avatar_url ?? undefined} />
                    <AvatarFallback className="text-[9px]">
                      {c.profiles?.display_name?.[0]?.toUpperCase() || c.profiles?.email?.[0]?.toUpperCase() || '?'}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <span className="font-medium mr-1.5">
                      {c.profiles?.display_name || c.profiles?.email || 'Unknown'}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}
                    </span>
                    {isSystemMessage(c.body) ? (
                      <p className="text-muted-foreground italic mt-0.5">{c.body}</p>
                    ) : (
                      <p className="text-muted-foreground whitespace-pre-wrap mt-0.5">{c.body}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground text-center py-3">
              No comments yet.
            </p>
          )}
        </div>

        {/* Comment input — pinned to bottom */}
        <div className="shrink-0 border-t px-3 py-2 flex gap-2 items-end">
          <Textarea
            placeholder="Add a comment..."
            className="text-xs min-h-[60px] resize-none flex-1"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                handleSubmit();
              }
            }}
          />
          <Button
            size="sm"
            className="gap-1 h-8 shrink-0"
            disabled={!body.trim() || submitting}
            onClick={handleSubmit}
          >
            {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
