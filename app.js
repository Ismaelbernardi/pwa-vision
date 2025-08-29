let video, canvas, ctx, overlay, statusEl, roisList;
let templateImg = null;      // ImageData do template
let tplKP = null, tplDESC = null; // keypoints/descritores do template
let programs = [];           // vários programas
let currentProgram = null;
let isFrozen = false;

// ZXing (instância do leitor)
const codeReader = new ZXing.BrowserMultiFormatReader();

// util
const sleep = ms => new Promise(r => setTimeout(r, ms));

window.addEventListener('load', async () => {
  video = document.getElementById('video');
  canvas = document.getElementById('canvas');
  ctx = canvas.getContext('2d');
  overlay = document.getElementById('overlay');
  statusEl = document.getElementById('status');
  roisList = document.getElementById('roisList');

  // PWA
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch {}
  }

  // Câmera (precisa HTTPS)
  await startCamera();

  // Botões
  document.getElementById('btnFreeze').onclick = () => isFrozen = !isFrozen;
  document.getElementById('btnPickTemplate').onclick = pickTemplateFromFrame;
  document.getElementById('btnAddRoiTpl').onclick = () => addROI('TEMPLATE');
  document.getElementById('btnAddRoiBarcode').onclick = () => addROI('BARCODE');
  document.getElementById('btnSaveProgram').onclick = saveProgram;
  document.getElementById('btnLoadProgram').onclick = loadProgram;
  document.getElementById('btnRun').onclick = () => runLoop();

  // Loop
  waitForOpenCV().then(() => mainLoop());
});

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  video.srcObject = stream;
  await video.play();
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
}

function waitForOpenCV() {
  return new Promise(res => {
    if (cv && cv.Mat) return res();
    let iv = setInterval(() => { if (cv && cv.Mat) { clearInterval(iv); res(); } }, 100);
  });
}

async function mainLoop() {
  while (true) {
    if (!isFrozen) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    }
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);

    if (templateImg) {
      const found = await detectTemplateAndCheckROIs(frame);
      statusEl.textContent = `Status: ${found ? "Template OK" : "Template não encontrado"}`;
    } else {
      statusEl.textContent = `Status: defina um Template`;
    }
    await sleep(33); // ~30 fps
  }
}

async function pickTemplateFromFrame() {
  // Para MVP: usa frame inteiro como template
  templateImg = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // Extrai ORB do template
  const tplMat = imageDataToMatGray(templateImg);
  const orb = new cv.ORB(800);
  let kp = new cv.KeyPointVector(), desc = new cv.Mat();
  orb.detectAndCompute(tplMat, new cv.Mat(), kp, desc);

  tplKP = kp; tplDESC = desc;
  tplMat.delete();
  orb.delete();
  alert("Template definido (frame inteiro). Você pode melhorar depois com recorte.");
}

function addROI(type) {
  if (!templateImg) return alert("Defina o template primeiro.");
  // ROI default central (normalizada) — depois você implementa seleção por toque
  const roi = {
    id: `roi_${Date.now()}`,
    type, // "TEMPLATE" ou "BARCODE"
    rectNorm: [0.3, 0.3, 0.4, 0.2],
    okThreshold: type === "TEMPLATE" ? 0.85 : null,
    expectedText: type === "BARCODE" ? "" : null,
    symbologies: type === "BARCODE" ? ["QR_CODE","EAN_13","CODE_128"] : null
  };
  if (!currentProgram) currentProgram = makeEmptyProgram();
  currentProgram.rois.push(roi);
  renderROIsList();
}

function makeEmptyProgram() {
  return {
    id: "program_"+Date.now(),
    name: "Programa",
    template: {
      w: templateImg.width, h: templateImg.height,
      nfeatures: 800, ratioTest: 0.75, ransac: 3.0
    },
    rois: [],
    ngPolicy: "ANY_ROI_FAILS"
  };
}

function renderROIsList() {
  roisList.innerHTML = "";
  if (!currentProgram) return;
  currentProgram.rois.forEach(r => {
    const div = document.createElement("div");
    div.innerHTML = `<b>${r.id}</b> — ${r.type}`;
    roisList.appendChild(div);
  });
}

async function detectTemplateAndCheckROIs(frameImageData) {
  // 1) ORB no frame
  const frameGray = imageDataToMatGray(frameImageData);
  const orb = new cv.ORB(800);
  let kpF = new cv.KeyPointVector(), descF = new cv.Mat();
  orb.detectAndCompute(frameGray, new cv.Mat(), kpF, descF);

  if (descF.empty() || !tplDESC || tplDESC.empty()) {
    cleanup([frameGray, orb, kpF, descF]);
    return false;
  }

  // 2) BFMatcher + Ratio test
  let bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
  let matches = new cv.DMatchVectorVector();
  bf.knnMatch(tplDESC, descF, matches, 2);

  let goodTpl = [], goodFrm = [];
  for (let i = 0; i < matches.size(); i++) {
    const m = matches.get(i);
    if (m.size() < 2) continue;
    const m0 = m.get(0), m1 = m.get(1);
    if (m0.distance < 0.75 * m1.distance) {
      const ptTpl = tplKP.get(m0.queryIdx).pt;
      const ptFrm = kpF.get(m0.trainIdx).pt;
      goodTpl.push(ptTpl.x, ptTpl.y);
      goodFrm.push(ptFrm.x, ptFrm.y);
    }
    m.delete();
  }

  const minInliers = 12;
  let found = false, H = null;
  if (goodTpl.length/2 >= minInliers) {
    let src = cv.matFromArray(goodFrm.length/2, 1, cv.CV_32FC2, goodFrm);
    let dst = cv.matFromArray(goodTpl.length/2, 1, cv.CV_32FC2, goodTpl);
    let mask = new cv.Mat();
    H = cv.findHomography(src, dst, cv.RANSAC, 3.0, mask);
    found = !H.empty();
    src.delete(); dst.delete(); mask.delete();
  }

  let allOK = found;
  if (found && currentProgram && currentProgram.rois.length) {
    // 3) Checar ROIs
    for (const roi of currentProgram.rois) {
      const rect = denormRect(roi.rectNorm, templateImg.width, templateImg.height);
      // Projeta o retângulo do template para o frame com H^-1 (ou warpa o frame p/ espaço do template)
      // Para simplificar: WARPA O FRAME inteiro p/ o tamanho do template
      const warped = warpFrameToTemplate(frameGray, H, templateImg.width, templateImg.height);
      const roiMat = warped.roi(new cv.Rect(rect.x, rect.y, rect.w, rect.h));

      if (roi.type === "TEMPLATE") {
        const score = matchTemplateScore(roiMat, warped, rect); // aqui eu comparo ROI vs. o próprio warp (placeholder)
        const ok = score >= (roi.okThreshold ?? 0.85);
        allOK = allOK && ok;
        drawBox(rect, ok ? 'ok' : 'ng');
      } else { // BARCODE
        const roiImgData = matToImageData(roiMat);
        const ok = await decodeBarcode(roiImgData, roi.symbologies, roi.expectedText);
        allOK = allOK && ok;
        drawBox(rect, ok ? 'ok' : 'ng');
      }

      roiMat.delete(); warped.delete();
    }
  }

  // limpeza
  cleanup([frameGray, orb, kpF, descF, bf, matches, H]);

  return allOK;
}

// -------- util OpenCV.js --------

function imageDataToMatGray(imgData) {
  const mat = cv.matFromImageData(imgData);
  const gray = new cv.Mat();
  cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
  mat.delete();
  return gray;
}

function warpFrameToTemplate(frameGray, H, w, h) {
  const warped = new cv.Mat();
  cv.warpPerspective(frameGray, warped, H, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_CONSTANT);
  return warped;
}

function matchTemplateScore(roiMat, warped, rect) {
  // Nesta versão base, como “golden”, use o mesmo recorte do template inicial.
  // Em produção: salve um GOLDEN (crop do template) e compare roiMat x GOLDEN.
  const tplCrop = warped.roi(new cv.Rect(rect.x, rect.y, rect.w, rect.h));
  const result = new cv.Mat();
  cv.matchTemplate(roiMat, tplCrop, result, cv.TM_CCOEFF_NORMED);
  const minMax = cv.minMaxLoc(result);
  const score = minMax.maxVal;
  result.delete(); tplCrop.delete();
  return score;
}

function matToImageData(mat) {
  const rgba = new cv.Mat();
  cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);
  const imgData = new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows);
  rgba.delete();
  return imgData;
}

async function decodeBarcode(imgData, symbologies, expected) {
  // ZXing trabalha melhor com <video>/<img>, mas podemos usar o helper decodeFromImageUrl / decodeOnce do stream.
  // Como fallback, desenhamos num canvas temporário.
  const c = document.createElement('canvas');
  c.width = imgData.width; c.height = imgData.height;
  const cctx = c.getContext('2d');
  cctx.putImageData(imgData, 0, 0);
  try {
    const result = await codeReader.decodeFromCanvas(c);
    const okSym = !symbologies || symbologies.length === 0 || symbologies.includes(result.getBarcodeFormat());
    const okTxt = !expected || expected.length === 0 || expected === result.getText();
    return okSym && okTxt;
  } catch {
    return false;
  }
}

function denormRect([x,y,w,h], W, H) {
  return { x: Math.round(x*W), y: Math.round(y*H), w: Math.round(w*W), h: Math.round(h*H) };
}

function drawBox(rect, className) {
  // desenha retângulos como DIVs CSS no overlay
  const box = document.createElement('div');
  box.style.position = 'absolute';
  box.style.left = rect.x + 'px';
  box.style.top = rect.y + 'px';
  box.style.width = rect.w + 'px';
  box.style.height = rect.h + 'px';
  box.style.border = `3px solid ${className === 'ok' ? '#0c0' : '#c00'}`;
  overlay.innerHTML = '';
  overlay.appendChild(box);
}

function cleanup(arr) {
  arr.forEach(a => { try { a && a.delete && a.delete(); } catch {} });
}

// -------- salvar / carregar programa --------

function saveProgram() {
  if (!currentProgram) return alert("Crie um programa primeiro.");
  const blob = new Blob([JSON.stringify(currentProgram, null, 2)], {type: "application/json"});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${currentProgram.id}.json`;
  a.click();
}

function loadProgram() {
  const inp = document.getElementById('fileProgram');
  if (!inp.files || !inp.files[0]) return alert("Selecione um arquivo JSON.");
  const fr = new FileReader();
  fr.onload = () => {
    currentProgram = JSON.parse(fr.result);
    renderROIsList();
    alert("Programa carregado.");
  };
  fr.readAsText(inp.files[0]);
}

async function runLoop() {
  if (!currentProgram) return alert("Carregue/crie um programa.");
  alert("Executando: o status aparecerá no topo. Instale como PWA para rodar offline.");
}
