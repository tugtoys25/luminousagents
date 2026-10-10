import type { Env } from '../env';

export interface ContactSettings {
  phoneMobile: string;
  phoneOffice: string;
  email: string;
  chairmanEmail: string;
  whatsapp: string;
}

/** Used when a setting has not been edited in the dashboard (and seeded by migration 0018). */
export const DEFAULT_CONTACT: ContactSettings = {
  phoneMobile: '+44 (0) 781 702 7077',
  phoneOffice: '+44 (0) 1424 221226',
  email: 'casinosofmayfair@btinternet.com',
  chairmanEmail: 'briancasinosofmayfair@gmail.com',
  whatsapp: '447817027077',
};

const KEYS = {
  contact_phone_mobile: 'phoneMobile',
  contact_phone_office: 'phoneOffice',
  contact_email: 'email',
  contact_email_chairman: 'chairmanEmail',
  whatsapp_number: 'whatsapp',
} as const satisfies Record<string, keyof ContactSettings>;

export async function loadContact(env: Env): Promise<ContactSettings> {
  const contact = { ...DEFAULT_CONTACT };
  try {
    const rows = await env.DB.prepare(
      `SELECT setting_key AS key, value_json AS value FROM platform_settings WHERE setting_key IN (${Object.keys(
        KEYS,
      )
        .map(() => '?')
        .join(',')})`,
    )
      .bind(...Object.keys(KEYS))
      .all<{ key: keyof typeof KEYS; value: string }>();
    for (const row of rows.results ?? []) {
      try {
        const parsed: unknown = JSON.parse(row.value);
        if (typeof parsed === 'string' && parsed.trim())
          contact[KEYS[row.key]] = parsed.trim().slice(0, 120);
      } catch {
        /* keep default */
      }
    }
  } catch {
    /* settings table unavailable: keep defaults */
  }
  return contact;
}

/** tel: href from a display number such as "+44 (0) 781 702 7077". */
export const telHref = (value: string): string =>
  `tel:${value.replace(/\(0\)/g, '').replace(/[^\d+]/g, '')}`;
