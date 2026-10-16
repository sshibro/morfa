// Limits of the design tool: what one account may keep, and the hard caps that protect the server. There are no plans:
// every account gets the same numbers. No zod and no server imports, so the app and the server read the same values.

export type DesignLimits = {
  /** Pictures uploaded into design files, bytes. */
  storageBytes: number;
  /** Automatic and named versions older than this are pruned. */
  historyDays: number;
  /** Days a file stays in the trash before it is erased. */
  trashDays: number;
};

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** What every account may keep: the one source the server's checks and the app read. Files, versions, projects and teams are not limited by count here. */
export const DESIGN_LIMITS: DesignLimits = {storageBytes: 20 * GB, historyDays: 365, trashDays: 365};

/** Hard caps that hold for every account: they protect the server. */
export const DESIGN_DOCUMENT_CAPS = {
  nodes: 50_000,
  /** Serialized JSON of one file. */
  bytes: 20 * MB,
  /** Serialized JSON of an account's files and saved versions together, the trash included. Automatic versions
   *  give way to new work, oldest first; a version, a copy or a file is refused when the rest alone fills it. */
  accountBytes: 5 * GB,
  pages: 200,
  /** One uploaded picture. */
  imageBytes: 20 * MB,
  imagePixels: 64_000_000,
  thumbnailBytes: 512 * 1024,
} as const;

/** The caps with the big-files switch on (`shared/design/big-files.ts`, docs/decisions/big-files.md §1): a safety net
 *  against hostile input, not the product limit — that is the browser tab's memory budget, as at Figma (no published layer
 *  cap, 2 GB per tab). `bytes` is one JSON text of the whole document: V8 cannot hold a string past about 1 GiB, and a
 *  file near it is only ever moved page by page (the skeleton and page slices), never as one body. */
export const DESIGN_BIG_FILE_CAPS = {
  nodes: 2_000_000,
  bytes: GB,
  pages: 1_000,
} as const;
