// Formats de frame prêts à l'emploi (outil Frame), en points CSS comme dans les outils de design pro.

export interface FramePreset { name: string; w: number; h: number }
export interface FramePresetGroup { title: string; presets: FramePreset[] }

export const FRAME_PRESETS: FramePresetGroup[] = [
  {
    title: "Téléphone",
    presets: [
      { name: "iPhone 16", w: 393, h: 852 },
      { name: "iPhone 16 Pro Max", w: 440, h: 956 },
      { name: "iPhone SE", w: 375, h: 667 },
      { name: "Android compact", w: 412, h: 917 },
      { name: "Android moyen", w: 360, h: 800 },
    ],
  },
  {
    title: "Tablette",
    presets: [
      { name: "iPad mini", w: 744, h: 1133 },
      { name: "iPad Pro 11\"", w: 834, h: 1194 },
      { name: "iPad Pro 13\"", w: 1032, h: 1376 },
      { name: "Tablette Android", w: 800, h: 1280 },
    ],
  },
  {
    title: "Ordinateur",
    presets: [
      { name: "MacBook Air", w: 1280, h: 832 },
      { name: "MacBook Pro 14\"", w: 1512, h: 982 },
      { name: "MacBook Pro 16\"", w: 1728, h: 1117 },
      { name: "Bureau", w: 1440, h: 1024 },
      { name: "Bureau Full HD", w: 1920, h: 1080 },
    ],
  },
  {
    title: "Réseaux sociaux",
    presets: [
      { name: "Publication carrée", w: 1080, h: 1080 },
      { name: "Publication portrait", w: 1080, h: 1350 },
      { name: "Story / Reel / Statut", w: 1080, h: 1920 },
      { name: "Publication Facebook", w: 1200, h: 630 },
      { name: "Publication LinkedIn", w: 1200, h: 627 },
      { name: "Publication X", w: 1600, h: 900 },
      { name: "Miniature YouTube", w: 1280, h: 720 },
      { name: "Bannière LinkedIn", w: 1584, h: 396 },
    ],
  },
  {
    title: "Présentation",
    presets: [
      { name: "Diapositive 16:9", w: 1920, h: 1080 },
      { name: "Diapositive 4:3", w: 1024, h: 768 },
    ],
  },
  {
    title: "Impression",
    presets: [
      { name: "A4", w: 595, h: 842 },
      { name: "A5", w: 420, h: 595 },
      { name: "Carte de visite", w: 241, h: 156 },
      { name: "Affiche A3", w: 842, h: 1191 },
    ],
  },
];
