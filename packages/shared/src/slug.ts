/** URL-safe slug for public pages, e.g. "Glow Salon & Spa" -> "glow-salon-spa". */
export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return s || 'business';
}

export const RESERVED_SLUGS = new Set(['admin', 'api', 'app', 'login', 'bridge', 'onboarding', 'inbox', 'manage', 'b', 'www', 'orbit', 'help', 'support', 'static', 'widget', 'icons', 'ws']);
