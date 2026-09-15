import { KNOWLEDGE } from './knowledge.js';

const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm';
const MODEL_STANDARD = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';
const MODEL_LIGHT = 'SmolLM2-360M-Instruct-q4f32_1-MLC';

const $ = (id) => document.getElementById(id);
const els = {
  netPill: $('netPill'), gpuPill: $('gpuPill'), guidePill: $('guidePill'),
  modelSelect: $('modelSelect'), modelBtn: $('modelBtn'),
  progressBar: $('progressBar'), progressText: $('progressText'), supportNote: $('supportNote'),
  chat: $('chat'), welcome: $('welcome'), input: $('messageInput'), send: $('sendBtn'),
  clear: $('clearBtn'), install: $('installBtn')
};

let gpuEngine = null;
let gpuModel = null;
let cpuModule = null;
let deferredInstall = null;
let isGenerating = false;
let hasWebGPU = false;
let runtimeKind = null;
let chatHistory = JSON.parse(localStorage.getItem('albw-chat-v2') || '[]');

const STOP = new Set('the a an and or but if then to of in on at for from with without into onto by is are was were be been being it this that these those i me my we our you your he she they them his her their what where when how why which who do does did can could should would will just about after before through get got have has had as up down out over under there here not no yes next help stuck please'.split(' '));

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
  localStorage.setItem('albw-chat-v2', JSON.stringify(chatHistory.slice(-50)));
}

function normalizeWords(text) {
  return (text.toLowerCase().match(/[a-z0-9']{2,}/g) || []).filter(w => !STOP.has(w));
}

function retrieve(question, limit=5) {
  const recentUser = chatHistory.filter(m => m.role === 'user').slice(-2).map(m => m.content).join(' ');
  const query = `${recentUser} ${question}`.trim();
  const words = [...new Set(normalizeWords(query))];
  const phrase = question.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();

  return KNOWLEDGE.map((entry) => {
    const title = entry.title.toLowerCase();
    const tags = entry.tags.join(' ').toLowerCase();
    const body = entry.text.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (title.includes(w)) score += w.length >= 6 ? 12 : 8;
      if (tags.includes(w)) score += w.length >= 6 ? 9 : 6;
      if (body.includes(w)) score += w.length >= 7 ? 5 : w.length >= 5 ? 3 : 2;
    }
    if (phrase.length > 5) {
      if (title.includes(phrase)) score += 30;
      if (tags.includes(phrase)) score += 20;
      if (body.includes(phrase)) score += 14;
    }
    for (let i = 0; i < words.length - 1; i++) {
      const pair = `${words[i]} ${words[i+1]}`;
      if (title.includes(pair)) score += 14;
      if (tags.includes(pair)) score += 10;
      if (body.includes(pair)) score += 6;
    }
    return { ...entry, score };
  }).filter(x => x.score > 0).sort((a,b) => b.score - a.score).slice(0, limit);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#039;'}[c]));
}

function addBubble(role, text, sources=[]) {
  if (els.welcome) els.welcome.classList.add('hidden');
  const div = document.createElement('div');
  div.className = `bubble ${role === 'user' ? 'user' : 'ai'}`;
  const body = document.createElement('div');
  body.innerHTML = escapeHtml(text);
  div.appendChild(body);
  if (sources.length) {
    const src = document.createElement('div');
    src.className = 'sources';
    src.textContent = `Guide topics: ${sources.slice(0,3).join(' · ')}`;
    div.appendChild(src);
  }
  els.chat.appendChild(div);
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  return { div, body };
}

function renderHistory() {
  if (!chatHistory.length) return;
  els.welcome.classList.add('hidden');
  for (const m of chatHistory) addBubble(m.role, m.content, m.sources || []);
}

function updateConnection() {
  setPill(els.netPill, navigator.onLine ? 'Online' : 'Offline', navigator.onLine ? '' : 'warn');
}

function updateModelButtonFromSavedState() {
  const ready = localStorage.getItem('albw-runtime-ready');
  if (!hasWebGPU && ready === 'cpu') {
    els.modelBtn.textContent = runtimeKind === 'cpu' ? 'CPU AI ready ✓' : 'CPU AI downloaded ✓';
  } else if (hasWebGPU && ready === 'gpu') {
    els.modelBtn.textContent = runtimeKind === 'gpu' ? 'GPU AI ready ✓' : 'GPU AI downloaded ✓';
  }
}

async function checkGPU() {
  hasWebGPU = false;
  if ('gpu' in navigator) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) hasWebGPU = true;
    } catch {}
  }

  const ready = localStorage.getItem('albw-runtime-ready');

  if (hasWebGPU) {
    setPill(els.gpuPill, ready === 'gpu' ? 'GPU AI downloaded' : 'GPU AI supported');
    els.modelSelect.disabled = false;
    els.modelBtn.textContent = ready === 'gpu' ? 'GPU AI downloaded ✓' : 'Download AI for offline use';
    return true;
  }

  setPill(els.gpuPill, ready === 'cpu' ? 'CPU AI downloaded' : 'CPU AI available', 'warn');
  els.modelSelect.disabled = true;
  els.modelBtn.textContent = ready === 'cpu' ? 'CPU AI downloaded ✓' : 'Download CPU AI (~271 MB)';
  els.supportNote.textContent = 'WebGPU is unavailable on this phone, so the app will use SmolLM2 360M on the CPU through WebAssembly instead. It will be slower, but it still runs locally and works offline after the first download.';
  els.supportNote.classList.remove('hidden');
  return false;
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

async function loadCPUModel() {
  const alreadyDownloaded = localStorage.getItem('albw-runtime-ready') === 'cpu';
  els.modelBtn.textContent = 'Loading CPU AI…';
  setProgress(0.01, alreadyDownloaded ? 'Loading the downloaded CPU AI into memory…' : (navigator.onLine ? 'Preparing CPU AI… first download is about 271 MB.' : 'Loading the saved CPU AI from this phone…'));
  cpuModule ??= await import('./cpu-llm.js');
  await cpuModule.loadCPUModel(({ progress, loaded, total }) => {
    const mb = n => (n / 1024 / 1024).toFixed(0);
    const detail = total > 0 ? ` ${mb(loaded)} / ${mb(total)} MB` : '';
    setProgress(progress || 0, alreadyDownloaded ? `Loading CPU AI…${detail}` : `Downloading CPU AI…${detail}`);
  });
  runtimeKind = 'cpu';
  localStorage.setItem('albw-runtime-ready', 'cpu');
  setProgress(1, 'CPU AI ready offline: SmolLM2 360M Q4.');
  setPill(els.gpuPill, 'CPU AI ready offline');
  els.modelBtn.textContent = 'CPU AI ready ✓';
  return 'cpu';
}

async function loadGPUModel(modelId, allowLightFallback=true) {
  if (gpuEngine && gpuModel === modelId) { runtimeKind = 'gpu'; els.modelBtn.textContent = 'GPU AI ready ✓'; return 'gpu'; }
  if (!hasWebGPU) return loadCPUModel();

  els.modelBtn.disabled = true;
  els.modelSelect.disabled = true;
  els.modelBtn.textContent = 'Loading GPU AI…';
  setProgress(0.02, navigator.onLine ? 'Downloading/preparing the GPU AI…' : 'Loading the saved GPU AI from this phone…');

  try {
    const webllm = await import(WEBLLM_URL);
    gpuEngine = await webllm.CreateMLCEngine(modelId, {
      initProgressCallback: (p) => setProgress(p.progress || 0, p.text || `Preparing GPU AI… ${Math.round((p.progress || 0)*100)}%`)
    });
    gpuModel = modelId;
    runtimeKind = 'gpu';
    localStorage.setItem('albw-model', modelId);
    localStorage.setItem('albw-runtime-ready', 'gpu');
    setProgress(1, `GPU AI ready offline: ${modelId === MODEL_STANDARD ? 'Llama 3.2 1B' : 'SmolLM2 360M'}.`);
    setPill(els.gpuPill, 'GPU AI ready offline');
    els.modelBtn.textContent = 'GPU AI ready ✓';
    return 'gpu';
  } catch (err) {
    console.error(err);
    gpuEngine = null;
    if (allowLightFallback && modelId === MODEL_STANDARD && navigator.onLine) {
      els.modelSelect.value = MODEL_LIGHT;
      localStorage.setItem('albw-model', MODEL_LIGHT);
      setProgress(0, 'The 1B GPU model failed. Trying the lighter GPU model…');
      return loadGPUModel(MODEL_LIGHT, false);
    }
    setProgress(0, 'GPU AI failed. Switching to the CPU model…');
    hasWebGPU = false;
    return loadCPUModel();
  } finally {
    els.modelBtn.disabled = false;
    els.modelSelect.disabled = !hasWebGPU;
    updateModelButtonFromSavedState();
  }
}

async function ensureRuntime() {
  if (runtimeKind === 'gpu' && gpuEngine) return 'gpu';
  if (runtimeKind === 'cpu') return 'cpu';
  return hasWebGPU ? loadGPUModel(els.modelSelect.value) : loadCPUModel();
}

function systemPrompt() {
  return `You are an offline companion for The Legend of Zelda: A Link Between Worlds on Nintendo 3DS. Answer only about this game. The supplied built-in guide notes are your primary source of truth. Use them closely and do not invent exact chest positions, room directions, item requirements, boss mechanics or collectible locations that are not supported by the notes. If the notes are not precise enough, say what you do know and ask the player for the dungeon, room feature, item or objective they can see. Keep answers practical and concise. If the user asks for a hint, give the smallest useful hint and avoid spoilers. If they ask for full directions, give clear numbered steps.`;
}

function directGuideAnswer(hits) {
  if (!hits.length) return 'I could not match that to the built-in guide. Try including the dungeon, boss, item, location or objective name.';
  return hits.slice(0,2).map(h => `${h.title}\n${h.text}`).join('\n\n');
}

async function answerQuestion(question) {
  const hits = retrieve(question, hasWebGPU ? 6 : 4);
  const excerpts = hits.length
    ? hits.map((h,i) => `[Guide topic ${i+1}: ${h.title}]\n${h.text.slice(0,700)}`).join('\n\n')
    : '[No close built-in guide topic matched this wording. Ask for more specific context rather than guessing.]';
  const sourceTitles = hits.map(h => h.title);
  const bubble = addBubble('assistant', 'Preparing answer…', sourceTitles);

  try {
    if (!hasWebGPU && runtimeKind !== 'cpu') {
      bubble.body.textContent = localStorage.getItem('albw-runtime-ready') === 'cpu' ? 'Loading CPU model…' : 'Preparing CPU model…';
    }
    const kind = await ensureRuntime();
    bubble.body.textContent = kind === 'cpu' ? 'Reading guide…' : 'Thinking…';

    const earlier = chatHistory.slice(0, -1).slice(kind === 'cpu' ? -4 : -6).map(m => ({ role: m.role, content: m.content }));
    const messages = [
      { role: 'system', content: systemPrompt() },
      ...earlier,
      { role: 'user', content: `Player question: ${question}\n\nRelevant built-in guide notes:\n${excerpts}` }
    ];

    let full = '';
    let stream;
    if (kind === 'cpu') {
      cpuModule ??= await import('./cpu-llm.js');
      stream = await cpuModule.cpuChat(messages, { max_tokens: 180, temperature: 0.1, top_p: 0.9, stream: true });
    } else {
      stream = await gpuEngine.chat.completions.create({
        messages, temperature: 0.12, top_p: 0.9,
        max_tokens: gpuModel === MODEL_LIGHT ? 240 : 360,
        stream: true
      });
    }

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content || '';
      full += delta;
      if (full) bubble.body.textContent = full;
      window.scrollTo({ top: document.body.scrollHeight });
    }
    if (!full.trim()) full = directGuideAnswer(hits);
    bubble.body.textContent = full;
    chatHistory.push({ role: 'assistant', content: full, sources: sourceTitles });
    saveChat();
  } catch (err) {
    console.error(err);
    const fallback = directGuideAnswer(hits);
    bubble.body.textContent = `${fallback}\n\n(Offline AI could not start on this device, so this answer is shown directly from the built-in guide.)`;
    chatHistory.push({ role: 'assistant', content: bubble.body.textContent, sources: sourceTitles });
    saveChat();
    setPill(els.gpuPill, 'Guide-only fallback', 'warn');
  }
}

async function sendMessage(prefill=null) {
  const question = (prefill ?? els.input.value).trim();
  if (!question || isGenerating) return;
  isGenerating = true;
  els.send.disabled = true;
  els.input.value = '';
  addBubble('user', question);
  chatHistory.push({ role: 'user', content: question });
  saveChat();
  try { await answerQuestion(question); }
  finally { isGenerating = false; els.send.disabled = false; els.input.focus(); }
}

function setupInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferredInstall = e; els.install.style.display = 'block';
  });
  els.install.addEventListener('click', async () => {
    if (deferredInstall) {
      deferredInstall.prompt(); await deferredInstall.userChoice;
      deferredInstall = null; els.install.style.display = 'none'; return;
    }
    els.supportNote.textContent = 'Open the browser menu and choose “Install app” or “Add to Home screen”.';
    els.supportNote.classList.remove('hidden');
  });
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (!standalone && /iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    els.install.style.display = 'block';
    els.install.textContent = 'Add to Home';
    els.install.onclick = () => {
      els.supportNote.textContent = 'On iPhone: tap Share in Safari, then “Add to Home Screen”. Download the AI once while online before relying on offline use.';
      els.supportNote.classList.remove('hidden');
    };
  }
}

async function init() {
  updateConnection();
  addEventListener('online', updateConnection);
  addEventListener('offline', updateConnection);
  await ensureServiceWorker();
  requestPersistence();
  await checkGPU();
  setPill(els.guidePill, `${KNOWLEDGE.length} built-in guide topics`);

  const savedModel = localStorage.getItem('albw-model');
  if (savedModel === MODEL_STANDARD || savedModel === MODEL_LIGHT) els.modelSelect.value = savedModel;
  const ready = localStorage.getItem('albw-runtime-ready');
  if (ready === 'cpu' && !hasWebGPU) {
    setPill(els.gpuPill, 'CPU AI downloaded');
    els.modelBtn.textContent = 'CPU AI downloaded ✓';
  }
  if (ready === 'gpu' && hasWebGPU) {
    setPill(els.gpuPill, 'GPU AI downloaded');
    els.modelBtn.textContent = 'GPU AI downloaded ✓';
  }

  renderHistory();
  setupInstallPrompt();

  els.modelSelect.addEventListener('change', () => localStorage.setItem('albw-model', els.modelSelect.value));
  els.modelBtn.addEventListener('click', async () => {
    els.modelBtn.disabled = true;
    try { await ensureRuntime(); }
    catch (e) {
      setProgress(0, `Could not prepare local AI: ${e?.message || e}`);
      updateModelButtonFromSavedState();
    }
    finally { els.modelBtn.disabled = false; }
  });
  els.send.addEventListener('click', () => sendMessage());
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  els.input.addEventListener('input', () => {
    els.input.style.height='auto';
    els.input.style.height=Math.min(120, els.input.scrollHeight)+'px';
  });
  els.clear.addEventListener('click', () => {
    chatHistory=[]; saveChat();
    [...els.chat.querySelectorAll('.bubble')].forEach(n=>n.remove());
    els.welcome.classList.remove('hidden');
  });
  document.querySelectorAll('.chip').forEach(btn => btn.addEventListener('click', () => sendMessage(btn.dataset.q || btn.textContent)));
}

init();