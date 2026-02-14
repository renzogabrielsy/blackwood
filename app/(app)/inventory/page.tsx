import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const submodules = [
  { name: 'Deliveries', href: '/inventory/rc-in', description: 'Raw charcoal receiving & delivery logs' },
  { name: 'Usage', href: '/inventory/rc-out', description: 'Raw charcoal usage & depletion logs' },
  { name: 'Blocking', href: '/inventory/blocking', description: 'Block location inventory management' },
];

export default function InventoryPage() {
  return (
    <div className="flex flex-col flex-1 bg-muted/10">
      <main className="flex-1 px-6 py-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 max-w-4xl">
          {submodules.map((mod) => (
            <Link key={mod.href} href={mod.href}>
              <Card className="h-full transition-colors hover:bg-accent/50 cursor-pointer">
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg">{mod.name}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">{mod.description}</p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
