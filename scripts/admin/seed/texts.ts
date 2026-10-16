// What the demo people are called and what they write: first names and surnames with the address they get, names of teams,
// projects and files, comment texts.
import type {Random} from './random';

/** The demo accounts' mail domain: `.example` is reserved (RFC 2606), so no address here can ever reach a person. */
export const DEMO_DOMAIN = 'demo.example';

const MEN: readonly string[] = [
  'Alexander', 'Daniel', 'Maxwell', 'Samuel', 'Andrew', 'Alex', 'Arthur', 'Ethan', 'Kyle', 'Michael', 'Nathan', 'Matthew',
  'Roman', 'Edward', 'Ivan', 'Paul', 'Dennis', 'Timothy', 'Gabriel', 'Victor', 'Connor', 'Russell', 'George', 'Leo',
];
const WOMEN: readonly string[] = [
  'Anna', 'Maria', 'Helen', 'Daisy', 'Alina', 'Irene', 'Katherine', 'Pauline', 'Olivia', 'Natalie', 'Julia', 'Victoria',
  'Kelsey', 'Sophia', 'Anastasia', 'Tessa', 'Veronica', 'Aria', 'Christina', 'Valerie', 'Uma', 'Eve', 'Marina', 'Jane',
];
const SURNAMES: readonly string[] = [
  'Smith', 'Johnson', 'Cooper', 'Taylor', 'Walker', 'Lee', 'Foster', 'Newman', 'Morris', 'Peterson', 'Wolfe', 'Sullivan',
  'Wilson', 'Zimmerman', 'Powell', 'Sanders', 'Goldman', 'Vincent', 'Bogart', 'Ford', 'Fedor', 'Mitchell', 'Bell', 'Turner',
  'White', 'Kramer', 'Ortiz', 'Kessler', 'Mackay', 'Anderson', 'Kowalski', 'Hill', 'Gray', 'Tate', 'Kuhn', 'Curtis',
  'Barnes', 'Kelly', 'Allen', 'Stevens', 'Jacobs', 'Sorensen', 'Sergeant', 'Roman', 'Zachary', 'Burke', 'Cole', 'Gerard',
];

export type Person = {name: string; firstName: string; email: string};

/** A person with an address no other demo account has (`taken` holds the local parts used so far). */
export function person(rng: Random, taken: Set<string>): Person {
  const woman = rng.chance(0.52);
  const first = rng.pick(woman ? WOMEN : MEN);
  const last = rng.pick(SURNAMES);
  const firstLatin = first.toLowerCase(),
    lastLatin = last.toLowerCase();
  const shapes = [
    `${firstLatin}.${lastLatin}`,
    `${firstLatin[0]}${lastLatin}`,
    `${firstLatin}_${lastLatin}`,
    `${lastLatin}.${firstLatin[0]}`,
    `${firstLatin}${rng.int(80, 99)}`,
    `${firstLatin}.${lastLatin}${rng.int(1, 9)}`,
    `${lastLatin}.design`,
    `${firstLatin}.ux`,
  ];
  let local = rng.pick(shapes);
  while (taken.has(local)) local = `${rng.pick(shapes)}${rng.int(2, 999)}`;
  taken.add(local);
  // Most people write their name as it is; some keep the first name only, a few a studio-ish handle.
  const name = rng.weighted<string>([
    [`${first} ${last}`, 0.78],
    [first, 0.14],
    [`${first[0]}. ${last}`, 0.08],
  ]);
  return {name, firstName: first, email: `${local}@${DEMO_DOMAIN}`};
}

export const TEAM_NAMES = [
  'North Studio',
  'Pixel & Co',
  'Product team',
  'Design department',
  'Marketing',
  'Line Bureau',
  'Mobile app team',
  'Square Agency',
  'Freelance bureau',
  'Mint Studio',
  'Brand team',
  'UX lab',
  'Website team',
  'Ochre Studio',
  'Digital team',
  'Design school',
  'Lotto startup',
  'Online store',
  'Editorial',
  'Platform team',
  'Graphite Studio',
  'Creative department',
  'Wave Agency',
  'Onboarding team',
  'Warm Light Studio',
  'Search team',
] as const;

export const PROJECT_NAMES = [
  'Website',
  'Mobile app',
  'Branding',
  'Landing pages',
  'Social media',
  'Design system',
  'Presentations',
  'Customer account',
  'Ad banners',
  'Research',
] as const;

export const FILE_NAMES = [
  'Untitled',
  'Coffee shop landing',
  'Mobile app — onboarding',
  'Banners for Instagram',
  'Investor presentation',
  'Customer account',
  'Product card',
  'Home page',
  'Icons',
  'Stories for Instagram',
  'Business card layout',
  'Design system',
  'Order form',
  'Cart and checkout',
  'Email newsletter',
  'Logo — options',
  'Portfolio',
  'Restaurant menu',
  'Sign-in screen',
  'App prototype',
  'YouTube covers',
  'Event poster',
  'Catalog',
  'Admin panel',
  'Wireframes',
  'Yoga studio website',
  'Profile redesign',
  'Checkout',
  'Dashboard',
  'Marketplace pack',
] as const;

export const BOARD_NAMES = [
  'Board: sprint retro',
  'Brainstorm',
  'User journey map',
  'Quarter planning',
  'Idea board',
  'Competitor research',
  'Client workshop',
  'Untitled',
] as const;

export const LIBRARY_FILE_NAMES = [
  'Design system',
  'UI Kit',
  'Components',
  'Icons and buttons',
  'Brand library',
] as const;

export const VERSION_LABELS = [
  'Client version',
  'Before edits',
  'Final',
  'v2',
  'Approved',
  'After review',
  'Draft',
  'Sent to the client',
] as const;

export const COMMENT_THREADS = [
  'The padding here is larger than in the other cards',
  'Can we make the button higher contrast?',
  'The heading font does not match the guide',
  'Let us try a different background color',
  'The icon looks blurry',
  'This block works better higher up',
  'The text does not fit on mobile',
  'We need a dark theme variant',
  'Approved, ready for development',
  'The error state is missing',
  'The caption text is too small',
  'I suggest removing this screen from the flow',
  'What will the empty state look like?',
  'Please check the alignment to the grid',
  'Great option!',
] as const;

export const COMMENT_REPLIES = [
  'Fixed',
  'Agreed, fixing it now',
  'Done, take a look',
  'Made two options side by side',
  'Not sure, shall we discuss on a call?',
  'Yes, that is better',
  'Let us keep it, it follows the guide',
  'OK',
  'Thanks!',
  'Added it to the next frame',
] as const;
