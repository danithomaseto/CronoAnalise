/* Editor — etapas: cadastro, edição, ordem e exclusão. */

import { uid } from './core/format.js';
import { sortStages, nextStagePos } from './core/model.js';
import { $, openModal, closeModal } from './ui.js';
import { S, persist, refresh, nowIso } from './editor.js';
import * as timer from './editor-timer.js';

let editingId = null;

export function init() {
  $('stageForm').addEventListener('submit', e => { e.preventDefault(); add(); });
  $('stageEditForm').addEventListener('submit', e => { e.preventDefault(); saveEdit(); });
}

function add() {
  if (S.readonly) return;
  const nameEl = $('stageName');
  const n = nameEl.value.trim();
  if (!n) { nameEl.focus(); return; }
  S.current.stages.push({ id: uid('st'), name: n, type: $('stageType').value, pos: nextStagePos(S.current.stages), u: nowIso() });
  nameEl.value = '';
  nameEl.focus();
  persist('Etapa "' + n + '" adicionada');
  render();
}

export function remove(id) {
  if (S.readonly) return;
  const s = S.current.stages.find(x => x.id === id);
  if (!s) return;
  if (!confirm('Remover esta etapa da lista de captura? Os registros já marcados com ela são mantidos.')) return;
  S.current.stages = S.current.stages.filter(x => x.id !== id);
  S.current.deletedStages = { ...(S.current.deletedStages || {}), [id]: nowIso() };
  persist('Etapa "' + s.name + '" removida');
  render();
  refresh();
}

export function openEdit(id) {
  if (S.readonly) return;
  const s = S.current.stages.find(x => x.id === id);
  if (!s) return;
  editingId = id;
  $('editStageName').value = s.name;
  $('editStageType').value = s.type;
  $('editStageOutput').checked = !!s.countsOutput;
  updateMoveButtons();
  openModal('stageEditModal', { focus: 'editStageName', onClose: () => { editingId = null; } });
}

function updateMoveButtons() {
  const i = S.current.stages.findIndex(x => x.id === editingId);
  $('btnStageBack').disabled = i <= 0;
  $('btnStageFwd').disabled = i < 0 || i >= S.current.stages.length - 1;
  $('stagePosLabel').textContent = i >= 0 ? 'Posição ' + (i + 1) + ' de ' + S.current.stages.length : '';
}

/* Troca a posição com a vizinha (o campo `pos` mescla entre aparelhos). */
export function move(delta) {
  if (S.readonly || !editingId) return;
  const list = S.current.stages;
  const i = list.findIndex(x => x.id === editingId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return;
  const t = nowIso();
  const a = list[i], b = list[j];
  const pa = a.pos;
  a.pos = b.pos;
  b.pos = pa;
  if (a.pos === b.pos) a.pos += delta; // posições repetidas (dados antigos)
  a.u = t;
  b.u = t;
  S.current.stages = sortStages(list);
  persist('Etapa "' + a.name + '" movida para a posição ' + (S.current.stages.findIndex(x => x.id === a.id) + 1));
  render();
  updateMoveButtons();
}

function saveEdit() {
  const s = S.current && S.current.stages.find(x => x.id === editingId);
  if (!s) { closeModal(); return; }
  const newName = $('editStageName').value.trim();
  if (!newName) { $('editStageName').focus(); return; }
  const newType = $('editStageType').value;
  const oldName = s.name;
  const t = nowIso();
  s.name = newName;
  s.type = newType;
  s.u = t;
  if ($('editStageOutput').checked) s.countsOutput = true; else delete s.countsOutput;
  S.current.records.forEach(r => {
    if (r.stageId === s.id && (r.stageName !== newName || r.type !== newType)) { r.stageName = newName; r.type = newType; r.u = t; }
  });
  closeModal();
  persist(oldName !== newName
    ? 'Etapa "' + oldName + '" renomeada para "' + newName + '"'
    : 'Etapa "' + newName + '" editada');
  render();
  refresh();
  timer.renderLastMark();
}

export function render() {
  const wrap = $('stages');
  wrap.innerHTML = '';
  if (!S.current.stages.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = S.readonly ? 'Nenhuma etapa cadastrada.' : 'Nenhuma etapa cadastrada ainda. Adicione as etapas do processo acima.';
    wrap.appendChild(p);
  }
  S.current.stages.forEach((s, i) => {
    const wrapDiv = document.createElement('div');
    wrapDiv.className = 'stage-wrap';
    wrapDiv.dataset.id = s.id;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'stage type-' + s.type.toLowerCase();
    btn.dataset.action = 'mark';
    btn.dataset.id = s.id;
    btn.disabled = S.readonly;
    const name = document.createElement('span');
    name.className = 'stage-name';
    name.textContent = s.name;
    const type = document.createElement('span');
    type.className = 'stage-type';
    type.textContent = s.type + (s.countsOutput ? ' · 📦 produção' : '');
    btn.append(name, type);
    if (i < 9) {
      const key = document.createElement('span');
      key.className = 'stage-key';
      key.textContent = String(i + 1);
      key.setAttribute('aria-hidden', 'true');
      btn.append(key);
    }
    wrapDiv.append(btn);

    if (!S.readonly) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'stage-remove';
      rm.title = 'Remover etapa';
      rm.setAttribute('aria-label', 'Remover etapa ' + s.name);
      rm.textContent = '✕';
      rm.dataset.action = 'remove-stage';
      rm.dataset.id = s.id;

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'stage-edit';
      edit.title = 'Editar ou mover etapa';
      edit.setAttribute('aria-label', 'Editar etapa ' + s.name);
      edit.textContent = '✎';
      edit.dataset.action = 'edit-stage';
      edit.dataset.id = s.id;
      wrapDiv.append(rm, edit);
    }
    wrap.appendChild(wrapDiv);
  });

  if (!S.readonly) {
    const intr = document.createElement('button');
    intr.type = 'button';
    intr.id = 'btnInterruption';
    intr.className = 'stage stage-interruption';
    intr.dataset.action = 'interruption';
    intr.title = 'Registra o tempo à parte (ex.: operador saiu, falta de material). Não entra nos cálculos. Atalho: 0';
    const n = document.createElement('span');
    n.className = 'stage-name';
    n.textContent = '⚡ Interrupção';
    const t = document.createElement('span');
    t.className = 'stage-type';
    t.textContent = 'fora dos cálculos';
    const k = document.createElement('span');
    k.className = 'stage-key';
    k.textContent = '0';
    k.setAttribute('aria-hidden', 'true');
    intr.append(n, t, k);
    wrap.appendChild(intr);
  }
}
