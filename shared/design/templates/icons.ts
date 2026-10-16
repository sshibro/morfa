// Line icons of the starter templates: SVG path data on a 24-unit grid, drawn for a 2 px stroke with
// round caps and joins (the builder scales them into the icon's box). Drawn for these templates; the
// shapes are the plain ones every icon set shares (a house, a magnifier, a heart).

export const ICONS = {
  home: ['M3.5 10.2 12 3.5l8.5 6.7V19a1.5 1.5 0 0 1-1.5 1.5h-4.25v-6h-5.5v6H5A1.5 1.5 0 0 1 3.5 19Z'],
  search: ['M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z', 'M20.5 20.5 16.05 16.05'],
  heart: ['M12 20.25s-8.25-4.7-8.25-10.6A4.65 4.65 0 0 1 8.4 5c1.55 0 2.85.75 3.6 2 .75-1.25 2.05-2 3.6-2a4.65 4.65 0 0 1 4.65 4.65c0 5.9-8.25 10.6-8.25 10.6Z'],
  user: ['M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z', 'M4.5 20.5c.9-3.5 3.9-5.5 7.5-5.5s6.6 2 7.5 5.5'],
  plus: ['M12 5v14', 'M5 12h14'],
  check: ['M5 12.5 9.5 17 19 7.5'],
  chevronRight: ['M9.5 6 15.5 12l-6 6'],
  chevronDown: ['M6 9.5 12 15.5l6-6'],
  arrowLeft: ['M19 12H5', 'M11 6 5 12l6 6'],
  arrowRight: ['M5 12h14', 'M13 6l6 6-6 6'],
  bell: ['M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15Z', 'M10 21a2.1 2.1 0 0 0 4 0'],
  lock: ['M6 11h12v9.5H6Z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
  moon: ['M20 14.6A8.5 8.5 0 1 1 9.4 4a7 7 0 0 0 10.6 10.6Z'],
  message: ['M4.5 5.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4.5 3.5v-3.5h-1a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z'],
  bookmark: ['M6.5 4h11v16.5L12 16.5l-5.5 4Z'],
  share: ['M12 15V3.5', 'M7.5 8 12 3.5 16.5 8', 'M5 12.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-6.5'],
  bolt: ['M13 2.5 4.5 13.5H11l-1 8 8.5-11H12Z'],
  shield: ['M12 3 19.5 6v5.6c0 4.4-3.1 8.3-7.5 9.4-4.4-1.1-7.5-5-7.5-9.4V6Z', 'M8.75 12.25 11 14.5l4.25-4.5'],
  chart: ['M4.5 20.5h15', 'M7 17v-5', 'M12 17V7', 'M17 17v-8'],
  calendar: ['M4.5 6h15v14.5h-15Z', 'M4.5 10.5h15', 'M8.5 3.5v4', 'M15.5 3.5v4'],
  globe: ['M20.5 12a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0Z', 'M3.5 12h17', 'M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5Z'],
  star: ['M12 3.5 14.6 8.8l5.9.85-4.25 4.15 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.65l5.9-.85Z'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  mail: ['M3.5 6h17v12h-17Z', 'M3.5 6.5 12 13l8.5-6.5'],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof ICONS;
