const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm';
const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const PDF_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
const MODEL_STANDARD = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';
const MODEL_LIGHT = 'SmolLM2-360M-Instruct-q4f32_1-MLC';

const $ = (id) => document.getElementById(id);
const els = {
  netPill: $('netPill'), gpuPill: $('gpuPill'), guidePill: $('guidePill'),
  modelSelect: $('modelSelect'), modelBtn: $('modelBtn'), pdfInput: $('pdfInput'),
  progressBar: $('progressBar'), progressText: $('progressText'), supportNote: $('supportNote'),
  chat: $('chat'), welcome: $('welcome'), input: $('messageInput'), send: $('sendBtn'),
  clear: $('clearBtn'), install: $('installBtn')
};

let engine = null;
let engineModel = null;
let guideChunks = [];
let guideMeta = null;
let deferredInstall = null;
let isGenerating = false;
let chatHistory = JSON.parse(localStorage.getItem('zelda-chat-v1') || '[]');

const STOP = new Set('the a an and or but if then to of in on at for from with without into onto by is are was were be been being it this that these those i me my we our you your he she they them his her their what where when how why which who do does did can could should would will just about after before through get got have has had as up down out over under there here not no yes'.split(' '));

function setPill(el, text, kind='') {
  el.textContent = text;
  el.className = `pill${kind ? ' ' + kind : ''}`;
}

function setProgress(value, text) {
  const pct = Math.max(0, Math.min(100, Math.round((value || 0) * 100)));
  els.progressBar.style.width = `${pct}%`;
  if (text) els.progressText.textContent = text;
}

function saveChat() {
  localStorage.setItem('zelda-chat-v1', JSON.stringify(chatHistory.slice(-40)));
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('zelda-guide-ai', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbSet(key, value) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function dbGet(key) {
  const db = await openDB();
  const value = await new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return value;
}

function normalizeWords(text) {
  return (text.toLowerCase().match(/[a-z0-9']{2,}/g) || []).filter(w => !STOP.has(w));
}

function chunkPage(text, page) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const size = 1050, overlap = 180;
  const out = [];
  for (let i = 0; i < clean.length; i += size - overlap) {
    const part = clean.slice(i, i + size).trim();
    if (part.length > 60) out.push({ page, text: part, lower: part.toLowerCase() });
    if (i + size >= clean.length) break;
  }
  return out;
}

function retrieve(question, limit=5) {
  if (!guideChunks.length) return [];
  const words = [...new Set(normalizeWords(question))];
  const phrase = question.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const scored = guideChunks.map((chunk) => {
    let score = 0;
    for (const w of words) {
      let pos = chunk.lower.indexOf(w);
      if (pos >= 0) {
        score += w.length >= 7 ? 5 : w.length >= 5 ? 3 : 2;
        const count = chunk.lower.split(w).length - 1;
        score += Math.min(count, 3);
      }
    }
    if (phrase.length > 5 && chunk.lower.includes(phrase)) score += 14;
    for (let i = 0; i < words.length - 1; i++) {
      if (chunk.lower.includes(`${words[i]} ${words[i+1]}`)) score += 5;
    }
    return { ...chunk, score };
  }).filter(x => x.score > 0).sort((a,b) => b.score - a.score);
  const result = [];
  const seen = new Set();
  for (const item of scored) {
    const key = `${item.page}:${item.text.slice(0,80)}`;
    if (!seen.has(key)) { result.push(item); seen.add(key); }
    if (result.length >= limit) break;
  }
  return result;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

function addBubble(role, text, pages=[]) {
  if (els.welcome) els.welcome.classList.add('hidden');
  const div = document.createElement('div');
  div.className = `bubble ${role === 'user' ? 'user' : 'ai'}`;
  const body = document.createElement('div');
  body.innerHTML = escapeHtml(text);
  div.appendChild(body);
  if (pages.length) {
    const src = document.createElement('div');
    src.className = 'sources';
    src.textContent = `Guide pages: ${[...new Set(pages)].join(', ')}`;
    div.appendChild(src);
  }
  els.chat.appendChild(div);
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  return { div, body };
}

function renderHistory() {
  if (!chatHistory.length) return;
  els.welcome.classList.add('hidden');
  for (const m of chatHistory) addBubble(m.role, m.content, m.pages || []);
}

function updateConnection() {
  setPill(els.netPill, navigator.onLine ? 'Online' : 'Offline', navigator.onLine ? '' : 'warn');
}

async function checkGPU() {
  if (!('gpu' in navigator)) {
    setPill(els.gpuPill, 'WebGPU unavailable', 'bad');
    els.supportNote.textContent = 'This browser cannot run the local AI. On Android, use a current version of Chrome. If Chrome is already current, this phone/GPU may not support WebGPU.';
    els.supportNote.classList.remove('hidden');
    return false;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No adapter');
    setPill(els.gpuPill, 'On-device AI supported');
    return true;
  } catch {
    setPill(els.gpuPill, 'WebGPU unavailable', 'bad');
    return false;
  }
}

async function ensureServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
      await navigator.serviceWorker.ready;
    } catch (e) { console.warn('Service worker:', e); }
  }
}

async function requestPersistence() {
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch {}
}

async function loadEngine(modelId, allowFallback=true) {
  if (engine && engineModel === modelId) return engine;
  if (!('gpu' in navigator)) throw new Error('WebGPU is not available in this browser.');
  els.modelBtn.disabled = true;
  els.modelSelect.disabled = true;
  setProgress(0.02, navigator.onLine ? 'Loading local AI… first download can be large.' : 'Loading the saved AI model from this phone…');
  try {
    const webllm = await import(WEBLLM_URL);
    engine = await webllm.CreateMLCEngine(modelId, {
      initProgressCallback: (p) => setProgress(p.progress || 0, p.text || `Preparing AI… ${Math.round((p.progress || 0)*100)}%`)
    });
    engineModel = modelId;
    localStorage.setItem('zelda-model', modelId);
    localStorage.setItem('zelda-model-ready', '1');
    setProgress(1, `AI ready on this phone: ${modelId === MODEL_STANDARD ? 'Llama 3.2 1B' : 'SmolLM2 360M'}.`);
    setPill(els.gpuPill, 'AI ready offline');
    return engine;
  } catch (err) {
    console.error(err);
    if (allowFallback && modelId === MODEL_STANDARD && navigator.onLine) {
      els.modelSelect.value = MODEL_LIGHT;
      localStorage.setItem('zelda-model', MODEL_LIGHT);
      setProgress(0, 'The 1B model did not initialise. Trying the lighter Android model…');
      engine = null;
      return loadEngine(MODEL_LIGHT, false);
    }
    setProgress(0, `Could not load the AI: ${err?.message || err}`);
    throw err;
  } finally {
    els.modelBtn.disabled = false;
    els.modelSelect.disabled = false;
  }
}

async function importPDF(file) {
  if (!file) return;
  els.pdfInput.disabled = true;
  setProgress(0.02, `Reading ${file.name} locally…`);
  try {
    const pdfjs = await import(PDFJS_URL);
    pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data: bytes }).promise;
    const chunks = [];
    let chars = 0;
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      const text = tc.items.map(i => i.str || '').join(' ');
      chars += text.length;
      chunks.push(...chunkPage(text, p));
      setProgress(p / pdf.numPages, `Indexing guide… page ${p} of ${pdf.numPages}`);
    }
    if (chars < 300 || chunks.length < 2) throw new Error('This PDF appears to contain scanned images rather than selectable text. This version needs a text-based PDF.');
    guideChunks = chunks;
    guideMeta = { name: file.name, pages: pdf.numPages, chunks: chunks.length, imported: Date.now() };
    await dbSet('guideChunks', guideChunks);
    await dbSet('guideMeta', guideMeta);
    setPill(els.guidePill, `${pdf.numPages}-page guide saved`);
    setProgress(1, `${file.name} is indexed and saved on this phone for offline use.`);
  } catch (err) {
    console.error(err);
    setProgress(0, `Guide import failed: ${err?.message || err}`);
  } finally {
    els.pdfInput.disabled = false;
  }
}

function systemPrompt() {
  return `You are a concise Zelda game-guide assistant running locally on a phone. The user's imported guide is your primary source of truth. Use the supplied guide extracts to answer the exact question. Never invent a location, item, quest step, control, or puzzle solution that is not supported by the extracts. If the extracts do not contain enough information, say that you cannot find that part in the retrieved guide and suggest a more specific search phrase. Avoid spoilers beyond what the user asks. Give short, practical step-by-step directions when useful. Do not mention being an AI model.`;
}

async function answerQuestion(question) {
  if (!guideChunks.length) {
    addBubble('ai', 'Load the Zelda guide PDF first so I can answer from it.');
    return;
  }
  const modelId = els.modelSelect.value;
  const localEngine = await loadEngine(modelId);
  const hits = retrieve(question, 5);
  const excerpts = hits.length
    ? hits.map((h,i) => `[Guide extract ${i+1} — page ${h.page}]\n${h.text}`).join('\n\n')
    : '[No relevant guide extract was found for this wording.]';
  const earlier = chatHistory.slice(0, -1).slice(-6).map(m => ({ role: m.role === 'ai' ? 'assistant' : m.role, content: m.content }));
  const messages = [
    { role: 'system', content: systemPrompt() },
    ...earlier,
    { role: 'user', content: `Question: ${question}\n\nRelevant extracts from the imported guide:\n${excerpts}` }
  ];
  const bubble = addBubble('ai', '…', hits.map(h => h.page));
  let full = '';
  try {
    const stream = await localEngine.chat.completions.create({
      messages, temperature: 0.15, top_p: 0.9, max_tokens: modelId === MODEL_LIGHT ? 220 : 320, stream: true
    });
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content || '';
      full += delta;
      bubble.body.textContent = full || '…';
      window.scrollTo({ top: document.body.scrollHeight });
    }
    if (!full.trim()) full = 'I could not produce an answer from those guide passages. Try asking with the dungeon, shrine, quest, item, or location name.';
    bubble.body.textContent = full;
    chatHistory.push({ role: 'assistant', content: full, pages: hits.map(h => h.page) });
    saveChat();
  } catch (err) {
    bubble.body.textContent = `I hit a local model error: ${err?.message || err}`;
    throw err;
  }
}

async function sendMessage() {
  const question = els.input.value.trim();
  if (!question || isGenerating) return;
  isGenerating = true;
  els.send.disabled = true;
  els.input.value = '';
  addBubble('user', question);
  chatHistory.push({ role: 'user', content: question });
  saveChat();
  try { await answerQuestion(question); }
  catch (e) { console.error(e); }
  finally { isGenerating = false; els.send.disabled = false; els.input.focus(); }
}

function setupInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferredInstall = e; els.install.style.display = 'block';
  });
  els.install.addEventListener('click', async () => {
    if (deferredInstall) { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; els.install.style.display = 'none'; return; }
    els.supportNote.textContent = 'To keep this on the phone: open the browser menu and choose “Install app” or “Add to Home screen”.';
    els.supportNote.classList.remove('hidden');
  });
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (!standalone && /iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    els.install.style.display = 'block';
    els.install.textContent = 'Add to Home';
    els.install.onclick = () => {
      els.supportNote.textContent = 'On iPhone: tap Share in Safari, then “Add to Home Screen”. Open it once online and download the AI before using it offline.';
      els.supportNote.classList.remove('hidden');
    };
  }
}

async function restoreGuide() {
  try {
    guideChunks = (await dbGet('guideChunks')) || [];
    guideMeta = (await dbGet('guideMeta')) || null;
    if (guideChunks.length && guideMeta) setPill(els.guidePill, `${guideMeta.pages}-page guide saved`);
  } catch (e) { console.warn(e); }
}

async function init() {
  updateConnection();
  addEventListener('online', updateConnection); addEventListener('offline', updateConnection);
  await ensureServiceWorker();
  requestPersistence();
  checkGPU();
  await restoreGuide();
  const savedModel = localStorage.getItem('zelda-model');
  if (savedModel === MODEL_STANDARD || savedModel === MODEL_LIGHT) els.modelSelect.value = savedModel;
  if (localStorage.getItem('zelda-model-ready') === '1') setPill(els.gpuPill, 'AI downloaded');
  renderHistory();
  setupInstallPrompt();

  els.modelSelect.addEventListener('change', () => localStorage.setItem('zelda-model', els.modelSelect.value));
  els.modelBtn.addEventListener('click', () => loadEngine(els.modelSelect.value).catch(() => {}));
  els.pdfInput.addEventListener('change', (e) => importPDF(e.target.files?.[0]));
  els.send.addEventListener('click', sendMessage);
  els.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
  els.input.addEventListener('input', () => { els.input.style.height='auto'; els.input.style.height=Math.min(120, els.input.scrollHeight)+'px'; });
  els.clear.addEventListener('click', () => { chatHistory=[]; saveChat(); [...els.chat.querySelectorAll('.bubble')].forEach(n=>n.remove()); els.welcome.classList.remove('hidden'); });
}

init();
