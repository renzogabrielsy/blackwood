import { Suspense } from 'react';
import { LoginForm } from './components/LoginForm';

export default function LoginPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted/10">
      <div className="w-full max-w-sm space-y-6 px-4">
        <div className="space-y-2 text-center">
          <h1 className="text-3xl font-bold tracking-tight">Blackwood</h1>
          <p className="text-sm text-muted-foreground">
            Industrial Inventory Management
          </p>
        </div>
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
