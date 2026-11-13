/** A code-shaped C and a plus, shared by the wordmark and social card. */
export function BrandMark({
  size = 36,
  symbolColor = '#fff',
}: {
  size?: number
  symbolColor?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="64" height="64" rx="16" fill="currentColor" />
      <path
        d="M30 18H25L12 32L25 46H30M38 32H52M45 25V39"
        stroke={symbolColor}
        strokeWidth="5"
        strokeLinecap="square"
        strokeLinejoin="round"
      />
    </svg>
  )
}
