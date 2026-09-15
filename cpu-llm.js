const WLLAMA_ESM = 'https://cdn.jsdelivr.net/npm/@wllama/wllama@3.6.1/esm/index.js';
const WLLAMA_WASM = 'https://cdn.jsdelivr.net/npm/@wllama/wllama@3.6.1/esm/wasm/wllama.wasm';

const CPU_MODEL = {
  repo: 'unsloth/SmolLM2-360M-Instruct-GGUF',
  file: 'SmolLM2-360M-Instruct-Q4_K_M.gguf',
  label: 'SmolLM2 360M Q4_K_M',
  approxMB: 271,
};

let instance = null;
let loaded = false;

export function cpuModelInfo() {
  return { ...CPU_MODEL };
}

function latestAssistantBody() {
  const bubbles = document.querySelectorAll('.bubble.ai');
  const bubble = bubbles[bubbles.length - 1];
  return bubble?.firstElementChild || null;
}

function setAssistantStatus(text) {
  const body = latestAssistantBody();
  if (body) body.textContent = text;
}

function timeoutAfter(ms, message) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

export async function loadCPUModel(onProgress = () => {}) {
  if (loaded && instance) return instance;

  let runtime;
  try {
    runtime = await import(WLLAMA_ESM);
  } catch (error) {
    throw new Error(`Could not load the CPU AI runtime. ${error?.message || error}`);
  }

  const { Wllama, LoggerWithoutDebug } = runtime;
  if (!instance) {
    instance = new Wllama(
      { default: WLLAMA_WASM },
      {
        allowOffline: true,
        parallelDownloads: 1,
        logger: LoggerWithoutDebug,
      }
    );
  }

  await instance.loadModelFromHF(
    { repo: CPU_MODEL.repo, file: CPU_MODEL.file },
    {
      n_ctx: 2048,
      n_batch: 64,
      n_threads: 1,
      n_gpu_layers: 0,
      useCache: true,
      progressCallback: ({ loaded: bytesLoaded = 0, total = 0 }) => {
        const progress = total > 0 ? bytesLoaded / total : 0;
        onProgress({ progress, loaded: bytesLoaded, total });
      },
    }
  );

  loaded = true;
  return instance;
}

export async function cpuChat(messages, options = {}) {
  if (!loaded) setAssistantStatus('Loading CPU model…');
  const model = await loadCPUModel(options.onProgress || (() => {}));

  const startedAt = performance.now();
  let firstTokenSeen = false;
  setAssistantStatus('Thinking on CPU… 0s');

  const timer = setInterval(() => {
    if (firstTokenSeen) return;
    const seconds = Math.max(1, Math.round((performance.now() - startedAt) / 1000));
    setAssistantStatus(`Thinking on CPU… ${seconds}s`);
  }, 1000);

  try {
    const rawStream = await Promise.race([
      model.createChatCompletion({
        messages,
        max_tokens: options.max_tokens ?? 220,
        temperature: options.temperature ?? 0.12,
        top_p: options.top_p ?? 0.9,
        stream: options.stream ?? true,
      }),
      timeoutAfter(120000, 'CPU AI did not start within 2 minutes.'),
    ]);

    if (!(rawStream && rawStream[Symbol.asyncIterator])) {
      throw new Error('CPU AI did not return a streaming response.');
    }

    const iterator = rawStream[Symbol.asyncIterator]();

    async function* monitoredStream() {
      try {
        let result = await Promise.race([
          iterator.next(),
          timeoutAfter(120000, 'CPU AI did not produce a first token within 2 minutes.'),
        ]);

        while (!result.done) {
          const delta = result.value?.choices?.[0]?.delta?.content || '';
          if (!firstTokenSeen && delta) {
            firstTokenSeen = true;
            clearInterval(timer);
            setAssistantStatus('Answering…');
          }
          yield result.value;
          result = await iterator.next();
        }
      } finally {
        clearInterval(timer);
      }
    }

    return monitoredStream();
  } catch (error) {
    clearInterval(timer);
    throw error;
  }
}
