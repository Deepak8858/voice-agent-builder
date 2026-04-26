import type { SVGProps } from 'react';

export function Logo({ size = 24, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M4 11a8 8 0 0 1 16 0" />
      <path d="M4 15a4 4 0 0 0 4 4h1v-6H4z" />
      <path d="M20 15a4 4 0 0 1-4 4h-1v-6h5z" />
    </svg>
  );
}
