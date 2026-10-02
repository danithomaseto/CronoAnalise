/* Fotos dos registros: tirar/escolher a foto, reduzir o tamanho no aparelho,
   guardar no IndexedDB (funciona offline) e enviar para o Supabase Storage
   quando houver conexão. A galeria mostra a cópia local ou um link assinado
   (temporário) do servidor. */

import * as storage from './storage.js';
import { uploadPhoto, signedPhotoUrl, removePhotos, removeStudyPhotos } from './cloud.js';
import { uid, escapeHtml, fmtTimeOfDay, toBR } from './core/format.js';
import { $, showToast, openModal } from './ui.js';

const MAX_SIDE = 1600;
const QUALITY = 0.8;

let target = null;              // { studyId, recordId }
let opts = { attach: () => false, detach: () => false, canUpload: () => false, pushStudyNow: async () => {}, isReadonly: () => true };
let objectUrls = [];
let uploading = false;
let storageMissing = false; // bucket ainda não criado (migração 003): não insiste nesta sessão

export function resetPhotos() {
  storageMissing = false;
}

export function initPhotos(o) {
  opts = { ...opts, ...o };
  $('photoInput').addEventListener('change', onFile);
  $('photoGrid').addEventListener('click', e => {
    const rm = e.target.closest('[data-photo-remove]');
    if (rm) remove(rm.dataset.record, rm.dataset.photoRemove, rm.dataset.path);
  });
  window.addEventListener('online', () => uploadPending());
}

export function capture(studyId, recordId) {
  if (!studyId || !recordId) return;
  target = { studyId, recordId };
  const input = $('photoInput');
  input.value = '';
  input.click();
}

/* Reduz para no máximo 1600 px no maior lado, em JPEG. */
export async function compress(file) {
  let source;
  try {
    source = await createImageBitmap(file);
  } catch (e) {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Imagem inválida'));
      img.src = URL.createObjectURL(file);
    });
  }
  const w0 = source.width, h0 = source.height;
  const k = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w0 * k));
  canvas.height = Math.max(1, Math.round(h0 * k));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  if (source.close) source.close();
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Falha ao comprimir'))), 'image/jpeg', QUALITY));
}

async function onFile(e) {
  const file = e.target.files && e.target.files[0];
  const t = target;
  target = null;
  if (!file || !t) return;
  try {
    const blob = await compress(file);
    const id = uid('ph');
    const photo = { id, path: t.studyId + '/' + id + '.jpg', ts: new Date().toISOString() };
    const saved = await storage.putPhoto({ ...photo, studyId: t.studyId, blob, uploaded: false });
    if (!saved && !opts.canUpload()) { showToast('Sem espaço para guardar fotos offline neste navegador. Tente com internet.'); return; }
    if (!saved) await uploadDirect(photo.path, blob);
    if (!opts.attach(t.recordId, photo)) { showToast('Registro não encontrado'); return; }
    showToast('📷 Foto anexada (' + toBR(blob.size / 1024, 0) + ' KB)');
    uploadPending();
  } catch (err) {
    showToast('Não foi possível usar a foto: ' + (err.message || err));
  }
}

async function uploadDirect(path, blob) {
  await uploadPhoto(path, blob);
}

/* Envia as fotos que ainda estão só neste aparelho. */
export async function uploadPending() {
  if (uploading || storageMissing || !opts.canUpload()) return;
  uploading = true;
  try {
    const pending = (await storage.listPhotos()).filter(p => !p.uploaded && p.blob);
    for (const p of pending) {
      if (!opts.canUpload()) break;
      try {
        await opts.pushStudyNow(p.studyId); // a foto só pode subir depois do estudo (regra de acesso)
        await uploadPhoto(p.path, p.blob);
        await storage.markPhotoUploaded(p.id);
      } catch (e) {
        console.warn('Foto não enviada agora:', e);
        if (/bucket not found/i.test(String(e && e.message))) { storageMissing = true; break; }
        if (/network|fetch/i.test(String(e && e.message))) break;
      }
    }
  } finally {
    uploading = false;
  }
}

/* Galeria: todas as fotos do estudo, ou só as de um registro. */
export async function openGallery(study, recordId) {
  objectUrls.forEach(u => URL.revokeObjectURL(u));
  objectUrls = [];
  const items = [];
  (study.records || []).forEach(r => {
    if (recordId && r.id !== recordId) return;
    (r.photos || []).forEach(p => items.push({ r, p }));
  });
  $('photoTitle').textContent = recordId ? 'Fotos do registro' : 'Fotos do estudo';
  const pendingCount = (await storage.listPhotos()).filter(p => !p.uploaded && p.studyId === study.id).length;
  $('photoInfo').textContent = items.length
    ? items.length + ' foto(s)' + (pendingCount ? ' · ' + pendingCount + ' aguardando envio (ficam neste aparelho até ter conexão)' : '')
    : 'Nenhuma foto ainda. Use 📷 na última marcação ou na linha do registro.';
  const ro = opts.isReadonly();
  $('photoGrid').innerHTML = items.map(({ r, p }) =>
    '<figure class="photo-card" data-photo="' + escapeHtml(p.id) + '"><img alt="Foto: ' + escapeHtml(r.stageName) + ', ciclo ' + r.cycle + '" loading="lazy">' +
    '<figcaption><span><b>' + escapeHtml(r.stageName) + '</b> · ciclo ' + r.cycle + ' · ' + escapeHtml(fmtTimeOfDay(p.ts || r.ts)) + '</span>' +
    (r.note ? '<span>📝 ' + escapeHtml(r.note) + '</span>' : '') +
    '<span class="pending" data-pending hidden>aguardando envio</span>' +
    '<span class="row-actions"><a data-open target="_blank" rel="noopener" hidden>Abrir</a>' +
    (ro ? '' : '<button type="button" class="danger" data-record="' + escapeHtml(r.id) + '" data-photo-remove="' + escapeHtml(p.id) + '" data-path="' + escapeHtml(p.path) + '">Remover</button>') +
    '</span></figcaption></figure>'
  ).join('');
  openModal('photoModal', { onClose: () => { objectUrls.forEach(u => URL.revokeObjectURL(u)); objectUrls = []; } });
  for (const { p } of items) loadInto(p);
}

async function loadInto(p) {
  const card = $('photoGrid').querySelector('[data-photo="' + CSS.escape(p.id) + '"]');
  if (!card) return;
  const img = card.querySelector('img');
  const link = card.querySelector('[data-open]');
  let url = null;
  const local = await storage.getPhoto(p.id);
  if (local && local.blob) {
    url = URL.createObjectURL(local.blob);
    objectUrls.push(url);
    if (!local.uploaded) card.querySelector('[data-pending]').hidden = false;
  } else if (opts.canUpload()) {
    try { url = await signedPhotoUrl(p.path); } catch (e) { url = null; }
  }
  if (url) {
    img.src = url;
    link.href = url;
    link.hidden = false;
  } else {
    img.alt = 'Foto disponível quando houver conexão';
  }
}

async function remove(recordId, photoId, path) {
  if (!confirm('Remover esta foto?')) return;
  if (!opts.detach(recordId, photoId)) return;
  await storage.deleteLocalPhotos([photoId]);
  if (opts.canUpload()) removePhotos([path]).catch(e => console.warn('Foto não removida do servidor:', e));
  const card = $('photoGrid').querySelector('[data-photo="' + CSS.escape(photoId) + '"]');
  if (card) card.remove();
  showToast('Foto removida');
}

/* Estudo excluído pelo dono: apaga as fotos (servidor e aparelho). */
export async function forgetStudyPhotos(studyId) {
  const local = (await storage.listPhotos()).filter(p => p.studyId === studyId).map(p => p.id);
  await storage.deleteLocalPhotos(local);
  if (opts.canUpload()) await removeStudyPhotos(studyId).catch(e => console.warn('Fotos não removidas do servidor:', e));
}
