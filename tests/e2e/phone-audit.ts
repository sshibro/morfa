import type {Page} from '@playwright/test';

// Phone checks the shell's specs share: the sizes, a touch context, and what a screen must not do on
// a phone (scroll sideways, put a control under a thumb's 44 px, reach past the screen's edge).

export const PHONE_SIZES = [
  {name: '360', width: 360, height: 740},
  {name: '390', width: 390, height: 844},
  {name: '440', width: 440, height: 956},
  {name: '768', width: 768, height: 1024},
] as const;

export const PHONE = {viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true} as const;

/** The smallest side a control may have on a phone (Apple's and Material's guidance, rounded to Apple's). */
export const TAP_MIN = 44;

export type PhoneAudit = {overflow: number; small: string[]; offscreen: string[]};

/** What on the page breaks a phone: the document wider than the screen, controls under `TAP_MIN`, things past an edge. */
export function auditPhone(page: Page, scope = 'body'): Promise<PhoneAudit> {
  return page.evaluate(({scope, min}) => {
    const root = document.scrollingElement ?? document.documentElement;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const describe = (element: Element) => {
      const label = element.getAttribute('aria-label') || (element.textContent ?? '').trim().slice(0, 24) || element.className.toString().slice(0, 40);
      const box = element.getBoundingClientRect();
      return `${element.tagName.toLowerCase()} «${label}» ${Math.round(box.width)}×${Math.round(box.height)}`;
    };
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.opacity !== '0' && !element.closest('[inert],[aria-hidden="true"]');
    };
    const controls = [...document.querySelectorAll(`${scope} :is(button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=menuitem], [role=tab], [role=option], [role=menuitemradio], [role=menuitemcheckbox])`)]
      .filter(visible)
      .filter(element => !element.closest('.dz-file') || element.matches('.dz-file-more'));
    const small = controls.filter(element => {
      const box = element.getBoundingClientRect();
      // Text links inside a sentence are read, not aimed at; their line is their target.
      if (element.matches('p a, li a:not([class])')) return false;
      return box.width < min - 0.5 || box.height < min - 0.5;
    }).map(describe);
    const offscreen = controls.filter(element => {
      const box = element.getBoundingClientRect();
      return box.right > width + 0.5 || box.left < -0.5 || box.bottom > height + 0.5 && getComputedStyle(element).position === 'fixed';
    }).map(describe);
    return {overflow: root.scrollWidth - root.clientWidth, small, offscreen};
  }, {scope, min: TAP_MIN});
}
