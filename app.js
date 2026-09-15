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

let engine = null;
let engineModel = null;
let deferredInstall = null;
let isGenerating = false;
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

function retrieve(question, limit=6) {
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
      if (body.includes(w)) {
        score += w.length >= 7 ? 5 : w.length >= 5 ? 3 : 2;
        score += Math.min(body.split(w).length - 1, 3);
      }
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
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
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

async function checkGPU() {
  if (!('gpu' in navigator)) {
    setPill(els.gpuPill, 'WebGPU unavailable', 'bad');
    els.supportNote.textContent = 'This browser cannot run the local AI. On Android, use an up-to-date Chrome browser. If Chrome is current, this phone/GPU may not expose WebGPU.';
    els.supportNote.classList.remove('hidden');
    return false;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter');
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
  setProgress(0.02, navigator.onLine ? 'Downloading/preparing the local AI…' : 'Loading the saved AI from this phone…');

  try {
    const webllm = await import(WEBLLM_URL);
    engine = await webllm.CreateMLCEngine(modelId, {
      initProgressCallback: (p) => setProgress(p.progress || 0, p.text || `Preparing AI… ${Math.round((p.progress || 0)*100)}%`)
    });
    engineModel = modelId;
    localStorage.setItem('albw-model', modelId);
    localStorage.setItem('albw-model-ready', '1');
    setProgress(1, `AI ready offline: ${modelId === MODEL_STANDARD ? 'Llama 3.2 1B' : 'SmolLM2 360M'}. The game guide is built in.`);
    setPill(els.gpuPill, 'AI ready offline');
    return engine;
  } catch (err) {
    console.error(err);
    if (allowFallback && modelId === MODEL_STANDARD && navigator.onLine) {
      els.modelSelect.value = MODEL_LIGHT;
      localStorage.setItem('albw-model', MODEL_LIGHT);
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

function systemPrompt() {
  return `You are an offline companion for The Legend of Zelda: A Link Between Worlds on Nintendo 3DS. Answer only about this game. The supplied built-in guide notes are your primary source of truth. Use them closely and do not invent exact chest positions, room directions, item requirements, boss mechanics or collectible locations that are not supported by the notes. If the notes are not precise enough, say what you do know and ask the player for the dungeon, room feature, item or objective they can see. Keep answers practical and concise. If the user asks for a hint, give the smallest useful hint and avoid spoilers. If they ask for full directions, give clear numbered steps. Never mention model training or pretend you searched the internet.`;
}

async function answerQuestion(question) {
  const modelId = els.modelSelect.value;
  const localEngine = await loadEngine(modelId);
  const hits = retrieve(question, 6);
  const excerpts = hits.length
    ? hits.map((h,i) => `[Built-in guide topic ${i+1}: ${h.title}]\n${h.text}`).join('\n\n')
    : '[No close built-in guide topic matched this wording. Ask for more specific context rather than guessing.]';

  const earlier = chatHistory.slice(0, -1).slice(-6).map(m => ({ role: m.role, content: m.content }));
  const messages = [
    { role: 'system', content: systemPrompt() },
    ...earlier,
    { role: 'user', content: `Player question: ${question}\n\nRelevant built-in A Link Between Worlds guide notes:\n${excerpts}` }
  ];

  const sourceTitles = hits.map(h => h.title);
  const bubble = addBubble('assistant', '…', sourceTitles);
  let full = '';

  try {
    const stream = await localEngine.chat.completions.create({
      messages,
      temperature: 0.12,
      top_p: 0.9,
      max_tokens: modelId === MODEL_LIGHT ? 240 : 360,
      stream: true
    });
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content || '';
      full += delta;
      bubble.body.textContent = full || '…';
      window.scrollTo({ top: document.body.scrollHeight });
    }
    if (!full.trim()) full = 'I could not form a reliable answer from the built-in notes. Tell me the dungeon/location and what you can see on screen.';
    bubble.body.textContent = full;
    chatHistory.push({ role: 'assistant', content: full, sources: sourceTitles });
    saveChat();
  } catch (err) {
    bubble.body.textContent = `Local model error: ${err?.message || err}`;
    throw err;
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
  catch (e) { console.error(e); }
  finally { isGenerating = false; els.send.disabled = false; els.input.focus(); }
}

function setupInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferredInstall = e; els.install.style.display = 'block';
  });
  els.install.addEventListener('click', async () => {
    if (deferredInstall) {
      deferredInstall.prompt();
      await deferredInstall.userChoice;
      deferredInstall = null;
      els.install.style.display = 'none';
      return;
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
  checkGPU();
  setPill(els.guidePill, `${KNOWLEDGE.length} built-in guide topics`);

  const savedModel = localStorage.getItem('albw-model');
  if (savedModel === MODEL_STANDARD || savedModel === MODEL_LIGHT) els.modelSelect.value = savedModel;
  if (localStorage.getItem('albw-model-ready') === '1') setPill(els.gpuPill, 'AI downloaded');

  renderHistory();
  setupInstallPrompt();

  els.modelSelect.addEventListener('change', () => localStorage.setItem('albw-model', els.modelSelect.value));
  els.modelBtn.addEventListener('click', () => loadEngine(els.modelSelect.value).catch(() => {}));
  els.send.addEventListener('click', () => sendMessage());
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  els.input.addEventListener('input', () => {
    els.input.style.height='auto';
    els.input.style.height=Math.min(120, els.input.scrollHeight)+'px';
  });
  els.clear.addEventListener('click', () => {
    chatHistory=[];
    saveChat();
    [...els.chat.querySelectorAll('.bubble')].forEach(n=>n.remove());
    els.welcome.classList.remove('hidden');
  });
  document.querySelectorAll('.chip').forEach(btn => btn.addEventListener('click', () => sendMessage(btn.dataset.q || btn.textContent)));
}

init();
