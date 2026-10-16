// "Favorites", Figma's "Starred" (docs/figma-parity-shell.md): what `/api/design-favourites` answers. Only the account that starred
// a file or a project sees the star; the list holds only what it may still open (a file in the trash or of a team it left drops out).

export type DesignFavouriteFile = {id: string; name: string; kind: 'design' | 'board'; teamId: string | null};
export type DesignFavouriteProject = {id: string; name: string; teamId: string};
export type DesignFavourites = {files: DesignFavouriteFile[]; projects: DesignFavouriteProject[]};
