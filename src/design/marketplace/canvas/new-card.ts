// "New file ▾ → Marketplace card": what the chooser hands the new-file menu (NewCardChooser.tsx).

import {marketplaceSpec, type Marketplace} from '../../../../shared/design/marketplace/specs';

export type NewCardChoice = {marketplace: Marketplace; set: 'single' | 'kit'};

/** The new file's name: "WB card", "Ozon cards". */
export const newCardFileName = (choice: NewCardChoice) => `${marketplaceSpec(choice.marketplace).short} ${choice.set === 'kit' ? 'cards' : 'card'}`;
