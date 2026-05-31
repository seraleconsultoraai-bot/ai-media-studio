const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory store for pending async video jobs (prompt/model metadata for gallery save)
const pendingVideoJobs = new Map();
const GALLERY_FILE = path.join(__dirname, 'gallery.json');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

app.use(express.json({ limit: '25mb' }));

// ── Acceso restringido (HTTP Basic Auth) ───────────────────────────
// Define en EasyPanel la variable APP_USERS con pares usuario:contraseña
// separados por coma. Ej:  sergi:miClave123,socio:otraClave456
// Si APP_USERS no está definida, la app queda abierta (útil en local).
const APP_USERS = (process.env.APP_USERS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

if (APP_USERS.length > 0) {
  app.use((req, res, next) => {
    const hdr = req.headers.authorization || '';
    const [scheme, encoded] = hdr.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8'); // "user:pass"
      if (APP_USERS.includes(decoded)) return next();
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="AI Media Studio"');
    return res.status(401).send('Acceso restringido — credenciales requeridas');
  });
  console.log(`[auth] Acceso protegido para ${APP_USERS.length} usuario(s)`);
}

// Serve the all-in-one standalone app as the homepage
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'AI-Media-Studio.html'));
});

// No-cache for HTML/JS/CSS so changes are always picked up in dev
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// Initialize required directories and gallery file
async function initDirs() {
  await fs.mkdir(path.join(UPLOADS_DIR, 'images'), { recursive: true });
  await fs.mkdir(path.join(UPLOADS_DIR, 'videos'), { recursive: true });
  try {
    await fs.access(GALLERY_FILE);
  } catch {
    await fs.writeFile(GALLERY_FILE, JSON.stringify([]));
  }
}

async function getGallery() {
  try {
    const data = await fs.readFile(GALLERY_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveGallery(gallery) {
  await fs.writeFile(GALLERY_FILE, JSON.stringify(gallery, null, 2));
}

async function addToGallery(item) {
  const gallery = await getGallery();
  gallery.unshift(item);
  await saveGallery(gallery);
}

// Models registry
const MODELS = {
  image: [
    { id: 'black-forest-labs/flux-schnell:free', name: 'FLUX Schnell', provider: 'Black Forest Labs', free: true },
    { id: 'black-forest-labs/flux-1.1-pro', name: 'FLUX 1.1 Pro', provider: 'Black Forest Labs' },
    { id: 'black-forest-labs/flux-pro', name: 'FLUX Pro', provider: 'Black Forest Labs' },
    { id: 'black-forest-labs/flux-1.1-pro:ultra', name: 'FLUX 1.1 Pro Ultra', provider: 'Black Forest Labs' },
    { id: 'openai/dall-e-3', name: 'DALL-E 3', provider: 'OpenAI' },
    { id: 'stabilityai/stable-diffusion-3-5-large', name: 'SD 3.5 Large', provider: 'Stability AI' },
    { id: 'stabilityai/stable-diffusion-xl-base-1.0', name: 'SDXL Base 1.0', provider: 'Stability AI' },
    { id: 'recraft-ai/recraft-v3', name: 'Recraft V3', provider: 'Recraft' },
  ],
  video: [
    { id: 'minimax/video-01', name: 'MiniMax Video-01', provider: 'MiniMax' },
    { id: 'minimax/video-01-live', name: 'MiniMax Video-01 Live', provider: 'MiniMax' },
    { id: 'runway/gen-3-alpha-turbo', name: 'Runway Gen-3 Turbo', provider: 'Runway' },
    { id: 'wan-ai/wan-2.1-i2v-480p', name: 'Wan 2.1 I2V 480p', provider: 'Wan AI' },
    { id: 'wan-ai/wan-2.1-t2v-480p', name: 'Wan 2.1 T2V 480p', provider: 'Wan AI' },
    { id: 'kling-ai/kling-video', name: 'Kling Video', provider: 'Kling AI' },
  ],
};

// --- API Routes ---

// Hardcoded fallback models
app.get('/api/models', (req, res) => {
  res.json(MODELS);
});

// Debug: see raw OpenRouter model fields (only in dev)
app.get('/api/models/debug', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'API key requerida' });
  try {
    const r = await axios.get('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` }, timeout: 15000,
    });
    const sample = (r.data.data || []).slice(0, 5).map(m => ({
      id: m.id, modality: m.architecture?.modality,
      input: m.architecture?.input_modalities, output: m.architecture?.output_modalities,
      pricingImage: m.pricing?.image,
    }));
    res.json({ total: r.data.data?.length, sample });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Live model list fetched directly from OpenRouter
app.get('/api/models/live', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'API key requerida' });

  try {
    const response = await axios.get('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 15000,
    });

    const allModels = response.data.data || [];

    // Patterns to identify image/video models robustly
    const IMAGE_ID_PATTERNS   = ['flux', 'stable-diffusion', 'dall-e', 'dalle', 'imagen', 'recraft', 'ideogram', 'kandinsky', 'playground', 'aura', 'kolors', 'hidream', 'wan-', 'cogview', 'hunyuan-image', 'sana'];
    const VIDEO_ID_PATTERNS   = ['video', 'gen-3', 'gen-4', 'kling', 'minimax/video', 'wan-2', 'hunyuan-video', 'cogvideo', 'mochi', 'ltx-video', 'nova-reel', 'luma'];
    const EDITING_ID_PATTERNS = ['kontext', 'inpaint', 'edit', 'gpt-image', 'gemini-flash-imagen', 'native'];

    const matchesAny = (id, patterns) => patterns.some(p => id.toLowerCase().includes(p));

    const hasImageOutput = (m) => {
      const mod = (m.architecture?.modality || '').toLowerCase();
      const outMods = m.architecture?.output_modalities || [];
      return mod.includes('->image') || mod.includes('image') && mod.includes('->') ||
             outMods.some(x => x.toLowerCase().includes('image')) ||
             (m.pricing?.image && m.pricing.image !== '0') ||
             matchesAny(m.id, IMAGE_ID_PATTERNS);
    };

    const hasVideoOutput = (m) => {
      const mod = (m.architecture?.modality || '').toLowerCase();
      const outMods = m.architecture?.output_modalities || [];
      return mod.includes('->video') ||
             outMods.some(x => x.toLowerCase().includes('video')) ||
             matchesAny(m.id, VIDEO_ID_PATTERNS);
    };

    const toModel = (m) => {
      const isFree = m.id.endsWith(':free') ||
        (m.pricing?.image === '0' && (m.pricing?.prompt === '0' || !m.pricing?.prompt));
      const isEditing = matchesAny(m.id, EDITING_ID_PATTERNS) ||
        (m.architecture?.modality || '').includes('+image->image');
      const providerRaw = m.id.split('/')[0] || '';
      const provider = providerRaw.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      // Clean up names like "FLUX 1 [Schnell]" → "FLUX 1 Schnell"
      const name = (m.name || m.id).replace(/\[|\]/g, '').replace(/\s+/g, ' ').trim();
      return { id: m.id, name, provider, editing: isEditing, free: isFree };
    };

    // Chat-completions models that EXPLICITLY output images
    // Use strict check: modality must declare "->image" output, OR output_modalities includes "image"
    // This avoids false positives like multimodal text models (text+image->text)
    const KNOWN_CHAT_IMAGE_PREFIXES = [
      'openai/gpt-image',
      'openai/gpt-4o-image',
      'google/gemini-2.0-flash-exp',
      'google/gemini-flash-1.5-imagen',
    ];
    // Models to always exclude (meta/routing models that claim all modalities but don't generate images)
    const CHAT_IMAGE_EXCLUDE_PREFIXES = ['openrouter/', 'mistralai/', 'anthropic/', 'meta-llama/', 'cohere/'];

    const chatImageModels = allModels
      .filter(m => {
        if (hasVideoOutput(m)) return false;
        // Exclude meta/routing/text-only providers
        if (CHAT_IMAGE_EXCLUDE_PREFIXES.some(p => m.id.startsWith(p))) return false;
        const mod = (m.architecture?.modality || '').toLowerCase();
        const outMods = (m.architecture?.output_modalities || []).map(x => x.toLowerCase());
        // Must explicitly declare image in OUTPUT side of the modality
        const hasExplicitImageOut = mod.includes('->image') || outMods.some(x => x === 'image');
        // OR is a known chat-image model prefix
        const isKnown = KNOWN_CHAT_IMAGE_PREFIXES.some(p => m.id.startsWith(p));
        return hasExplicitImageOut || isKnown;
      })
      .map(m => ({ ...toModel(m), endpoint: 'chat', editing: true }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Classic text-to-image models (FLUX, DALL-E, SD) — use /images/generations endpoint
    // These are NOT in the OpenRouter model list; we maintain a curated static list
    const IMAGES_ENDPOINT_MODELS = [
      { id: 'black-forest-labs/flux-schnell:free',   name: 'FLUX Schnell',        provider: 'Black Forest Labs', free: true,  endpoint: 'images', editing: false },
      { id: 'black-forest-labs/flux-schnell',         name: 'FLUX Schnell Pro',    provider: 'Black Forest Labs', free: false, endpoint: 'images', editing: false },
      { id: 'black-forest-labs/flux-pro',             name: 'FLUX Pro',            provider: 'Black Forest Labs', free: false, endpoint: 'images', editing: false },
      { id: 'black-forest-labs/flux-1.1-pro',         name: 'FLUX 1.1 Pro',        provider: 'Black Forest Labs', free: false, endpoint: 'images', editing: false },
      { id: 'black-forest-labs/flux-1.1-pro:ultra',   name: 'FLUX 1.1 Pro Ultra',  provider: 'Black Forest Labs', free: false, endpoint: 'images', editing: false },
      { id: 'stabilityai/stable-diffusion-3-5-large', name: 'SD 3.5 Large',        provider: 'Stability AI',      free: false, endpoint: 'images', editing: false },
      { id: 'stabilityai/stable-diffusion-xl-base-1.0', name: 'SDXL Base',         provider: 'Stability AI',      free: false, endpoint: 'images', editing: false },
      { id: 'recraft-ai/recraft-v3',                  name: 'Recraft V3',          provider: 'Recraft',           free: false, endpoint: 'images', editing: false },
    ];

    // Combine: classic first, then chat/multimodal at the end (editing-capable)
    const imageModels = [...IMAGES_ENDPOINT_MODELS, ...chatImageModels];

    // Video models — also not in OpenRouter's /models list, so we use a static curated list
    // plus any dynamically detected ones from the API
    // Video models — NOT in OpenRouter's /models catalog (separate system, like FLUX for images)
    // These IDs are validated against OpenRouter's video generation API
    // Video models from OpenRouter's /api/v1/videos/models (14 confirmed models)
    const STATIC_VIDEO_MODELS = [
      { id: 'x-ai/grok-imagine-video',    name: 'Grok Imagine Video',   provider: 'xAI',       free: false },
      { id: 'kwaivgi/kling-v3.0-pro',     name: 'Kling v3.0 Pro',       provider: 'Kuaishou',  free: false },
      { id: 'kwaivgi/kling-v3.0-std',     name: 'Kling v3.0 Standard',  provider: 'Kuaishou',  free: false },
      { id: 'kwaivgi/kling-video-o1',     name: 'Kling Video O1',       provider: 'Kuaishou',  free: false },
      { id: 'google/veo-3.1',             name: 'Veo 3.1',              provider: 'Google',    free: false },
      { id: 'google/veo-3.1-fast',        name: 'Veo 3.1 Fast',         provider: 'Google',    free: false },
      { id: 'google/veo-3.1-lite',        name: 'Veo 3.1 Lite',         provider: 'Google',    free: false },
      { id: 'openai/sora-2-pro',          name: 'Sora 2 Pro',           provider: 'OpenAI',    free: false },
      { id: 'bytedance/seedance-2.0',     name: 'Seedance 2.0',         provider: 'ByteDance', free: false },
      { id: 'bytedance/seedance-2.0-fast',name: 'Seedance 2.0 Fast',    provider: 'ByteDance', free: false },
      { id: 'bytedance/seedance-1-5-pro', name: 'Seedance 1.5 Pro',     provider: 'ByteDance', free: false },
      { id: 'alibaba/wan-2.7',            name: 'Wan 2.7',              provider: 'Alibaba',   free: false },
      { id: 'alibaba/wan-2.6',            name: 'Wan 2.6',              provider: 'Alibaba',   free: false },
      { id: 'minimax/hailuo-2.3',         name: 'Hailuo 2.3',           provider: 'MiniMax',   free: false },
    ];

    // Merge static + any dynamic video models detected from OpenRouter API (dedup by id)
    const dynamicVideoModels = allModels.filter(hasVideoOutput).map(toModel);
    const staticVideoIds = new Set(STATIC_VIDEO_MODELS.map(m => m.id));
    const extraDynamic = dynamicVideoModels.filter(m => !staticVideoIds.has(m.id));
    const videoModels = [...STATIC_VIDEO_MODELS, ...extraDynamic]
      .sort((a, b) => a.name.localeCompare(b.name));

    console.log(`[models/live] ${IMAGES_ENDPOINT_MODELS.length} images-endpoint + ${chatImageModels.length} chat-image + ${videoModels.length} video`);
    if (chatImageModels.length > 0) console.log('[models/live] chat-image models:', chatImageModels.map(m => m.id));
    res.json({ image: imageModels, video: videoModels });

  } catch (error) {
    console.error('Error fetching live models:', error.message);
    res.json(MODELS);
  }
});

app.get('/api/gallery', async (req, res) => {
  const gallery = await getGallery();
  res.json(gallery);
});

app.delete('/api/gallery/:id', async (req, res) => {
  const gallery = await getGallery();
  const item = gallery.find(i => i.id === req.params.id);

  if (item?.localPath) {
    try {
      await fs.unlink(path.join(__dirname, 'public', item.localPath));
    } catch { /* file may already be gone */ }
  }

  await saveGallery(gallery.filter(i => i.id !== req.params.id));
  res.json({ success: true });
});

// Video proxy — streams CDN video through server to avoid CORS restrictions
// The unsigned_urls from OpenRouter are CDN links that browsers can't embed directly
app.get('/api/video/proxy', async (req, res) => {
  const { url, download } = req.query;
  if (!url) return res.status(400).send('URL requerida');

  try {
    const axiosConfig = {
      responseType: 'stream',
      timeout: 120000,
      headers: {},
    };
    // Forward Range header so video seeking works
    if (req.headers.range) axiosConfig.headers.Range = req.headers.range;

    const upstream = await axios.get(url, axiosConfig);

    res.setHeader('Content-Type', upstream.headers['content-type'] || 'video/mp4');
    if (upstream.headers['content-length']) {
      res.setHeader('Content-Length', upstream.headers['content-length']);
    }
    if (upstream.headers['content-range']) {
      res.setHeader('Content-Range', upstream.headers['content-range']);
    }
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');

    if (download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="video_${Date.now()}.mp4"`);
    }

    // 206 Partial Content if range was requested, otherwise 200
    res.status(req.headers.range ? 206 : upstream.status);
    upstream.data.pipe(res);
  } catch (error) {
    console.error('Video proxy error:', error.message);
    if (!res.headersSent) res.status(500).send('Error al obtener el video');
  }
});

// Models that use chat completions endpoint (multimodal output)
const CHAT_IMAGE_PREFIXES = ['openai/gpt-', 'google/gemini-', 'openai/o3', 'openai/o4', 'openai/chatgpt'];

function isChatImageModel(modelId) {
  return CHAT_IMAGE_PREFIXES.some(p => modelId.startsWith(p));
}

// Image generation — routes to the correct endpoint based on model type
app.post('/api/generate/image', async (req, res) => {
  const { prompt, model, negativePrompt, style, inputImageUrl } = req.body;
  const apiKey = req.headers['x-api-key'] || process.env.OPENROUTER_API_KEY;

  if (!apiKey) return res.status(400).json({ error: 'API key requerida' });
  if (!prompt) return res.status(400).json({ error: 'El prompt es requerido' });

  const selectedModel = model || 'black-forest-labs/flux-schnell:free';
  const fullPrompt = style ? `${prompt}, ${style}` : prompt;

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'HTTP-Referer': `http://localhost:${PORT}`,
    'X-Title': 'AI Media Generator',
    'Content-Type': 'application/json',
  };

  try {
    let imageUrl = null;

    // If reference image provided → must use chat completions (multimodal)
    // Otherwise → use images endpoint for classic models, chat for GPT/Gemini
    const useChatCompletions = inputImageUrl || isChatImageModel(selectedModel);

    if (!useChatCompletions) {
      // ── IMAGES ENDPOINT (FLUX, DALL-E, SD, Recraft…) ──────────────────
      console.log(`[generate/image] images endpoint → ${selectedModel}`);
      const payload = { model: selectedModel, prompt: fullPrompt, n: 1 };
      if (negativePrompt) payload.negative_prompt = negativePrompt;

      const response = await axios.post(
        'https://openrouter.ai/api/v1/images/generations',
        payload,
        { headers, timeout: 90000 }
      );

      imageUrl = response.data.data?.[0]?.url
        || (response.data.data?.[0]?.b64_json ? `data:image/png;base64,${response.data.data[0].b64_json}` : null);

    } else {
      // ── CHAT COMPLETIONS (GPT-5 Image, Gemini Image, or editing) ───────
      console.log(`[generate/image] chat completions → ${selectedModel}`);
      const messageContent = inputImageUrl
        ? [
            { type: 'image_url', image_url: { url: inputImageUrl } },
            { type: 'text', text: fullPrompt },
          ]
        : fullPrompt;

      const payload = {
        model: selectedModel,
        messages: [{ role: 'user', content: messageContent }],
      };
      if (negativePrompt) payload.negative_prompt = negativePrompt;

      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        payload,
        { headers, timeout: 90000 }
      );

      imageUrl = extractImageUrl(response.data);
    }

    if (!imageUrl) {
      return res.status(502).json({ error: 'El modelo no devolvió una imagen. Prueba con otro modelo.' });
    }

    const { localPath, finalUrl } = await downloadAndSave(imageUrl, 'images');

    const item = {
      id: uuidv4(),
      type: inputImageUrl ? 'edited' : 'image',
      prompt: fullPrompt,
      model: selectedModel,
      url: finalUrl,
      localPath,
      createdAt: new Date().toISOString(),
    };

    await addToGallery(item);
    res.json({ success: true, url: localPath || finalUrl, item });

  } catch (error) {
    const msg = error.response?.data?.error?.message || error.message;
    console.error('Image generation error:', msg);
    res.status(500).json({ error: msg });
  }
});

// Video generation — submits async job to OpenRouter /api/v1/videos
// Returns job_id immediately; client polls /api/video/status/:jobId
app.post('/api/generate/video', async (req, res) => {
  const { prompt, model, imageUrl: inputImageUrl } = req.body;
  const apiKey = req.headers['x-api-key'] || process.env.OPENROUTER_API_KEY;

  if (!apiKey) return res.status(400).json({ error: 'API key requerida' });
  if (!prompt) return res.status(400).json({ error: 'El prompt es requerido' });

  const selectedModel = model || 'kwaivgi/kling-v3.0-std';

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'HTTP-Referer': `http://localhost:${PORT}`,
    'X-Title': 'AI Media Generator',
    'Content-Type': 'application/json',
  };

  try {
    const payload = { model: selectedModel, prompt };

    if (inputImageUrl) {
      // Local server paths must be converted to base64 (OpenRouter can't reach localhost)
      let imageData = inputImageUrl;
      if (inputImageUrl.startsWith('/uploads/')) {
        try {
          const filePath = path.join(__dirname, 'public', inputImageUrl);
          const buf = await fs.readFile(filePath);
          const ext = (path.extname(inputImageUrl).slice(1) || 'png').replace('jpg', 'jpeg');
          imageData = `data:image/${ext};base64,${buf.toString('base64')}`;
        } catch (e) {
          console.error('Could not read local image:', e.message);
          imageData = null;
        }
      }
      // OpenRouter video API uses frame_images array for image-to-video (first_frame)
      if (imageData) {
        payload.frame_images = [{
          type: 'image_url',
          image_url: { url: imageData },
          frame_type: 'first_frame',
        }];
      }
    }

    const response = await axios.post(
      'https://openrouter.ai/api/v1/videos',
      payload,
      { headers, timeout: 30000 }
    );

    console.log(`[generate/video] raw response:`, JSON.stringify(response.data).slice(0, 500));
    const { id: jobId, status, polling_url } = response.data;

    if (!jobId) {
      console.error('[generate/video] no job ID in response:', response.data);
      return res.status(502).json({ error: 'OpenRouter no devolvió un ID de trabajo. Respuesta: ' + JSON.stringify(response.data).slice(0, 200) });
    }

    // Store metadata so we can save to gallery when job completes
    pendingVideoJobs.set(jobId, {
      prompt,
      model: selectedModel,
      createdAt: new Date().toISOString(),
    });

    console.log(`[generate/video] job submitted: ${jobId} status=${status}`);
    res.json({ jobId, status, pollingUrl: polling_url });

  } catch (error) {
    const msg = error.response?.data?.error?.message || error.message;
    console.error('Video job submission error:', msg, error.response?.data);
    res.status(500).json({ error: msg });
  }
});

// Video status polling — client calls this every few seconds until status="completed"
app.get('/api/video/status/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const apiKey = req.headers['x-api-key'] || process.env.OPENROUTER_API_KEY;

  if (!apiKey) return res.status(400).json({ error: 'API key requerida' });

  try {
    const response = await axios.get(
      `https://openrouter.ai/api/v1/videos/${jobId}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': `http://localhost:${PORT}`,
        },
        timeout: 15000,
      }
    );

    const { status, unsigned_urls, urls, url: directUrl, progress, failure_reason, error: apiError } = response.data;

    console.log(`[video/status] jobId=${jobId} status=${status} data=${JSON.stringify(response.data).slice(0, 300)}`);

    if (status === 'failed' || status === 'error') {
      pendingVideoJobs.delete(jobId);
      return res.json({ status: 'failed', error: failure_reason || apiError || 'La generación del video falló' });
    }

    // OpenRouter may return unsigned_urls, urls, or url depending on the version
    const urlList = unsigned_urls || urls || (directUrl ? [directUrl] : null);

    if ((status === 'completed' || status === 'succeeded') && urlList?.length > 0) {
      const videoUrl = urlList[0];
      const jobMeta = pendingVideoJobs.get(jobId) || {};
      pendingVideoJobs.delete(jobId);

      // Save gallery entry immediately with CDN URL (don't await disk download)
      const item = {
        id: uuidv4(),
        type: 'video',
        prompt: jobMeta.prompt || '',
        model: jobMeta.model || '',
        url: videoUrl,   // CDN URL — proxy serves this to browser
        localPath: null, // filled in by background download below
        createdAt: jobMeta.createdAt || new Date().toISOString(),
      };
      await addToGallery(item);

      // Background download — fires and forgets so response is instant
      const savedItemId = item.id;
      downloadAndSaveVideo(videoUrl).then(async ({ localPath }) => {
        if (!localPath) return;
        const gallery = await getGallery();
        const idx = gallery.findIndex(g => g.id === savedItemId);
        if (idx !== -1) { gallery[idx].localPath = localPath; await saveGallery(gallery); }
        console.log(`[video] background save done: ${localPath}`);
      }).catch(e => console.error('[video] background save failed:', e.message));

      console.log(`[video/status] completed instantly: ${jobId}`);
      return res.json({ status: 'completed', url: videoUrl, item });
    }

    // Still pending or in_progress
    res.json({ status, progress: progress ?? null });

  } catch (error) {
    const msg = error.response?.data?.error?.message || error.message;
    console.error('Video status error:', msg);
    res.status(500).json({ error: msg });
  }
});

// --- Helpers ---

function extractImageUrl(data) {
  // OpenAI images endpoint format: {data: [{url}]} or {data: [{b64_json}]}
  if (data.data?.[0]?.url) return data.data[0].url;
  if (data.data?.[0]?.b64_json) return `data:image/png;base64,${data.data[0].b64_json}`;

  // ── OpenRouter-specific: images in message.images[] (Gemini, GPT-5 Image via OpenRouter) ──
  const msgImages = data.choices?.[0]?.message?.images;
  if (Array.isArray(msgImages) && msgImages.length > 0) {
    const img = msgImages[0];
    if (img.type === 'image_url' && img.image_url?.url) return img.image_url.url;
    if (img.url) return img.url;
  }

  // Chat completions format
  const content = data.choices?.[0]?.message?.content;

  if (typeof content === 'string') {
    // Markdown image: ![...](url)
    const mdMatch = content.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/);
    if (mdMatch) return mdMatch[1];
    // Inline base64 data URI
    const b64Match = content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/);
    if (b64Match) return b64Match[0];
    // URL with image extension
    const urlMatch = content.match(/https?:\/\/\S+\.(png|jpg|jpeg|webp|gif)/i);
    if (urlMatch) return urlMatch[0];
    // Any bare URL
    if (content.trim().startsWith('http')) return content.trim();
  }

  if (Array.isArray(content)) {
    for (const part of content) {
      // Standard OpenAI-style image_url part
      if (part.type === 'image_url') return part.image_url?.url;
      // Gemini inlineData (base64) part
      if (part.type === 'image' && part.source?.type === 'base64') {
        return `data:${part.source.media_type};base64,${part.source.data}`;
      }
      // Some models return inline_data
      if (part.inline_data?.data) {
        return `data:${part.inline_data.mime_type || 'image/png'};base64,${part.inline_data.data}`;
      }
    }
  }

  // Gemini native format (candidates instead of choices)
  const parts = data.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (part.inlineData?.data) {
        return `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
      }
      if (part.fileData?.fileUri) return part.fileData.fileUri;
    }
  }

  // Log raw response when nothing matched (helps debugging)
  console.error('[extractImageUrl] could not extract image from response:', JSON.stringify(data).slice(0, 500));
  return null;
}

async function downloadAndSaveVideo(videoUrl) {
  if (!videoUrl || videoUrl.startsWith('data:')) {
    return { localPath: null, finalUrl: videoUrl };
  }
  try {
    const res = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 120000 });
    const filename = `${uuidv4()}.mp4`;
    const filepath = path.join(UPLOADS_DIR, 'videos', filename);
    await fs.writeFile(filepath, res.data);
    const localPath = `/uploads/videos/${filename}`;
    return { localPath, finalUrl: videoUrl };
  } catch (e) {
    console.error('Could not download video to disk:', e.message);
    return { localPath: null, finalUrl: videoUrl };
  }
}

async function downloadAndSave(imageUrl, subdir) {
  if (imageUrl.startsWith('data:')) {
    const base64 = imageUrl.replace(/^data:image\/\w+;base64,/, '');
    const filename = `${uuidv4()}.png`;
    const filepath = path.join(UPLOADS_DIR, subdir, filename);
    await fs.writeFile(filepath, Buffer.from(base64, 'base64'));
    const localPath = `/uploads/${subdir}/${filename}`;
    return { localPath, finalUrl: localPath };
  }

  try {
    const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
    const ext = imageUrl.split('.').pop().split('?')[0] || 'png';
    const filename = `${uuidv4()}.${ext}`;
    const filepath = path.join(UPLOADS_DIR, subdir, filename);
    await fs.writeFile(filepath, imgRes.data);
    const localPath = `/uploads/${subdir}/${filename}`;
    return { localPath, finalUrl: imageUrl };
  } catch {
    return { localPath: null, finalUrl: imageUrl };
  }
}

// Start server
initDirs().then(() => {
  app.listen(PORT, () => {
    console.log(`\n✦ AI Media Generator corriendo en http://localhost:${PORT}\n`);
  });
}).catch(console.error);
