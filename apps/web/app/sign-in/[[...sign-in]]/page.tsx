import { SignIn } from '@clerk/nextjs';

export default function Page() {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-24">
      <SignIn />
    </div>
  );
}
