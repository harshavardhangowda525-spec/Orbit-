import Link from 'next/link';

export const metadata = { title: 'Privacy and sub-processors · Orbit' };

/** Who processes data for Orbit. AI is described as "leading AI providers"; this list names them as sub-processors. */
const SUBPROCESSORS: [string, string, string][] = [
  ['Groq, Inc.', 'AI language models (customer replies, owner questions)', 'USA'],
  ['Anthropic, PBC', 'AI language models (premium plans, when enabled)', 'USA'],
  ['Sarvam AI', 'Speech recognition and voice (phone calls, voice notes)', 'India'],
  ['Supabase', 'Database, sign-in and file storage', 'Region chosen at setup'],
  ['Render', 'Application hosting', 'Region chosen at setup'],
  ['Meta Platforms', 'WhatsApp, Instagram and Messenger messages (when connected)', 'Global'],
  ['Google', 'Calendar, Gmail and sign-in (when connected)', 'Global'],
  ['Microsoft', 'Outlook email (when connected)', 'Global'],
  ['Razorpay', 'Payments and plan subscriptions', 'India'],
  ['MSG91', 'SMS (when connected)', 'India'],
  ['Exotel', 'Phone calls (when connected)', 'India'],
  ['Resend', 'Sign-in and account emails', 'USA'],
];

export default function Privacy() {
  return (
    <main className="page stack" style={{ maxWidth: 760 }}>
      <Link href="/" className="small">← Orbit</Link>
      <h1>Privacy and sub-processors</h1>
      <p>
        Orbit runs your business&apos;s customer conversations, bookings and follow-ups. Each business&apos;s data is kept separate from every
        other business&apos;s at the database level, and is used only to provide Orbit to that business.
      </p>
      <h2>AI in Orbit</h2>
      <p>
        Orbit and its Crew (Aria, Vox, Nudge, Ledger and Spark) use leading AI providers to understand and write messages. Orbit did not
        build its own foundation model. Messages are sent to these providers only to produce a reply, and Orbit records how much AI each
        business uses so it can apply plan allowances.
      </p>
      <h2>Sub-processors</h2>
      <p className="muted small">Companies that process data on Orbit&apos;s behalf. Integrations marked &quot;when connected&quot; are used only if the business connects them.</p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Company</th><th>Purpose</th><th>Location</th></tr></thead>
          <tbody>{SUBPROCESSORS.map(([n, p, l]) => <tr key={n}><td>{n}</td><td>{p}</td><td>{l}</td></tr>)}</tbody>
        </table>
      </div>
      <p className="small muted">Questions about privacy or a data processing agreement: write to the Orbit team from your account.</p>
    </main>
  );
}
