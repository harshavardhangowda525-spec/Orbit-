import { groupFeed, type FeedItem } from './feed-group';

const item = (id: string, agent: string, type: string, at: string, valueAmount = 0): FeedItem => ({
  id, agent, type, at, valueAmount, sentence: { key: `feed.${agent}.${type}` }, entityType: null, entityId: null,
});

describe('groupFeed', () => {
  it('groups back-to-back similar events and keeps others separate', () => {
    const g = groupFeed(
      [
        item('1', 'aria', 'booking_created', '2026-11-10T10:00:00Z', 300),
        item('2', 'aria', 'booking_created', '2026-11-10T09:00:00Z', 200),
        item('3', 'vox', 'calls_done', '2026-11-10T08:00:00Z'),
        item('4', 'aria', 'booking_created', '2026-11-10T07:00:00Z'),
      ],
      { aria: 'Maya' },
    );
    expect(g.map((x) => x.items.length)).toEqual([2, 1, 1]);
    expect(g[0].sentence).toEqual({ key: 'feed.group.booking_created', params: { count: 2, agent: 'Maya', amount: 500 } });
    expect(g[1].sentence.key).toBe('feed.vox.calls_done');
  });

  it('does not group across days or for non-groupable types', () => {
    const g = groupFeed([
      item('1', 'aria', 'booking_created', '2026-11-10T01:00:00Z'),
      item('2', 'aria', 'booking_created', '2026-11-09T23:00:00Z'),
      item('3', 'orbit', 'card_approved', '2026-11-09T22:00:00Z'),
      item('4', 'orbit', 'card_approved', '2026-11-09T21:00:00Z'),
    ]);
    expect(g).toHaveLength(4);
  });
});
