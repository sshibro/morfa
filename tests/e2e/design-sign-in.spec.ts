import {randomBytes} from 'node:crypto';
import {test, expect} from './fixtures';

// The way in (src/auth, src/App.tsx): a person types a name and lands on the file browser, like anyone who opens the app. The same
// name is the same account (docs/authentication.md).

const uniqueName = (name: string) => `${name} ${randomBytes(4).toString('hex')}`;

async function signInOnScreen(page: import('@playwright/test').Page, name: string) {
  await expect(page.getByRole('heading', {name: 'Welcome to Morfa', exact: true})).toBeVisible();
  await page.getByRole('textbox', {name: 'Your name'}).fill(name);
  await page.getByRole('button', {name: 'Continue'}).click();
}

test('a new person lands on the file browser, and no file is made for them', async ({page}) => {
  await page.goto('/');
  await signInOnScreen(page, uniqueName('First'));

  await expect(page.getByRole('heading', {name: 'Recent', exact: true})).toBeVisible();
  await expect(page).toHaveURL(/#designs$/);
  await expect(page.getByRole('button', {name: 'Main menu'})).toHaveCount(0);
  const listed = (await (await page.request.get('/api/design-files')).json()) as {files: unknown[]};
  expect(listed.files).toHaveLength(0);
});

test('a person with files lands on the file browser with their files, not inside one of them', async ({page, browser, baseURL}) => {
  const name = uniqueName('Returning');
  const earlier = await browser.newContext({baseURL});
  expect((await earlier.request.post('/api/auth/name', {data: {name}})).ok(), 'The name sign-in').toBeTruthy();
  await earlier.request.post('/api/design-files', {data: {name: 'Old mockup'}});
  await earlier.request.post('/api/design-files', {data: {name: 'Latest mockup'}});
  await earlier.close();

  await page.goto('/');
  // Another spelling of the same name opens the same account.
  await signInOnScreen(page, `  ${name.toUpperCase()} `);

  await expect(page.getByRole('heading', {name: 'Recent', exact: true})).toBeVisible();
  await expect(page).toHaveURL(/#designs$/);
  await expect(page.locator('.dz-file')).toHaveCount(2);
});

test('a name the server cannot take is explained on the screen', async ({page}) => {
  await page.goto('/');
  await signInOnScreen(page, '   ');

  await expect(page.getByRole('alert')).toContainText('Enter your name.');
  await expect(page.getByRole('heading', {name: 'Welcome to Morfa', exact: true})).toBeVisible();
});

test('the sign-in screen and the file browser carry the product’s own mark', async ({page}) => {
  await page.goto('/');
  await expect(page.getByRole('img', {name: 'Morfa'})).toBeVisible();

  await signInOnScreen(page, uniqueName('Mark'));

  await expect(page.locator('.dz-files-product').getByRole('img', {name: 'Morfa'})).toBeVisible();
});
