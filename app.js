// === Estado global ===
let video, canvas, ctx, overlay, statusEl, roisList;
let isFrozen = false;
let mode = "idle"; // idle | selectTemplate | addRoiTpl | addRoiBarcode

// Template selecionado (crop do frame) e sua caixa no frame
let templateImg = null;            // ImageData do template
let tplBox = null;                 // {x,y,w,h} no frame (pixels)
let tplKP = null, tplDESC = null;  // ORB do template

// Programa atual
let currentProgram = null;

// Desenho de seleção
let dragStart = null;
let dragRect = null;

// ZXing
const codeReader = new ZXing.BrowserMultiFormatReader();

// Util
const sleep = ms => new Promise(r => setTimeout(r, ms));

// === Boot ===
window.addEventListener('load', async () => {
  video = document.getElementById('video');
  canvas = document.getElementById('canvas');
  ctx = canvas.getContext('2d');
  overlay = document.getElementById('overlay');
  statusEl = document.getElementById('status');
  roisList = document.getElementById('roisList');

  if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('sw.js'); } catch {} }

  await startCamera();
  await waitForOpenCV();

  // Botões
  document.getElementById('btnFreeze').onclick = () => { isFrozen = !isFrozen; };
  document.getElementById('btnPickTemplate').onclick = () => {
    if (!isFrozen) { alert("Congele a imagem antes."); return; }
    mode = "selectTemplate"; info("Arraste o retângulo do template.");
  };
  document.getElementById('btnAddRoiTpl').onclick = () => {
    if (!templateImg) { alert("Defina o template primeiro."); return; }
    mode = "addRoiTpl"; info("Arraste a ROI de TEMPLATE dentro do template.");
  };
  document.getElementById('btnAddRoiBarcode').onclick = () => {
    if (!templateImg) { alert("Defina o template primeiro."); return; }
    mode = "addRoiBarcode"; info("Arraste a ROI de BARCODE dentro do template.");
  };
  document.getElementById('btnSaveProgram').onclick = saveProgram;
  document.getElementById('btnLoadProgram').onclick = loadProgram;
  document.getElementById('btnRun').onclick = () => info("Executando… (mova a câmera)");

  // Eventos de arraste na overlay (mouse + touch)
  addDragHandlers();

  // Loop
  mainLoop();
});

// === Câmera ===
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
    const t = setInterval(() => { if (cv && cv.Mat) { clearInterval(t); res(); } }, 100);
  });
}

// === UI helpers ===
function info(txt) { statusEl.textContent = "Status: " + txt; }

function addDragHandlers() {
  const getPos = (evt) => {
    const rect = overlay.getBoundingClientRect();
    const x = (evt.touches ? evt.touches[0].clientX : evt.clientX) - rect.left;
    const y = (evt.touches ? evt.touches[0].clientY : evt.clientY) - rect.top;
    // Ajusta para escala do canvas
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    return { x: Math.max(0, Math.min(canvas.width, x * sx)),
             y: Math.max(0, Math.min(canvas.height, y * sy)) };
  };

  const start = (evt) => {
    if (mode === "idle") return;
    evt.preventDefault();
    dragStart = getPos(evt);
    dragRect = { x: dragStart.x, y: dragStart.y, w: 0, h: 0 };
    drawOverlay();
  };
  const move = (evt) => {
    if (!dragStart) return;
    const p = getPos(evt);
    dragRect = {
      x: Math.min(dragStart.x, p.x),
      y: Math.min(dragStart.y, p.y),
      w: Math.abs(p.x - dragStart.x),
      h: Math.abs(p.y - dragStart.y)
    };
    drawOverlay();
  };
  const end = () => {
    if (!dragRect || dragRect.w < 8 || dragRect.h < 8) { dragStart = null; dragRect = null; drawOverlay(); return; }
    // Finaliza seleção conforme o modo
    if (mode === "selectTemplate") finalizeTemplateSelection(dragRect);
    else if (mode === "addRoiTpl") finalizeRoiSelection(dragRect, "TEMPLATE");
    else if (mode === "addRoiBarcode") finalizeRoiSelection(dragRect, "BARCODE");
    // reset
    dragStart = null; dragRect = null;
    mode = "idle";
    drawOverlay();
  };

  overlay.addEventListener('mousedown', start);
  overlay.addEventListener('mousemove', move);
  overlay.addEventListener('mouseup', end);
  overlay.addEventListener('mouseleave', end);
  overlay.addEventListener('touchstart', start, {passive:false});
  overlay.addEventListener('touchmove', move, {passive:false});
  overlay.addEventListener('touchend', end);
}

function drawOverlay(boxes = []) {
  overlay.innerHTML = "";
  // Caixa de arraste atual
  if (dragRect) {
    overlay.appendChild(makeBoxDiv(dragRect, "#ff0", 2));
  }
  // Caixas do template e ROIs salvas (em coords de frame)
  if (tplBox) overlay.appendChild(makeBoxDiv(tplBox, "#0af", 3)); // template = azul
  if (currentProgram && currentProgram.rois) {
    currentProgram.rois.forEach(r => {
      if (!tplBox) return;
      const R = denormRectOnFrame(r.rectNorm, tplBox);
      overlay.appendChild(makeBoxDiv(R, r.type === "TEMPLATE" ? "#0c0" : "#c0f", 2));
    });
  }
  // Caixas de status (na execução, colorimos por OK/NG no drawExecutionOverlay)
}

function makeBoxDiv(rect, color, width=3) {
  const div = document.createElement('div');
  div.style.position = 'absolute';
  const bb = frameToOverlayRect(rect);
  div.style.left   = bb.x + "px";
  div.style.top    = bb.y + "px";
  div.style.width  = bb.w + "px";
  div.style.height = bb.h + "px";
  div.style.border = `${width}px solid ${color}`;
  return div;
}

function frameToOverlayRect(r) {
  const rect = overlay.getBoundingClientRect();
  const sx = rect.width / canvas.width;
  const sy = rect.height / canvas.height;
  return { x: r.x * sx, y: r.y * sy, w: r.w * sx, h: r.h * sy };
}

// === Seleções ===
function finalizeTemplateSelection(r) {
  // Garante mínimo
  tplBox = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
  // recorta template do frame congelado
  const tpl = ctx.getImageData(tplBox.x, tplBox.y, tplBox.w, tplBox.h);
  templateImg = tpl;

  // Extrai ORB do template
  const tplMat = imageDataToMatGray(templateImg);
  const orb = new cv.ORB(800);
  let kp = new cv.KeyPointVector(), desc = new cv.Mat();
  orb.detectAndCompute(tplMat, new cv.Mat(), kp, desc);
  tplKP = kp; tplDESC = desc;
  tplMat.delete(); orb.delete();

  // Inicializa programa
  currentProgram = {
    id: "program_"+Date.now(),
    name: "Programa",
    template: { w: templateImg.width, h: templateImg.height, nfeatures:800, ratioTest:0.75, ransac:3.0 },
    rois: [],
    ngPolicy: "ANY_ROI_FAILS"
  };
  renderROIsList();
  info("Template definido.");
}

function finalizeRoiSelection(rectFrame, type) {
  if (!tplBox || !templateImg) { alert("Defina o template primeiro."); return; }
  // Converte retângulo do frame para coordenadas normalizadas no espaço do template
  const rx = (rectFrame.x - tplBox.x) / tplBox.w;
  const ry = (rectFrame.y - tplBox.y) / tplBox.h;
  const rw = rectFrame.w / tplBox.w;
  const rh = rectFrame.h / tplBox.h;
  // Clampa entre 0..1
  const rectNorm = [
    Math.max(0, Math.min(1, rx)),
    Math.max(0, Math.min(1, ry)),
    Math.max(0, Math.min(1, rw)),
    Math.max(0, Math.min(1, rh))
  ];

  const roi = {
    id: `roi_${Date.now()}`,
    type, rectNorm,
    okThreshold: (type === "TEMPLATE") ? 0.85 : null,
    symbologies: (type === "BARCODE") ? ["QR_CODE","EAN_13","CODE_128"] : null,
    expectedText: (type === "BARCODE") ? "" : null,
    // Para TEMPLATE salvamos o GOLDEN crop como dataURL (fica dentro do JSON)
    goldenData: null
  };

  if (type === "TEMPLATE") {
    const rectPix = denormRect(rectNorm, templateImg.width, templateImg.height);
    const golden = cropImageData(templateImg, rectPix);
    roi.goldenData = imageDataToPNGDataURL(golden);
  }

  currentProgram.rois.push(roi);
  renderROIsList();
  drawOverlay();
  info(`${type} adicionada.`);
}

function renderROIsList() {
  roisList.innerHTML = "";
  if (!currentProgram) return;
  currentProgram.rois.forEach(r => {
    const div = document.createElement('div');
    div.innerHTML = `<b>${r.id}</b> — ${r.type} — rect ${r.rectNorm.map(n=>n.toFixed(2)).join(", ")}`;
    roisList.appendChild(div);
  });
}

// === Loop principal ===
async function mainLoop() {
  while (true) {
    if (!isFrozen) ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Execução
    if (templateImg && currentProgram && currentProgram.rois.length) {
      const ok = await detectTemplateAndCheckROIs();
      info(ok ? "OK" : "NG");
    }
    await sleep(33);
  }
}

// === Pipeline de execução ===
async function detectTemplateAndCheckROIs() {
  // Frame gray
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const frameGray = imageDataToMatGray(frame);

  // ORB frame
  const orb = new cv.ORB(800);
  let kpF = new cv.KeyPointVector(), descF = new cv.Mat();
  orb.detectAndCompute(frameGray, new cv.Mat(), kpF, descF);

  let allOK = false;
  let H = null;

  if (!descF.empty() && tplDESC && !tplDESC.empty()) {
    // KNN + Ratio
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

    if (goodTpl.length/2 >= 12) {
      let src = cv.matFromArray(goodFrm.length/2, 1, cv.CV_32FC2, goodFrm);
      let dst = cv.matFromArray(goodTpl.length/2, 1, cv.CV_32FC2, goodTpl);
      let mask = new cv.Mat();
      H = cv.findHomography(src, dst, cv.RANSAC, 3.0, mask);
      const found = !H.empty();
      src.delete(); dst.delete(); mask.delete();

      if (found) {
        // Warp do frame → espaço do template
        const warped = warpFrameToTemplate(frameGray, H, templateImg.width, templateImg.height);
        // Avaliar ROIs
        let everyOK = true;
        const statusBoxes = [];

        for (const roi of currentProgram.rois) {
          const r = denormRect(roi.rectNorm, templateImg.width, templateImg.height);
          const roiMat = warped.roi(new cv.Rect(r.x, r.y, r.w, r.h));

          let ok = false;
          if (roi.type === "TEMPLATE") {
            if (roi.goldenData) {
              const goldenImgData = dataURLToImageData(roi.goldenData);
              const goldenMat = imageDataToMatGray(goldenImgData);
              // matchTemplate
              const result = new cv.Mat();
              cv.matchTemplate(roiMat, goldenMat, result, cv.TM_CCOEFF_NORMED);
              const mm = cv.minMaxLoc(result);
              const score = mm.maxVal;
              ok = score >= (roi.okThreshold ?? 0.85);
              result.delete(); goldenMat.delete();
            }
          } else {
            // BARCODE
            const idata = matToImageData(roiMat);
            ok = await decodeBarcode(idata, roi.symbologies, roi.expectedText);
          }

          everyOK = everyOK && ok;
          statusBoxes.push({ rect: r, color: ok ? "#0c0" : "#c00" });
          roiMat.delete();
        }

        warped.delete();
        drawExecutionOverlay(statusBoxes);
        allOK = everyOK;
      }
    }

    bf.delete(); matches.delete();
  }

  // limpeza
  frameGray.delete(); orb.delete(); kpF.delete(); descF.delete();
  return allOK;
}

function drawExecutionOverlay(boxes) {
  // Desenha template + ROIs + status
  drawOverlay(); // base (template/rois)
  boxes.forEach(b => {
    overlay.appendChild(makeBoxDiv(b.rect, b.color, 3));
  });
}

// === OpenCV utils ===
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
function matToImageData(mat) {
  const rgba = new cv.Mat();
  cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);
  const imgData = new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows);
  rgba.delete();
  return imgData;
}

// === Barcode (ZXing) ===
async function decodeBarcode(imgData, symbologies, expected) {
  const c = document.createElement('canvas');
  c.width = imgData.width; c.height = imgData.height;
  const cctx = c.getContext('2d');
  cctx.putImageData(imgData, 0, 0);
  try {
    const result = await codeReader.decodeFromCanvas(c);
    const okSym = !symbologies || symbologies.length === 0 || symbologies.includes(result.getBarcodeFormat());
    const okTxt = !expected || expected.length === 0 || expected === result.getText();
    return okSym && okTxt;
  } catch { return false; }
}

// === Conversões e recortes ===
function denormRect([x,y,w,h], W, H) {
  return { x: Math.round(x*W), y: Math.round(y*H), w: Math.round(w*W), h: Math.round(h*H) };
}
function denormRectOnFrame([x,y,w,h], tplBox) {
  return {
    x: Math.round(tplBox.x + x*tplBox.w),
    y: Math.round(tplBox.y + y*tplBox.h),
    w: Math.round(w*tplBox.w),
    h: Math.round(h*tplBox.h)
  };
}
function cropImageData(imgData, rect) {
  const tmp = document.createElement('canvas');
  tmp.width = rect.w; tmp.height = rect.h;
  const tctx = tmp.getContext('2d');
  const srcC = document.createElement('canvas');
  srcC.width = imgData.width; srcC.height = imgData.height;
  srcC.getContext('2d').putImageData(imgData, 0, 0);
  tctx.drawImage(srcC, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  return tctx.getImageData(0, 0, rect.w, rect.h);
}
function imageDataToPNGDataURL(imgData) {
  const c = document.createElement('canvas');
  c.width = imgData.width; c.height = imgData.height;
  c.getContext('2d').putImageData(imgData, 0, 0);
  return c.toDataURL("image/png");
}
function dataURLToImageData(dataURL) {
  const img = new Image();
  const c = document.createElement('canvas');
  const p = new Promise((resolve) => {
    img.onload = () => {
      c.width = img.width; c.height = img.height;
      const ictx = c.getContext('2d');
      ictx.drawImage(img, 0, 0);
      resolve(ictx.getImageData(0, 0, img.width, img.height));
    };
  });
  img.src = dataURL;
  return p;
}

// === Salvar / carregar programa ===
function saveProgram() {
  if (!currentProgram) return alert("Crie um programa.");
  const blob = new Blob([JSON.stringify(currentProgram, null, 2)], {type: "application/json"});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${currentProgram.id}.json`;
  a.click();
}
function loadProgram() {
  const inp = document.getElementById('fileProgram');
  if (!inp.files || !inp.files[0]) return alert("Selecione um JSON.");
  const fr = new FileReader();
  fr.onload = () => {
    currentProgram = JSON.parse(fr.result);
    // Observação: este JSON assume goldenData embutido nas ROIs TEMPLATE.
    // Para carregar um programa salvo antes sem goldenData, você pode redefinir as ROIs.
    renderROIsList();
    info("Programa carregado.");
  };
  fr.readAsText(inp.files[0]);
}
