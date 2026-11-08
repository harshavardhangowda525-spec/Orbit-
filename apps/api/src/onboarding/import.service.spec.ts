import { ImportService, parseBusinessHtml } from './import.service';

describe('quick import', () => {
  const svc = new ImportService();

  it('reads JSON-LD LocalBusiness details from a website', () => {
    const html = `<html><head><title>Glow | Best salon</title>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"HairSalon","name":"Glow Salon","telephone":"+91 80 4123 4567",
      "address":{"streetAddress":"12, 4th Cross","addressLocality":"Bengaluru","postalCode":"560038"},"image":["https://glow.example/a.jpg"],"description":"Hair &amp; skin"}</script>
      </head></html>`;
    expect(parseBusinessHtml(html, 'https://glow.example')).toEqual({
      name: 'Glow Salon',
      phone: '+91 80 4123 4567',
      address: '12, 4th Cross, Bengaluru, 560038',
      photos: ['https://glow.example/a.jpg'],
      description: 'Hair & skin',
    });
  });

  it('falls back to meta tags, title and tel: links', () => {
    const html = `<title>Calm Flow Yoga - JP Nagar</title><meta name="description" content="Morning and evening classes"><meta property="og:image" content="/img/hero.jpg"><a href="tel:+919845012345">Call</a>`;
    expect(parseBusinessHtml(html, 'https://calm.example/about')).toEqual({
      name: 'Calm Flow Yoga',
      description: 'Morning and evening classes',
      phone: '+919845012345',
      photos: ['https://calm.example/img/hero.jpg'],
    });
  });

  it('recognises Instagram handles and Google Maps links without scraping', async () => {
    expect(await svc.run('https://www.instagram.com/glow.salon/')).toMatchObject({ source: 'instagram', fields: { instagram: 'https://instagram.com/glow.salon' } });
    expect(await svc.run('https://www.google.com/maps/place/Glow+Salon/@12.9,77.6,17z')).toMatchObject({ source: 'google_maps', fields: { name: 'Glow Salon' } });
    expect(await svc.run('hello there')).toMatchObject({ source: 'unknown', ok: false });
  });

  it('refuses to fetch private network addresses', async () => {
    const r = await svc.run('http://127.0.0.1:4000/health');
    expect(r).toMatchObject({ source: 'website', ok: false });
    expect((await svc.run('http://169.254.169.254/latest/meta-data')).ok).toBe(false);
  });
});
