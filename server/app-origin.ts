/** The app on Vite's port, where development runs it (vite.config.ts proxies /api to the API). */
const DEV_APP_ORIGIN = 'http://127.0.0.1:5400';

/** The origin the app is served from: APP_ORIGIN (https in production), else the development app's. */
export const appOrigin = (env: NodeJS.ProcessEnv = process.env) => env.APP_ORIGIN || DEV_APP_ORIGIN;
