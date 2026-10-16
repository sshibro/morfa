import type {ReactNode} from 'react';
import {BrandMorph} from '../brand/BrandMorph';
import {Lockup} from '../brand/marks';

/** The frame of the screens before the design area (the sign-in, "The server did not respond"): the brand's stage, where the symbol
 *  unfolds once, and the column with the lockup and the screen's own content. `labelledBy` is the id of its heading. */
export function AuthShell({labelledBy, children}: {labelledBy: string; children: ReactNode}) {
  return (
    <main className="mf-auth">
      <div className="mf-auth-stage" aria-hidden="true">
        <BrandMorph motion="once" />
      </div>
      <section className="mf-auth-panel" aria-labelledby={labelledBy}>
        <Lockup className="mf-auth-lockup" />
        <div className="mf-auth-content">{children}</div>
      </section>
    </main>
  );
}
