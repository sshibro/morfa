import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
// Only what the sign-in needs loads here; the design area brings its own font and styles (src/design/DesignRoot.tsx).
import '@fontsource-variable/inter';
// The brand's display face for the screens before the design area.
import '@fontsource-variable/wix-madefor-display';
import './brand/brand.css';
import './shell.css';
import './auth/auth.css';
import {PRODUCT_NAME} from '../shared/design/product';
import {App} from './App';
import {startDesktop} from './desktop/host';

document.title = PRODUCT_NAME;
// In the desktop app only: its bridge loads beside the app (docs/desktop.md); a browser loads nothing more.
void startDesktop();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
