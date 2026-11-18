// Speech recognition for "Write lyrics from the singing", in a worker so the page stays responsive.
// Uses OpenAI's Whisper through transformers.js (Hugging Face), entirely on this device: the model is
// downloaded once from Hugging Face and cached by the browser.

const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js";

let recognizer = null;
let loadedModel = null;

const post = (msg) => self.postMessage(msg);

self.onmessage = async ({ data }) => {
  const { audio, model, language } = data;
  try {
    const { pipeline, env } = await import(TRANSFORMERS_URL);
    env.allowLocalModels = false;

    if (!recognizer || loadedModel !== model) {
      const files = {};
      recognizer = await pipeline("automatic-speech-recognition", model, {
        // The quantized (8-bit) model: about a quarter of the download, small accuracy cost.
        dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
        device: "wasm",
        progress_callback: (p) => {
          if (p.status === "progress" && p.total) {
            files[p.file] = { loaded: p.loaded, total: p.total };
            const all = Object.values(files);
            const loaded = all.reduce((s, f) => s + f.loaded, 0);
            const total = all.reduce((s, f) => s + f.total, 0);
            post({ type: "download", loaded, total });
          }
        },
      });
      loadedModel = model;
    }

    post({ type: "listening" });
    const started = performance.now();
    const result = await recognizer(audio, {
      // Whisper hears 30 s at a time; longer audio is cut into overlapping pieces and joined up.
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      task: "transcribe",
      ...(language ? { language } : {}),
    });
    post({ type: "done", chunks: result.chunks || [], text: result.text || "", seconds: (performance.now() - started) / 1000 });
  } catch (err) {
    post({ type: "error", message: String(err?.message || err) });
  }
};
