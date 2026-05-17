document.getElementById("btnPrint").addEventListener("click", async () => {
  const statusEl = document.getElementById("statusMsg");

  const config = {
    examTitle: document.getElementById("examTitle").value.trim(),
    subjectInfo: document.getElementById("subjectInfo").value.trim(),
    examTime: document.getElementById("examTime").value.trim(),
    showOMR: document.getElementById("showOMR").checked,
    showAnswers: document.getElementById("showAnswers").checked,
    twoColumns: document.getElementById("twoColumns").checked,
    showNumbers: document.getElementById("showNumbers").checked,
    paperSize: document.getElementById("paperSize").value,
  };

  statusEl.className = "status info";
  statusEl.textContent = "⏳ প্রশ্ন খোঁজা হচ্ছে...";

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab.url.includes("daricomma.com")) {
      statusEl.className = "status error";
      statusEl.textContent = "❌ daricomma.com এ যান, তারপর ক্লিক করুন।";
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractAndPrint,
      args: [config],
    });

    const result = results[0].result;

    if (result.success) {
      statusEl.className = "status success";
      statusEl.textContent = `✅ ${result.count}টি প্রশ্ন পাওয়া গেছে! প্রিন্ট উইন্ডো খুলছে...`;
    } else {
      statusEl.className = "status error";
      statusEl.textContent = "❌ " + result.message;
    }
  } catch (err) {
    statusEl.className = "status error";
    statusEl.textContent = "❌ সমস্যা হয়েছে: " + err.message;
  }
});

// ─── This function runs INSIDE the page context ───────────────────────────────
function extractAndPrint(config) {
  // ── Helper: convert a node to clean HTML with LaTeX restored ────────────────
  // Strategy: replace each MathJax span+script pair with \(...\) so MathJax 3
  // in the print window can re-render them fresh (fonts included).
  function cleanNode(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll("button").forEach((s) => s.remove());
    // Remove raw LaTeX scripts and assistive MathML (keep rendered .mjx-chtml spans)
    clone
      .querySelectorAll('script[type="math/tex"]')
      .forEach((s) => s.remove());
    clone.querySelectorAll(".MathJax_Preview").forEach((s) => s.remove());
    clone.querySelectorAll(".MJX_Assistive_MathML").forEach((s) => s.remove());
    return clone.innerHTML.trim();
  }

  // Collect MathJax 2 CSS from page stylesheets so print window can render correctly
  function getMathJaxCSS() {
    const sheets = [];
    for (const sheet of document.styleSheets) {
      try {
        const rules = sheet.cssRules || sheet.rules;
        if (!rules) continue;
        for (const rule of rules) {
          const txt = rule.cssText || "";
          if (
            txt.includes("mjx") ||
            txt.includes("MathJax") ||
            txt.includes("MJX")
          ) {
            sheets.push(txt);
          }
        }
      } catch (e) {
        /* cross-origin sheet, skip */
      }
    }
    return sheets.join("\n");
  }

  // ── Helper: find option rows inside a wrapper ─────────────────────────────
  // Strategy: look for elements that contain "ক." / "খ." / "A." / "B." etc.
  // We search ALL span/div children and pick those whose first text is a label.
  function findOptions(wrapper) {
    const options = [];

    // Pattern 1 – elements that have a leading "ক." / "A." label span followed by content
    // Both pages share the same pattern: a container div with two spans inside:
    //   <div class="sc-gouidz ..."><span>ক. </span><span>content</span></div>
    //   <div class="sc-hVyMPc ..."><span>ক. </span><span>content</span></div>
    // Since class names change, we match by structure: div > span:first-child whose
    // text matches an option label, followed by a sibling span with content.

    const labelPattern = /^(ক|খ|গ|ঘ|ঙ|A|B|C|D|E)[.)।\s]/;

    // Walk all divs inside the wrapper
    const candidates = wrapper.querySelectorAll("div");
    for (const div of candidates) {
      const spans = div.querySelectorAll(":scope > span");
      if (spans.length >= 2) {
        const labelText = spans[0].textContent.trim();
        if (labelPattern.test(labelText)) {
          const contentSpan = spans[1];
          const content = cleanNode(contentSpan);
          if (content) {
            options.push({ label: labelText, content });
          }
        }
      }
    }

    // Deduplicate: same label shouldn't appear twice (nested divs can cause doubles)
    const seen = new Set();
    return options.filter((o) => {
      if (seen.has(o.label)) return false;
      seen.add(o.label);
      return true;
    });
  }

  // ── 1. Find question containers ──────────────────────────────────────────
  const questionWrappers = document.querySelectorAll("[data-rbd-draggable-id]");

  if (!questionWrappers || questionWrappers.length === 0) {
    return {
      success: false,
      message: "কোনো প্রশ্ন খুঁজে পাওয়া যায়নি। প্রশ্নের পেইজে আছেন কি?",
    };
  }

  const questions = [];

  questionWrappers.forEach((wrapper, idx) => {
    try {
      // ── Question text ──────────────────────────────────────────────────
      // The question body lives inside .mantine-TypographyStylesProvider-root
      // which is stable across pages (it's a Mantine class, not styled-components)
      const qTextEl = wrapper.querySelector(
        ".mantine-TypographyStylesProvider-root",
      );
      let qHTML = "";
      if (qTextEl) {
        qHTML = cleanNode(qTextEl);
      }

      // ── Options ────────────────────────────────────────────────────────
      const options = findOptions(wrapper);

      questions.push({ index: idx + 1, qHTML, options, correctAnswer: null });
    } catch (e) {
      // Skip malformed question
    }
  });

  if (questions.length === 0) {
    return {
      success: false,
      message: "প্রশ্ন parse করতে পারিনি। পেজ ঠিকমতো লোড হয়েছে কি?",
    };
  }

  // ── 2. Build print HTML ──────────────────────────────────────────────────
  const paperSizes = {
    A4: { width: "210mm", height: "297mm", margin: "15mm 18mm" },
    letter: { width: "216mm", height: "279mm", margin: "18mm 20mm" },
    A5: { width: "148mm", height: "210mm", margin: "12mm 14mm" },
  };
  const paper = paperSizes[config.paperSize] || paperSizes.A4;

  const now = new Date();
  const dateStr = `${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()}`;

  // Build questions HTML
  let questionsHTML = "";
  questions.forEach((q) => {
    const numStr = config.showNumbers
      ? `<span class="q-num">${q.index}.</span>`
      : "";

    let optionsHTML = '<div class="options">';
    q.options.forEach((opt) => {
      optionsHTML += `
        <div class="option">
          <span class="opt-label">${opt.label}</span>
          <span class="opt-content">${opt.content}</span>
        </div>`;
    });
    optionsHTML += "</div>";

    questionsHTML += `
      <div class="question ${config.twoColumns ? "two-col-q" : ""}">
        <div class="q-text">${numStr} <span class="q-body">${q.qHTML}</span></div>
        ${optionsHTML}
      </div>`;
  });

  // ── Build OMR sheet ───────────────────────────────────────────────────────
  let omrHTML = "";
  if (config.showOMR) {
    // Detect option labels used (ক/খ/গ/ঘ  or  A/B/C/D)
    // Check first question's options to determine label style
    let optLabels = ["ক", "খ", "গ", "ঘ"];
    if (questions.length > 0 && questions[0].options.length > 0) {
      const firstLabel = questions[0].options[0].label
        .replace(/[.)।\s]/g, "")
        .trim();
      if (/^[A-D]$/.test(firstLabel)) {
        optLabels = ["A", "B", "C", "D"];
      }
    }
    // How many options does any question have (max across all questions, cap at 5)
    const maxOpts = Math.min(
      Math.max(...questions.map((q) => q.options.length), 4),
      5,
    );
    const labels = optLabels.slice(0, maxOpts);

    // Build bubble columns — 4 columns, questions go top-to-bottom
    const cols = 4;
    const totalRows = Math.ceil(questions.length / cols);
    let rows = "";
    for (let row = 0; row < totalRows; row++) {
      const cells = [];
      for (let col = 0; col < cols; col++) {
        const qIdx = col * totalRows + row;
        if (qIdx >= questions.length) {
          cells.push(`<div class="omr-cell"></div>`);
          continue;
        }
        const q = questions[qIdx];
        const bubbles = labels
          .map((lbl) => `<span class="bubble">${lbl}</span>`)
          .join("");
        cells.push(`<div class="omr-cell">
      <span class="omr-num">${q.index}.</span>
      <span class="omr-bubbles">${bubbles}</span>
    </div>`);
      }
      rows += `<div class="omr-row">${cells.join("")}</div>`;
    }

    omrHTML = `
      <div class="omr-section">
        <div class="omr-title">উত্তরপত্র (OMR)</div>
        <div class="omr-info">
          <span>নাম: ___________________________</span>
          <span>প্রাপ্ত নম্বর: ________________</span>
          <span>তারিখ: ___________</span>
        </div> 
        <div class="omr-grid">${rows}</div>
        <div class="omr-note">নির্দেশনা: সঠিক উত্তরের বৃত্তটি বলপয়েন্ট কলম দিয়ে ভরাট করুন।</div>
      </div>`;
  }

  // Build answer key
  let answerKeyHTML = "";
  if (config.showAnswers) {
    answerKeyHTML = `
      <div class="answer-key">
        <h3>উত্তরমালা</h3>
        <div class="answer-grid">
          ${questions
            .map(
              (q) =>
                `<div class="ans-item">
               <span class="ans-num">${q.index}.</span>
               <span class="ans-val">${q.correctAnswer || "—"}</span>
             </div>`,
            )
            .join("")}
        </div>
      </div>`;
  }

  const mjCss = getMathJaxCSS();

  const printHTML = `<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8">
  <title>${config.examTitle || "MCQ প্রশ্নপত্র"}</title>
  <style>
    @import url('https://fonts.maateen.me/kalpurush/font.css');

    * { margin: 0; padding: 0; box-sizing: border-box; }

    @page {
      size: ${config.paperSize};
      margin: ${paper.margin};
    }

    body {
      font-family: 'Kalpurush', 'SolaimanLipi', Arial, sans-serif;
      font-size: 13pt;
      color: #000;
      background: white;
      width: ${paper.width};
      margin: 0 auto;
      padding: ${paper.margin};
      
    }

    /* ── Header ──────────────────────────────────── */
    .exam-header {
      text-align: center;
      border-bottom: 2.5px double #000;
      padding-bottom: 10px;
      margin-bottom: 18px;
    }

    .exam-title {
      font-size: 18pt;
      font-weight: bold;
      margin-bottom: 4px;
    }

    .exam-subtitle {
      font-size: 11pt;
      color: #333;
      margin-bottom: 4px;
    }

    .exam-meta {
      font-size: 10pt;
      color: #555;
      display: flex;
      justify-content: space-between;
      margin-top: 6px;
    }

    /* ── Questions ───────────────────────────────── */
    .questions-container {
      ${config.twoColumns ? "columns: 2; column-gap: 18pt; column-rule: 1px solid #ccc;" : ""}
    }

    .question {
      margin-bottom: 14pt;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .q-text {
      font-size: 12pt;
      line-height: 1.5;
      margin-bottom: 5pt;
      display: flex;
      gap: 4pt;
    }

    .q-num {
      font-weight: bold;
      min-width: 22pt;
      flex-shrink: 0;
    }

    .q-body { flex: 1; }

    .q-body p { margin: 0; }

    .q-body img {
      max-width: 100%;
      max-height: 80pt;
      display: block;
      margin: 4pt 0;
    }

    /* ── Options ─────────────────────────────────── */
    .options {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 2pt 12pt;
      margin-left: 22pt;
      margin-top: 3pt;
    }

    .option {
      display: flex;
      gap: 4pt;
      font-size: 11.5pt;
      line-height: 1.4;
    }

    .opt-label {
      font-weight: bold;
      min-width: 18pt;
      flex-shrink: 0;
    }

    .opt-content { flex: 1; }
    .opt-content p { margin: 0; }

    /* ── MathJax 3 ───────────────────────────────── */
    mjx-container { display: inline !important; vertical-align: middle; }
    mjx-container[display="true"] { display: block !important; text-align: center; margin: 4pt 0; }
    .latex-inline { font-family: monospace; font-size: 0.1px; color: transparent; }

    /* ── OMR Sheet ───────────────────────────────── */
    .omr-section {
      margin-top: 20pt;
      border: 1.5px solid #000;
      border-radius: 4pt;
      padding: 10pt 12pt;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .omr-title {
      font-size: 13pt;
      font-weight: bold;
      text-align: center;
      border-bottom: 1px solid #555;
      padding-bottom: 6pt;
      margin-bottom: 8pt;
    }

    .omr-info {
      display: flex;
      justify-content: space-between;
      font-size: 10pt;
      margin-bottom: 10pt;
      border-bottom: 1px dashed #999;
      padding-bottom: 6pt;
    }

    .omr-grid { display: flex; flex-direction: column; gap: 5pt; }

    .omr-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 4pt;
    }

    .omr-cell {
      display: flex;
      align-items: center;
      gap: 4pt;
      font-size: 10pt;
    }

    .omr-num {
      font-weight: bold;
      min-width: 18pt;
      text-align: right;
      flex-shrink: 0;
    }

    .omr-bubbles { display: flex; gap: 3pt; }

    .bubble {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 12pt;
      height: 12pt;
      border: 1.5px solid #000;
      border-radius: 50%;
      font-size: 8pt;
      font-weight: bold;
    }

    .omr-note {
      font-size: 9pt;
      color: #555;
      margin-top: 8pt;
      text-align: center;
      border-top: 1px dashed #aaa;
      padding-top: 5pt;
    }

    /* ── Answer key ──────────────────────────────── */
    .answer-key {
      margin-top: 24pt;
      border-top: 2px solid #000;
      padding-top: 12pt;
      break-before: always;
      page-break-before: always;
    }

    .answer-key h3 {
      font-size: 14pt;
      text-align: center;
      margin-bottom: 12pt;
    }

    .answer-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(55pt, 1fr));
      gap: 4pt;
    }

    .ans-item {
      display: flex;
      gap: 4pt;
      font-size: 11pt;
    }

    .ans-num { font-weight: bold; }

    /* ── Print controls (hidden on print) ────────── */
    .print-controls {
      position: fixed;
      top: 12px;
      right: 12px;
      display: flex;
      gap: 8px;
      z-index: 9999;
    }

    .print-controls button {
      padding: 8px 16px;
      border: none;
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
      font-family: inherit;
    }

    .btn-do-print {
      background: #6366f1;
      color: white;
      font-weight: bold;
    }

    .btn-close {
      background: #e5e7eb;
      color: #374151;
    }

    @media print {
      .print-controls { display: none !important; }
      body { width: 100%; padding: 0; }
    }
  </style>

  <!-- MathJax 2 fonts from CDN (needed for matrix brackets, vector arrows etc) -->
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.9/fonts/HTML-CSS/TeX/woff/MathJax_Main-Regular.woff">
  <!-- MathJax 2 CSS extracted from daricomma page -->
  <style id="mjax-css">${mjCss}</style>
  <style>
    /* Ensure MathJax 2 rendered output displays correctly */
    .mjx-chtml { display: inline-block !important; vertical-align: middle; }
    .MathJax_CHTML { display: inline-block !important; white-space: nowrap; }
    /* Force MathJax fonts to load from CDN */
    @font-face { font-family: MJXc-TeX-main-R; src: url('https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.9/fonts/HTML-CSS/TeX/woff/MathJax_Main-Regular.woff') format('woff'); }
    @font-face { font-family: MJXc-TeX-math-I; src: url('https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.9/fonts/HTML-CSS/TeX/woff/MathJax_Math-Italic.woff') format('woff'); }
    @font-face { font-family: MJXc-TeX-size4-R; src: url('https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.9/fonts/HTML-CSS/TeX/woff/MathJax_Size4-Regular.woff') format('woff'); }
    @font-face { font-family: MJXc-TeX-size3-R; src: url('https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.9/fonts/HTML-CSS/TeX/woff/MathJax_Size3-Regular.woff') format('woff'); }
    @font-face { font-family: MJXc-TeX-size2-R; src: url('https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.9/fonts/HTML-CSS/TeX/woff/MathJax_Size2-Regular.woff') format('woff'); }
    @font-face { font-family: MJXc-TeX-size1-R; src: url('https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.9/fonts/HTML-CSS/TeX/woff/MathJax_Size1-Regular.woff') format('woff'); }
    @font-face { font-family: MJXc-TeX-main-B; src: url('https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.9/fonts/HTML-CSS/TeX/woff/MathJax_Main-Bold.woff') format('woff'); }
    @font-face { font-family: MJXc-TeX-vec-R; src: url('https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.9/fonts/HTML-CSS/TeX/woff/MathJax_Vector-Regular.woff') format('woff'); }
    @font-face { font-family: MJXc-TeX-ams-R; src: url('https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.9/fonts/HTML-CSS/TeX/woff/MathJax_AMS-Regular.woff') format('woff'); }
  </style>
</head>
<body>

  <div class="print-controls">
    <button class="btn-do-print" onclick="window.print()">🖨️ প্রিন্ট করুন</button>
    <button class="btn-close" onclick="window.close()">✕ বন্ধ করুন</button>
  </div>

  <div class="exam-header">
    <div class="exam-title">${config.examTitle || "MCQ প্রশ্নপত্র"}</div>
    ${config.subjectInfo ? `<div class="exam-subtitle">${config.subjectInfo}</div>` : ""}
    <div class="exam-meta">
      <span>মোট প্রশ্ন: ${questions.length}</span>
      <span>সময়: ${config.examTime || "________"}</span> 
      
      
      

    </div> 
  </div>

  <div class="questions-container">
    ${questionsHTML}
  </div>

  ${omrHTML}

  ${answerKeyHTML}

</body>
</html>`;

  // ── 3. Open print window via Blob URL (avoids document.write timing issues) ──
  const blob = new Blob([printHTML], { type: "text/html; charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const printWin = window.open(url, "_blank", "width=900,height=700");
  if (!printWin) {
    URL.revokeObjectURL(url);
    return {
      success: false,
      message: "Pop-up block করা আছে! Browser এ pop-up allow করুন।",
    };
  }
  // Revoke after window loads
  printWin.addEventListener("load", () => URL.revokeObjectURL(url));

  return { success: true, count: questions.length };
}
