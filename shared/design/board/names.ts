// "Board" (docs/board.md): the product's words in one place, so the owner can rename the board (the working name) by
// changing this file. Everything the user reads about the file kind takes its name from here.

export const BOARD_NAMES = {
  /** The file kind, as a noun: "Board". */
  product: 'Board',
  /** "New board" (the file browser's button). */
  create: 'New board',
  /** A new board's name before it is renamed. */
  untitled: 'Untitled board',
  /** In sentences: "board", "board's", "board". */
  one: 'board',
  genitive: 'board',
  accusative: 'board',
  /** The filter and the section of the file browser. */
  many: 'Boards',
} as const;
