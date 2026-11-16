import { GroqProvider, fromGroqChoice, groqModel, toGroqMessages, toGroqTools } from './groq.provider';
import { pickGroqModel, resetGroqFallback } from './groq.provider';
import { AiUnavailableError } from './provider';

describe('Groq provider', () => {
  const realFetch = global.fetch;
  const env = { ...process.env };
  afterEach(() => {
    global.fetch = realFetch;
    process.env = { ...env };
  });

  it('turns a tool round trip into OpenAI-style messages', () => {
    const out = toGroqMessages('You are Aria.', [
      { role: 'user', content: 'What are your timings?' },
      { role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'call_1', name: 'search_knowledge', input: { query: 'timings' } }] as any },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"answer":"10am to 8pm"}' }] as any },
    ]);
    expect(out).toEqual([
      { role: 'system', content: 'You are Aria.' },
      { role: 'user', content: 'What are your timings?' },
      { role: 'assistant', content: 'Let me check.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_knowledge', arguments: '{"query":"timings"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"answer":"10am to 8pm"}' },
    ]);
  });

  it('maps tools and replies both ways', () => {
    expect(toGroqTools([{ name: 'x', description: 'd', input_schema: { type: 'object', properties: {} } } as any])).toEqual([
      { type: 'function', function: { name: 'x', description: 'd', parameters: { type: 'object', properties: {} } } },
    ]);
    const r = fromGroqChoice({ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'find_slots', arguments: '{"serviceId":"s1"}' } }] } });
    expect(r.stopReason).toBe('tool_use');
    expect(r.content).toEqual([{ type: 'tool_use', id: 'c1', name: 'find_slots', input: { serviceId: 's1' } }]);
    // A broken arguments string from the model does not crash Aria.
    expect(fromGroqChoice({ message: { tool_calls: [{ id: 'c2', function: { name: 'x', arguments: '{oops' } }] } }).content[0]).toMatchObject({ input: {} });
    expect(fromGroqChoice({ finish_reason: 'stop', message: { content: 'Hi!' } })).toMatchObject({ stopReason: 'end_turn', content: [{ type: 'text', text: 'Hi!' }] });
  });

  it('picks the model from GROQ_MODEL, then a non-Claude AI_MODEL, then the default', () => {
    delete process.env.GROQ_MODEL;
    process.env.AI_MODEL = 'claude-opus-5-5';
    expect(groqModel()).toBe('openai/gpt-oss-120b');
    process.env.AI_MODEL = 'openai/gpt-oss-120b';
    expect(groqModel()).toBe('openai/gpt-oss-120b');
    process.env.GROQ_MODEL = 'llama-3.1-8b-instant';
    expect(groqModel()).toBe('llama-3.1-8b-instant');
  });

  it('calls Groq with the key and reports usage', async () => {
    process.env.GROQ_API_KEY = 'gsk_test';
    let sent: any;
    global.fetch = jest.fn(async (_url: any, init: any) => {
      sent = { headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ model: 'llama-3.3-70b-versatile', choices: [{ finish_reason: 'stop', message: { content: 'Namaste!' } }], usage: { prompt_tokens: 120, completion_tokens: 8 } }), { status: 200 });
    }) as any;
    const r = await new GroqProvider().complete({ system: 'S', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(sent.headers.authorization).toBe('Bearer gsk_test');
    expect(sent.body.tools).toBeUndefined();
    expect(r).toMatchObject({ stopReason: 'end_turn', model: 'llama-3.3-70b-versatile', usage: { input: 120, output: 8 } });
  });

  it('fails safely (Aria hands over) on a missing key, bad key or outage', async () => {
    delete process.env.GROQ_API_KEY;
    await expect(new GroqProvider().complete({ system: 'S', messages: [], tools: [] })).rejects.toBeInstanceOf(AiUnavailableError);
    process.env.GROQ_API_KEY = 'bad';
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), { status: 401 })) as any;
    await expect(new GroqProvider().complete({ system: 'S', messages: [], tools: [] })).rejects.toThrow('Groq key missing or invalid');
    global.fetch = jest.fn(async () => new Response('{}', { status: 503 })) as any;
    await expect(new GroqProvider().complete({ system: 'S', messages: [], tools: [] })).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it('when the model is retired, picks the best available one from Groq and keeps using it', async () => {
    process.env.GROQ_API_KEY = 'gsk_test';
    process.env.GROQ_MODEL = 'llama-3.3-70b-versatile';
    resetGroqFallback();
    const used: string[] = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'whisper-large-v3' }, { id: 'llama-3.1-8b-instant' }, { id: 'openai/gpt-oss-120b' }] }), { status: 200 });
      const model = JSON.parse(init.body).model;
      used.push(model);
      if (model === 'llama-3.3-70b-versatile') return new Response(JSON.stringify({ error: { message: 'The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.', code: 'model_not_found' } }), { status: 404 });
      return new Response(JSON.stringify({ model, choices: [{ finish_reason: 'stop', message: { content: 'Hello' } }], usage: {} }), { status: 200 });
    }) as any;
    const p = new GroqProvider();
    expect((await p.complete({ system: 'S', messages: [{ role: 'user', content: 'hi' }], tools: [] })).model).toBe('openai/gpt-oss-120b');
    await p.complete({ system: 'S', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(used).toEqual(['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-120b']);
    expect(pickGroqModel(['whisper-large-v3', 'llama-3.1-8b-instant'], 'x')).toBe('llama-3.1-8b-instant');
    delete process.env.GROQ_MODEL;
    resetGroqFallback();
  });
});

import { groqSee, groqVisionCandidates, GROQ_VISION_FALLBACK } from './groq.provider';

describe('Groq vision', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.GROQ_VISION_MODEL;
  });

  it('tries the configured model first, then vision-looking models on the account, then Groq’s documented one', () => {
    expect(groqVisionCandidates(['openai/gpt-oss-120b', 'qwen/qwen3-32b', 'meta-llama/llama-4-scout-17b-16e-instruct', 'whisper-large-v3'], 'my/vision')).toEqual([
      'my/vision', 'meta-llama/llama-4-scout-17b-16e-instruct', GROQ_VISION_FALLBACK,
    ]);
    // An empty or failed model list still has a model to try.
    expect(groqVisionCandidates([], '')).toEqual([GROQ_VISION_FALLBACK]);
  });

  it('skips a model that refuses images and uses the next one', async () => {
    process.env.GROQ_API_KEY = 'gsk_test';
    const tried: string[] = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'meta-llama/llama-4-scout-17b-16e-instruct' }, { id: 'openai/gpt-oss-120b' }] }), { status: 200 });
      const model = JSON.parse(init.body).model;
      tried.push(model);
      if (model.includes('llama-4')) return new Response(JSON.stringify({ error: { message: 'The model `meta-llama/llama-4-scout-17b-16e-instruct` has been decommissioned' } }), { status: 400 });
      return new Response(JSON.stringify({ model, choices: [{ message: { content: '{"is_bill":true,"total":100}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
    }) as any;
    const r = await groqSee({ system: 's', prompt: 'KIND: bill', images: [{ mime: 'image/jpeg', data: 'AAAA' }] });
    // The listed Llama 4 model was retired: skipped, then Groq's documented vision model works.
    expect(tried).toEqual(['meta-llama/llama-4-scout-17b-16e-instruct', 'qwen/qwen3.8-27b']);
    expect(r).toMatchObject({ model: 'qwen/qwen3.8-27b', text: '{"is_bill":true,"total":100}' });
  });
});
