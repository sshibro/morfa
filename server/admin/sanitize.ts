/* The scrubber every collected text passes: logs and issues. Pure, so
 * code that must not open the database (a report builder, a test) can use it. */
// Partner preview links are bearer tokens: never keep them in logs or issues.
export const HANDOVER_TOKEN = /\/(p|handovers)\/[A-Za-z0-9_-]{24,64}/g;
// "Check by link": the id of a check is a bearer capability (24 random characters, not a UUID), so it is masked like a preview token.
export const SITE_CHECK_ID = /\/site-check\/(?!prefill\b)[A-Za-z0-9_-]{22,64}/g;
export const maskSiteCheckId = (text: string) => text.replace(SITE_CHECK_ID, '/site-check/:id');
// The connector's upload address carries a one-time bearer ticket in its path: never keep it in logs, the activity journal or an issue.
export const UPLOAD_TICKET_PATH = /\/assistant-upload\/[^/?#\s]+/g;
export const maskUploadTicket = (text: string) => text.replace(UPLOAD_TICKET_PATH, '/assistant-upload/:ticket');
// "Morfa" team invite links: the token in `/design-teams/invites/<token>` (and the `designInvite=` query of the link) is a bearer secret.
export const DESIGN_INVITE_PATH = /\/design-teams\/invites\/[A-Za-z0-9_-]{20,}/g;
export const DESIGN_INVITE_QUERY = /([?&]designInvite=)[A-Za-z0-9_-]+/g;
export const maskDesignInvite = (text: string) =>
  text.replace(DESIGN_INVITE_PATH, '/design-teams/invites/:token').replace(DESIGN_INVITE_QUERY, '$1[token]');
export function sanitize(value: unknown, max = 2000): string {
  return String(value ?? '')
    .slice(0, max * 2)
    .replace(HANDOVER_TOKEN, '/$1/[token]')
    .replace(SITE_CHECK_ID, '/site-check/:id')
    .replace(UPLOAD_TICKET_PATH, '/assistant-upload/:ticket')
    .replace(DESIGN_INVITE_PATH, '/design-teams/invites/:token')
    .replace(DESIGN_INVITE_QUERY, '$1[token]')
    .replace(/<[^>]*>/g, '[html]')
    .replace(/https?:\/\/[^\s"'<>]+/g, v => {
      try {
        const u = new URL(v);
        return u.origin + u.pathname.replace(/[a-zA-Z0-9_-]{32,}/g, '[id]');
      } catch {
        return '[url]';
      }
    })
    .replace(/\b(?:Bearer\s+\S+|sk-[\w-]+|eyJ[\w.-]{20,})/gi, '[secret]')
    .replace(
      /["']?\b(password|token|secret|authorization|cookie|prompt|html|email|message|sourceHtml|screenshot)["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1=[redacted]',
    )
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
    .replace(/\b\+?\d[\d ()-]{8,}\d\b/g, '[number]')
    .replace(/\/(?:Users|home)\/[^/\s]+/g, '/[home]')
    .slice(0, max);
}
