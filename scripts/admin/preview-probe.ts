// A probe for the console preview: lists the elements that stick out past the workspace's right edge at a width
// (`npx tsx scripts/admin/preview-probe.ts '#admin' 390 [shot.png]`), and saves the first screen when a path is given. Uses the
// preview's fixtures and API interception.
import {chromium} from 'playwright';
import {NOW} from './fixtures';
import {executablePath, intercept} from './preview';

const [hash = '#admin', width = '390', shot] = process.argv.slice(2);
const executable = executablePath();
const browser = await chromium.launch({headless: true, args: ['--no-sandbox'], ...(executable ? {executablePath: executable} : {})});
const page = await browser.newPage({viewport: {width: Number(width), height: 844}});
await page.clock.setFixedTime(new Date(NOW));
await intercept(page);
await page.goto('http://127.0.0.1:5480/' + hash);
await page.waitForTimeout(2500);
const found = await page.evaluate(() => {
  const work = document.querySelector('.mfa-work') as HTMLElement;
  const edge = work.getBoundingClientRect().right;
  const out: string[] = [];
  for (const node of Array.from(work.querySelectorAll('*'))) {
    const box = node.getBoundingClientRect();
    if (box.right > edge + 1 && box.width > 0) {
      const parent = node.parentElement;
      if (parent && parent.getBoundingClientRect().right > edge + 1) continue;
      out.push(`${node.tagName.toLowerCase()}.${(node.getAttribute('class') ?? '').split(' ').join('.')} right=${Math.round(box.right)} width=${Math.round(box.width)}`);
    }
  }
  return {edge, scroll: work.scrollWidth, client: work.clientWidth, out: out.slice(0, 20)};
});
console.log(JSON.stringify(found, null, 1));
if (shot) await page.screenshot({path: shot});
await browser.close();
