'use client';

/**
 * Meta's own popups for one-click connect: WhatsApp Embedded Signup and
 * Facebook Login for Business (Pages + Instagram). The browser only ever gets a
 * short-lived code; Orbit's server swaps it for tokens.
 */
export interface MetaSetup {
  oneClick: { whatsapp: boolean; pages: boolean };
  appId: string | null;
  version: string;
  whatsappConfigId: string | null;
  loginConfigId: string | null;
}

declare global {
  interface Window {
    FB?: any;
    fbAsyncInit?: () => void;
  }
}

let sdk: Promise<any> | null = null;

function loadSdk(appId: string, version: string): Promise<any> {
  if (sdk) return sdk;
  sdk = new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(window.FB);
    };
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.async = true;
    s.defer = true;
    s.crossOrigin = 'anonymous';
    s.onerror = () => {
      sdk = null;
      reject(new Error('Could not load Facebook. Check your connection and try again.'));
    };
    document.body.appendChild(s);
  });
  return sdk;
}

/** Only messages from Facebook itself (exact host match, not "anything ending in facebook.com"). */
function fromFacebook(origin: string) {
  try {
    const h = new URL(origin).hostname;
    return h === 'facebook.com' || h.endsWith('.facebook.com');
  } catch {
    return false;
  }
}

function login(FB: any, configId: string, extras?: object): Promise<string> {
  return new Promise((resolve, reject) => {
    FB.login(
      (r: any) => (r?.authResponse?.code ? resolve(r.authResponse.code) : reject(new Error('cancelled'))),
      { config_id: configId, response_type: 'code', override_default_response_type: true, ...(extras ? { extras } : {}) },
    );
  });
}

/** WhatsApp Embedded Signup: the owner logs in and picks (or adds) their number in Meta's window. */
export async function whatsappSignup(setup: MetaSetup): Promise<{ code: string; phoneNumberId: string; wabaId: string }> {
  const FB = await loadSdk(setup.appId!, setup.version);
  let session: { phoneNumberId: string; wabaId: string } | null = null;
  let failure: string | null = null;
  const onMessage = (e: MessageEvent) => {
    if (!fromFacebook(e.origin)) return;
    try {
      const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      if (d?.type !== 'WA_EMBEDDED_SIGNUP') return;
      if (String(d.event).startsWith('FINISH') && d.data?.phone_number_id && d.data?.waba_id) session = { phoneNumberId: String(d.data.phone_number_id), wabaId: String(d.data.waba_id) };
      else if (d.event === 'ERROR') failure = d.data?.error_message ?? 'WhatsApp setup failed.';
    } catch {
      /* not ours */
    }
  };
  window.addEventListener('message', onMessage);
  try {
    const code = await login(FB, setup.whatsappConfigId!, { setup: {} });
    // The number details arrive as a separate message; give it a moment.
    for (let i = 0; i < 30 && !session && !failure; i++) await new Promise((r) => setTimeout(r, 100));
    if (failure) throw new Error(failure);
    if (!session) throw new Error('WhatsApp did not say which number you chose. Please try again.');
    const s = session as { phoneNumberId: string; wabaId: string };
    return { code, ...s };
  } finally {
    window.removeEventListener('message', onMessage);
  }
}

/** Facebook Login for Business: the owner ticks their Page (and its Instagram account). */
export async function pagesLogin(setup: MetaSetup): Promise<string> {
  const FB = await loadSdk(setup.appId!, setup.version);
  return login(FB, setup.loginConfigId!);
}
