// send_and_upload.js
// Node 18+ required (uses global fetch, child_process)

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PIXEL_FILE_RE = /https?:\/\/(?:www\.)?pixeldrain\.com\/u\/([A-Za-z0-9_-]+)/i;
const PIXEL_FOLDER_RE = /https?:\/\/(?:www\.)?pixeldrain\.com\/l\/([A-Za-z0-9_-]+)/i;

const DEFAULT_MAX_BYTES = 1_900_000_000; // 1.9 GB conservative default

function fileApiUrl(id) { return `https://pixeldrain.com/api/file/${id}`; }
function folderApiUrl(id) { return `https://pixeldrain.com/api/list/${id}`; }
function tgApiUrl(token, method='sendMessage') { return `https://api.telegram.org/bot${token}/${method}`; }

function escapeMarkdownV2(s='') {
  return String(s).replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

async function sendTelegramMessage(token, chat_id, text) {
  const body = { chat_id: chat_id, text, parse_mode: 'MarkdownV2', disable_web_page_preview: true };
  const resp = await fetch(tgApiUrl(token, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (!json.ok) {
    console.error('Telegram sendMessage failed:', json);
  }
  return json;
}

function runCmd(cmd, args, opts={}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}`);
  return res;
}

async function headUrl(url) {
  try {
    const resp = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return resp;
  } catch (e) {
    return null;
  }
}

async function downloadWithWget(url, outPath) {
  // Use wget with --content-disposition disabled for stable name; we set outPath
  // using -O is safer (no guesswork).
  runCmd('wget', ['-c', '-O', outPath, url]);
}

async function uploadDocumentCurl(token, chat_id, filePath, caption='') {
  // Use curl to POST multipart/form-data to Telegram sendDocument
  const url = tgApiUrl(token, 'sendDocument');
  const args = [
    '--silent',
    '--show-error',
    '--fail',
    '--form', `chat_id=${chat_id}`,
    '--form', `document=@${filePath}`,
  ];
  if (caption) args.push('--form', `caption=${caption}`);
  const res = spawnSync('curl', args, { encoding: 'utf-8' });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    console.error('curl upload error stdout/stderr:', res.stdout, res.stderr);
    throw new Error(`curl exited with ${res.status}`);
  }
  // Try parse response
  try { return JSON.parse(res.stdout || '{}'); } catch { return null; }
}

async function handleFile(token, chat_id, fileId, maxBytes) {
  const url = fileApiUrl(fileId);
  const head = await headUrl(url);
  let filename = `pixeldrain-${fileId}`;
  let size = null;
  if (head && head.ok) {
    const cd = head.headers.get('content-disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)|filename="?([^"]+)"?/i);
    const raw = (m && (m[1] || m[2])) || null;
    if (raw) filename = decodeURIComponent(raw);
    const len = head.headers.get('content-length');
    if (len) size = Number(len);
  }

  if (size && size > maxBytes) {
    await sendTelegramMessage(token, chat_id, `❗ File *${escapeMarkdownV2(filename)}* is too large to auto-upload (${size} bytes). Here is the direct download URL:\n\`\`${escapeMarkdownV2(url)}\`\`\n\nUse wget on your machine to download it.`);
    console.log('File too large, aborted upload.');
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixeldrain-'));
  const outPath = path.join(tmpDir, filename.replace(/\//g,'_'));
  try {
    await sendTelegramMessage(token, chat_id, `⬇️ Downloading *${escapeMarkdownV2(filename)}*...`);
    await downloadWithWget(url, outPath);
    const stats = fs.statSync(outPath);
    if (stats.size > maxBytes) {
      await sendTelegramMessage(token, chat_id, `❗ After download file exceeds max allowed size. Not uploading. Direct URL:\n\`\`${escapeMarkdownV2(url)}\`\``);
      return;
    }

    await sendTelegramMessage(token, chat_id, `⬆️ Uploading *${escapeMarkdownV2(filename)}* to Telegram (this may take a while)...`);
    await uploadDocumentCurl(token, chat_id, outPath, `Uploaded from Pixeldrain: ${filename}`);
    await sendTelegramMessage(token, chat_id, `✅ Uploaded *${escapeMarkdownV2(filename)}* successfully.`);
  } finally {
    // cleanup
    try { fs.unlinkSync(outPath); } catch {}
    try { fs.rmdirSync(tmpDir, { recursive: true }); } catch {}
  }
}

async function handleFolder(token, chat_id, folderId, maxBytes) {
  const api = folderApiUrl(folderId);
  const resp = await fetch(api);
  if (!resp.ok) {
    await sendTelegramMessage(token, chat_id, `Failed to read folder ${folderId}: HTTP ${resp.status}`);
    return;
  }
  const json = await resp.json();
  if (!json || !Array.isArray(json.files) || json.files.length === 0) {
    await sendTelegramMessage(token, chat_id, `Folder appears empty or returned no files.`);
    return;
  }

  const totalBytes = json.files.reduce((s,f)=>s + (f.size || 0), 0);
  if (totalBytes > maxBytes) {
    // too big to zip + upload
    const lines = json.files.map(f => `- ${escapeMarkdownV2(f.name)} (${f.size || 'unknown'} bytes)\n\`\`${escapeMarkdownV2(fileApiUrl(f.id))}\`\``);
    const preview = lines.slice(0, 20).join('\n\n');
    await sendTelegramMessage(token, chat_id, `❗ Folder contains ${json.files.length} files, total size ${totalBytes} bytes which is larger than allowed upload limit. Sending direct links instead:\n\n${preview}\n\n(Only first 20 shown)`);
    // send them in chunks
    let chunk = [];
    let curLen = 0;
    for (const line of lines) {
      if (curLen + line.length > 3000) {
        await sendTelegramMessage(token, chat_id, chunk.join('\n\n'));
        chunk = [line]; curLen = line.length;
      } else { chunk.push(line); curLen += line.length; }
    }
    if (chunk.length) await sendTelegramMessage(token, chat_id, chunk.join('\n\n'));
    return;
  }

  // Download all files and zip
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixeldrain-'));
  try {
    await sendTelegramMessage(token, chat_id, `⬇️ Downloading ${json.files.length} file(s) and preparing zip...`);
    for (const f of json.files) {
      const durl = fileApiUrl(f.id);
      // safe name
      const safeName = f.name.replace(/[\/\\]/g, '_');
      const outPath = path.join(tmpDir, safeName);
      await downloadWithWget(durl, outPath);
    }
    // zip
    const zipPath = path.join(os.tmpdir(), `pixeldrain-folder-${folderId}.zip`);
    runCmd('zip', ['-r', zipPath, '.'], { cwd: tmpDir });
    const stats = fs.statSync(zipPath);
    if (stats.size > maxBytes) {
      await sendTelegramMessage(token, chat_id, `❗ Zip archive size ${stats.size} bytes exceeds the allowed upload size. Sending direct links instead.`);
      // fallback to sending links
      for (const f of json.files) {
        await sendTelegramMessage(token, chat_id, `${escapeMarkdownV2(f.name)} — \`\`${escapeMarkdownV2(fileApiUrl(f.id))}\`\``);
      }
      return;
    }

    await sendTelegramMessage(token, chat_id, `⬆️ Uploading zip (${stats.size} bytes) to Telegram...`);
    await uploadDocumentCurl(token, chat_id, zipPath, `Pixeldrain folder ${folderId}`);
    await sendTelegramMessage(token, chat_id, `✅ Folder uploaded as zip.`);
    // cleanup zip
    try { fs.unlinkSync(zipPath); } catch {}
  } finally {
    // cleanup tmpDir
    try { fs.rmdirSync(tmpDir, { recursive: true }); } catch {}
  }
}

(async () => {
  try {
    const link = process.env.PIXEL_LINK;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat_id = process.env.TELEGRAM_CHAT_ID;
    const maxBytes = process.env.MAX_UPLOAD_BYTES ? Number(process.env.MAX_UPLOAD_BYTES) : DEFAULT_MAX_BYTES;

    if (!link) throw new Error('PIXEL_LINK environment variable missing');
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN environment variable missing');
    if (!chat_id) throw new Error('TELEGRAM_CHAT_ID environment variable missing');

    await sendTelegramMessage(token, chat_id, `🚀 Received Pixeldrain link, starting process...`);

    const fileMatch = link.match(PIXEL_FILE_RE);
    const folderMatch = link.match(PIXEL_FOLDER_RE);

    if (fileMatch) {
      await handleFile(token, chat_id, fileMatch[1], maxBytes);
    } else if (folderMatch) {
      await handleFolder(token, chat_id, folderMatch[1], maxBytes);
    } else {
      throw new Error('No pixeldrain link found in PIXEL_LINK.');
    }

    console.log('Done');
  } catch (err) {
    console.error('Fatal error:', err);
    try {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chat_id = process.env.TELEGRAM_CHAT_ID;
      if (token && chat_id) {
        await sendTelegramMessage(token, chat_id, `❌ Error in upload script: ${escapeMarkdownV2(String(err.message || err))}`);
      }
    } catch {}
    process.exit(1);
  }
})();
