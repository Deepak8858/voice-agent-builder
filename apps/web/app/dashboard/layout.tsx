import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { AppSidebar } from '@/components/layout/app-sidebar';
import { Separator } from '@/components/ui/separator';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId } = await auth();
  if (!userId) {
    redirect('/');
  }
  return (
    <div className="flex flex-1 min-h-[calc(100vh-57px)]">
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Separator orientation="vertical" className="hidden md:block absolute left-64 h-full" />
        <div className="flex flex-1 flex-col px-6 py-8 max-w-7xl mx-auto w-full">
          {children}
        </div>
      </div>
    </div>
  );
}
