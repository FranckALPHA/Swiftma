// Icônes en SVG (trait 1.5 px, 16×16), dans l'esprit des interfaces d'outils de design.

type P = { size?: number };
const svg = (path: React.ReactNode) =>
  function Icon({ size = 16 }: P) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        {path}
      </svg>
    );
  };

export const IconCursor = svg(<path d="M3.5 2.5l9 4.2-3.9 1.2-1.6 3.8z" fill="currentColor" stroke="none" />);
export const IconFrame = svg(<path d="M5 2v12M11 2v12M2 5h12M2 11h12" />);
export const IconRect = svg(<rect x="2.5" y="2.5" width="11" height="11" rx="1" />);
export const IconEllipse = svg(<circle cx="8" cy="8" r="5.5" />);
export const IconText = svg(<path d="M3 3.5h10M8 3.5v9.5M6 13h4" />);
export const IconHand = svg(<path d="M5.5 8V3.8a1 1 0 0 1 2 0V7.5M7.5 7V3a1 1 0 0 1 2 0v4M9.5 7V4a1 1 0 0 1 2 0v5.5c0 2.5-1.6 4-4 4h-.5c-1.5 0-2.4-.6-3.2-1.7L2.6 9.5a1 1 0 0 1 1.6-1.2L5.5 9.5" />);
export const IconSparkle = svg(<path d="M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z" />);
export const IconFile = svg(<path d="M4 1.8h5l3 3v9.4H4zM9 1.8v3h3" />);
export const IconCode = svg(<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" />);
export const IconPlus = svg(<path d="M8 3v10M3 8h10" />);
export const IconMinus = svg(<path d="M3 8h10" />);
export const IconEye = svg(<><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="1.8" /></>);
export const IconEyeOff = svg(<path d="M2 2l12 12M6.6 4c.4-.3.9-.5 1.4-.5 4 0 6.5 4.5 6.5 4.5a12 12 0 0 1-1.7 2.2M10.5 11.6c-.8.6-1.6.9-2.5.9-4 0-6.5-4.5-6.5-4.5a11 11 0 0 1 2.4-2.9" />);
export const IconLock = svg(<><rect x="3.5" y="7" width="9" height="6.5" rx="1" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></>);
export const IconUnlock = svg(<><rect x="3.5" y="7" width="9" height="6.5" rx="1" /><path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.6" /></>);
export const IconChevron = svg(<path d="M4.5 6.5L8 10l3.5-3.5" />);
export const IconCaretRight = svg(<path d="M6.5 4.5L10 8l-3.5 3.5" />);
export const IconCaretDown = svg(<path d="M4.5 6.5L8 10l3.5-3.5" />);
export const IconPlug = svg(<path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3" />);
export const IconHelp = svg(<><circle cx="8" cy="8" r="6" /><path d="M6.3 6.3a1.8 1.8 0 0 1 3.4.6c0 1.2-1.7 1.5-1.7 2.6M8 11.4v.1" /></>);
export const IconUndo = svg(<path d="M4 6h6a3 3 0 0 1 0 6H6M6.5 3.5L4 6l2.5 2.5" />);
export const IconRedo = svg(<path d="M12 6H6a3 3 0 0 0 0 6h4M9.5 3.5L12 6 9.5 8.5" />);
export const IconDownload = svg(<path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" />);

export const IconPen = svg(<path d="M8 2l4 6-4 6-4-6zM8 2v5M2.5 14h11" />);
export const IconImage = svg(<><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><circle cx="5.8" cy="6" r="1.2" /><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3" /></>);
export const IconImport = svg(<path d="M8 10V2.5M4.5 6L8 2.5 11.5 6M2.5 9.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3" />);

export const IconComponent = svg(<path d="M8 1.8l2.2 2.2L8 6.2 5.8 4zM8 9.8l2.2 2.2L8 14.2 5.8 12zM4 5.8l2.2 2.2L4 10.2 1.8 8zM12 5.8l2.2 2.2-2.2 2.2L9.8 8z" />);
export const IconInstance = svg(<path d="M8 2l6 6-6 6-6-6z" />);

export const IconLogo = ({ size = 20 }: P) => (
  <svg width={size} height={size} viewBox="0 0 20 20">
    <rect width="20" height="20" rx="5" fill="#0D99FF" />
    <path d="M10 3.5l1.6 4.9 4.9 1.6-4.9 1.6L10 16.5l-1.6-4.9L3.5 10l4.9-1.6z" fill="#fff" />
  </svg>
);
