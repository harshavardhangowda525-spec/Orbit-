import type { AiProvider, AiRequest, AiResponse, AiBlock } from './provider';

type Script = (req: AiRequest, turn: number) => AiBlock[] | Promise<AiBlock[]>;

/**
 * A scripted, deterministic stand-in for the LLM. Tests set a script; without
 * one it runs a tiny demo brain (look up knowledge, offer slots) so Orbit can be
 * tried end to end with no API key. It never invents facts: replies only quote tool results.
 */
export class FakeProvider implements AiProvider {
  readonly name = 'fake';
  script: Script | null = null;
  calls: AiRequest[] = [];
  private turn = 0;

  reset() {
    this.script = null;
    this.calls = [];
    this.turn = 0;
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    this.calls.push(JSON.parse(JSON.stringify(req)));
    const content = this.script ? await this.script(req, this.turn++) : demoBrain(req);
    const hasTool = content.some((b) => b.type === 'tool_use');
    return { content, stopReason: hasTool ? 'tool_use' : 'end_turn', model: 'fake', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  }
}

let n = 0;
export const toolUse = (name: string, input: Record<string, unknown>): AiBlock => ({ type: 'tool_use', id: `toolu_fake_${++n}`, name, input } as any);
export const text = (t: string): AiBlock => ({ type: 'text', text: t, citations: null } as any);

function lastUserText(req: AiRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    const t = m.content.find((b: any) => b.type === 'text') as any;
    if (t) return t.text;
  }
  return '';
}

function demoBrain(req: AiRequest): AiBlock[] {
  const last = req.messages[req.messages.length - 1];
  const results = Array.isArray(last?.content) ? (last.content as any[]).filter((b) => b.type === 'tool_result') : [];
  if (results.length) {
    const data = JSON.parse(String(results[0].content ?? '{}'));
    if (data.slots) return [text(data.slots.length ? `I have these times free: ${data.slots.map((s: any) => s.label).join(', ')}. Which one suits you?` : 'Sorry, there are no free times in the next few days.')];
    if (data.results?.length) return [text(data.results[0].content)];
    return [text("I'm not sure about that, so I've asked the team. They will get back to you soon.")];
  }
  const q = lastUserText(req);
  const svc = req.system.match(/service_id=([0-9a-f-]{36})/);
  if (/book|appointment|slot|available|free/i.test(q) && svc) return [toolUse('check_availability', { service_id: svc[1] })];
  return [toolUse('search_knowledge', { query: q.slice(0, 200) })];
}
