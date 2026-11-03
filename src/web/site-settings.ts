import type { Env } from '../env';
import { BRAND } from '../brand/defaults';
import { brandUrl, DEFAULT_CHAIRMAN_IMAGE, type SocialInputs } from './branding';
import { listSettingsByKeys } from '../admin/repos/settings-repo';

export interface ContactSettings {
  phoneMobile: string;
  phoneOffice: string;
  email: string;
  chairmanEmail: string;
  whatsapp: string;
  /** Profile, social and widget values (PHP-edition parity). All optional so existing callers are unaffected. */
  whatsappMessage?: string;
  emailWidgetAddress?: string;
  instagramUrl?: string;
  linkedinUrl?: string;
  chairmanName?: string;
  chairmanTitle?: string;
  chairmanBio?: string;
  chairmanExpertise?: string;
  chairmanLanguages?: string;
  chairmanImage?: string;
  chairmanImageAlt?: string;
}

/** Used when a setting has not been edited in the dashboard (and seeded by migration 0018). */
export const DEFAULT_CONTACT: ContactSettings = {
  phoneMobile: '+44 (0) 781 702 7077',
  phoneOffice: '+44 (0) 1424 221226',
  email: BRAND.email,
  chairmanEmail: BRAND.chairmanEmail,
  whatsapp: '447817027077',
};

const KEYS = {
  contact_phone_mobile: 'phoneMobile',
  contact_phone_office: 'phoneOffice',
  contact_email: 'email',
  contact_email_chairman: 'chairmanEmail',
  whatsapp_number: 'whatsapp',
} as const satisfies Record<string, keyof ContactSettings>;

/** Profile and social settings: key -> [field, maximum length]. Empty values are ignored (built-in text stays). */
const EXTRA_KEYS = {
  whatsapp_message: ['whatsappMessage', 500],
  email_widget_address: ['emailWidgetAddress', 254],
  instagram_url: ['instagramUrl', 300],
  linkedin_url: ['linkedinUrl', 300],
  chairman_name: ['chairmanName', 120],
  chairman_title: ['chairmanTitle', 200],
  chairman_bio: ['chairmanBio', 4000],
  chairman_expertise: ['chairmanExpertise', 1500],
  chairman_languages: ['chairmanLanguages', 200],
  chairman_image_url: ['chairmanImage', 500],
  chairman_image_alt: ['chairmanImageAlt', 160],
} as const;

export const DEFAULT_CHAIRMAN = {
  name: 'Brian Minister',
  title: 'Chairman, Luminous Agents',
  bio: 'We opened our first office in London in 1994 with only two casinos for sale. Today we present a worldwide portfolio of land-based casino and casino-hotel opportunities, with prices from under $1 million to over $1 billion.\n\nIf you wish to discuss any casino for sale or casino hotel personally, please contact me directly. Every enquiry is treated in strict confidence, and opportunities are advertised in a way that protects the identity and location of the property.',
};

/** Inputs for the social icon helpers, from loaded contact settings. */
export function socialInputs(contact: ContactSettings, emailOverride = ''): SocialInputs {
  return {
    whatsapp: contact.whatsapp,
    whatsappMessage: contact.whatsappMessage ?? '',
    emails: [emailOverride, contact.emailWidgetAddress ?? '', contact.email],
    instagram: contact.instagramUrl ?? '',
    linkedin: contact.linkedinUrl ?? '',
  };
}

/** Chairman portrait: configured image (site path or https) or the built-in photo. */
export const chairmanImage = (contact: ContactSettings): string =>
  brandUrl(contact.chairmanImage) || DEFAULT_CHAIRMAN_IMAGE;

export async function loadContact(env: Env): Promise<ContactSettings> {
  const contact: ContactSettings = { ...DEFAULT_CONTACT };
  const keys = [...Object.keys(KEYS), ...Object.keys(EXTRA_KEYS)];
  try {
    const rows = await listSettingsByKeys(env.DB, keys);
    for (const row of rows) {
      try {
        const parsed: unknown = JSON.parse(row.value);
        if (typeof parsed !== 'string' || !parsed.trim()) continue;
        if (row.key in KEYS) {
          contact[KEYS[row.key as keyof typeof KEYS]] = parsed.trim().slice(0, 120);
        } else if (row.key in EXTRA_KEYS) {
          const [field, max] = EXTRA_KEYS[row.key as keyof typeof EXTRA_KEYS];
          contact[field] = parsed.trim().slice(0, max);
        }
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
