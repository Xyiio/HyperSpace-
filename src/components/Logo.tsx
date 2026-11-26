// HyperSpace mark: a nebula orb wrapped by a tilted orbit, with a comet riding the ring.
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="logo-mark">
      <defs>
        <radialGradient id="hs-core" cx="42%" cy="38%" r="62%">
          <stop offset="0%" stopColor="#f5f0ff" />
          <stop offset="18%" stopColor="#c9b6ff" />
          <stop offset="45%" stopColor="#7c4dff" />
          <stop offset="75%" stopColor="#2a1263" />
          <stop offset="100%" stopColor="#0b0620" />
        </radialGradient>
        <radialGradient id="hs-nebula" cx="70%" cy="72%" r="55%">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="hs-haze" cx="50%" cy="50%" r="50%">
          <stop offset="55%" stopColor="#8b5cf6" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="hs-ring" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity="0" />
          <stop offset="35%" stopColor="#67e8f9" />
          <stop offset="70%" stopColor="#e879f9" />
          <stop offset="100%" stopColor="#e879f9" stopOpacity="0.1" />
        </linearGradient>
        <filter id="hs-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <circle cx="32" cy="32" r="31" fill="url(#hs-haze)" />
      {/* Back half of the orbit sits behind the orb, front half passes over it. */}
      <g transform="rotate(-24 32 32)" opacity="0.55">
        <path d="M 4 32 A 28 9 0 0 1 60 32" fill="none" stroke="url(#hs-ring)" strokeWidth="1.6" />
      </g>
      <circle cx="32" cy="32" r="17" fill="url(#hs-core)" />
      <circle cx="32" cy="32" r="17" fill="url(#hs-nebula)" />
      <g transform="rotate(-24 32 32)" filter="url(#hs-glow)">
        <path d="M 4 32 A 28 9 0 0 0 60 32" fill="none" stroke="url(#hs-ring)" strokeWidth="2.4" />
        <circle cx="49" cy="39.2" r="2.6" fill="#fdf4ff" />
      </g>
      <g fill="#ffffff">
        <circle cx="11" cy="14" r="0.9" opacity="0.9" />
        <circle cx="52" cy="11" r="0.7" opacity="0.7" />
        <circle cx="48" cy="54" r="0.8" opacity="0.6" />
        <circle cx="15" cy="50" r="0.6" opacity="0.5" />
      </g>
    </svg>
  );
}

export function Logo() {
  return (
    <span className="logo">
      <LogoMark />
      <span className="logo-word">
        <span className="lw-hyper">HYPER</span>
        <span className="lw-space">SPACE</span>
      </span>
    </span>
  );
}
