import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="page center stack" style={{ textAlign: 'center' }}>
      <div style={{ fontSize: '3rem' }}>🪐</div>
      <h1>We could not find that page</h1>
      <Link className="btn" href="/">Go to Orbit</Link>
    </main>
  );
}
