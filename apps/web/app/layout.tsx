import type { Metadata, Viewport } from 'next';
import { Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';

// Self-hosted at build time (no request to Google from the customer's phone).
const jakarta = Plus_Jakarta_Sans({ subsets: ['latin'], weight: ['400', '500', '600', '700', '800'], variable: '--font-jakarta', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Orbit', template: '%s · Orbit' },
  description: 'Orbit runs your front office: answers customers, books appointments, follows up and briefs you every morning.',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icons/icon.svg', apple: '/icons/icon-192.png' },
  appleWebApp: { capable: true, title: 'Orbit', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f5fb' },
    { media: '(prefers-color-scheme: dark)', color: '#12112a' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={jakarta.variable}>
      <head>
        {/* Public runtime settings (API address, Supabase project); tiny and cached. */}
        <script src="/runtime-config" />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
