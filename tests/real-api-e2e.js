#!/usr/bin/env node
// 애미나이 실제 API 통합 테스트(Playwright).
// index.html 을 로컬 서버로 띄워 실제 브라우저에서 실제 Google·xAI·OpenAI API 로 기능을 차례로 확인한다.
//
//  · 키는 환경 변수에서만 읽는다: GOOGLE_API_KEY(또는 GEMINI_API_KEY) · XAI_API_KEY · OPENAI_API_KEY.
//    키가 없는 공급자의 테스트는 건너뛴다(SKIP). 키 값은 화면·보고서·로그 어디에도 남기지 않는다.
//  · 과금 방지: 인자 없이 실행하면 계획과 예상 비용만 보여 주고 끝난다. 실제로 돌리려면 --yes 를 붙인다.
//  · 비용 최소화: 모든 생성은 1K · 1장 · 절약 모드 · GPT Image quality low · Grok quality low 로 요청한다.
//  · --mock: 공급자 API 를 가짜 응답으로 바꿔 스크립트 자체를 점검한다(과금 없음, 키 불필요).
//
// 선택 환경 변수:
//   ONLY=google,xai,openai        공급자 한정
//   MODELS=nanobanana2_1,...      모델별 생성 테스트 대상(앱의 모델 키)
//   INCLUDE_BATCH=1               Batch 제출·취소 확인 추가(제출 직후 취소)
//   COMPARE_TURBO=1               나노바나나 2.1 초고속 모드 켬/끔 시간·사고 토큰 비교(2장 추가)
//   TEST_TIMEOUT_SEC=240          요청 1건 대기 상한
//   LOCAL_DEPS_DIR=<node_modules> unpkg.com 이 막힌 환경에서 React·pdf.js·fflate 를 이 폴더에서 제공
//   PORT=8790                     로컬 서버 포트
//
// 결과: tests/output/real-api-report.md · real-api-report.json · 실패 시 스크린샷.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (error) {
  console.error('Playwright 가 필요합니다. (클라우드 세션에는 기본 설치되어 있습니다. 로컬은 `npm i -D playwright && npx playwright install chromium`)');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..');
const APP_FILE = path.join(ROOT, 'index.html');
const OUT_DIR = path.join(__dirname, 'output');
const args = new Set(process.argv.slice(2));
const MOCK = args.has('--mock');
const CONFIRMED = args.has('--yes') || MOCK;
const env = process.env;
const KEYS = {
  google: (env.GOOGLE_API_KEY || env.GEMINI_API_KEY || '').trim(),
  xai: (env.XAI_API_KEY || '').trim(),
  openai: (env.OPENAI_API_KEY || '').trim()
};
if (MOCK) {
  KEYS.google = KEYS.google || 'mock-google-key';
  KEYS.xai = KEYS.xai || 'mock-xai-key';
  KEYS.openai = KEYS.openai || 'mock-openai-key';
}
const ONLY = new Set((env.ONLY || 'google,xai,openai').split(',').map(item => item.trim()).filter(Boolean));
const MODEL_FILTER = env.MODELS ? new Set(env.MODELS.split(',').map(item => item.trim()).filter(Boolean)) : null;
const INCLUDE_BATCH = env.INCLUDE_BATCH === '1';
const COMPARE_TURBO = env.COMPARE_TURBO === '1';
const TIMEOUT_MS = Math.max(30, Number(env.TEST_TIMEOUT_SEC) || 240) * 1000;
const PORT = Number(env.PORT) || 8790;
const LOCAL_DEPS_DIR = env.LOCAL_DEPS_DIR || '';
const PROVIDER_HOSTS = {
  google: 'generativelanguage.googleapis.com',
  xai: 'api.x.ai',
  openai: 'api.openai.com'
};
const hasKey = provider => ONLY.has(provider) && Boolean(KEYS[provider]);

// 보고서·로그에 키가 섞이지 않도록 모든 문자열에서 키 값을 가린다.
const redact = value => Object.values(KEYS).filter(key => key && key.length > 6).reduce((text, key) => text.split(key).join('***'), String(value ?? ''));

// ── 테스트 결과 기록 ──
const results = [];
const record = entry => {
  const row = { ...entry, error: entry.error ? redact(entry.error) : undefined };
  results.push(row);
  const icon = row.status === 'PASS' ? '✅' : row.status === 'SKIP' ? '⏭️' : row.status === 'WARN' ? '⚠️' : '❌';
  console.log(`${icon} ${row.status} ${row.name}${row.seconds != null ? ` (${row.seconds}s)` : ''}${row.costText ? ` · ${row.costText}` : ''}${row.note ? ` — ${row.note}` : ''}${row.error ? ` — ${row.error.split('\n').slice(0, 3).join(' / ')}` : ''}`);
};

// ── 픽스처(이미지·문서) 생성 ──
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = buffer => {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 255] ^ c >>> 8;
  return (c ^ 0xffffffff) >>> 0;
};
// 최소 ZIP 작성기(deflate) — DOCX 픽스처용. 앱의 ZIP 읽기(DecompressionStream) 경로를 실제로 거치게 한다.
const makeZip = files => {
  const locals = [];
  const centrals = [];
  let offset = 0;
  files.forEach(({ name, text }) => {
    const data = Buffer.from(text, 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + compressed.length;
  });
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
};
const STORY_PARAGRAPHS = ['용사 민수의 모험', '제1장 숲의 입구', '민수는 붉은 망토를 두른 열여섯 살 소년이다. 푸른 눈과 갈색 머리를 가졌고 청동 검을 들고 있다.', '제2장 드래곤의 성', '은빛 비늘의 드래곤 "아르곤"이 검은 성 꼭대기에서 파란 불을 뿜는다. 하늘은 보랏빛 노을로 물들어 있다.', '제3장 귀환', '민수는 마을 광장으로 돌아와 사람들에게 환영받는다.'];
const buildDocx = () => {
  const esc = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = STORY_PARAGRAPHS.map(text => `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`).join('') + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>이름</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>무기</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>민수</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>청동 검</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
  return makeZip([{
    name: '[Content_Types].xml',
    text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  }, {
    name: '_rels/.rels',
    text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  }, {
    name: 'word/document.xml',
    text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
  }]);
};
const buildFixtures = async context => {
  const dir = path.join(OUT_DIR, 'fixtures');
  fs.mkdirSync(dir, { recursive: true });
  const page = await context.newPage();
  const scene = (sky, ground, sun) => `<html><body style="margin:0"><div id="s" style="width:1024px;height:768px;position:relative;background:linear-gradient(${sky},#fff);overflow:hidden">
    <div style="position:absolute;left:0;right:0;bottom:0;height:260px;background:${ground}"></div>
    <div style="position:absolute;left:700px;top:90px;width:140px;height:140px;border-radius:50%;background:${sun}"></div>
    <div style="position:absolute;left:260px;top:330px;width:300px;height:220px;background:#c0392b"></div>
    <div style="position:absolute;left:240px;top:250px;width:0;height:0;border-left:170px solid transparent;border-right:170px solid transparent;border-bottom:90px solid #6d4c41"></div>
    <div style="position:absolute;left:370px;top:440px;width:80px;height:110px;background:#4e342e"></div></div></body></html>`;
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.setContent(scene('#4fc3f7', '#66bb6a', '#ffd54f'));
  const imageA = await page.locator('#s').screenshot({ type: 'png' });
  await page.setContent(scene('#7e57c2', '#8d6e63', '#ff7043'));
  const imageB = await page.locator('#s').screenshot({ type: 'png' });
  await page.setContent(`<html><body style="font-family:'Noto Sans CJK KR','WenQuanYi Zen Hei','Malgun Gothic',sans-serif">${STORY_PARAGRAPHS.map((text, i) => `<p style="font-size:${i === 0 ? 26 : 16}px">${text}</p>${i === 3 ? '<div style="page-break-after:always"></div>' : ''}`).join('')}</body></html>`);
  const textPdf = await page.pdf({ format: 'A4' });
  await page.setContent(`<html><body style="margin:0"><img style="width:100%" src="data:image/png;base64,${imageA.toString('base64')}"></body></html>`);
  const scannedPdf = await page.pdf({ format: 'A4' });
  await page.close();
  const files = {
    imageA: path.join(dir, 'scene-a.png'),
    imageB: path.join(dir, 'scene-b.png'),
    docx: path.join(dir, 'story.docx'),
    pdf: path.join(dir, 'story.pdf'),
    scanned: path.join(dir, 'scanned.pdf')
  };
  fs.writeFileSync(files.imageA, imageA);
  fs.writeFileSync(files.imageB, imageB);
  fs.writeFileSync(files.docx, buildDocx());
  fs.writeFileSync(files.pdf, textPdf);
  fs.writeFileSync(files.scanned, scannedPdf);
  return files;
};

// ── 가짜 공급자(--mock) ──
const installMockProviders = async (context, files) => {
  const png = fs.readFileSync(files.imageA).toString('base64');
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
  const json = (route, data) => route.fulfill({ status: 200, body: JSON.stringify(data), headers: { 'content-type': 'application/json', ...cors } });
  await context.route(`https://${PROVIDER_HOSTS.google}/**`, route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const url = req.url();
    if (req.method() === 'GET' && /\/models\/[^/:]+$/.test(url)) return json(route, { name: 'models/mock' });
    if (/batchGenerateContent/.test(url)) return json(route, { name: 'batches/mock-1', metadata: { state: 'JOB_STATE_PENDING' } });
    if (/batches\/mock-1:cancel/.test(url)) return json(route, {});
    if (/batches\/mock-1$/.test(url)) return json(route, { name: 'batches/mock-1', metadata: { state: 'JOB_STATE_PENDING' } });
    if (/gemini-2\.5-flash:generateContent/.test(url)) {
      const ocr = String(req.postData() || '').includes('application/pdf');
      return json(route, { candidates: [{ content: { parts: [{ text: ocr ? '[페이지 1]\n스캔 문서의 글자: 하얀 등대' : '분석 결과(모의): 드래곤 아르곤과 민수가 나옵니다.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 80 } });
    }
    return json(route, { candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: png }, thoughtSignature: 'mock' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1200, thoughtsTokenCount: 30, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1120 }] } });
  });
  await context.route(`https://${PROVIDER_HOSTS.xai}/**`, route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (req.method() === 'GET') return json(route, { data: [] });
    return json(route, { data: [{ b64_json: png, mime_type: 'image/png' }], usage: { cost_in_usd_ticks: 200000000 } });
  });
  await context.route(`https://${PROVIDER_HOSTS.openai}/**`, route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const url = req.url();
    if (req.method() === 'GET') return json(route, { data: [] });
    if (/\/files$/.test(url)) return json(route, { id: 'file-mock' });
    if (/\/batches\/batch-mock\/cancel$/.test(url)) return json(route, { id: 'batch-mock', status: 'cancelling' });
    if (/\/batches$/.test(url)) return json(route, { id: 'batch-mock', status: 'validating' });
    if (/\/batches\/batch-mock$/.test(url)) return json(route, { id: 'batch-mock', status: 'in_progress' });
    return json(route, { data: [{ b64_json: png }], output_format: 'png', usage: { input_tokens: 300, input_tokens_details: { text_tokens: 300, image_tokens: 0 }, output_tokens: 400, output_tokens_details: { image_tokens: 400 } } });
  });
};

// ── 네트워크 관찰(요청 본문 요약·응답 상태·usage) ──
const providerOf = url => Object.keys(PROVIDER_HOSTS).find(provider => url.includes(PROVIDER_HOSTS[provider])) || '';
const summarizeBody = raw => {
  if (!raw) return null;
  let body;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    return { multipart: true, hasDocBlock: raw.includes('[REFERENCE DOCUMENTS') };
  }
  const text = JSON.stringify(body);
  const lastUserText = Array.isArray(body.contents) ? (body.contents[body.contents.length - 1]?.parts || []).map(part => part.text || '').join('\n') : '';
  return {
    model: body.model,
    generationConfig: body.generationConfig,
    serviceTier: body.serviceTier,
    n: body.n,
    quality: body.quality,
    size: body.size,
    output_format: body.output_format,
    output_compression: body.output_compression,
    hasMask: Boolean(body.mask),
    imageCount: (text.match(/"(?:data|image_url|url)":"data:image|"inlineData"/g) || []).length,
    promptChars: typeof body.prompt === 'string' ? body.prompt.length : lastUserText.length,
    hasDocBlock: text.includes('[REFERENCE DOCUMENTS'),
    isMaskedEdit: text.includes('MASKED REGION EDIT'),
    batch: Boolean(body.batch) || /purpose/.test(raw)
  };
};
const attachTrafficRecorder = page => {
  const traffic = [];
  const byRequest = new Map();
  page.on('request', req => {
    const provider = providerOf(req.url());
    if (!provider || req.method() === 'OPTIONS') return;
    const entry = { provider, method: req.method(), url: redact(req.url().split('?')[0]), body: summarizeBody(req.postData()), startedAt: Date.now() };
    traffic.push(entry);
    byRequest.set(req, entry);
  });
  page.on('response', async res => {
    const entry = byRequest.get(res.request());
    if (!entry) return;
    entry.status = res.status();
    entry.ms = Date.now() - entry.startedAt;
    try {
      const text = await res.text();
      if (!res.ok()) entry.errorText = redact(text.slice(0, 600));
      if (text.length < 80 * 1024 * 1024) {
        const data = JSON.parse(text);
        entry.usage = data.usageMetadata || data.usage || null;
        entry.finishReason = data.candidates?.[0]?.finishReason;
        entry.servedTier = data.usageMetadata?.serviceTier;
      }
    } catch (e) {}
  });
  page.on('requestfailed', req => {
    const entry = byRequest.get(req);
    if (entry) entry.failure = req.failure()?.errorText || 'failed';
  });
  return traffic;
};

// ── 앱 조작 도우미 ──
const SEL = {
  input: 'textarea[rows="1"]',
  docInput: 'input[type=file][accept^=".pdf"]',
  imageInput: 'input[type=file][accept="image/*"]',
  editInput: 'input[type=file][accept^="image/*,"]',
  send: 'button[title="이미지 생성"]',
  analyze: 'button[title="이미지·문서 분석"]',
  newChat: 'button:has-text("새 세션 시작")'
};
const waitReady = async page => {
  await page.waitForSelector(SEL.input, { timeout: 60000 });
  await page.waitForTimeout(300);
};
const applySettings = async (page, patch) => {
  await page.evaluate(p => {
    const current = JSON.parse(localStorage.getItem('settings') || '{}');
    localStorage.setItem('settings', JSON.stringify({ ...current, ...p }));
  }, patch);
  await page.reload();
  await waitReady(page);
};
const newChat = async page => {
  await page.locator(SEL.newChat).click();
  await page.waitForTimeout(300);
};
// 생성 시작(중지 버튼 표시) → 끝(사라짐)까지 기다린다.
const waitGenerationDone = async page => {
  const stop = page.locator('button:has-text("중지")');
  await stop.first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  await stop.first().waitFor({ state: 'detached', timeout: TIMEOUT_MS });
  await page.waitForTimeout(900);
};
// 저장된 현재 채팅(IndexedDB)에서 마지막 사용자 턴의 출력들을 읽는다(이미지 본문 제외).
const readLastTurn = page => page.evaluate(() => new Promise((resolve, reject) => {
  const activeId = JSON.parse(localStorage.getItem('activeChatId') || 'null');
  const open = indexedDB.open('AeminaiDB', 1);
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const get = open.result.transaction('chatsStore', 'readonly').objectStore('chatsStore').get('chats');
    get.onsuccess = () => {
      const chat = (get.result || []).find(c => c.id === activeId) || (get.result || [])[0];
      const messages = chat?.messages || [];
      const lastUser = messages.map(m => m.role).lastIndexOf('user');
      const outputs = messages.slice(lastUser + 1).map(m => ({
        msgType: m.msgType,
        mime: String(m.imageUrl || '').slice(5).split(/[;,]/)[0],
        width: m.width,
        height: m.height,
        costKrw: m.costKrw,
        costUsd: m.costUsd,
        costSource: m.costSource,
        billingTier: m.billingTier,
        model: m.model,
        docRefs: m.docRefs || null,
        maskApplied: m.maskApplied,
        maskComposited: m.maskComposited,
        maskSourceMode: m.maskSourceMode,
        maskCompositeError: m.maskCompositeError,
        text: m.msgType === 'image' ? '' : String(m.text || '').slice(0, 700),
        batchState: m.batchJob?.state
      }));
      resolve({ user: messages[lastUser] ? { text: messages[lastUser].text, documents: (messages[lastUser].documents || []).map(d => d.name), images: (messages[lastUser].imageUrls || (messages[lastUser].imageUrl ? [1] : [])).length, masks: (messages[lastUser].imageMasks || []).filter(Boolean).length, docCarry: Boolean(messages[lastUser].docCarry) } : null, outputs, userCount: messages.filter(m => m.role === 'user').length });
    };
    get.onerror = () => reject(get.error);
  };
}));
const drawMask = async page => {
  await page.locator('text=마스크 적용').waitFor({ timeout: 15000 });
  await page.waitForTimeout(500);
  const box = await page.locator('canvas').first().boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.65, { steps: 10 });
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.7, { steps: 6 });
  await page.mouse.up();
  await page.locator('button:has-text("마스크 적용")').click();
  await page.waitForTimeout(300);
};
const waitDocReady = async (page, pattern) => page.waitForFunction(source => new RegExp(source).test(document.body.innerText), pattern.source, { timeout: 60000 });
const costText = output => output?.costKrw != null ? `약 ${output.costKrw.toLocaleString('ko-KR')}원(${output.costSource === 'usage' ? '실제 청구' : '추정'}${output.billingTier && output.billingTier !== 'standard' ? ` · ${output.billingTier}` : ''})` : '';
const describeError = turn => (turn.outputs.find(o => o.msgType === 'error')?.text || '').split('\n').slice(0, 4).join(' / ');

(async () => {
  if (!fs.existsSync(APP_FILE)) {
    console.error(`index.html 을 찾지 못했습니다: ${APP_FILE}`);
    process.exit(2);
  }
  if (!MOCK && !['google', 'xai', 'openai'].some(hasKey)) {
    console.log('사용할 API 키가 없습니다. GOOGLE_API_KEY(또는 GEMINI_API_KEY) · XAI_API_KEY · OPENAI_API_KEY 중 하나 이상을 환경 변수로 설정하세요. (스크립트 점검만 하려면 --mock)');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(APP_FILE));
  });
  await new Promise(resolve => server.listen(PORT, resolve));
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const shutdown = async code => {
    await browser.close().catch(() => {});
    server.close();
    process.exit(code);
  };
  try {
    if (LOCAL_DEPS_DIR) {
      await context.route('https://unpkg.com/**', route => {
        const match = new URL(route.request().url()).pathname.match(/^\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.*)$/);
        const file = match ? path.join(LOCAL_DEPS_DIR, match[1], match[2]) : '';
        if (!file || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
        return route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': /\.m?js$/.test(file) ? 'application/javascript' : 'application/octet-stream', 'access-control-allow-origin': '*' } });
      });
    }
    await context.route('https://fonts.gstatic.com/**', route => route.abort());
    const files = await buildFixtures(context);
    if (MOCK) await installMockProviders(context, files);
    await context.addInitScript(keys => {
      if (sessionStorage.getItem('__realApiSeeded')) return;
      sessionStorage.setItem('__realApiSeeded', '1');
      localStorage.setItem('settings', JSON.stringify({
        model: 'nanobanana2_1',
        googleApiKey: keys.google,
        xaiApiKey: keys.xai,
        openaiApiKey: keys.openai,
        resolution: '1K',
        aspectRatio: '1:1',
        count: '1',
        saveMode: true,
        turboMode: true,
        batchMode: false,
        flexMode: false,
        xaiQuality: 'low',
        openaiQuality: 'low'
      }));
      localStorage.setItem('showAppWarning', 'false');
    }, KEYS);

    const page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', error => consoleErrors.push(redact(error.message)));
    page.on('console', msg => {
      if (msg.type() === 'error' && !/Failed to load resource|fonts\.g/.test(msg.text())) consoleErrors.push(redact(msg.text()));
    });
    const traffic = attachTrafficRecorder(page);
    const trafficSince = start => traffic.slice(start);
    await page.goto(`http://localhost:${PORT}/index.html`);
    try {
      await waitReady(page);
    } catch (error) {
      const reactLoaded = await page.evaluate(() => typeof window.React !== 'undefined').catch(() => false);
      throw new Error(reactLoaded ? `앱 화면이 뜨지 않았습니다: ${error.message}` : 'React 를 불러오지 못해 앱이 뜨지 않았습니다. unpkg.com 접속을 허용하거나, LOCAL_DEPS_DIR 에 react@18.3.1·react-dom@18.3.1·pdfjs-dist@4.10.38·fflate@0.8.2 가 설치된 node_modules 경로를 지정하세요.');
    }

    // ── 계획·예상 비용(앱의 공식 단가 계산 함수 사용) ──
    const models = await page.evaluate(() => SELECTABLE_MODEL_KEYS.map(key => ({
      key,
      name: MODEL_INFO[key].name,
      provider: MODEL_INFO[key].provider,
      usd: MODEL_INFO[key].provider === 'openai' ? estimateOpenaiImageCostUsd(key, 'low', buildOpenaiSizeForRatio(1, '1K')) : MODEL_INFO[key].provider === 'xai' ? estimateXaiImageCostUsd(MODEL_INFO[key].id) : estimateGoogleImageCostUsd(key, '1K')
    })));
    const fx = await page.evaluate(() => DEFAULT_USD_TO_KRW);
    const plannedModels = models.filter(model => hasKey(model.provider) && (!MODEL_FILTER || MODEL_FILTER.has(model.key)));
    const price = key => models.find(model => model.key === key)?.usd || 0;
    const plan = [];
    plannedModels.forEach(model => plan.push({ label: `모델별 1K 생성 — ${model.name}`, usd: model.usd }));
    if (hasKey('google')) {
      plan.push({ label: '문서(DOCX) 참조 생성 — 나노바나나 2.1', usd: price('nanobanana2_1') * 1.15 });
      plan.push({ label: '이전 문서 함께 보내기 후속 생성 — 나노바나나 2.1', usd: price('nanobanana2_1') * 1.15 });
      plan.push({ label: '마스크 편집 — 나노바나나 2.1', usd: price('nanobanana2_1') * 1.05 });
      plan.push({ label: '다중 이미지 개별 편집(2장) — 나노바나나 2.1', usd: price('nanobanana2_1') * 2.1 });
      plan.push({ label: '프롬프트·첨부 수정 후 재생성 — 나노바나나 2.1', usd: price('nanobanana2_1') * 1.15 });
      plan.push({ label: '문서 분석 — Gemini 2.5 Flash(사고 끔)', usd: 0.002 });
      plan.push({ label: '스캔 PDF 글자 읽기 — Gemini 2.5 Flash', usd: 0.002 });
      if (COMPARE_TURBO) plan.push({ label: '초고속 켬/끔 비교(2장) — 나노바나나 2.1', usd: price('nanobanana2_1') * 2.1 });
      if (INCLUDE_BATCH) plan.push({ label: 'Batch 제출 후 즉시 취소 — 나노바나나 2.1', usd: 0 });
    }
    if (hasKey('xai')) plan.push({ label: '문서 참조 생성 — Grok Imagine 2.0', usd: price('grok_imagine_2') });
    if (hasKey('openai')) {
      plan.push({ label: '문서 참조 생성 — GPT Image 2.5 Flare', usd: price('gpt_image_2_5_flare') * 1.1 });
      plan.push({ label: '마스크 편집(공식 mask) — GPT Image 2.5 Flare', usd: price('gpt_image_2_5_flare') * 1.1 });
      if (INCLUDE_BATCH) plan.push({ label: 'Batch 제출 후 즉시 취소 — GPT Image 2.5 Flare', usd: 0 });
    }
    const totalUsd = plan.reduce((sum, item) => sum + item.usd, 0);
    console.log(`\n=== 애미나이 실제 API 테스트 계획 ${MOCK ? '(모의 모드 · 과금 없음)' : ''} ===`);
    console.log(`키: Google ${KEYS.google ? '있음' : '없음'} · xAI ${KEYS.xai ? '있음' : '없음'} · OpenAI ${KEYS.openai ? '있음' : '없음'}${env.ONLY ? ` · 공급자 한정 ${env.ONLY}` : ''}`);
    plan.forEach(item => console.log(`  - ${item.label}: 약 ${Math.round(item.usd * fx).toLocaleString('ko-KR')}원`));
    console.log(`  + 연결 테스트(무료) · PDF 글자 추출(무료)\n예상 합계: 약 ${Math.round(totalUsd * fx).toLocaleString('ko-KR')}원 (입력 토큰 포함 추정, 환율 ${fx})\n`);
    if (!CONFIRMED) {
      console.log('실제 요금이 발생합니다. 진행하려면 --yes 를 붙여 다시 실행하세요. (스크립트 점검만 하려면 --mock)');
      return shutdown(0);
    }

    const runTest = async (name, meta, fn) => {
      const startedAt = Date.now();
      const trafficStart = traffic.length;
      try {
        const detail = (await fn()) || {};
        record({ name, ...meta, status: detail.status || 'PASS', seconds: Math.round((Date.now() - startedAt) / 100) / 10, ...detail, requests: trafficSince(trafficStart) });
      } catch (error) {
        const shot = path.join(OUT_DIR, `fail-${results.length + 1}.png`);
        await page.screenshot({ path: shot }).catch(() => {});
        record({ name, ...meta, status: 'FAIL', seconds: Math.round((Date.now() - startedAt) / 100) / 10, error: String(error?.message || error), screenshot: path.relative(ROOT, shot), requests: trafficSince(trafficStart) });
        await page.keyboard.press('Escape').catch(() => {});
        await page.reload().catch(() => {});
        await waitReady(page).catch(() => {});
      }
    };
    const expectImage = (turn, extra = '') => {
      const image = turn.outputs.find(o => o.msgType === 'image');
      if (!image) throw new Error(`이미지가 오지 않았습니다. ${describeError(turn) || '(오류 메시지 없음)'}${extra}`);
      return image;
    };
    const sendPrompt = async (text, button = SEL.send) => {
      await page.locator(SEL.input).fill(text);
      await page.locator(button).click();
      await waitGenerationDone(page);
      return readLastTurn(page);
    };

    // 1) 연결 테스트(무료)
    for (const provider of ['google', 'xai', 'openai']) {
      if (!hasKey(provider)) {
        record({ name: `연결 테스트 — ${provider}`, status: 'SKIP', note: '키 없음' });
        continue;
      }
      await runTest(`연결 테스트 — ${provider}`, { provider }, async () => {
        await page.locator('div.h-16 button').last().click();
        const label = provider === 'google' ? 'Google Gemini' : provider === 'openai' ? 'OpenAI' : 'Grok/xAI';
        await page.locator('button', { hasText: '연결 테스트' }).nth(['google', 'xai', 'openai'].indexOf(provider)).click();
        await page.waitForFunction(text => document.body.innerText.includes(`${text} 연결 테스트 성공`) || document.body.innerText.includes(`${text} 연결 테스트 실패`) || document.body.innerText.includes(`${text} 연결 테스트 시간 초과`), label, { timeout: 30000 });
        const ok = await page.evaluate(text => document.body.innerText.includes(`${text} 연결 테스트 성공`), label);
        const message = await page.evaluate(text => (document.body.innerText.split('\n').find(line => line.includes(`${text} 연결 테스트`)) || ''), label);
        await page.locator('button:has-text("저장 및 닫기")').click();
        if (!ok) throw new Error(message);
        return { note: '키 유효 · 모델 목록 조회 성공' };
      });
    }

    // 2) 모델별 1K 생성
    for (const model of models) {
      if (!hasKey(model.provider) || MODEL_FILTER && !MODEL_FILTER.has(model.key)) {
        record({ name: `모델별 생성 — ${model.name}`, provider: model.provider, model: model.key, status: 'SKIP', note: hasKey(model.provider) ? 'MODELS 에서 제외' : '키 없음' });
        continue;
      }
      await runTest(`모델별 생성 — ${model.name}`, { provider: model.provider, model: model.key }, async () => {
        await applySettings(page, { model: model.key });
        await newChat(page);
        const start = traffic.length;
        const turn = await sendPrompt('노란 우산을 쓴 귀여운 고양이, 단순한 플랫 일러스트');
        const image = expectImage(turn);
        const reqs = trafficSince(start).filter(r => r.body && r.method === 'POST');
        const notes = [`${image.width}×${image.height}`, image.mime];
        if (model.key === 'nanobanana2_1') {
          const level = reqs[0]?.body?.generationConfig?.thinkingConfig?.thinkingLevel;
          notes.push(`thinkingLevel=${level || '(생략)'}`);
          if (level !== 'MINIMAL') return { status: 'WARN', costText: costText(image), note: `${notes.join(' · ')} — 초고속 모드인데 MINIMAL 이 아님` };
        }
        if (model.provider === 'openai') {
          const sent = reqs.find(r => r.body?.output_format);
          notes.push(sent ? `output_format=${sent.body.output_format}` : 'output_format 거부되어 PNG 로 재요청');
        }
        const thoughts = reqs.map(r => r.usage?.thoughtsTokenCount).find(v => v != null);
        if (thoughts != null) notes.push(`사고 토큰 ${thoughts}`);
        return { costText: costText(image), note: notes.join(' · '), costKrw: image.costKrw, costSource: image.costSource };
      });
    }

    // 3) 문서 기능(나노바나나 2.1)
    if (hasKey('google')) {
      await runTest('PDF 글자 추출(pdf.js·실제 CDN)', { provider: 'local' }, async () => {
        await applySettings(page, { model: 'nanobanana2_1' });
        await newChat(page);
        await page.locator(SEL.docInput).setInputFiles(files.pdf);
        await waitDocReady(page, /PDF · [\d,]+자/);
        const text = await page.evaluate(() => document.body.innerText.match(/PDF · [\d,]+자[^\n]*/)?.[0] || '');
        await page.locator('button:has-text("모두 제거")').first().click();
        return { note: text };
      });
      await runTest('문서(DOCX) 참조 생성 — 나노바나나 2.1', { provider: 'google', model: 'nanobanana2_1' }, async () => {
        await newChat(page);
        await page.locator(SEL.docInput).setInputFiles(files.docx);
        await waitDocReady(page, /Word · [\d,]+자/);
        const start = traffic.length;
        const turn = await sendPrompt('제2장의 드래곤 장면을 그려줘');
        const image = expectImage(turn);
        const sentDoc = trafficSince(start).some(r => r.body?.hasDocBlock);
        if (!sentDoc) throw new Error('요청에 문서 블록이 없습니다.');
        if (!image.docRefs?.names?.length) throw new Error('결과에 참조 문서 표시가 없습니다.');
        await page.screenshot({ path: path.join(OUT_DIR, 'doc-generate.png') });
        return { costText: costText(image), note: `문서 발췌 ${image.docRefs.usedChars}자/${image.docRefs.totalChars}자 → 결과 ${image.width}×${image.height}` };
      });
      await runTest('이전 문서 함께 보내기 — 나노바나나 2.1', { provider: 'google', model: 'nanobanana2_1' }, async () => {
        await page.locator(SEL.input).fill('문서의 제1장 장면도 그려줘');
        const carry = page.locator('label:has-text("이전 문서 함께 보내기") input[type=checkbox]');
        if (!(await carry.isChecked())) throw new Error('문서 언급을 자동 감지하지 못했습니다.');
        const start = traffic.length;
        await page.locator(SEL.send).click();
        await waitGenerationDone(page);
        const turn = await readLastTurn(page);
        const image = expectImage(turn);
        if (!trafficSince(start).some(r => r.body?.hasDocBlock)) throw new Error('후속 요청에 문서가 포함되지 않았습니다.');
        return { costText: costText(image), note: `docCarry=${turn.user?.docCarry}` };
      });
      await runTest('문서 분석(사고 끔) — Gemini 2.5 Flash', { provider: 'google', model: 'gemini-2.5-flash' }, async () => {
        await newChat(page);
        await page.locator(SEL.docInput).setInputFiles(files.docx);
        await waitDocReady(page, /Word · [\d,]+자/);
        const start = traffic.length;
        const turn = await sendPrompt('이 문서의 등장인물과 장면을 요약해줘', SEL.analyze);
        const text = turn.outputs.find(o => o.msgType === 'text');
        if (!text) throw new Error(`분석 결과가 없습니다. ${describeError(turn)}`);
        const req = trafficSince(start).find(r => r.url.includes('gemini-2.5-flash'));
        return { note: `사고 끔=${req?.body?.generationConfig?.thinkingConfig?.thinkingBudget === 0} · 응답 "${text.text.slice(0, 60).replace(/\s+/g, ' ')}…"` };
      });
      await runTest('스캔 PDF 글자 읽기(OCR) — Gemini 2.5 Flash', { provider: 'google', model: 'gemini-2.5-flash' }, async () => {
        await newChat(page);
        await page.locator(SEL.docInput).setInputFiles(files.scanned);
        await page.locator('button:has-text("AI로 글자 읽기")').waitFor({ timeout: 60000 });
        await page.locator('button:has-text("AI로 글자 읽기")').click();
        await page.waitForFunction(() => /AI 글자 읽기/.test(document.body.innerText) || /글자 읽기 실패/.test(document.body.innerText), null, { timeout: TIMEOUT_MS });
        const chip = await page.evaluate(() => document.body.innerText.match(/PDF · [^\n]*/)?.[0] || '');
        await page.locator('button:has-text("모두 제거")').first().click();
        if (!/AI 글자 읽기/.test(chip)) throw new Error(`글자 읽기 실패: ${chip}`);
        return { note: chip };
      });
      await runTest('마스크 편집 — 나노바나나 2.1', { provider: 'google', model: 'nanobanana2_1' }, async () => {
        await newChat(page);
        await page.locator(SEL.imageInput).setInputFiles(files.imageA);
        await page.locator('img[alt="첨부 #1"]').waitFor();
        await page.locator('button[title^="마스크 그리기"]').first().click();
        await drawMask(page);
        const turn = await sendPrompt('칠한 곳을 빨간 풍선 다발로 바꿔줘');
        const image = expectImage(turn);
        if (!image.maskApplied) throw new Error('마스크 편집 경로가 아닙니다.');
        await page.screenshot({ path: path.join(OUT_DIR, 'mask-google.png') });
        return { status: image.maskCompositeError ? 'WARN' : 'PASS', costText: costText(image), note: `영역 전달=${image.maskSourceMode} · 원본 합성=${image.maskComposited}${image.maskCompositeError ? ` · 합성 오류 ${image.maskCompositeError}` : ''}` };
      });
      await runTest('다중 이미지 개별 편집(2장) — 나노바나나 2.1', { provider: 'google', model: 'nanobanana2_1' }, async () => {
        await newChat(page);
        await page.locator(SEL.imageInput).setInputFiles([files.imageA, files.imageB]);
        await page.locator('img[alt="첨부 #2"]').waitFor();
        const turn = await sendPrompt('두 이미지를 같은 수채화 스타일로 바꿔줘');
        const images = turn.outputs.filter(o => o.msgType === 'image');
        if (images.length !== 2) throw new Error(`결과 ${images.length}장 (기대 2장). ${describeError(turn)}`);
        return { costText: `${images.map(costText).join(' + ')}` };
      });
      await runTest('프롬프트·첨부 수정 후 재생성 — 나노바나나 2.1', { provider: 'google', model: 'nanobanana2_1' }, async () => {
        await page.locator('div.bg-blue-600.text-white.rounded-2xl').first().hover();
        await page.locator('button:has-text("Edit")').first().click();
        await page.locator('div.border-blue-500 button[title="이 첨부 이미지 삭제"]').nth(1).click();
        await page.locator(SEL.editInput).setInputFiles(files.docx);
        await page.waitForFunction(() => /Word · [\d,]+자/.test(document.querySelector('div.border-blue-500')?.innerText || ''), null, { timeout: 60000 });
        await page.locator('div.border-blue-500 button[title^="마스크 그리기"]').first().click();
        await drawMask(page);
        await page.locator('div.border-blue-500 textarea').fill('칠한 곳에 문서에 나오는 드래곤을 작게 그려줘');
        const start = traffic.length;
        await page.locator('button:has-text("저장 & 재생성")').click();
        await waitGenerationDone(page);
        const turn = await readLastTurn(page);
        const image = expectImage(turn);
        const reqs = trafficSince(start);
        if (turn.user.images !== 1 || turn.user.masks !== 1 || !turn.user.documents.length) throw new Error(`수정 내용이 저장되지 않았습니다: ${JSON.stringify(turn.user)}`);
        if (!reqs.some(r => r.body?.isMaskedEdit && r.body?.hasDocBlock)) throw new Error('요청에 마스크 지시·문서가 함께 들어가지 않았습니다.');
        await page.screenshot({ path: path.join(OUT_DIR, 'edit-regenerate.png') });
        return { costText: costText(image), note: '이미지 1장 삭제 · 문서 추가 · 마스크 칠함 → 반영 확인' };
      });
      if (COMPARE_TURBO) {
        await runTest('초고속 모드 켬/끔 비교 — 나노바나나 2.1', { provider: 'google', model: 'nanobanana2_1' }, async () => {
          // 절약 모드는 단순한 프롬프트의 사고 수준을 따로 낮추므로, 비교 중에는 끄고(1장 유지) 초고속 모드만 바꾼다.
          const measure = async turbo => {
            await applySettings(page, { model: 'nanobanana2_1', turboMode: turbo, saveMode: false, count: '1' });
            await newChat(page);
            const start = traffic.length;
            const t0 = Date.now();
            const turn = await sendPrompt('비 오는 밤거리에서 네온사인 아래 서 있는 로봇, 영화 같은 조명');
            expectImage(turn);
            const req = trafficSince(start).find(r => r.body?.generationConfig);
            return { seconds: Math.round((Date.now() - t0) / 100) / 10, thoughts: req?.usage?.thoughtsTokenCount ?? null, level: req?.body?.generationConfig?.thinkingConfig?.thinkingLevel || '(기본)' };
          };
          const on = await measure(true);
          const off = await measure(false);
          await applySettings(page, { turboMode: true, saveMode: true });
          return { note: `켬 ${on.seconds}s·사고 ${on.thoughts}토큰(${on.level}) / 끔 ${off.seconds}s·사고 ${off.thoughts}토큰(${off.level})` };
        });
      }
      if (INCLUDE_BATCH) {
        await runTest('Batch 제출 후 취소 — 나노바나나 2.1', { provider: 'google', model: 'nanobanana2_1' }, async () => {
          await applySettings(page, { model: 'nanobanana2_1', batchMode: true });
          await newChat(page);
          const turn = await sendPrompt('하늘을 나는 고래');
          const pending = turn.outputs.find(o => o.msgType === 'pending');
          if (!pending) throw new Error(`Batch 대기 메시지가 없습니다. ${describeError(turn)}`);
          await page.locator('button:has-text("Batch 취소")').first().click();
          await page.waitForTimeout(4000);
          await applySettings(page, { batchMode: false });
          return { note: `제출 상태 ${pending.batchState} → 취소 요청` };
        });
      }
    }

    // 4) Grok·GPT Image 문서·마스크
    if (hasKey('xai')) {
      await runTest('문서 참조 생성 — Grok Imagine 2.0', { provider: 'xai', model: 'grok_imagine_2' }, async () => {
        await applySettings(page, { model: 'grok_imagine_2' });
        await newChat(page);
        await page.locator(SEL.docInput).setInputFiles(files.docx);
        await waitDocReady(page, /Word · [\d,]+자/);
        const start = traffic.length;
        const turn = await sendPrompt('제2장의 드래곤을 그려줘');
        const image = expectImage(turn);
        const req = trafficSince(start).find(r => r.body?.promptChars);
        if (!req?.body?.hasDocBlock) throw new Error('요청에 문서 블록이 없습니다.');
        if (req.body.promptChars > 7000) throw new Error(`프롬프트 ${req.body.promptChars}자 — xAI 상한(7,000자) 초과`);
        return { costText: costText(image), note: `프롬프트 ${req.body.promptChars}자` };
      });
    }
    if (hasKey('openai')) {
      await runTest('문서 참조 생성 — GPT Image 2.5 Flare', { provider: 'openai', model: 'gpt_image_2_5_flare' }, async () => {
        await applySettings(page, { model: 'gpt_image_2_5_flare' });
        await newChat(page);
        await page.locator(SEL.docInput).setInputFiles(files.docx);
        await waitDocReady(page, /Word · [\d,]+자/);
        const start = traffic.length;
        const turn = await sendPrompt('제2장의 드래곤을 그려줘');
        const image = expectImage(turn);
        if (!trafficSince(start).some(r => r.body?.hasDocBlock)) throw new Error('요청에 문서 블록이 없습니다.');
        return { costText: costText(image), note: `${image.mime} ${image.width}×${image.height}` };
      });
      await runTest('마스크 편집(공식 mask) — GPT Image 2.5 Flare', { provider: 'openai', model: 'gpt_image_2_5_flare' }, async () => {
        await newChat(page);
        await page.locator(SEL.imageInput).setInputFiles(files.imageA);
        await page.locator('img[alt="첨부 #1"]').waitFor();
        await page.locator('button[title^="마스크 그리기"]').first().click();
        await drawMask(page);
        const turn = await sendPrompt('칠한 곳을 파란 자전거로 바꿔줘');
        const image = expectImage(turn);
        return { status: image.maskSourceMode === 'native-mask' && !image.maskCompositeError ? 'PASS' : 'WARN', costText: costText(image), note: `영역 전달=${image.maskSourceMode} · 원본 합성=${image.maskComposited}` };
      });
      if (INCLUDE_BATCH) {
        await runTest('Batch 제출 후 취소 — GPT Image 2.5 Flare', { provider: 'openai', model: 'gpt_image_2_5_flare' }, async () => {
          await applySettings(page, { model: 'gpt_image_2_5_flare', batchMode: true });
          await newChat(page);
          const turn = await sendPrompt('하늘을 나는 고래');
          const pending = turn.outputs.find(o => o.msgType === 'pending');
          if (!pending) throw new Error(`Batch 대기 메시지가 없습니다. ${describeError(turn)}`);
          await page.locator('button:has-text("Batch 취소")').first().click();
          await page.waitForTimeout(4000);
          await applySettings(page, { batchMode: false });
          return { note: `제출 상태 ${pending.batchState} → 취소 요청` };
        });
      }
    }

    record({ name: '브라우저 콘솔 오류', status: consoleErrors.length ? 'WARN' : 'PASS', note: consoleErrors.length ? consoleErrors.slice(0, 5).join(' | ') : '없음' });

    // ── 보고서 ──
    const counts = ['PASS', 'WARN', 'FAIL', 'SKIP'].map(status => `${status} ${results.filter(r => r.status === status).length}`).join(' · ');
    const spentKrw = results.reduce((sum, r) => sum + (Number(r.costKrw) || 0), 0);
    const lines = [`# 애미나이 실제 API 테스트 보고서${MOCK ? ' (모의 모드)' : ''}`, '', `- 실행: ${new Date().toISOString()}`, `- 결과: ${counts}`, `- 모델별 생성 테스트의 기록 비용 합계: 약 ${spentKrw.toLocaleString('ko-KR')}원 (그 외 테스트 비용은 각 줄 참조)`, '', '| 결과 | 테스트 | 시간 | 비용 | 메모 |', '|---|---|---|---|---|', ...results.map(r => `| ${r.status} | ${r.name} | ${r.seconds != null ? `${r.seconds}s` : ''} | ${r.costText || ''} | ${String(r.note || r.error || '').replace(/\|/g, '/').replace(/\n/g, ' ')}${r.screenshot ? ` (스크린샷: ${r.screenshot})` : ''} |`), '', '## 실패·경고 상세', ...results.filter(r => r.status === 'FAIL' || r.status === 'WARN').map(r => `### ${r.name}\n${r.error || r.note || ''}\n\n요청: ${JSON.stringify((r.requests || []).map(q => ({ url: q.url, status: q.status, ms: q.ms, error: q.errorText, failure: q.failure, finishReason: q.finishReason })), null, 1)}`)];
    fs.writeFileSync(path.join(OUT_DIR, 'real-api-report.md'), redact(lines.join('\n')));
    fs.writeFileSync(path.join(OUT_DIR, 'real-api-report.json'), redact(JSON.stringify(results, null, 2)));
    console.log(`\n${counts}\n보고서: ${path.relative(ROOT, path.join(OUT_DIR, 'real-api-report.md'))}`);
    return shutdown(results.some(r => r.status === 'FAIL') ? 1 : 0);
  } catch (error) {
    console.error('테스트 실행 오류:', redact(error?.stack || error));
    return shutdown(2);
  }
})();
