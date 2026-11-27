// Small line icons, drawn in the current text color. Decorative: the buttons carry the names.

interface IconProps {
  size?: number;
}

function Svg({ size = 16, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  );
}

/** The app menu's button: three lines, as in Hangar. */
export function MenuIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
    </Svg>
  );
}

/**
 * The app's logo, the folded N of src-tauri/app-icon.svg without its tile, so it sits on the
 * sidebar like Hangar's H; its two tones come from styles.css (`--brand-n`, `--brand-mark`).
 */
export function AppLogo({ size = 20 }: IconProps) {
  return (
    <svg
      className="logo"
      width={size}
      height={size}
      viewBox="32 32 192 192"
      aria-hidden="true"
      focusable="false"
    >
      <path className="logo-n" d="M40 72L80 58L176 154V72L216 58V200H176L80 104V200H40Z" />
      <path className="logo-bar" d="M104 184H144V200H104Z" />
    </svg>
  );
}

export function MoreIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="3.5" cy="8" r="0.6" fill="currentColor" />
      <circle cx="8" cy="8" r="0.6" fill="currentColor" />
      <circle cx="12.5" cy="8" r="0.6" fill="currentColor" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 8.5l3 3 6-7" />
    </Svg>
  );
}

export function BackIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 3L5 8l5 5" />
    </Svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.2 10.2L13.5 13.5" />
    </Svg>
  );
}

export function BulletIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="3" cy="4.5" r="0.7" fill="currentColor" />
      <circle cx="3" cy="11.5" r="0.7" fill="currentColor" />
      <path d="M6 4.5h7.5M6 11.5h7.5" />
    </Svg>
  );
}

export function TaskIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="2.5" width="4" height="4" rx="1" />
      <path d="M2.8 11.6l1.2 1.2 2.2-2.6" />
      <path d="M8.5 4.5h5M8.5 11.5h5" />
    </Svg>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="1.9" />
    </Svg>
  );
}

/** A note on a screen: "on the desktop". */
export function DesktopIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.25" />
      <path d="M6 14h4M8 11v3" />
      <path d="M8.5 4.75h3v2.5" />
    </Svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 6.5L8 10l3.5-3.5" />
    </Svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 8.5h6.6l.7-8.5" />
    </Svg>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M1.75 4.25v8h12.5v-6.5H7.5L6 4.25z" />
    </Svg>
  );
}

export function GearIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="2" />
      {/* A cog with eight teeth, not spokes: beside the sun of the theme switch it must not read
          as a second sun. */}
      <path d="M6.63 3.29 7 1.68 9 1.68 9.37 3.29 10.36 3.71 11.76 2.82 13.18 4.24 12.29 5.64 12.71 6.63 14.32 7 14.32 9 12.71 9.37 12.29 10.36 13.18 11.76 11.76 13.18 10.36 12.29 9.37 12.71 9 14.32 7 14.32 6.63 12.71 5.64 12.29 4.24 13.18 2.82 11.76 3.71 10.36 3.29 9.37 1.68 9 1.68 7 3.29 6.63 3.71 5.64 2.82 4.24 4.24 2.82 5.64 3.71z" />
    </Svg>
  );
}

export function PaletteIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="6" />
      <circle cx="5.5" cy="6.5" r="0.8" fill="currentColor" />
      <circle cx="8.5" cy="5" r="0.8" fill="currentColor" />
      <circle cx="10.8" cy="7.6" r="0.8" fill="currentColor" />
    </Svg>
  );
}

/** An error or a warning. */
export function AlertIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8v3.6M8 10.9v.1" />
    </Svg>
  );
}

/** A quiet notice that something happened. */
export function InfoIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.4v3.8M8 5.1v.1" />
    </Svg>
  );
}

/** "All notes": a small stack of sheets. */
export function NotesIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.75" y="4.25" width="8.5" height="9.5" rx="1.25" />
      <path d="M5.25 2.25h6.5a1.5 1.5 0 0 1 1.5 1.5v8" />
    </Svg>
  );
}

/** "General": one sheet with lines, notes that belong to no project. */
export function NoteIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="1.75" width="10" height="12.5" rx="1.25" />
      <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" />
    </Svg>
  );
}

/** Read only. */
export function LockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.25" y="7" width="9.5" height="7" rx="1.25" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </Svg>
  );
}

/** The team level: two people side by side. */
export function TeamIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="6" cy="5.5" r="2.25" />
      <path d="M1.75 13.25c.4-2.3 2-3.5 4.25-3.5s3.85 1.2 4.25 3.5" />
      <path d="M10.75 3.6a2.25 2.25 0 0 1 0 4.3M12 9.9c1.2.45 2 1.55 2.25 3.35" />
    </Svg>
  );
}

/** The private level: one person. */
export function PersonIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="5.25" r="2.5" />
      <path d="M3.25 13.5c.45-2.6 2.25-4 4.75-4s4.3 1.4 4.75 4" />
    </Svg>
  );
}

/** The look "paper": cards in a grid. */
export function PaperLookIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="2" width="5" height="5" rx="1.25" />
      <rect x="9" y="2" width="5" height="5" rx="1.25" />
      <rect x="2" y="9" width="5" height="5" rx="1.25" />
      <rect x="9" y="9" width="5" height="5" rx="1.25" />
    </Svg>
  );
}

/** The look "hangar": a window with a list column and a note under its header. */
export function HangarLookIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <path d="M6.25 2.75v10.5M6.25 6h8" />
    </Svg>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.5v1.25M8 13.25v1.25M1.5 8h1.25M13.25 8h1.25M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" />
    </Svg>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1z" />
    </Svg>
  );
}
