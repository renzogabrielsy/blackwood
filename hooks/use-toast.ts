import { useCallback } from 'react';

interface Toast {
  title?: string;
  description?: string;
  variant?: 'default' | 'destructive';
}

export function useToast() {
  const toast = useCallback((props: Toast) => {
    // For now, use browser console
    // In production, you'd want to use a toast library like react-hot-toast or sonner
    if (props.variant === 'destructive') {
      console.error(`${props.title}: ${props.description}`);
    } else {
      console.log(`${props.title}: ${props.description}`);
    }
  }, []);

  return { toast };
}
