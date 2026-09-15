const WLLAMA_ESM = 'https://cdn.jsdelivr.net/npm/@wllama/wllama@3.6.1/esm/index.js';
const WLLAMA_WASM = 'https://cdn.jsdelivr.net/npm/@wllama/wllama@3.6.1/esm/wasm/wllama.wasm';

const CPU_MODEL = {
  repo: 'tensorblock/SmolLM2-360M-Instruct-GGUF',
  file: 'SmolLM2-360M-Instruct-Q4_K_M.gguf',
  label: 'SmolLM2 360M Q4_K_M',
  approxMB: 271,
};

let instance = null;
let loaded = false;

export function cpuModelInfo() {
  return { ...CPU_MODEL };
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
  const model = await loadCPUModel(options.onProgress || (() => {}));
  return model.createChatCompletion({
    messages,
    max_tokens: options.max_tokens ?? 220,
    temperature: options.temperature ?? 0.12,
    top_p: options.top_p ?? 0.9,
    stream: options.stream ?? true,
  });
}
