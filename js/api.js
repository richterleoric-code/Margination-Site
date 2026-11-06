// Talks to Google Gemini directly from the browser, using the key the user pastes in.
// The key is stored only in this browser (localStorage) and is never in the code.
import { buildPrompt } from './prompt.js';

export class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const KEY_NAME = 'margination.geminiKey';
let memoryKey = '';

export function getApiKey() {
  try {
    return localStorage.getItem(KEY_NAME) || memoryKey;
  } catch {
    return memoryKey;
  }
}
export function setApiKey(key) {
  memoryKey = key.trim();
  try {
    if (memoryKey) localStorage.setItem(KEY_NAME, memoryKey);
    else localStorage.removeItem(KEY_NAME);
  } catch {
    /* works for this session only */
  }
}

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODELS = ['gemini-2.5-flash-image', 'gemini-3.1-flash-image-preview'];

async function callModel(model, key, prompt, withAspect, signal) {
  const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
  if (withAspect) generationConfig.imageConfig = { aspectRatio: '4:3' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort('timeout'), 120000);
  const onAbort = () => ctl.abort('cancelled');
  signal?.addEventListener('abort', onAbort);
  try {
    return await fetch(`${ENDPOINT}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig }),
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Resolves with { image (base64), mimeType, scene: null }. */
export async function generateIllustration({ passage, style, variation }, { signal } = {}) {
  const key = getApiKey();
  if (!key) throw new ApiError('no_key', 'Add your Gemini API key first (the box above the passage).');

  const prompt = buildPrompt({ passage, style, variation });
  let res = null;

  try {
    for (const model of MODELS) {
      res = await callModel(model, key, prompt, true, signal);
      if (res.status === 400) {
        const t = await res.clone().text();
        if (/imageConfig|aspect/i.test(t)) res = await callModel(model, key, prompt, false, signal);
      }
      if (res.status !== 404) break; // 404 = model name not available, try the next one
    }
  } catch (err) {
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    if (err?.name === 'AbortError') throw new ApiError('timeout', 'The illustration took too long. Please try again.');
    throw new ApiError('network', 'Margination could not reach Google. Check your internet connection and try again.');
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }

  if (!res.ok) {
    const detail = data?.error?.message || '';
    if (res.status === 429)
      throw new ApiError('rate_limited', 'Google says the free usage limit was reached or it is busy. Wait a minute and try again.', 429);
    if (res.status === 401 || res.status === 403 || (res.status === 400 && /api key/i.test(detail)))
      throw new ApiError('bad_key', 'Google did not accept that API key. Check that you pasted the whole key, or make a new one.', res.status);
    if (res.status === 404)
      throw new ApiError('no_model', 'The image model is not available for your key right now. Try again later.', 404);
    throw new ApiError('unavailable', 'Google’s illustration service had a problem. Please try again shortly.', res.status);
  }

  if (data?.promptFeedback?.blockReason)
    throw new ApiError('blocked', 'The illustrator could not draw this passage. Try selecting a different part.');

  const parts = data?.candidates?.[0]?.content?.parts || [];
  const inline = parts.map((p) => p.inlineData || p.inline_data).find((d) => d?.data);
  if (!inline) {
    const finish = data?.candidates?.[0]?.finishReason || '';
    if (/SAFETY|PROHIBITED|BLOCK/i.test(finish))
      throw new ApiError('blocked', 'The illustrator could not draw this passage. Try selecting a different part.');
    throw new ApiError('no_image', 'The illustrator did not return a picture this time. Please try again.');
  }
  return { image: inline.data, mimeType: inline.mimeType || inline.mime_type || 'image/png', scene: null };
}

export async function getStatus() {
  return { configured: Boolean(getApiKey()) };
}
