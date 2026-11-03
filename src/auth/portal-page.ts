/** Shared shell for the private sign-in style pages (staff MFA, and future portal pages). */

export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

export function portalPage(opts: {
  title: string;
  heading: string;
  intro: string;
  body: string;
  links?: string;
}): string {
  const { title, heading, intro, body, links = '' } = opts;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="robots" content="noindex"><title>${escapeHtml(title)} · Luminous Agents</title><link rel="stylesheet" href="/static/css/portal.css"></head><body><main class="shell"><aside class="story"><div><div class="brand"><span class="mark">L</span><span>LUMINOUS AGENTS<br><small class="brand-subtitle">INTERNATIONAL BROKERAGE</small></span></div><h1>Good decisions start with <em>trusted access.</em></h1><p>Private access for qualified buyers and a carefully controlled workspace for the team behind each opportunity.</p></div><div class="story-foot">CONFIDENTIAL BY DESIGN · ACCESS IS ROLE-BASED</div></aside><section class="panel"><span class="eyebrow">${escapeHtml(title.toUpperCase())}</span><h2>${escapeHtml(heading)}</h2><p class="muted">${escapeHtml(intro)}</p>${body}<div class="links">${links}</div><p class="fine">Never share your password, verification codes or confidential deal materials by email. Luminous Agents will never ask for them.</p></section></main></body></html>`;
}
