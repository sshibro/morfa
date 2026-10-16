import {expect, type CDPSession, type Page} from '@playwright/test';
import type {DesignDocument, SceneNode} from '../../shared/design/types';
import {waitEditorReady} from './fixtures';

// Phone helpers for tests/e2e/design-phone-*.spec.ts: an iPhone-sized page with touch, and
// touches sent through CDP, so two fingers reach the canvas as the phone's browser sends them.

/** 390 × 844 (an iPhone 14), touch, a mobile browser, 3× pixels. */
export const PHONE = {viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true, deviceScaleFactor: 3} as const;
/** A large iPhone viewport (440 × 956). */
export const OWNER_PHONE = {width: 440, height: 956} as const;

export type Pt = {x: number; y: number};

/** Touches by CDP (Input.dispatchTouchEvent): one or more fingers moving together, in steps. */
export class Fingers {
  private constructor(private readonly cdp: CDPSession) {}

  static async on(page: Page) {
    return new Fingers(await page.context().newCDPSession(page));
  }

  private send(type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', points: readonly Pt[]) {
    const touchPoints = points.map((point, id) => ({x: point.x, y: point.y, id, radiusX: 4, radiusY: 4, force: 1}));
    return this.cdp.send('Input.dispatchTouchEvent', {type, touchPoints});
  }

  down(points: readonly Pt[]) { return this.send('touchStart', points); }
  move(points: readonly Pt[]) { return this.send('touchMove', points); }
  up() { return this.send('touchEnd', []); }

  /** Fingers from `from` to `to` (same count), in `steps` moves, then lifted. */
  async drag(from: readonly Pt[], to: readonly Pt[], steps = 8) {
    await this.down(from);
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      await this.move(from.map((a, i) => ({x: a.x + (to[i].x - a.x) * t, y: a.y + (to[i].y - a.y) * t})));
    }
    // Rest before lifting: a drag, not a flick (Chromium answers a flick with a fling that eats the next tap).
    await new Promise(resolve => setTimeout(resolve, 120));
    await this.move(to);
    await this.up();
  }

  async tap(point: Pt) {
    await this.down([point]);
    await this.up();
  }
}

/** A new empty design file from the file browser; returns its id and the canvas. */
export async function openNewPhoneFile(page: Page) {
  await page.goto('/#designs');
  await page.getByRole('button', {name: 'New file', exact: true}).first().click();
  await expect(page).toHaveURL(/#design\/[^/?]+$/);
  const canvas = page.getByRole('application', {name: 'Canvas'});
  await expect(canvas).toBeVisible();
  await waitEditorReady(page);
  const id = decodeURIComponent(new URL(page.url()).hash.slice('#design/'.length).split('?')[0]);
  return {id, canvas};
}

/** With MORFA_PH_SHOTS=<suffix> set, a 1× screenshot into output/phone-shots/<name>-<suffix>.png (gitignored). */
export async function shot(page: Page, name: string) {
  const suffix = process.env.MORFA_PH_SHOTS;
  if (suffix) await page.screenshot({path: `output/phone-shots/${name}-${suffix}.png`, scale: 'css'});
}

export type SavedFile = {file: {name: string; version: number}; document: DesignDocument};

export async function savedFile(page: Page, id: string): Promise<SavedFile> {
  const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as SavedFile;
}

export const nodesOf = (file: SavedFile, type: SceneNode['type']) => Object.values(file.document.nodes).filter(node => node.type === type);

/** Picks a tool from the bottom bar (it scrolls sideways when the tools do not fit). */
export async function pickTool(page: Page, label: string) {
  await page.getByRole('toolbar', {name: 'Tools'}).locator('.dz-tool').and(page.getByRole('button', {name: label, exact: true})).tap();
}

/** The saved state settles ("Saved" in the top bar). */
export const waitSaved = (page: Page) => expect(page.getByRole('status').filter({hasText: 'Saved'})).toBeVisible();
