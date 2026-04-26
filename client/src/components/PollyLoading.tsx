/** Public path — file lives in `client/public/assets/brand/`. */
export const POLLY_DANCE_GIF = '/assets/brand/polly_dance.gif'

export function PollyLoading({ size = 40, className = '' }: { size?: number; className?: string }) {
  return (
    <img
      src={POLLY_DANCE_GIF}
      alt=""
      aria-hidden
      width={size}
      height={size}
      className={`select-none shrink-0 ${className}`.trim()}
      draggable={false}
      style={{ objectFit: 'contain' }}
    />
  )
}
