// ====== STATE ======
const state = {
  apiKey: localStorage.getItem('openrouter_api_key') || '',
  activeType: 'image',
  activeFilter: 'all',
  gallery: [],
  currentResult: null,
  generating: false,
  cancelRequested: false,
  models: { image: [], video: [] },
  uploadedImageBase64: null,   // video input image
  refImageBase64: null,        // image editing reference
  currentModalItem: null,
};

// ====== INIT ======
async function init() {
  setupEventListeners();
  updateApiStatus();
  if (state.apiKey) {
    document.getElementById('apiKeyInput').value = state.apiKey;
  }
  await loadModels();
  await loadGallery();
}

// ====== MODELS ======
async function loadModels() {
  if (state.apiKey) {
    await loadLiveModels();
  } else {
    await loadFallbackModels();
    populateModelSelect(state.activeType === 'video' ? 'video' : 'image');
    renderModelInfo();
  }
}

async function loadLiveModels() {
  setModelLoadingState(true);
  try {
    const res = await fetch('/api/models/live', {
      headers: { 'x-api-key': state.apiKey },
    });
    if (!res.ok) throw new Error('Live models failed');
    const data = await res.json();
    if ((data.image?.length || 0) + (data.video?.length || 0) > 0) {
      state.models = data;
    } else {
      await loadFallbackModels();
    }
  } catch {
    await loadFallbackModels();
  } finally {
    setModelLoadingState(false);
    populateModelSelect(state.activeType === 'video' ? 'video' : 'image');
    renderModelInfo();
  }
}

async function loadFallbackModels() {
  try {
    const res = await fetch('/api/models');
    state.models = await res.json();
  } catch (e) {
    console.error('Error loading fallback models:', e);
  }
}

function setModelLoadingState(loading) {
  const sel = document.getElementById('modelSelect');
  if (loading) {
    sel.innerHTML = '<option disabled selected>Cargando modelos...</option>';
    sel.disabled = true;
  } else {
    sel.disabled = false;
  }
}

function populateModelSelect(type, filterList = null) {
  const sel = document.getElementById('modelSelect');
  sel.innerHTML = '';

  let models = type === 'video' ? state.models.video : state.models.image;
  if (filterList) models = filterList;

  models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name + (m.free ? ' (Gratis)' : '') + (m.editing ? ' ✏️' : '');
    sel.appendChild(opt);
  });

  // Select first option by default
  if (sel.options.length > 0) sel.selectedIndex = 0;
}

function renderModelInfo() {
  const grid = document.getElementById('modelInfoGrid');
  const images = state.models.image || [];
  const videos = state.models.video || [];
  const all = [...images, ...videos];

  if (all.length === 0) {
    grid.innerHTML = '<p class="settings-desc">Guarda tu API key para ver todos los modelos disponibles.</p>';
    return;
  }

  const totalFree = all.filter(m => m.free).length;
  grid.innerHTML = `
    <div class="model-summary">
      <span>🖼️ ${images.length} modelos de imagen</span>
      <span>🎬 ${videos.length} modelos de video</span>
      <span>🆓 ${totalFree} gratuitos</span>
    </div>
    ${all.map(m => `
      <div class="model-info-item">
        <div class="model-name">
          ${escHtml(m.name)}
          ${m.free ? '<span class="model-badge free">GRATIS</span>' : ''}
          ${m.editing ? '<span class="model-badge edit">EDICIÓN</span>' : ''}
        </div>
        <div class="model-provider">${escHtml(m.provider || '')}</div>
      </div>
    `).join('')}
  `;
}

// ====== EVENT LISTENERS ======
function setupEventListeners() {
  // Tab navigation
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Type buttons
  document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => switchType(btn.dataset.type));
  });

  // Ratio buttons
  document.querySelectorAll('.ratio-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ratio-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Prompt
  const promptInput = document.getElementById('promptInput');
  promptInput.addEventListener('input', () => {
    document.getElementById('charCount').textContent = promptInput.value.length;
  });

  document.getElementById('clearPromptBtn').addEventListener('click', () => {
    promptInput.value = '';
    document.getElementById('negativePrompt').value = '';
    document.getElementById('charCount').textContent = '0';
    promptInput.focus();
  });

  // Negative prompt toggle
  document.getElementById('toggleNegative').addEventListener('click', () => {
    const neg = document.getElementById('negativePrompt');
    const btn = document.getElementById('toggleNegative');
    const isHidden = neg.classList.contains('hidden');
    neg.classList.toggle('hidden', !isHidden);
    btn.textContent = isHidden ? '－ Prompt negativo' : '＋ Prompt negativo';
    if (isHidden) neg.focus();
  });

  // Generate
  document.getElementById('generateBtn').addEventListener('click', generate);
  promptInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.ctrlKey) generate();
  });

  // Result actions
  document.getElementById('downloadBtn').addEventListener('click', downloadResult);
  document.getElementById('copyPromptBtn').addEventListener('click', copyPrompt);
  document.getElementById('useAsInputBtn').addEventListener('click', useCurrentAsVideoInput);

  // Gallery filters
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => filterGallery(btn.dataset.filter));
  });

  // Settings - API Key
  document.getElementById('saveApiKeyBtn').addEventListener('click', saveApiKey);
  document.getElementById('apiKeyInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveApiKey();
  });

  document.getElementById('toggleApiKeyBtn').addEventListener('click', () => {
    const input = document.getElementById('apiKeyInput');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  // Video image upload — explicit click handler so the area always opens the file dialog
  document.getElementById('videoImageUpload').addEventListener('click', (e) => {
    if (!e.target.matches('input[type="file"]')) document.getElementById('videoImageInput').click();
  });
  document.getElementById('videoImageInput').addEventListener('change', handleImageUpload);
  document.getElementById('clearUpload').addEventListener('click', clearUploadedImage);

  // Reference image upload (for image editing) — same explicit click fallback
  document.getElementById('imgFileUpload').addEventListener('click', (e) => {
    if (!e.target.matches('input[type="file"]')) document.getElementById('imageFileInput').click();
  });
  document.getElementById('imageFileInput').addEventListener('change', handleRefImageUpload);
  document.getElementById('clearImgUpload').addEventListener('click', clearRefImage);

  // Modal
  document.getElementById('modalBackdrop').addEventListener('click', closeModal);
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modalDownloadBtn').addEventListener('click', () => {
    if (state.currentModalItem) downloadItem(state.currentModalItem.id);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
  });

  // Cancel video generation
  document.getElementById('cancelBtn').addEventListener('click', () => {
    state.cancelRequested = true;
    showToast('Cancelando...', 'warning');
  });
}

// ====== TAB SWITCHING ======
function switchTab(tab) {
  document.querySelectorAll('.nav-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-content').forEach(c => {
    c.classList.toggle('active', c.id === `tab-${tab}`);
    c.classList.toggle('hidden', c.id !== `tab-${tab}`);
  });
  if (tab === 'gallery') loadGallery();
}

// ====== TYPE SWITCHING ======
function switchType(type) {
  state.activeType = type;

  document.querySelectorAll('.type-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === type);
  });

  const isImage = type === 'image';
  const isVideo = type === 'video';
  const isAvatar = type === 'avatar';

  document.getElementById('imageSettings').classList.toggle('hidden', isVideo);
  document.getElementById('videoSettings').classList.toggle('hidden', !isVideo);
  document.getElementById('avatarSettings').classList.toggle('hidden', !isAvatar);

  // Clear reference image when switching away from image mode
  if (isVideo || isAvatar) clearRefImage();
  document.getElementById('useAsInputBtn').classList.toggle('hidden', isVideo);

  populateModelSelect(isVideo ? 'video' : 'image');

  const loadingSubText = document.getElementById('loadingSubText');
  if (isVideo) {
    loadingSubText.textContent = 'Los videos pueden tardar 1-3 minutos';
  } else {
    loadingSubText.textContent = 'Esto puede tardar unos segundos';
  }
}

// ====== IMAGE UPLOAD (for video input) ======
async function handleImageUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const normalizedBase64 = await normalizeImageOrientation(file);
    state.uploadedImageBase64 = normalizedBase64;

    // Show preview
    document.getElementById('videoImageUpload').classList.add('hidden');
    const previewBox = document.getElementById('videoPreviewBox');
    previewBox.classList.remove('hidden');
    document.getElementById('videoPreviewThumb').src = normalizedBase64;

    showToast('Imagen cargada como base para el video', 'success');
  } catch {
    // Fallback
    const reader = new FileReader();
    reader.onload = (ev) => {
      state.uploadedImageBase64 = ev.target.result;
      document.getElementById('videoImageUpload').classList.add('hidden');
      document.getElementById('videoPreviewBox').classList.remove('hidden');
      document.getElementById('videoPreviewThumb').src = ev.target.result;
      showToast('Imagen cargada como base para el video', 'success');
    };
    reader.readAsDataURL(file);
  }
}

function clearUploadedImage() {
  state.uploadedImageBase64 = null;
  document.getElementById('videoImageInput').value = '';
  document.getElementById('videoImageUpload').classList.remove('hidden');
  document.getElementById('videoPreviewBox').classList.add('hidden');
}

// Normalizes EXIF orientation using canvas so AI models see correctly-oriented pixels
async function normalizeImageOrientation(file) {
  // createImageBitmap respects EXIF orientation in modern browsers
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.88);
}

// Reference image for image editing
async function handleRefImageUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  if (file.size > 10 * 1024 * 1024) {
    showToast('La imagen debe pesar menos de 10 MB', 'error');
    return;
  }

  try {
    // Normalize orientation (fixes EXIF rotation from phone cameras)
    const normalizedBase64 = await normalizeImageOrientation(file);
    state.refImageBase64 = normalizedBase64;

    // Show preview (also orientation-corrected)
    document.getElementById('imgFileUpload').classList.add('hidden');
    const previewBox = document.getElementById('imgPreviewBox');
    previewBox.classList.remove('hidden');
    document.getElementById('imgPreviewThumb').src = normalizedBase64;

    // Show editing hint
    document.getElementById('editingHint').classList.remove('hidden');

    // Filter model dropdown to only show editing-capable models
    const editingModels = state.models.image.filter(m => m.editing);
    if (editingModels.length > 0) {
      populateModelSelect('image', editingModels);
    } else {
      showToast('Sube un prompt describiendo los cambios. Usa GPT Image o Gemini para mejores resultados.', 'warning');
    }

    // Update prompt placeholder
    document.getElementById('promptInput').placeholder =
      'Describe los cambios que quieres hacer... (Ej: "Cambia el fondo por un atardecer en la playa", "Añade un sombrero rojo", "Convierte a estilo anime")';

    showToast('Imagen cargada — describe cómo editarla en el prompt', 'success');
  } catch (err) {
    console.error('Error normalizing image:', err);
    // Fallback: read as-is without normalization
    const reader = new FileReader();
    reader.onload = (ev) => {
      state.refImageBase64 = ev.target.result;
      document.getElementById('imgFileUpload').classList.add('hidden');
      document.getElementById('imgPreviewBox').classList.remove('hidden');
      document.getElementById('imgPreviewThumb').src = ev.target.result;
      document.getElementById('editingHint').classList.remove('hidden');
      const editingModels = state.models.image.filter(m => m.editing);
      if (editingModels.length > 0) populateModelSelect('image', editingModels);
      showToast('Imagen cargada — describe cómo editarla en el prompt', 'success');
    };
    reader.readAsDataURL(file);
  }
}

function clearRefImage() {
  state.refImageBase64 = null;
  document.getElementById('imageFileInput').value = '';
  document.getElementById('imgFileUpload').classList.remove('hidden');
  document.getElementById('imgPreviewBox').classList.add('hidden');
  document.getElementById('editingHint').classList.add('hidden');
  document.getElementById('promptInput').placeholder =
    'Describe lo que quieres crear... (Ej: \'Un dragón dorado volando sobre una ciudad futurista al atardecer, estilo cinematográfico\')';
  // Restore all image models
  populateModelSelect('image');
}

function useCurrentAsVideoInput() {
  if (!state.currentResult) return;
  switchType('video');
  document.querySelectorAll('.type-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === 'video');
  });
  state.uploadedImageBase64 = state.currentResult.url;
  document.getElementById('uploadLabel').textContent = 'Imagen generada';
  document.getElementById('clearUpload').classList.remove('hidden');
  showToast('Imagen añadida como base del video', 'success');
}

// ====== API KEY ======
async function saveApiKey() {
  const key = document.getElementById('apiKeyInput').value.trim();
  const info = document.getElementById('apiKeyInfo');

  if (!key) {
    info.textContent = 'Introduce una API key';
    info.className = 'api-key-info error';
    return;
  }
  if (!key.startsWith('sk-')) {
    info.textContent = 'La key debe empezar con "sk-"';
    info.className = 'api-key-info error';
    return;
  }

  state.apiKey = key;
  localStorage.setItem('openrouter_api_key', key);
  info.textContent = '✓ Cargando modelos de OpenRouter...';
  info.className = 'api-key-info success';
  updateApiStatus();
  await loadLiveModels();
  const total = (state.models.image?.length || 0) + (state.models.video?.length || 0);
  info.textContent = `✓ API key guardada · ${total} modelos cargados`;
  info.className = 'api-key-info success';
}

function updateApiStatus() {
  const dot = document.querySelector('.status-dot');
  const text = document.querySelector('.status-text');
  if (state.apiKey) {
    dot.classList.add('connected');
    text.textContent = 'Conectado';
  } else {
    dot.classList.remove('connected');
    text.textContent = 'Sin API Key';
  }
}

// ====== GENERATE ======
async function generate() {
  const prompt = document.getElementById('promptInput').value.trim();

  if (!prompt) {
    showToast('Escribe un prompt para continuar', 'error');
    document.getElementById('promptInput').focus();
    return;
  }

  if (!state.apiKey) {
    showToast('Añade tu API key en Configuración primero', 'warning');
    switchTab('settings');
    return;
  }

  if (state.generating) return;

  state.generating = true;
  document.getElementById('generateBtn').disabled = true;

  // Show loading UI
  document.getElementById('resultPlaceholder').classList.add('hidden');
  document.getElementById('resultContent').classList.add('hidden');
  document.getElementById('loadingOverlay').classList.remove('hidden');

  const isVideo = state.activeType === 'video';
  document.getElementById('loadingText').textContent = isVideo ? 'Generando video...' : 'Generando imagen...';

  try {
    const style = document.getElementById('styleSelect')?.value || '';
    const avatarStyle = document.getElementById('avatarStyle')?.value || '';
    const negativePrompt = document.getElementById('negativePrompt').value.trim();
    const effectiveStyle = state.activeType === 'avatar' ? avatarStyle : style;

    const body = {
      prompt,
      model: document.getElementById('modelSelect').value,
      negativePrompt: negativePrompt || undefined,
      style: effectiveStyle || undefined,
    };

    if (isVideo) {
      // ── ASYNC VIDEO JOB ─────────────────────────────────────
      if (state.uploadedImageBase64) body.imageUrl = state.uploadedImageBase64;
      await pollVideoGeneration(body);

    } else {
      // ── IMAGE GENERATION ────────────────────────────────────
      if (state.refImageBase64) {
        const selectedModel = state.models.image.find(m => m.id === body.model);
        if (selectedModel && !selectedModel.editing) {
          showToast('Con imagen de referencia debes usar un modelo de edición. Cambiando...', 'warning');
          const editingModel = state.models.image.find(m => m.editing);
          if (editingModel) {
            body.model = editingModel.id;
            document.getElementById('modelSelect').value = editingModel.id;
          }
        }
        body.inputImageUrl = state.refImageBase64;
      }

      const res = await fetch('/api/generate/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': state.apiKey },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error desconocido del servidor');

      state.currentResult = { ...data, type: state.activeType };
      showResult(data.url, state.activeType);
      showToast('¡Generado con éxito! ✦', 'success');
      if (state.gallery.length > 0) await loadGallery();
    }

  } catch (err) {
    console.error(err);
    showToast(err.message, 'error');
    document.getElementById('resultPlaceholder').classList.remove('hidden');
  } finally {
    document.getElementById('loadingOverlay').classList.add('hidden');
    state.generating = false;
    document.getElementById('generateBtn').disabled = false;
  }
}

// ── Async video polling (called from generate()) ────────────────
async function pollVideoGeneration(body) {
  state.cancelRequested = false;
  document.getElementById('loadingText').textContent = 'Enviando solicitud...';
  document.getElementById('loadingSubText').textContent = 'Iniciando generación de video...';
  document.getElementById('cancelBtn').classList.add('hidden');

  // 1. Submit the job
  const submitRes = await fetch('/api/generate/video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': state.apiKey },
    body: JSON.stringify(body),
  });
  const submitData = await submitRes.json();
  if (!submitRes.ok || submitData.error) {
    throw new Error(submitData.error || 'Error al enviar la solicitud de video');
  }

  const { jobId } = submitData;
  document.getElementById('loadingText').textContent = 'Generando video...';
  // Show cancel button after job is submitted
  document.getElementById('cancelBtn').classList.remove('hidden');

  // 2. Poll until complete (max ~10 min)
  const MAX_POLLS = 120;
  const POLL_INTERVAL = 5000; // 5 seconds

  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    await sleep(POLL_INTERVAL);

    // Check if user cancelled
    if (state.cancelRequested) {
      document.getElementById('cancelBtn').classList.add('hidden');
      throw new Error('Generación cancelada por el usuario.');
    }

    const elapsed = (attempt + 1) * (POLL_INTERVAL / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    document.getElementById('loadingSubText').textContent =
      elapsed < 20 ? 'Preparando generación...' : `Generando... ${timeStr} transcurridos`;

    let pollData;
    try {
      const pollRes = await fetch(`/api/video/status/${jobId}`, {
        headers: { 'x-api-key': state.apiKey },
      });
      pollData = await pollRes.json();
      if (!pollRes.ok) throw new Error(pollData.error || `HTTP ${pollRes.status}`);
    } catch (e) {
      console.warn(`[video] poll attempt ${attempt + 1} failed:`, e.message, '— retrying...');
      continue; // retry on transient errors
    }

    if (pollData.status === 'failed') {
      document.getElementById('cancelBtn').classList.add('hidden');
      throw new Error(pollData.error || 'La generación del video falló');
    }

    if (pollData.status === 'completed') {
      document.getElementById('cancelBtn').classList.add('hidden');
      // Download the video as a blob through our server proxy.
      // This avoids ALL CORS issues: the server fetches the CDN URL,
      // we get a local blob:// URL that always plays in <video>.
      document.getElementById('loadingSubText').textContent = 'Descargando video...';

      let blobUrl;
      try {
        const proxyUrl = `/api/video/proxy?url=${encodeURIComponent(pollData.url)}`;
        const blobRes = await fetch(proxyUrl);
        if (!blobRes.ok) throw new Error(`proxy status ${blobRes.status}`);
        const blob = await blobRes.blob();
        blobUrl = URL.createObjectURL(blob);
      } catch (e) {
        console.error('[video] blob fetch failed, trying direct URL:', e.message);
        blobUrl = pollData.url; // último recurso
      }

      state.currentResult = { url: blobUrl, cdnUrl: pollData.url, type: 'video' };
      showResult(blobUrl, 'video');
      showToast('¡Video generado con éxito! 🎬', 'success');
      if (state.gallery.length > 0) await loadGallery();
      return;
    }

    // Update progress if available
    if (pollData.progress != null) {
      document.getElementById('loadingSubText').textContent = `Generando... ${pollData.progress}%`;
    }
  }

  document.getElementById('cancelBtn').classList.add('hidden');
  throw new Error('Tiempo de espera agotado. El video puede seguir generándose — comprueba la galería más tarde.');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function showResult(url, type) {
  const content = document.getElementById('resultContent');
  const img = document.getElementById('resultImage');
  const vid = document.getElementById('resultVideo');

  content.classList.remove('hidden');

  if (type === 'video') {
    img.classList.add('hidden');
    vid.classList.remove('hidden');
    vid.onerror = () => {
      console.error('[video] Error al cargar:', url);
      showToast('Error al cargar el video en el reproductor', 'error');
    };
    vid.src = url;
    vid.load(); // forzar recarga del elemento
    vid.play().catch(() => {}); // autoplay bloqueado por navegador es normal
  } else {
    vid.classList.add('hidden');
    img.classList.remove('hidden');
    img.src = url;
  }
}

// ====== RESULT ACTIONS ======
function downloadResult() {
  if (!state.currentResult) return;
  triggerDownload(state.currentResult.url, `ai_${state.activeType}_${Date.now()}`);
}

function copyPrompt() {
  const p = document.getElementById('promptInput').value;
  navigator.clipboard.writeText(p)
    .then(() => showToast('Prompt copiado al portapapeles', 'success'))
    .catch(() => showToast('No se pudo copiar', 'error'));
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');

  // Use the result's own saved type — never rely on activeType (it can change after generation)
  const isVideo = (state.currentResult?.type ?? state.activeType) === 'video';

  // Videos → mp4 ; images/avatars → jpg (always, regardless of stored format)
  const ext = isVideo ? 'mp4' : 'jpg';

  // blob:// and local /uploads/ paths work directly; CDN URLs need server proxy
  const href = url.startsWith('http')
    ? `/api/video/proxy?url=${encodeURIComponent(url)}&download=1`
    : url;

  a.href = href;
  a.download = `${filename}.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ====== GALLERY ======
async function loadGallery() {
  try {
    const res = await fetch('/api/gallery');
    state.gallery = await res.json();
    renderGallery();
  } catch (e) {
    console.error('Error loading gallery:', e);
  }
}

function renderGallery() {
  const filter = state.activeFilter;
  const filtered = filter === 'all'
    ? state.gallery
    : state.gallery.filter(i => i.type === filter);

  const grid = document.getElementById('galleryGrid');

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="gallery-empty" id="galleryEmpty">
        <div class="empty-icon">🖼️</div>
        <p>No hay contenido guardado aún.</p>
        <p>¡Genera algo para verlo aquí!</p>
      </div>`;
    return;
  }

  grid.innerHTML = filtered.map(item => {
    const thumb = item.type === 'video'
      ? `<video class="gallery-item-video" src="${escHtml(videoSrc(item.localPath || item.url))}" muted preload="metadata"></video>`
      : `<img class="gallery-item-thumb" src="${escHtml(item.localPath || item.url)}" alt="" loading="lazy">`;

    const typeLabel = { image: '🖼️', video: '🎬', avatar: '👤' }[item.type] || '✦';

    return `
      <div class="gallery-item" data-id="${item.id}" onclick="openGalleryModal('${item.id}')">
        ${thumb}
        <span class="gallery-type-badge">${typeLabel}</span>
        <div class="gallery-item-info">
          <p class="gallery-item-prompt">${escHtml(item.prompt)}</p>
          <p class="gallery-item-meta">${escHtml(shortModel(item.model))} · ${fmtDate(item.createdAt)}</p>
        </div>
        <div class="gallery-item-actions">
          <button class="gallery-action-btn" title="Descargar" onclick="event.stopPropagation(); downloadItem('${item.id}')">⬇</button>
          <button class="gallery-action-btn" title="Eliminar" onclick="event.stopPropagation(); deleteItem('${item.id}')">🗑</button>
        </div>
      </div>`;
  }).join('');
}

function filterGallery(filter) {
  state.activeFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === filter);
  });
  renderGallery();
}

function openGalleryModal(id) {
  const item = state.gallery.find(i => i.id === id);
  if (!item) return;

  state.currentModalItem = item;

  const modal = document.getElementById('imageModal');
  const modalImg = document.getElementById('modalImage');
  const modalVid = document.getElementById('modalVideo');

  if (item.type === 'video') {
    modalImg.classList.add('hidden');
    modalVid.classList.remove('hidden');
    modalVid.src = videoSrc(item.localPath || item.url);
  } else {
    modalVid.classList.add('hidden');
    modalImg.classList.remove('hidden');
    modalImg.src = item.localPath || item.url;
  }

  document.getElementById('modalPrompt').textContent = item.prompt;
  document.getElementById('modalMeta').textContent = `${item.model} · ${fmtDate(item.createdAt)}`;

  modal.classList.remove('hidden');
}

function closeModal() {
  document.getElementById('imageModal').classList.add('hidden');
  document.getElementById('modalVideo').pause?.();
  state.currentModalItem = null;
}

async function deleteItem(id) {
  if (!confirm('¿Eliminar este elemento de la galería?')) return;
  try {
    await fetch(`/api/gallery/${id}`, { method: 'DELETE' });
    state.gallery = state.gallery.filter(i => i.id !== id);
    renderGallery();
    showToast('Elemento eliminado', 'success');
  } catch {
    showToast('Error al eliminar', 'error');
  }
}

function downloadItem(id) {
  const item = state.gallery.find(i => i.id === id);
  if (!item) return;
  const rawUrl = item.localPath || item.url;
  const isVideo = item.type === 'video';
  const ext = isVideo ? 'mp4' : 'jpg';

  const a = document.createElement('a');
  a.href = (isVideo && rawUrl.startsWith('http'))
    ? `/api/video/proxy?url=${encodeURIComponent(rawUrl)}&download=1`
    : rawUrl;
  a.download = `${item.type}_${item.id.slice(0, 8)}.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ====== TOAST ======
function showToast(msg, type = 'info') {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity 0.35s, transform 0.35s';
    t.style.opacity = '0';
    t.style.transform = 'translateX(110%)';
    setTimeout(() => t.remove(), 400);
  }, 3200);
}

// ====== UTILS ======
// Wrap external CDN video URLs in our server proxy to avoid CORS blocking
function videoSrc(url = '') {
  if (url.startsWith('http')) {
    return `/api/video/proxy?url=${encodeURIComponent(url)}`;
  }
  return url;
}

function escHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortModel(modelId = '') {
  return modelId.split('/').pop().replace(/:free$/, '');
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('es-ES', {
    day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });
}

// ====== START ======
console.log('[AI Media Studio] app.js v6 loaded ✦');
init();
