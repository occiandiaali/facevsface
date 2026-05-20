import "./style.css";
import * as faceapi from "@vladmandic/face-api";

// ─── CDN path for model weights ──────────────────────────────────────
// Models are ~6 MB total, fetched once and cached by the browser.
// const MODEL_URL =
//   "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14/model";
//const MODEL_URL =

// ─── State ───────────────────────────────────────────────────────────
const state = {
  imageA: null, // HTMLImageElement
  imageB: null, // HTMLImageElement
  dataA: null, // face-api detection result
  dataB: null,
  modelsReady: false,
  selfieTarget: null, // 'A' | 'B'
  stream: null,
};

// ─── DOM refs ────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const statusDot = $("statusDot");
const statusText = $("statusText");
const progressFill = $("progressFill");
const analyseBtn = $("analyseBtn");
const btnLabel = $("btnLabel");
const btnIco = $("btnIco");
const btnSpinner = $("btnSpinner");
const errorBar = $("errorBar");
const errorMsg = $("errorMsg");
const results = $("results");
const metricsGrid = $("metricsGrid");
const breakdown = $("breakdown");
const scoreFill = $("scoreFill");
const scoreValue = $("scoreValue");
const scoreVerdict = $("scoreVerdict");
const overlayA = $("overlayA");
const overlayB = $("overlayB");
const cameraModal = $("cameraModal");
const cameraFeed = $("cameraFeed");
const captureCanvas = $("captureCanvas");

// ─── Load models ─────────────────────────────────────────────────────

async function loadModels() {
  const steps = [
    {
      name: "SSD face detector",
      fn: () => faceapi.nets.ssdMobilenetv1.loadFromUri("/models"),
    },
    {
      name: "68-pt landmarks",
      fn: () => faceapi.nets.faceLandmark68Net.loadFromUri("/models"),
    },
    {
      name: "Age & gender",
      fn: () => faceapi.nets.ageGenderNet.loadFromUri("/models"),
    },
    {
      name: "Expressions",
      fn: () => faceapi.nets.faceExpressionNet.loadFromUri("/models"),
    },
    {
      name: "Face recognition",
      fn: () => faceapi.nets.faceRecognitionNet.loadFromUri("/models"),
    },
  ];

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    statusText.textContent = `Loading model ${i + 1}/${steps.length}: ${s.name}…`;
    progressFill.style.width = `${(i / steps.length) * 100}%`;
    await s.fn();
  }

  progressFill.style.width = "100%";
  statusDot.className = "status-dot ready";
  statusText.textContent = "Models ready — upload two face images to begin";
  state.modelsReady = true;
  checkCanAnalyse();
}

loadModels().catch((err) => {
  statusDot.className = "status-dot error";
  statusText.textContent = `Model load failed: ${err.message}`;
});

// ─── Image loading helpers ───────────────────────────────────────────
function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function drawImageToCanvas(canvas, img) {
  const MAX = 320;
  const ratio = Math.min(MAX / img.width, MAX / img.height, 1);
  canvas.width = Math.round(img.width * ratio);
  canvas.height = Math.round(img.height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
}

function setImage(side, img) {
  state[`image${side}`] = img;
  state[`data${side}`] = null; // reset detection

  const canvas = $(`canvas${side}`);
  const placeholder = $(`placeholder${side}`);
  const clearBtn = $(`clear${side}`);
  const badgeEl = $(`badge${side}`);

  drawImageToCanvas(canvas, img);
  canvas.hidden = false;
  placeholder.style.display = "none";
  clearBtn.hidden = false;
  badgeEl.hidden = true;
  checkCanAnalyse();
}

function clearSide(side) {
  state[`image${side}`] = null;
  state[`data${side}`] = null;

  const canvas = $(`canvas${side}`);
  const placeholder = $(`placeholder${side}`);
  const clearBtn = $(`clear${side}`);
  const badgeEl = $(`badge${side}`);
  const fileInput = $(`file${side}`); // ← reset the actual input

  canvas.hidden = true;
  placeholder.style.display = "";
  clearBtn.hidden = true;
  badgeEl.hidden = true;
  results.hidden = true;
  fileInput.value = ""; // ← clears the browser's file reference so re-selecting same file fires change
  checkCanAnalyse();
}

// ─── File upload wiring ───────────────────────────────────────────────
function wireUpload(side) {
  const fileInput = $(`file${side}`);
  const dropZone = $(`drop${side}`);

  fileInput.addEventListener("change", async (e) => {
    if (!e.target.files[0]) return;
    const img = await fileToImage(e.target.files[0]);
    setImage(side, img);
    e.target.value = "";
  });

  // Click drop zone → trigger file input
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  // Drag & drop
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });
  dropZone.addEventListener("dragleave", () =>
    dropZone.classList.remove("drag-over"),
  );
  dropZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) {
      const img = await fileToImage(file);
      setImage(side, img);
    }
  });
}

wireUpload("A");
wireUpload("B");

$("clearA").addEventListener("click", () => clearSide("A"));
$("clearB").addEventListener("click", () => clearSide("B"));

// ─── Camera / selfie ─────────────────────────────────────────────────
async function openCamera(side) {
  state.selfieTarget = side;
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    cameraFeed.srcObject = state.stream;
    cameraModal.hidden = false;
  } catch (err) {
    showError(`Camera access denied: ${err.message}`);
  }
}

function closeCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  cameraFeed.srcObject = null;
  cameraModal.hidden = true;
}

$("selfieA").addEventListener("click", () => openCamera("A"));
$("selfieB").addEventListener("click", () => openCamera("B"));
$("closeCamera").addEventListener("click", closeCamera);
$("cancelCamera").addEventListener("click", closeCamera);

$("snapPhoto").addEventListener("click", () => {
  captureCanvas.width = cameraFeed.videoWidth;
  captureCanvas.height = cameraFeed.videoHeight;
  captureCanvas.getContext("2d").drawImage(cameraFeed, 0, 0);
  const img = new Image();
  img.onload = () => {
    setImage(state.selfieTarget, img);
    closeCamera();
  };
  img.src = captureCanvas.toDataURL("image/jpeg", 0.92);
});

// ─── Analyse button gate ─────────────────────────────────────────────
function checkCanAnalyse() {
  analyseBtn.disabled = !(state.modelsReady && state.imageA && state.imageB);
}

// ─── Error helper ────────────────────────────────────────────────────
function showError(msg) {
  errorMsg.textContent = msg;
  errorBar.hidden = false;
}
function clearError() {
  errorBar.hidden = true;
}

// ─── Run analysis ────────────────────────────────────────────────────
analyseBtn.addEventListener("click", runAnalysis);

async function detectFace(img, side) {
  // Resize to a virtual canvas to pass to face-api
  const canvas = document.createElement("canvas");
  drawImageToCanvas(canvas, img);

  const options = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.4 });
  const result = await faceapi
    .detectSingleFace(canvas, options)
    .withFaceLandmarks()
    .withFaceDescriptor()
    .withAgeAndGender()
    .withFaceExpressions();
  return { result, canvas };
}

async function runAnalysis() {
  clearError();
  results.hidden = true;
  setLoading(true);
  await new Promise((r) => setTimeout(r, 0)); // yield to paint thread before heavy work

  try {
    // Detect both faces
    const [rA, rB] = await Promise.all([
      detectFace(state.imageA, "A"),
      detectFace(state.imageB, "B"),
    ]);

    if (!rA.result)
      throw new Error(
        "No face detected in Subject A. Try a clearer, front-facing photo.",
      );
    if (!rB.result)
      throw new Error(
        "No face detected in Subject B. Try a clearer, front-facing photo.",
      );

    state.dataA = rA;
    state.dataB = rB;

    // Show per-face badges
    showBadge("A", rA.result);
    showBadge("B", rB.result);

    // Draw landmarks on overlay canvases
    drawLandmarks(overlayA, rA.canvas, rA.result);
    drawLandmarks(overlayB, rB.canvas, rB.result);

    // Compute and render metrics
    const metrics = computeMetrics(rA.result, rB.result);
    renderResults(metrics, rA.result, rB.result);

    results.hidden = false;
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

function setLoading(on) {
  analyseBtn.disabled = on;
  btnIco.hidden = on;
  //btnSpinner.hidden = !on;

  btnLabel.textContent = on ? "ANALYSING…" : "RUN ANALYSIS";
}

function showBadge(side, result) {
  const genderStr = result.gender
    ? `${result.gender.toUpperCase()} · ~${Math.round(result.age)}yr`
    : "";
  const expEntries = Object.entries(result.expressions).sort(
    (a, b) => b[1] - a[1],
  );
  const topExp = expEntries[0];
  const expStr = topExp
    ? `${topExp[0].toUpperCase()} ${Math.round(topExp[1] * 100)}%`
    : "";

  $(`ageGender${side}`).textContent = genderStr;
  $(`expression${side}`).textContent = expStr;
  $(`badge${side}`).hidden = false;
}

// ─── Draw 68-pt landmarks ─────────────────────────────────────────────
function drawLandmarks(canvas, srcCanvas, result) {
  canvas.width = srcCanvas.width;
  canvas.height = srcCanvas.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(srcCanvas, 0, 0);

  // Dim overlay
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw bounding box
  const box = result.detection.box;
  ctx.strokeStyle = "#ff0000"; //"#00e6b4";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  // Draw landmark dots
  const pts = result.landmarks.positions;
  ctx.fillStyle = "#00e6b4";
  for (const pt of pts) {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Draw connection lines for key regions
  ctx.strokeStyle = "rgba(0,230,180,0.4)";
  ctx.lineWidth = 0.8;
  drawPolyline(ctx, pts, 0, 16); // jaw
  drawPolyline(ctx, pts, 17, 21); // left eyebrow
  drawPolyline(ctx, pts, 22, 26); // right eyebrow
  drawPolyline(ctx, pts, 27, 35); // nose bridge + tip
  drawPolyline(ctx, pts, 36, 41, true); // left eye
  drawPolyline(ctx, pts, 42, 47, true); // right eye
  drawPolyline(ctx, pts, 48, 59, true); // outer mouth
  drawPolyline(ctx, pts, 60, 67, true); // inner mouth
}

function drawPolyline(ctx, pts, start, end, close = false) {
  ctx.beginPath();
  ctx.moveTo(pts[start].x, pts[start].y);
  for (let i = start + 1; i <= end; i++) ctx.lineTo(pts[i].x, pts[i].y);
  if (close) ctx.closePath();
  ctx.stroke();
}

// ─── Geometric metrics ───────────────────────────────────────────────
/**
 * All metrics derived from the 68-point landmark schema:
 * 0-16:  jaw, 17-21: L eyebrow, 22-26: R eyebrow,
 * 27-35: nose, 36-41: L eye, 42-47: R eye,
 * 48-67: mouth
 */
function dist(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function computeRatios(pts) {
  const faceWidth = dist(pts[0], pts[16]);
  const faceHeight = dist(pts[8], midPoint(pts[19], pts[24])); // chin to mid-eyebrow
  const interEye = dist(pts[39], pts[42]); // inner eye corners
  const eyeSpan = dist(pts[36], pts[45]); // outer eye corners
  const noseWidth = dist(pts[31], pts[35]);
  const noseBridge = dist(pts[27], pts[33]);
  const mouthWidth = dist(pts[48], pts[54]);
  const mouthHeight = dist(
    midPoint(pts[50], pts[51], pts[52]),
    midPoint(pts[56], pts[57], pts[58]),
  );
  const jawWidth = dist(pts[3], pts[13]);
  const lEyeH = dist(midPoint(pts[37], pts[38]), midPoint(pts[40], pts[41]));
  const lEyeW = dist(pts[36], pts[39]);
  const rEyeH = dist(midPoint(pts[43], pts[44]), midPoint(pts[46], pts[47]));
  const rEyeW = dist(pts[42], pts[45]);
  const eyeAspect = (lEyeH / lEyeW + rEyeH / rEyeW) / 2;

  // Symmetry: compare left vs right half distances
  const lCheek = dist(pts[0], pts[8]);
  const rCheek = dist(pts[16], pts[8]);
  const symmetry = 1 - Math.abs(lCheek - rCheek) / Math.max(lCheek, rCheek);

  return {
    faceRatio: faceWidth / Math.max(faceHeight, 1),
    eyeSpanRatio: eyeSpan / Math.max(faceWidth, 1),
    interEyeRatio: interEye / Math.max(eyeSpan, 1),
    noseWidthRatio: noseWidth / Math.max(faceWidth, 1),
    noseBridgeRatio: noseBridge / Math.max(faceHeight, 1),
    mouthWidthRatio: mouthWidth / Math.max(faceWidth, 1),
    mouthOpenRatio: mouthHeight / Math.max(mouthWidth, 1),
    jawRatio: jawWidth / Math.max(faceWidth, 1),
    eyeAspect,
    symmetry,
  };
}

function midPoint(...pts) {
  // accepts array or multiple args
  const arr = pts.length === 1 ? pts[0] : pts;
  const x = arr.reduce((s, p) => s + p.x, 0) / arr.length;
  const y = arr.reduce((s, p) => s + p.y, 0) / arr.length;
  return { x, y };
}

function ratioSimilarity(a, b) {
  // 0–1, how close two ratios are (within ±50% of each other)
  const diff = Math.abs(a - b);
  const avg = (Math.abs(a) + Math.abs(b)) / 2 || 1;
  return Math.max(0, 1 - diff / avg);
}

function computeMetrics(resA, resB) {
  const ptsA = resA.landmarks.positions;
  const ptsB = resB.landmarks.positions;
  const rA = computeRatios(ptsA);
  const rB = computeRatios(ptsB);

  const metricDefs = [
    {
      key: "faceRatio",
      label: "Face Width / Height",
      fmt: (v) => v.toFixed(3),
    },
    {
      key: "eyeSpanRatio",
      label: "Eye Span / Face Width",
      fmt: (v) => v.toFixed(3),
    },
    {
      key: "interEyeRatio",
      label: "Inter-Eye / Eye Span",
      fmt: (v) => v.toFixed(3),
    },
    {
      key: "noseWidthRatio",
      label: "Nose Width / Face",
      fmt: (v) => v.toFixed(3),
    },
    {
      key: "noseBridgeRatio",
      label: "Nose Bridge / Face Height",
      fmt: (v) => v.toFixed(3),
    },
    {
      key: "mouthWidthRatio",
      label: "Mouth Width / Face",
      fmt: (v) => v.toFixed(3),
    },
    { key: "jawRatio", label: "Jaw Width / Face", fmt: (v) => v.toFixed(3) },
    { key: "eyeAspect", label: "Eye Aspect Ratio", fmt: (v) => v.toFixed(3) },
    {
      key: "symmetry",
      label: "Facial Symmetry",
      fmt: (v) => `${Math.round(v * 100)}%`,
    },
  ];

  const items = metricDefs.map((m) => {
    const sim = ratioSimilarity(rA[m.key], rB[m.key]);
    return {
      label: m.label,
      valA: m.fmt(rA[m.key]),
      valB: m.fmt(rB[m.key]),
      sim,
      simPct: Math.round(sim * 100),
    };
  });

  // Weights for overall score
  const weights = [2, 2, 1.5, 1.5, 1, 1.5, 1.5, 1, 2];
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const overall =
    items.reduce((acc, it, i) => acc + it.sim * weights[i], 0) / totalWeight;

  return {
    items,
    overall: Math.round(overall * 100),
    ratiosA: rA,
    ratiosB: rB,
  };
}

// ─── Render results ───────────────────────────────────────────────────
function renderResults(metrics, resA, resB) {
  // Score card
  const pct = metrics.overall;
  scoreValue.textContent = pct;
  scoreFill.style.width = `${pct}%`;

  let verdict, cls;
  if (pct >= 70) {
    verdict = "HIGH SIMILARITY";
    cls = "high";
  } else if (pct >= 45) {
    verdict = "MODERATE MATCH";
    cls = "medium";
  } else {
    verdict = "LOW SIMILARITY";
    cls = "low";
  }
  scoreVerdict.textContent = verdict;
  scoreVerdict.className = `score-verdict ${cls}`;

  // ── Resemblance card (descriptor-based) ──────────────────────────
  // Euclidean distance between 128-dim face descriptors; range ~0–1.4.
  // Convert to a 0–100% resemblance score: 0 distance = 100% match.
  if (resA.descriptor && resB.descriptor) {
    const euclidean = faceapi.euclideanDistance(
      resA.descriptor,
      resB.descriptor,
    );
    // Clamp to 0–1.4 range then invert: lower distance = higher resemblance
    const resPct = Math.round(Math.max(0, 1 - euclidean / 1.4) * 100);

    resemblanceValue.textContent = resPct;
    resemblanceFill.style.width = `${resPct}%`;

    let resBadgeText, resBadgeCls, resDescText;
    if (resPct >= 80) {
      resBadgeText = "NEAR IDENTICAL";
      resBadgeCls = "twin";
      resDescText =
        "The face descriptor vectors are extremely close. These faces share strong structural and textural resemblance — consistent with the same person or identical twins.";
    } else if (resPct >= 60) {
      resBadgeText = "STRONG LIKENESS";
      resBadgeCls = "strong";
      resDescText =
        "High descriptor similarity detected. The faces share notable feature resemblance — possibly related individuals, or strong visual similarity across different people.";
    } else if (resPct >= 40) {
      resBadgeText = "SOME SIMILARITY";
      resBadgeCls = "similar";
      resDescText =
        "Moderate descriptor overlap. The faces share some common features but are likely different individuals with coincidental similarities.";
    } else {
      resBadgeText = "DISTINCT FACES";
      resBadgeCls = "low";
      resDescText =
        "Low descriptor similarity. The neural feature vectors diverge significantly — these are most likely different individuals with little facial resemblance.";
    }

    resemblanceBadge.textContent = resBadgeText;
    resemblanceBadge.className = `resemblance-badge ${resBadgeCls}`;
    resemblanceDesc.textContent = resDescText;
  } else {
    // Descriptor unavailable — show fallback
    resemblanceValue.textContent = "N/A";
    resemblanceBadge.textContent = "MODEL UNAVAILABLE";
    resemblanceBadge.className = "resemblance-badge low";
    resemblanceDesc.textContent =
      "Face descriptor model did not return data. Check that faceRecognitionNet loaded successfully.";
  }

  // ── Share links ───────────────────────────────────────────────────
  const shareText = `I just compared two faces with FaceVersusFace — structural similarity ${pct}%, resemblance ${resemblanceValue.textContent}%. Try it yourself!`;
  const shareUrl = encodeURIComponent(window.location.href);
  const shareTxt = encodeURIComponent(shareText);
  shareX.href = `https://twitter.com/intent/tweet?text=${shareTxt}&url=${shareUrl}`;
  shareWa.href = `https://wa.me/?text=${shareTxt}%20${shareUrl}`;

  // Metrics cards
  metricsGrid.innerHTML = "";
  for (const m of metrics.items) {
    const qualCls =
      m.simPct >= 70 ? "good" : m.simPct >= 45 ? "medium" : "poor";
    metricsGrid.insertAdjacentHTML(
      "beforeend",
      `
      <div class="metric-card">
        <div class="metric-name">${m.label}</div>
        <div class="metric-vals">
          <span class="metric-a">${m.valA}</span>
          <span class="metric-sep">→</span>
          <span class="metric-b">${m.valB}</span>
        </div>
        <div class="metric-bar-wrap">
          <div class="metric-bar">
            <div class="metric-bar-fill ${qualCls}" style="width:${m.simPct}%"></div>
          </div>
          <span class="metric-sim mono">${m.simPct}%</span>
        </div>
      </div>
    `,
    );
  }

  // Expression comparison
  const expA = topExpressions(resA.expressions);
  const expB = topExpressions(resB.expressions);

  // Age/gender
  const agA = `${resA.gender ? resA.gender.charAt(0).toUpperCase() + resA.gender.slice(1) : "?"}, ~${Math.round(resA.age)} yr`;
  const agB = `${resB.gender ? resB.gender.charAt(0).toUpperCase() + resB.gender.slice(1) : "?"}, ~${Math.round(resB.age)} yr`;
  const sameGender = resA.gender === resB.gender;
  const ageDiff = Math.abs(Math.round(resA.age) - Math.round(resB.age));

  breakdown.innerHTML = `
    <h3>Analysis Summary</h3>
    <p>
      <span class="${verdictClass(pct)}">Overall structural similarity: ${pct}% (${verdict.toLowerCase()}).</span>
      The two faces share a ${pct >= 60 ? "notably similar" : pct >= 40 ? "moderately similar" : "quite different"}
      facial geometry based on 68-point landmark ratios.
    </p>
    <p>
      <strong>Demographics:</strong>
      Subject A estimated as <em>${agA}</em>;
      Subject B estimated as <em>${agB}</em>.
      ${sameGender ? "Both subjects appear to be the same gender." : "Subjects appear to be different genders."}
      Estimated age difference: ~${ageDiff} year${ageDiff !== 1 ? "s" : ""}.
    </p>
    <p>
      <strong>Dominant expressions:</strong>
      Subject A — ${expA};
      Subject B — ${expB}.
    </p>
    <p>
      <strong>Strongest matches:</strong>
      ${topMatches(metrics.items, 3)}.
    </p>
    <p>
      <strong>Greatest divergence:</strong>
      ${bottomMatches(metrics.items, 2)}.
    </p>
  `;
}

function verdictClass(pct) {
  return pct >= 70 ? "hi" : pct >= 45 ? "mid" : "lo";
}

function topExpressions(expr) {
  return Object.entries(expr)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k, v]) => `${k} (${Math.round(v * 100)}%)`)
    .join(", ");
}

function topMatches(items, n) {
  return [...items]
    .sort((a, b) => b.simPct - a.simPct)
    .slice(0, n)
    .map((m) => `${m.label} (${m.simPct}%)`)
    .join(", ");
}

function bottomMatches(items, n) {
  return [...items]
    .sort((a, b) => a.simPct - b.simPct)
    .slice(0, n)
    .map((m) => `${m.label} (${m.simPct}%)`)
    .join(", ");
}

// ─── Reset ────────────────────────────────────────────────────────────
$("resetBtn").addEventListener("click", () => {
  clearSide("A");
  document.getElementById("fileA").value = null;
  clearSide("B");
  document.getElementById("fileB").value = null;
  results.hidden = true;
  clearError();
  metricsGrid.innerHTML = "";
  breakdown.innerHTML = "";
  window.scrollTo({ top: 0, behavior: "smooth" });
});
