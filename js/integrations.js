/* Integrações de exportação:
   - OneDrive (Microsoft Graph): salva a planilha na pasta "CronoAnalise" do
     OneDrive de quem entrou com a conta Microsoft — de lá abre no Excel Online,
     sincroniza com o computador e pode ser compartilhada no SharePoint/Teams.
   - Compartilhar arquivo (Web Share API): no celular, abre a lista de apps
     (Teams, Outlook, WhatsApp, OneDrive…) com a planilha anexada. */

import { ONEDRIVE_FOLDER } from './config.js';

export const GRAPH_SCOPE = 'Files.ReadWrite';

export async function uploadToOneDrive(token, filename, bytes, mime) {
  const path = encodeURIComponent(ONEDRIVE_FOLDER) + '/' + encodeURIComponent(filename);
  const res = await fetch('https://graph.microsoft.com/v1.0/me/drive/root:/' + path + ':/content', {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': mime },
    body: bytes
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error('A autorização do OneDrive expirou ou não foi concedida.');
    err.code = 'auth';
    throw err;
  }
  if (!res.ok) throw new Error('O OneDrive respondeu com erro ' + res.status + '.');
  return res.json(); // { name, webUrl, ... }
}

export function canShareFiles() {
  try {
    return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [new File(['x'], 'teste.txt', { type: 'text/plain' })] });
  } catch (e) {
    return false;
  }
}

export async function shareFile(filename, bytes, mime, title) {
  const file = new File([bytes], filename, { type: mime });
  await navigator.share({ files: [file], title });
}
