/* =====================================================================
 * 漂移法赤道仪校准推演台 —— 前端逻辑（原生 JS + SVG，无第三方依赖）
 *
 * 几何约定（已用 Rodrigues 数值仿真标定，南北半球通用）：
 *   站心右手系 E(东) N(北) U(天)；方位角 A 北=0 东=90；时角 H 西为正。
 *   sinδ = sinφ·sin h + cosφ·cos h·cos A
 *   sinH = -cos h·sin A / cosδ
 *   cosH = (sin h·cosφ - cos h·sinφ·cos A) / cosδ
 *   极轴“方位东移 ΔA”“仰角抬高 Δh”各 1 角秒引起的赤纬漂移率：
 *     v_dec = ω·(-cosφ·cosH·ΔA - sinH·Δh)         [角秒/秒，正=向北]
 *   即子午线(H≈0)只暴露方位误差，东天(H<0)/西天(H>0)以相反符号暴露高度误差。
 * =================================================================== */
"use strict";

const OMEGA = 15.041068 / 206264.806;          // 恒星速率，rad/s
const KIND_LABEL = { meridian: "子午线段", east_low: "东低空段", west_low: "西低空段" };
const KIND_COLOR = { meridian: "#58a6ff", east_low: "#3fb950", west_low: "#d29922" };

const $ = (id) => document.getElementById(id);

/* ---------------- 纯计算函数（便于核对/单测） ---------------- */

const Calc = {
  // 由 A/h 与有符号纬度求 H、dec（弧度）
  hdOf(phiDeg, azDeg, altDeg) {
    const phi = (phiDeg * Math.PI) / 180;
    const A = (azDeg * Math.PI) / 180;
    const a = (altDeg * Math.PI) / 180;
    const sd = Math.max(-1, Math.min(1,
      Math.sin(phi) * Math.sin(a) + Math.cos(phi) * Math.cos(a) * Math.cos(A)));
    const dec = Math.asin(sd);
    const cd = Math.cos(dec);
    if (cd < 1e-9) return { H: 0, dec, cosH: 1, sinH: 0 };
    const sinH = (-Math.cos(a) * Math.sin(A)) / cd;
    const cosH = (Math.sin(a) * Math.cos(phi) - Math.cos(a) * Math.sin(phi) * Math.cos(A)) / cd;
    return { H: Math.atan2(Math.max(-1, Math.min(1, sinH)), Math.max(-1, Math.min(1, cosH))),
             dec, cosH: Math.max(-1, Math.min(1, cosH)), sinH: Math.max(-1, Math.min(1, sinH)) };
  },

  // 极轴每误差 1 角秒（方位东移 / 仰角抬高）造成的赤纬漂移率，单位 (角秒/秒)/角秒 = 1/秒
  // v_dec = ω·(-cosφ·cosH·ΔA - sinH·Δh)，ΔA、Δh 以角秒代入
  sensitivities(phiDeg, H) {
    const cphi = Math.cos(((phiDeg || 0) * Math.PI) / 180);
    return { kA: -cphi * Math.cos(H) * OMEGA, kh: -Math.sin(H) * OMEGA };
  },

  // 加权最小二乘 y = a + b x；x 毫秒，y 刻度
  linfit(pts) {
    const n = pts.length;
    if (n < 2) return null;
    let sx = 0, sy = 0;
    for (const p of pts) { sx += p.t; sy += p.tick; }
    const mx = sx / n, my = sy / n;
    let sxx = 0, sxy = 0;
    for (const p of pts) { sxx += (p.t - mx) ** 2; sxy += (p.t - mx) * (p.tick - my); }
    if (sxx === 0) return null;
    const b = sxy / sxx, a = my - b * mx;
    let resid = pts.map((p) => p.tick - (a + b * p.t));
    let sse = 0;
    for (const r of resid) sse += r * r;
    const se_b = n > 2 ? Math.sqrt(sse / (n - 2) / sxx) : 0;   // 斜率标准误（刻度/毫秒）
    return { a, b, se_b, resid, sse };
  },

  // 解二元一次方程 [m11 m12; m21 m22] x = [v1; v2]
  solve2(m11, m12, m21, m22, v1, v2) {
    const det = m11 * m22 - m12 * m21;
    if (Math.abs(det) < 1e-15) return null;
    return { x: (v1 * m22 - m12 * v2) / det, y: (m11 * v2 - v1 * m21) / det };
  },
};

/* ---------------- 全局状态 ---------------- */

const state = {
  list: [],            // 会话摘要
  bundle: null,        // 当前完整会话
  roundId: null,       // 当前轮次
  segKind: "meridian", // 当前测段种类
  busy: false,
};

async function api(method, path, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(path, opt);
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = { raw: txt }; }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

/* ---------------- 设置 ---------------- */

function readSettings() {
  const num = (v) => (v === "" || v === null || v === undefined || Number.isNaN(+v) ? null : +v);
  return {
    hemisphere: $("hemisphere").value,
    mountType: $("mountType").value,
    latitude: num($("latitude").value),
    azimuth: num($("azimuth").value),
    altitude: num($("altitude").value),
    declination: num($("declination").value),
    flip: $("flip").value,
    customRot: num($("customRot").value) ?? 0,
    scaleDir: $("scaleDir").value,
    arcsecPerTick: num($("arcsecPerTick").value),
  };
}

function applySettings(s) {
  s = s || {};
  $("hemisphere").value = s.hemisphere || "N";
  $("mountType").value = s.mountType || "GEM";
  $("latitude").value = s.latitude ?? "";
  $("azimuth").value = s.azimuth ?? "";
  $("altitude").value = s.altitude ?? "";
  $("declination").value = s.declination ?? "";
  $("flip").value = s.flip || "diag";
  $("customRot").value = s.customRot ?? 0;
  $("scaleDir").value = s.scaleDir || "N";
  $("arcsecPerTick").value = s.arcsecPerTick ?? "";
  onFlipChange();
}

let saveTimer = null;
function localSettingsChanged() {
  // 先同步到本地状态并立即重算（几何/角尺度/翻转的变化马上反映到图表与结论）
  if (state.bundle) {
    state.bundle.settings = readSettings();
    renderAll();
  } else {
    renderGeometryHint();
  }
  clearTimeout(saveTimer);
  if (!state.bundle) return;
  const snapshot = state.bundle.settings;
  saveTimer = setTimeout(async () => {
    try {
      await api("PATCH", `/api/sessions/${state.bundle.id}`, { settings: snapshot });
    } catch (e) { alert("设置保存失败：" + e.message); }
  }, 300);
}

/* ---------------- 会话/轮次/测段导航 ---------------- */

async function loadSessionList(selectId) {
  state.list = await api("GET", "/api/sessions");
  const sel = $("sessionSelect");
  sel.innerHTML = "";
  if (!state.list.length) {
    const o = document.createElement("option");
    o.textContent = "（暂无会话，点“新建会话”）";
    o.value = "";
    sel.appendChild(o);
    return;
  }
  for (const s of state.list) {
    const o = document.createElement("option");
    o.value = s.id;
    const d = new Date(s.updated_at);
    o.textContent = `${s.name} — 第${s.n_rounds}轮 · ${d.toLocaleString()}`;
    sel.appendChild(o);
  }
  if (selectId) sel.value = selectId;
}

async function loadBundle(id) {
  if (!id) { state.bundle = null; state.roundId = null; renderAll(); return; }
  state.bundle = await api("GET", `/api/sessions/${id}`);
  applySettings(state.bundle.settings);
  const rounds = state.bundle.rounds;
  state.roundId = rounds.length ? rounds[rounds.length - 1].id : null;
  renderAll();
}

async function refreshBundle(render = true) {
  if (!state.bundle) return;
  const id = state.bundle.id, rid = state.roundId;
  state.bundle = await api("GET", `/api/sessions/${id}`);
  if (rid && state.bundle.rounds.some((r) => r.id === rid)) state.roundId = rid;
  else state.roundId = state.bundle.rounds.length ? state.bundle.rounds[state.bundle.rounds.length - 1].id : null;
  if (render) renderAll();
}

async function createSession() {
  const s = readSettings();
  const b = await api("POST", "/api/sessions", {
    name: `校准 ${new Date().toLocaleString()}`,
    settings: s,
  });
  await loadSessionList(b.id);
  await loadBundle(b.id);
}

async function createRound() {
  if (!state.bundle) await createSession();
  const seq = state.bundle.rounds.length + 1;
  const r = await api("POST", `/api/sessions/${state.bundle.id}/rounds`, { seq, note: "" });
  await refreshBundle(false);
  state.roundId = r.id;
  renderAll();
}

function currentRound() {
  return state.bundle && state.bundle.rounds.find((r) => r.id === state.roundId) || null;
}

function findSegment(round, kind) {
  return round.segments.filter((g) => g.kind === kind).sort(
    (a, b2) => a.created_at - b2.created_at).slice(-1)[0] || null;
}

// 写入测段快照的字段：这些是“目标在天空中的位置”，随测段固定
const GEO_KEYS = ["hemisphere", "mountType", "latitude", "azimuth", "altitude", "declination"];
function geoSnapshot(s) {
  s = s || readSettings();
  const out = {};
  for (const k of GEO_KEYS) out[k] = s[k];
  return out;
}
// 测段生效设置 = 会话级测量变换（翻转/刻度方向/角尺度）+ 该测段自己的几何快照
function segmentSettings(seg, s) {
  const merged = { ...s };
  const snap = (seg && seg.snapshot) || {};
  for (const k of GEO_KEYS) if (snap[k] !== undefined && snap[k] !== null) merged[k] = snap[k];
  return merged;
}

async function ensureRoundAndSegment(kind) {
  if (!state.bundle) await createSession();
  let round = currentRound();
  if (!round) {
    await createRound();
    round = currentRound();
  }
  let seg = findSegment(round, kind);
  if (!seg) {
    const g = await api("POST", `/api/rounds/${round.id}/segments`,
      { kind, snapshot: geoSnapshot() });
    await refreshBundle(false);
    round = currentRound();
    seg = round.segments.find((x) => x.id === g.id);
  }
  return seg;
}

/* ---------------- 打点 ---------------- */

async function markPoint() {
  if (state.busy) return;
  state.busy = true;
  try {
    const kind = $("segKind").value;
    state.segKind = kind;
    const seg = await ensureRoundAndSegment(kind);
    // 测段尚无点时，允许用表单里最新的位置修正本段几何；一旦有点，快照即冻结
    if (!seg.points.length) {
      await api("PATCH", `/api/segments/${seg.id}`, { snapshot: geoSnapshot() });
    }
    const raw = $("tickInput").value;
    const tick = raw === "" ? 0 : +raw;
    await api("POST", `/api/segments/${seg.id}/points`, {
      t: Date.now(),
      tick,
      direction: +$("dirInput").value,
      note: raw === "" ? "时刻点（刻度待补）" : "",
    });
    $("tickInput").value = "";
    $("tickInput").focus();
    await refreshBundle();
  } catch (e) {
    alert("打点失败：" + e.message);
  } finally { state.busy = false; }
}

async function undoPoint() {
  const seg = currentSegment();
  if (!seg || !seg.points.length) return;
  const p = seg.points[seg.points.length - 1];
  await api("DELETE", `/api/points/${p.id}`);
  await refreshBundle();
}

async function clearSegmentPoints() {
  const seg = currentSegment();
  if (!seg || !seg.points.length) return;
  if (!confirm(`清空${KIND_LABEL[seg.kind]}全部 ${seg.points.length} 个打点？`)) return;
  for (const p of [...seg.points]) await api("DELETE", `/api/points/${p.id}`);
  await refreshBundle();
}

async function toggleLock() {
  const seg = currentSegment();
  if (!seg) return;
  await api("PATCH", `/api/segments/${seg.id}`, { locked: !seg.locked });
  await refreshBundle();
}

function currentSegment() {
  const round = currentRound();
  return round ? findSegment(round, state.segKind) : null;
}

/* ---------------- 单测段分析 ---------------- */

function analyzeSegment(seg, sessionSettings) {
  // 会话级测量变换（角尺度/翻转/刻度方向）实时生效；几何取测段快照
  const settings = segmentSettings(seg, sessionSettings);
  const out = {
    seg, settings, warnings: [], refusals: [], good: [],
    n: 0, duration_s: 0, fit: null,
    slope_tick_min: null, slope_as_s: null, se_as_s: null, se_tick_min: null,
    decRate_as_s: null, decSign: null, geo: null, outlierIdx: new Set(),
    geomOk: false, directionUsable: false, usable: false, quantifiable: false,
    snapshotMismatch: false,
  };
  const pts = seg.points.filter((p) => !p.excluded);
  out.n = pts.length;
  if (pts.length >= 2)
    out.duration_s = (pts[pts.length - 1].t - pts[0].t) / 1000;

  // 表单当前几何与测段快照不一致时提示（旧测段不被新位置污染）
  if (seg.points.length && seg.snapshot && sessionSettings) {
    for (const k of ["hemisphere", "azimuth", "altitude", "latitude"]) {
      const a = sessionSettings[k], b = seg.snapshot[k];
      if (a !== null && a !== undefined && b !== null && b !== undefined &&
          (k === "hemisphere" ? a !== b : Math.abs((a || 0) - (b || 0)) > 1e-9)) {
        out.snapshotMismatch = true; break;
      }
    }
  }

  // —— 几何适宜性（用测段快照）——
  if (settings.azimuth === null || settings.altitude === null) {
    out.refusals.push("该测段缺少目标方位角/高度角，无法把漂移换算到赤纬方向。");
  } else {
    const phi = settings.hemisphere === "S"
      ? -(settings.latitude ?? 0) : (settings.latitude ?? 0);
    const g = Calc.hdOf(phi, settings.azimuth, settings.altitude);
    out.geo = g;
    out.geomOk = true;
    const Hdeg = g.H * 180 / Math.PI, decdeg = g.dec * 180 / Math.PI;

    if (settings.altitude < 10) out.refusals.push(`目标高度仅 ${settings.altitude}°，大气折射严重，结果不可信。`);
    else if (settings.altitude < 20) out.warnings.push(`高度 ${settings.altitude}° 偏低，折射不确定，建议 >25°。`);
    if (Math.abs(decdeg) > 72) out.warnings.push(`目标赤纬 |δ|≈${Math.abs(decdeg).toFixed(0)}° 靠近天极，周日运动慢、不灵敏。`);
    if (settings.declination !== null && Math.abs(settings.declination - decdeg) > 3)
      out.warnings.push(`填写的赤纬 ${settings.declination}° 与由方位/高度推算的 δ=${decdeg.toFixed(1)}° 不一致，请核对。`);

    if (seg.kind === "meridian") {
      if (Math.abs(Hdeg) > 45) out.refusals.push(`该目标时角 |H|=${Math.abs(Hdeg).toFixed(0)}°，已远离子午线，不能作为子午线段。`);
      else if (Math.abs(Hdeg) > 25) out.warnings.push(`离子午线 ${Math.abs(Hdeg).toFixed(0)}°，方位轴灵敏度降为 cosH=${g.cosH.toFixed(2)}。`);
      if (settings.altitude > 85) out.warnings.push("高度接近天顶，十字线方向难以判读。");
    } else {
      const sinAbs = Math.abs(g.sinH);
      if (settings.altitude > 45) out.warnings.push(`${KIND_LABEL[seg.kind]}目标高度 ${settings.altitude}° 偏高，典型漂移法低空段取 15–40°。`);
      if (sinAbs < 0.45) out.refusals.push(`|sin H|=${sinAbs.toFixed(2)} 太小，高度轴几乎不产生可测漂移，请用更靠近东/西点的星。`);
      else if (sinAbs < 0.7) out.warnings.push(`|sin H|=${sinAbs.toFixed(2)}，高度轴灵敏度一般。`);
      if (seg.kind === "east_low" && Hdeg > 0)
        out.warnings.push("时角 H>0（星在子午线以西），与“东低空段”标注不符。");
      if (seg.kind === "west_low" && Hdeg < 0)
        out.warnings.push("时角 H<0（星在子午线以东），与“西低空段”标注不符。");
    }
    if (settings.mountType === "GEM" && seg.kind === "meridian")
      out.good.push("德式赤道仪中天附近可能需要翻转，翻转前后的数据不要并入同一直线。");
  }

  if (out.n < 2) {
    out.refusals.push(out.n === 0 ? "尚无打点。" : "只有 1 个点，至少需要 2 点才能得到斜率。");
    return out;
  }

  const fit = Calc.linfit(pts);
  out.fit = fit;
  out.slope_tick_min = fit.b * 60000;                 // 刻度/分钟
  out.se_tick_min = fit.se_b * 60000;
  const dirSign = settings.scaleDir === "S" ? -1 : +1; // 刻度增大端指向真实南/北
  const sc = settings.arcsecPerTick;
  if (sc !== null && sc > 0) {
    out.slope_as_s = fit.b * 1000 * sc;               // 角秒/秒（沿刻度增大方向）
    out.se_as_s = fit.se_b * 1000 * sc;
    out.decRate_as_s = out.slope_as_s * dirSign;      // 赤纬方向：正=向北
  }
  // 没有角尺度也给出赤纬漂移的符号（刻度斜率 × 刻度端指向）
  out.decSign = out.slope_tick_min === 0 ? 0 : Math.sign(out.slope_tick_min * dirSign);

  if (out.duration_s < 15) out.refusals.push(`测段仅 ${out.duration_s.toFixed(0)} 秒，时长不足。`);
  else if (out.duration_s < 45) out.warnings.push(`测段 ${out.duration_s.toFixed(0)} 秒偏短，建议 ≥60 秒。`);
  if (out.n < 4) out.warnings.push(`仅 ${out.n} 点，建议 4 点以上以便识别异常点。`);

  const dirs = new Set(pts.map((p) => p.direction));
  if (dirs.size > 1)
    out.warnings.push("同一测段出现两个越过方向：可能碰到赤纬微动、存在回程间隙或混入了不同穿越。");

  if (out.n >= 4) {
    const half = Math.floor(out.n / 2);
    const f1 = Calc.linfit(pts.slice(0, half + 1));
    const f2 = Calc.linfit(pts.slice(half));
    if (f1 && f2 && f1.b * f2.b < 0 && Math.abs(f1.b - f2.b) > 3 * Math.abs(fit.se_b))
      out.warnings.push("测段前后半斜率符号相反：疑似中途拧过调节钮、回程间隙或记录中断。");
  }

  if (out.n >= 5) {
    const absr = fit.resid.map(Math.abs).sort((x, y) => x - y);
    const mad = absr[Math.floor(absr.length / 2)] || 0;
    const sigma = 1.4826 * mad;
    if (sigma > 0) {
      fit.resid.forEach((r, i) => {
        if (Math.abs(r) > 3.5 * sigma) out.outlierIdx.add(pts[i].id);
      });
      if (out.outlierIdx.size)
        out.warnings.push(`${out.outlierIdx.size} 个打点残差异常（>3.5σ），可在表格中排除后重算。`);
    }
  }

  // 方向是否可信：几何通过、时长够、斜率相对其不确定度显著
  const slopeMag = Math.abs(out.slope_tick_min);
  const slopeSig = out.n < 3 || slopeMag > 1.5 * Math.abs(out.se_tick_min);
  if (!slopeSig)
    out.warnings.push("斜率与拟合噪声相当，漂移方向尚不能确定，建议延长观测或加打点。");
  out.directionUsable = out.geomOk && out.duration_s >= 15 && out.decSign !== 0 && slopeSig;

  out.usable = out.directionUsable && out.refusals.length === 0;
  out.quantifiable = out.usable && out.decRate_as_s !== null && settings.latitude !== null;

  const dirTxt = out.decSign > 0 ? "向北" : "向南";
  const rateTxt = out.decRate_as_s === null
    ? "未填角尺度，仅给出漂移方向。"
    : `赤纬漂移${dirTxt} ${Math.abs(out.decRate_as_s).toFixed(4)} 角秒/秒。`;
  if (out.usable)
    out.good.push(`拟合斜率 ${out.slope_tick_min >= 0 ? "+" : ""}${out.slope_tick_min.toFixed(3)} 格/分；${rateTxt}`);
  return out;
}

/* ---------------- 轮次级联立解算 ---------------- */

function analyzeRound(round, sessionSettings) {
  const segs = round.segments.map((g) => analyzeSegment(g, sessionSettings));
  // 锁定优先；数值段优先于仅方向段
  const pick = (kind) => {
    const cand = segs.filter((x) => x.seg.kind === kind && x.usable);
    const locked = cand.filter((x) => x.seg.locked);
    const pool = locked.length ? locked : cand;
    pool.sort((a, b) => (b.quantifiable - a.quantifiable) || (b.n - a.n));
    return pool[0] || null;
  };
  const mer = pick("meridian"), east = pick("east_low"), west = pick("west_low");
  const res = {
    segs, mer, east, west,
    dA: null, dh: null, dA_se: null, dh_se: null,
    azSignOnly: false, altSignOnly: false,
    azCorrection: null, altCorrection: null,
    assumptions: [], contradictions: [],
  };
  const kOf = (a) => {
    const lat = a.settings.latitude ?? 0;
    const cphi = Math.cos((lat * Math.PI) / 180);
    return { kA: -cphi * a.geo.cosH * OMEGA, kh: -a.geo.sinH * OMEGA };
  };

  // 数值解：子午线 → ΔA
  if (mer && mer.quantifiable) {
    const { kA } = kOf(mer);
    res.dA = mer.decRate_as_s / kA;
    res.dA_se = mer.se_as_s / Math.abs(kA);
  }
  // 数值解：东低空，在已知 ΔA 基础上扣除方位项
  const sideNumeric = {};
  for (const [name, g] of [["east", east], ["west", west]]) {
    if (!g || !g.quantifiable) continue;
    const k = kOf(g);
    let dh = null, se = g.se_as_s / Math.abs(k.kh);
    if (res.dA !== null) {
      dh = (g.decRate_as_s - k.kA * res.dA) / k.kh;
      se = Math.sqrt((g.se_as_s / Math.abs(k.kh)) ** 2 +
        ((k.kA / k.kh) * (res.dA_se || 0)) ** 2);
    }
    sideNumeric[name] = { dh, se, g };
  }
  if (sideNumeric.east && sideNumeric.east.dh !== null) {
    res.dh = sideNumeric.east.dh; res.dh_se = sideNumeric.east.se;
  }
  if (sideNumeric.west && sideNumeric.west.dh !== null) {
    const w = sideNumeric.west;
    if (res.dh === null) { res.dh = w.dh; res.dh_se = w.se; }
    else {
      const e = sideNumeric.east;
      if (Math.sign(res.dh) !== Math.sign(w.dh) &&
          Math.abs(res.dh) > 2 * res.dh_se && Math.abs(w.dh) > 2 * w.se)
        res.contradictions.push("东、西低空推出的高度误差符号相反，请检查翻转/刻度方向或测段可信度，勿按单段调整。");
      else {
        const w1 = 1 / (res.dh_se ** 2), w2 = 1 / (w.se ** 2);
        res.dh = (res.dh * w1 + w.dh * w2) / (w1 + w2);
        res.dh_se = 1 / Math.sqrt(w1 + w2);
      }
    }
  }

  // 数值解：无子午线，东西低空联立
  if (res.dA === null && east && west && east.quantifiable && west.quantifiable) {
    const ke = kOf(east), kw = kOf(west);
    const sol = Calc.solve2(ke.kA, ke.kh, kw.kA, kw.kh,
      east.decRate_as_s, west.decRate_as_s);
    if (sol) {
      res.dA = sol.x; res.dh = sol.y;
      res.assumptions.push("无子午线段：方位/高度由东、西低空两段联立求出；两段不对称时误差较大。");
    }
  }

  // —— 仅方向（符号）回退 ——
  // 子午线：sinH≈0 高度项可忽略，v 与 ΔA 反号（kA<0），修正方向与 v 同向
  if (res.dA === null && mer && mer.usable) {
    res.azSignOnly = true;
    res.dA_sign = mer.decSign;
    // 记录方向量以便 UI：观测到北漂(+)→极轴偏西→向东拧
    res.azCorrection = mer.decSign > 0 ? "east" : "west";
    res.assumptions.push("子午线方向由漂移符号直接判读（高度项在 H≈0 时≈0），未标定角尺度故不给量。");
  }
  // 单低空段（方位轴已校准的前提下）给高度方向
  const altFromSign = (g) => {
    if (!g || !g.usable) return null;
    // 东天 kh>0：北漂→偏高→降低；西天 kh<0：北漂→偏低→抬高
    const corr = g.geo.sinH < 0 ? (g.decSign > 0 ? "down" : "up")
                               : (g.decSign > 0 ? "up" : "down");
    return corr;
  };
  if (res.dh === null && res.altCorrection === null) {
    const ce = altFromSign(east), cw = altFromSign(west);
    if (ce && cw) {
      if (ce === cw) res.altCorrection = ce;
      else res.contradictions.push("东、西低空的漂移符号给出相反的高度调整方向，无法仅靠方向定夺，请加角尺度或复测。");
      res.altSignOnly = true;
      res.assumptions.push("无子午线数值结果：高度方向假设方位轴已先行校准；若方位未校，低空漂移含方位成分。");
    } else if (ce || cw) {
      res.altCorrection = ce || cw;
      res.altSignOnly = true;
      res.assumptions.push(`${ce ? "仅东" : "仅西"}低空段给出高度方向，前提是方位轴已校准；未标定角尺度故不给量。`);
    }
  }

  // 数值结果的修正方向（与现有极轴误差反向）
  if (res.dA !== null) res.azCorrection = res.dA > 0 ? "west" : "east";
  if (res.dh !== null) res.altCorrection = res.dh > 0 ? "down" : "up";
  if (!sessionSettings || sessionSettings.latitude === null)
    res.assumptions.push("未填纬度：只给方向，不估算调整角秒数。");
  return res;
}

/* ---------------- 渲染：几何提示 ---------------- */

function renderGeometryHint() {
  const s = state.bundle ? state.bundle.settings : readSettings();
  $("customRot").disabled = s.flip !== "custom";
  const el = $("geometryHint");
  if (s.azimuth === null || s.altitude === null) {
    el.innerHTML = "填写目标方位角与高度角后，将自动推算时角 H、赤纬 δ 并判断该目标是否适合当前测段。";
    return;
  }
  const phi = s.hemisphere === "S" ? -(s.latitude ?? 0) : (s.latitude ?? 0);
  const g = Calc.hdOf(phi, s.azimuth, s.altitude);
  const Hdeg = g.H * 180 / Math.PI, ddeg = g.dec * 180 / Math.PI;
  let side = "子午线附近";
  if (Hdeg < -10) side = "子午线以东（星升起一侧）";
  if (Hdeg > 10) side = "子午线以西（星下落一侧）";
  el.innerHTML = `推算：时角 H = <b>${Hdeg.toFixed(1)}°</b>，赤纬 δ = <b>${ddeg.toFixed(1)}°</b>，目标在${side}。` +
    (s.latitude === null ? "（未填纬度，以下只能给方向不能给调整量）" : "");
}

/* ---------------- 渲染：打点表 ---------------- */

function renderPointsTable() {
  const tb = $("ptsTable").querySelector("tbody");
  tb.innerHTML = "";
  const seg = currentSegment();
  if (!seg) {
    tb.innerHTML = `<tr><td colspan="6" class="hint">当前轮次还没有${KIND_LABEL[state.segKind]}，打点时自动创建。</td></tr>`;
    return;
  }
  seg.points.forEach((p, i) => {
    const tr = document.createElement("tr");
    if (p.excluded) tr.className = "excluded";
    const t = new Date(p.t);
    tr.innerHTML =
      `<td>${i + 1}</td>` +
      `<td>${t.toLocaleTimeString()}<span class="hint">.${String(t.getMilliseconds()).padStart(3, "0")}</span></td>` +
      `<td><input type="number" step="any" value="${p.tick}" data-id="${p.id}" class="tick-edit"></td>` +
      `<td>${p.direction > 0 ? "＋向" : "－向"}</td>` +
      `<td>${p.excluded ? "已排除" : (seg.locked ? "🔒 已锁定测段" : "在用")}${p.note ? `<br><span class="hint">${p.note}</span>` : ""}</td>` +
      `<td><button data-id="${p.id}" class="ex-btn">${p.excluded ? "恢复" : "排除"}</button>` +
      `<button data-id="${p.id}" class="del-btn">删</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll(".tick-edit").forEach((inp) => {
    inp.addEventListener("change", async () => {
      await api("PATCH", `/api/points/${inp.dataset.id}`, { tick: +inp.value, note: "" });
      await refreshBundle();
    });
  });
  tb.querySelectorAll(".ex-btn").forEach((b) => b.addEventListener("click", async () => {
    const p = seg.points.find((x) => x.id === b.dataset.id);
    await api("PATCH", `/api/points/${p.id}`, { excluded: !p.excluded });
    await refreshBundle();
  }));
  tb.querySelectorAll(".del-btn").forEach((b) => b.addEventListener("click", async () => {
    await api("DELETE", `/api/points/${b.dataset.id}`);
    await refreshBundle();
  }));
}

/* ---------------- 渲染：轨迹图 ---------------- */

function renderChart(analyses) {
  const svg = $("chart");
  const W = 640, Hh = 300, pad = { l: 52, r: 14, t: 16, b: 34 };
  svg.innerHTML = "";
  if (!state.bundle) {
    svg.innerHTML = `<text x="${W / 2}" y="${Hh / 2}" fill="#93a1b0" text-anchor="middle">新建会话并打点后绘制轨迹</text>`;
    $("chartLegend").innerHTML = "";
    return;
  }
  const sets = analyses.filter((a) => a.n >= 1);
  const s = state.bundle.settings;
  $("driftUnit").textContent = s.arcsecPerTick ? "角秒（按每格角秒换算）" : "刻度";
  if (!sets.length) {
    svg.innerHTML = `<text x="${W / 2}" y="${Hh / 2}" fill="#93a1b0" text-anchor="middle">打点后在此绘制漂移轨迹</text>`;
    $("chartLegend").innerHTML = "";
    return;
  }
  let t0 = Infinity, t1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const series = sets.map((a) => {
    const scale = s.arcsecPerTick || 1;
    const pts = a.seg.points.map((p) => ({
      x: p.t,
      y: p.tick * scale * (s.scaleDir === "S" ? -1 : 1),
      ex: p.excluded, id: p.id,
    }));
    pts.forEach((p) => {
      if (!p.ex) { t0 = Math.min(t0, p.x); t1 = Math.max(t1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    });
    return { a, pts };
  });
  if (!isFinite(t0)) { t0 = Date.now() - 60000; t1 = Date.now(); y0 = -1; y1 = 1; }
  if (t0 === t1) { t0 -= 30000; t1 += 30000; }
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const ypad = (y1 - y0) * 0.12 || 1;
  y0 -= ypad; y1 += ypad;
  const X = (t) => pad.l + (t - t0) / (t1 - t0) * (W - pad.l - pad.r);
  const Y = (v) => Hh - pad.b - (v - y0) / (y1 - y0) * (Hh - pad.t - pad.b);
  const ns = "http://www.w3.org/2000/svg";
  const el = (tag, attrs) => {
    const e = document.createElementNS(ns, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };
  // 轴
  svg.appendChild(el("line", { x1: pad.l, y1: Y(0), x2: W - pad.r, y2: Y(0), stroke: "#3a4757", "stroke-dasharray": "3 3" }));
  svg.appendChild(el("line", { x1: pad.l, y1: pad.t, x2: pad.l, y2: Hh - pad.b, stroke: "#3a4757" }));
  svg.appendChild(el("line", { x1: pad.l, y1: Hh - pad.b, x2: W - pad.r, y2: Hh - pad.b, stroke: "#3a4757" }));
  for (let i = 0; i <= 4; i++) {
    const tt = t0 + (t1 - t0) * i / 4;
    const x = X(tt);
    svg.appendChild(el("text", { x, y: Hh - pad.b + 16, fill: "#93a1b0", "font-size": 10, "text-anchor": "middle" }))
      .textContent = `${((tt - t0) / 1000).toFixed(0)}s`;
  }
  for (let i = 0; i <= 4; i++) {
    const vv = y0 + (y1 - y0) * i / 4;
    svg.appendChild(el("text", { x: pad.l - 6, y: Y(vv) + 3, fill: "#93a1b0", "font-size": 10, "text-anchor": "end" }))
      .textContent = vv.toFixed(1);
  }
  svg.appendChild(el("text", { x: 14, y: pad.t + 4, fill: "#93a1b0", "font-size": 11 }))
    .textContent = s.arcsecPerTick ? "角秒" : "刻度";
  svg.appendChild(el("text", { x: W - pad.r, y: Hh - 6, fill: "#93a1b0", "font-size": 11, "text-anchor": "end" }))
    .textContent = "时间 →";

  for (const { a, pts } of series) {
    const col = KIND_COLOR[a.seg.kind];
    const used = pts.filter((p) => !p.ex);
    if (used.length >= 2 && a.fit) {
      const scale = s.arcsecPerTick || 1;
      const ds = s.scaleDir === "S" ? -1 : 1;
      const xA = X(used[0].x), xB = X(used[used.length - 1].x);
      const yA = Y((a.fit.a + a.fit.b * used[0].x) * scale * ds);
      const yB = Y((a.fit.a + a.fit.b * used[used.length - 1].x) * scale * ds);
      svg.appendChild(el("line", { x1: xA, y1: yA, x2: xB, y2: yB, stroke: col, "stroke-width": a.seg.locked ? 2.4 : 1.6, opacity: 0.9 }));
    }
    for (const p of pts) {
      svg.appendChild(el("circle", {
        cx: X(p.x), cy: Y(p.y), r: a.outlierIdx.has(p.id) ? 6 : 3.6,
        fill: p.ex ? "#556070" : col,
        stroke: a.outlierIdx.has(p.id) ? "#f85149" : "none", "stroke-width": 2,
        opacity: p.ex ? 0.5 : 1,
      }));
    }
  }
  $("chartLegend").innerHTML = Object.keys(KIND_LABEL).map((k) =>
    `<span><i style="background:${KIND_COLOR[k]}"></i>${KIND_LABEL[k]}</span>`).join("") +
    `<span><i style="background:#f85149"></i>红圈=疑似异常点</span><span>灰点=已排除</span>`;
}

/* ---------------- 渲染：视场示意 ---------------- */

function renderFov(analyses) {
  const svg = $("fov");
  const ns = "http://www.w3.org/2000/svg";
  const C = 150, R = 120;
  svg.innerHTML = "";
  if (!state.bundle) {
    const t0 = document.createElementNS(ns, "text");
    t0.setAttribute("x", C); t0.setAttribute("y", C); t0.setAttribute("fill", "#93a1b0");
    t0.setAttribute("text-anchor", "middle"); t0.textContent = "新建会话后显示视场方向";
    svg.appendChild(t0);
    $("fovHint").textContent = "新建会话并填写翻转方式后，这里画出十字线与真实北/东、漂移方向。";
    return;
  }
  const s = state.bundle.settings;
  const el = (tag, attrs, txt) => {
    const e = document.createElementNS(ns, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (txt !== undefined) e.textContent = txt;
    return e;
  };
  // 屏幕基：无翻转时 北↑ 东→
  let N = [0, -1], E = [1, 0];
  const flipMap = {
    none:     [[0, -1], [1, 0]],
    diag:     [[0, 1], [1, 0]],   // 天顶镜：上下翻转
    mirror:   [[0, -1], [-1, 0]], // 反射：左右翻转
    rotate180:[[0, 1], [-1, 0]],
  };
  let n0, e0;
  if (s.flip === "custom") {
    [n0, e0] = [[0, -1], [1, 0]];
  } else [n0, e0] = flipMap[s.flip] || flipMap.none;
  const rot = ((s.flip === "custom" ? s.customRot : 0) * Math.PI) / 180;
  const rotPt = ([x, y]) => [x * Math.cos(rot) + y * Math.sin(rot), -x * Math.sin(rot) + y * Math.cos(rot)];
  N = rotPt(n0); E = rotPt(e0);
  const P = (v) => [C + v[0] * R, C + v[1] * R];

  svg.appendChild(el("circle", { cx: C, cy: C, r: R, fill: "#05080c", stroke: "#2c3a4a" }));
  svg.appendChild(el("line", { x1: C - R, y1: C, x2: C + R, y2: C, stroke: "#3a4757" }));
  svg.appendChild(el("line", { x1: C, y1: C - R, x2: C, y2: C + R, stroke: "#3a4757" }));
  // 方向标签
  const neg = (v) => [-v[0], -v[1]];
  const labels = [[N, "N 北"], [E, "E 东"], [neg(N), "S 南"], [neg(E), "W 西"]];
  for (const [v, t] of labels) {
    const [x, y] = P(v);
    svg.appendChild(el("text", { x, y: y + 3, fill: "#9fb4c8", "font-size": 11, "text-anchor": "middle" }, t));
  }
  // 恒星周日运动方向（向西，白色虚线箭头）
  const wv = [-E[0] * 0.62, -E[1] * 0.62];
  svg.appendChild(el("line", {
    x1: C - wv[0] * R * 0.5, y1: C - wv[1] * R * 0.5,
    x2: C + wv[0] * R * 0.5, y2: C + wv[1] * R * 0.5,
    stroke: "#c9d4e0", "stroke-width": 1.4, "stroke-dasharray": "5 4",
    "marker-end": "url(#arrowW)",
  }));
  const defs = el("defs", {});
  defs.innerHTML = `<marker id="arrowW" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
    <path d="M0,0 L6,3 L0,6 Z" fill="#c9d4e0"/></marker>
    <marker id="arrowD" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
    <path d="M0,0 L6,3 L0,6 Z" fill="#f85149"/></marker>`;
  svg.appendChild(defs);
  svg.appendChild(el("text", { x: C, y: C + R + 16, fill: "#93a1b0", "font-size": 10, "text-anchor": "middle" },
    "白虚线=恒星周日运动方向（向西）"));

  // 红色漂移箭头：取当前轮次最显著测段
  const cur = analyses.find((a) => a.seg.kind === state.segKind && a.usable &&
    (a.decRate_as_s !== null || a.decSign !== 0));
  if (cur) {
    const sign = cur.decRate_as_s !== null ? Math.sign(cur.decRate_as_s) : cur.decSign;
    const mag = cur.decRate_as_s !== null
      ? Math.min(0.9, 0.25 + Math.abs(cur.decRate_as_s) * 40) : 0.6;
    const d = [N[0] * sign * mag, N[1] * sign * mag];
    svg.appendChild(el("line", {
      x1: C, y1: C, x2: C + d[0] * R, y2: C + d[1] * R,
      stroke: "#f85149", "stroke-width": 2.4, "marker-end": "url(#arrowD)",
    }));
    svg.appendChild(el("text", { x: C, y: 16, fill: "#f85149", "font-size": 11, "text-anchor": "middle" },
      `红箭头=当前赤纬漂移方向（${sign > 0 ? "向北" : "向南"}）`));
  }
  $("fovHint").textContent =
    `N 为真实北天方向，已按“${({none:"无翻转",diag:"天顶镜(上下翻转)",mirror:"反射(左右翻转)",rotate180:"旋转180°",custom:"自定义旋转"})[s.flip]}”映射；` +
    `刻度增大端你设定为指向真实${s.scaleDir === "N" ? "北（赤纬增大）" : "南（赤纬减小）"}。停跟踪后恒星沿白虚线西移，可据此核对方向。`;
}

/* ---------------- 渲染：测段结果卡 ---------------- */

function renderSegResults(analyses) {
  const box = $("segResults");
  box.innerHTML = "";
  if (!analyses.length) {
    box.innerHTML = `<p class="hint">本轮还没有测段。选择测段类型并打点后，这里给出每段的拟合与可信度。</p>`;
    return;
  }
  for (const a of analyses) {
    const d = document.createElement("div");
    d.className = `seg-result ${a.seg.kind}${a.seg.locked ? " locked" : ""}`;
    const ss = a.settings;
    const posTxt = ss.azimuth !== null && ss.altitude !== null
      ? `A=${ss.azimuth}° h=${ss.altitude}°` : "无位置快照";
    const geoTxt = a.geo ? `H=${(a.geo.H * 180 / Math.PI).toFixed(1)}° δ=${(a.geo.dec * 180 / Math.PI).toFixed(1)}°` : "";
    let driftLine = "";
    if (a.decRate_as_s !== null)
      driftLine = `　赤纬漂移：<b style="color:${a.decRate_as_s >= 0 ? "#79c0ff" : "#ffa657"}">${a.decRate_as_s >= 0 ? "向北" : "向南"} ${Math.abs(a.decRate_as_s).toFixed(4)}″/s</b>`;
    else if (a.usable && a.decSign)
      driftLine = `　赤纬漂移方向：<b style="color:${a.decSign > 0 ? "#79c0ff" : "#ffa657"}">${a.decSign > 0 ? "向北 ↑" : "向南 ↓"}</b>（无角尺度，仅方向）`;
    const mismatchWarn = a.snapshotMismatch
      ? `<li>当前表单位置（A=${state.bundle.settings.azimuth}° h=${state.bundle.settings.altitude}°）与本测段快照（A=${ss.azimuth}° h=${ss.altitude}°）不同；本测段仍按快照解算，改目标不会污染旧段。</li>` : "";
    d.innerHTML =
      `<h3><span>${KIND_LABEL[a.seg.kind]} ${a.seg.locked ? "🔒" : ""}</span><span class="hint">${a.n} 点 · ${a.duration_s.toFixed(0)}s · ${posTxt} ${geoTxt}</span></h3>` +
      `<div class="rate">斜率：<b>${a.slope_tick_min === null ? "—" : (a.slope_tick_min >= 0 ? "+" : "") + a.slope_tick_min.toFixed(3) + " 格/分"}</b>${driftLine}</div>` +
      `<ul class="warnings">` +
      a.good.map((x) => `<li class="good">✓ ${x}</li>`).join("") +
      mismatchWarn +
      a.warnings.map((x) => `<li>⚠ ${x}</li>`).join("") +
      a.refusals.map((x) => `<li class="bad">⛔ ${x}</li>`).join("") +
      `</ul>` +
      `<div class="ops">` +
      `<button data-op="lock">${a.seg.locked ? "解锁" : "锁定为可信测段"}</button>` +
      (a.n === 0 ? `<button data-op="repos">用当前位置更新本段</button>` : ``) +
      (a.outlierIdx.size ? `<button data-op="excludeOutliers">排除全部异常点</button>` : ``) +
      `</div>`;
    d.querySelector('[data-op="lock"]').addEventListener("click", async () => {
      await api("PATCH", `/api/segments/${a.seg.id}`, { locked: !a.seg.locked });
      await refreshBundle();
    });
    const rp = d.querySelector('[data-op="repos"]');
    if (rp) rp.addEventListener("click", async () => {
      await api("PATCH", `/api/segments/${a.seg.id}`, { snapshot: geoSnapshot() });
      await refreshBundle();
    });
    const eo = d.querySelector('[data-op="excludeOutliers"]');
    if (eo) eo.addEventListener("click", async () => {
      for (const id of a.outlierIdx) {
        await api("PATCH", `/api/points/${id}`, { excluded: true });
      }
      await refreshBundle();
    });
    box.appendChild(d);
  }
}

/* ---------------- 渲染：调整建议 ---------------- */

function renderAdvice(res) {
  const box = $("adviceBox");
  if (!state.bundle) {
    box.innerHTML = `<div class="advice"><p class="hint">新建会话、设置观测参数并完成打点后，这里给出方位轴 / 高度轴的调整方向与调整量。</p></div>`;
    return;
  }
  const s = state.bundle.settings;
  const haveScale = s.arcsecPerTick !== null && s.arcsecPerTick > 0;
  const havePhi = s.latitude !== null;
  const canAmount = haveScale && havePhi;

  const anySeg = res.mer || res.east || res.west;
  const anyAz = res.dA !== null || res.azCorrection;
  const anyAlt = res.dh !== null || res.altCorrection;
  if (!anySeg) {
    box.innerHTML = `<div class="advice"><p class="refuse">暂不下结论：当前轮次还没有满足基本条件的测段（点数不足、时长不足或目标位置不合适时，不会硬给调整方向）。</p>
      <p class="basis">建议流程：先在子午线附近高点测方位轴，再到东/西低空测高度轴；每段建议 ≥60 秒、≥4 点。</p></div>`;
    return;
  }
  let html = `<div class="advice">`;
  const errText = { east: "极轴偏东", west: "极轴偏西", up: "仰角偏高", down: "仰角偏低" };
  const fixText = { east: "把方位轴向<b>东</b>拧（极轴朝东转）", west: "把方位轴向<b>西</b>拧",
                    up: "把高度轴<b>抬高</b>（仰角升高）", down: "把高度轴<b>降低</b>（仰角下降）" };

  // 方位轴
  html += `<div class="axis"><div>方位角轴（水平旋转）：</div>`;
  if (res.dA !== null && res.azCorrection) {
    html += `<div class="dir az">${fixText[res.azCorrection]}</div>`;
    if (canAmount) {
      const errDir = res.dA > 0 ? "east" : "west";
      html += `<div class="amount">判读：当前${errText[errDir]}约 <b>${Math.abs(res.dA).toFixed(0)}″</b>（≈${(Math.abs(res.dA) / 60).toFixed(2)}′），向反方向回调该量` +
        (res.dA_se ? `（拟合不确定度 ±${res.dA_se.toFixed(0)}″）` : "") + `。</div>`;
    } else {
      html += `<div class="amount">${haveScale ? "未填纬度，" : "未填角尺度，"}只给方向不给量。</div>`;
    }
  } else if (res.azCorrection) {
    html += `<div class="dir az">${fixText[res.azCorrection]}</div>
      <div class="amount">仅方向：子午线段显示赤纬${res.dA_sign > 0 ? "向北" : "向南"}漂移${haveScale ? "" : "（未标定角尺度）"}。</div>`;
  } else {
    html += `<div class="amount">尚无可用子午线段，方位轴方向未定。</div>`;
  }
  html += `</div>`;

  // 高度轴
  html += `<div class="axis"><div>高度轴（仰角）：</div>`;
  if (res.dh !== null && res.altCorrection) {
    html += `<div class="dir alt">${fixText[res.altCorrection]}</div>`;
    if (canAmount) {
      const errDir = res.dh > 0 ? "up" : "down";
      html += `<div class="amount">判读：当前${errText[errDir]}约 <b>${Math.abs(res.dh).toFixed(0)}″</b>（≈${(Math.abs(res.dh) / 60).toFixed(2)}′），向反方向回调该量` +
        (res.dh_se ? `（不确定度 ±${res.dh_se.toFixed(0)}″）` : "") + `。</div>`;
    } else {
      html += `<div class="amount">${haveScale ? "未填纬度，" : "未填角尺度，"}只给方向不给量。</div>`;
    }
  } else if (res.altCorrection) {
    html += `<div class="dir alt">${fixText[res.altCorrection]}</div>
      <div class="amount">仅方向${haveScale ? "" : "（未标定角尺度）"}。</div>`;
  } else {
    html += `<div class="amount">尚无可用低空测段，高度轴方向未定。</div>`;
  }
  html += `</div>`;

  if (res.assumptions.length)
    html += `<p class="basis">前提说明：${[...new Set(res.assumptions)].join("　")}</p>`;
  if (res.contradictions.length)
    html += `<p class="refuse">测段间矛盾：${[...new Set(res.contradictions)].join("　")}</p>`;
  if (!anyAz || !anyAlt)
    html += `<p class="basis">${!anyAz ? "方位轴需在子午线附近（H≈0）高一点的目标上观测；" : ""}${!anyAlt ? "高度轴需在东或西天、高度 15–40° 的目标上观测。" : ""}</p>`;
  html += `</div>`;
  box.innerHTML = html;
}

/* ---------------- 渲染：轮次比较 ---------------- */

function roundResiduals() {
  const s = state.bundle.settings;
  const out = [];
  for (const round of state.bundle.rounds) {
    const res = analyzeRound(round, s);
    const mer = res.mer, low = res.east || res.west;
    const merRate = mer ? mer.decRate_as_s : null;
    const altRate = low ? low.decRate_as_s : null;
    const merSign = mer ? mer.decSign : null;
    const altSign = low ? low.decSign : null;
    out.push({ round, res, merRate, altRate, merSign, altSign });
  }
  return out;
}

function renderRounds() {
  const tb = $("roundsTable").querySelector("tbody");
  tb.innerHTML = "";
  if (!state.bundle) { $("contradictionBox").innerHTML = ""; return; }
  const rows = roundResiduals();
  const fmt = (v) => v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(4)}″/s`;
  const arrow = (sg) => sg === null || sg === 0 ? "—" : (sg > 0 ? "↑北漂" : "↓南漂");
  const tickTxt = (a) => a && a.slope_tick_min !== null ? `${a.slope_tick_min >= 0 ? "+" : ""}${a.slope_tick_min.toFixed(2)} 格/分` : "—";
  const s = state.bundle.settings;
  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    const prev = i > 0 ? rows[i - 1] : null;
    let cls = "";
    // 有数值按数值幅度比，否则按残余方向是否消失来粗判
    const mag = (x) => Math.abs(x.merRate ?? 0) + Math.abs(x.altRate ?? 0);
    const haveNum = rows.some((x) => x.merRate !== null || x.altRate !== null);
    if (prev && haveNum) {
      const nowMag = mag(r), prevMag = mag(prev);
      if (nowMag < prevMag * 0.8) cls = "improved";
      if (nowMag > prevMag * 1.2) cls = "worse";
    }
    tr.className = cls;
    const adj = r.round.adjustment || {};
    const azCell = r.merRate !== null ? fmt(r.merRate)
      : (s.arcsecPerTick ? (r.res.mer ? tickTxt(r.res.mer) : "—") : arrow(r.merSign));
    const altCell = r.altRate !== null ? fmt(r.altRate)
      : (s.arcsecPerTick ? tickTxt(r.res.east || r.res.west) : arrow(r.altSign));
    tr.innerHTML =
      `<td>第 ${r.round.seq} 轮${r.round.id === state.roundId ? " ◀" : ""}</td>` +
      `<td class="resid">${azCell}</td><td class="resid">${altCell}</td>` +
      `<td class="hint">${[adj.az, adj.alt].filter(Boolean).join("；") || "—"}</td>` +
      `<td><button class="use-btn">使用</button> <button class="del-round-btn danger ghost">删</button></td>`;
    tr.querySelector(".use-btn").addEventListener("click", () => { state.roundId = r.round.id; renderAll(); });
    tr.querySelector(".del-round-btn").addEventListener("click", async () => {
      if (!confirm(`删除第 ${r.round.seq} 轮及其全部打点？`)) return;
      await api("DELETE", `/api/rounds/${r.round.id}`);
      await refreshBundle();
    });
    tb.appendChild(tr);
  });

  // 跨轮矛盾
  const cbox = $("contradictionBox");
  cbox.innerHTML = "";
  const msgs = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].res, b = rows[i].res;
    if (a.dA !== null && b.dA !== null && Math.sign(a.dA) !== Math.sign(b.dA) &&
        Math.abs(a.dA) > 2 * (a.dA_se || 0) && Math.abs(b.dA) > 2 * (b.dA_se || 0))
      msgs.push({ cls: "bad", t: `第 ${rows[i - 1].round.seq}、${rows[i].round.seq} 轮方位残余符号相反：上一轮调整可能过冲、方向拧反，或其中一轮测段不可信，不要按单轮结果继续调。` });
    if (a.dh !== null && b.dh !== null && Math.sign(a.dh) !== Math.sign(b.dh) &&
        Math.abs(a.dh) > 2 * (a.dh_se || 0) && Math.abs(b.dh) > 2 * (b.dh_se || 0))
      msgs.push({ cls: "bad", t: `第 ${rows[i - 1].round.seq}、${rows[i].round.seq} 轮高度残余符号相反，依据同上，请先复测确认。` });
    const ma = Math.abs(a.dA ?? 0), mb = Math.abs(b.dA ?? 0);
    if (a.dA !== null && b.dA !== null && mb > ma * 1.5)
      msgs.push({ cls: "warn", t: `第 ${rows[i].round.seq} 轮方位残余不降反增（${mb.toFixed(0)}″ vs ${ma.toFixed(0)}″），检查调节方向与回程间隙。` });
    // 仅方向模式下，若相邻两轮的漂移符号翻转，同样提示（可能过冲/拧反）
    if (a.dA === null && b.dA === null &&
        rows[i - 1].merSign && rows[i].merSign && rows[i - 1].merSign !== rows[i].merSign)
      msgs.push({ cls: "warn", t: `第 ${rows[i - 1].round.seq}、${rows[i].round.seq} 轮子午线漂移方向相反（仅方向判读）：可能调整过冲或拧反，请复测确认。` });
    if (rows[i - 1].altSign && rows[i].altSign && rows[i - 1].altSign !== rows[i].altSign &&
        a.dh === null && b.dh === null)
      msgs.push({ cls: "warn", t: `第 ${rows[i - 1].round.seq}、${rows[i].round.seq} 轮低空漂移方向相反（仅方向判读），请复测确认。` });
  }
  if (rows.length >= 2 && !msgs.length)
    msgs.push({ cls: "good", t: "相邻两轮调整方向一致、残余漂移未出现反转；若绝对值逐轮减小即收敛良好。" });
  for (const m of msgs) {
    const d = document.createElement("div");
    d.className = `boxline ${m.cls}`;
    d.textContent = m.t;
    cbox.appendChild(d);
  }

  // 当前轮调整记录回填
  const cur = currentRound();
  if (cur) {
    $("adjAz").value = (cur.adjustment && cur.adjustment.az) || "";
    $("adjAlt").value = (cur.adjustment && cur.adjustment.alt) || "";
  }
}

/* ---------------- 总渲染 ---------------- */

function renderAll() {
  renderGeometryHint();
  const round = currentRound();
  $("roundLabel").textContent = !state.bundle ? "尚未创建会话"
    : !round ? "第 0 轮（打点将自动开始第 1 轮）"
    : `第 ${round.seq} 轮 · ${KIND_LABEL[state.segKind]}`;
  $("lockSegBtn").textContent = (() => {
    const seg = round ? findSegment(round, state.segKind) : null;
    return seg && seg.locked ? "解锁当前测段" : "锁定当前测段";
  })();

  let analyses = [];
  if (round) analyses = round.segments.map((g) => analyzeSegment(g, state.bundle.settings));
  renderPointsTable();
  renderChart(analyses);
  renderFov(analyses);
  renderSegResults(analyses);
  const res = round ? analyzeRound(round, state.bundle.settings) :
    { segs: [], mer: null, east: null, west: null, dA: null, dh: null,
      dA_se: null, dh_se: null, azOnlyDirection: null, altOnlyDirection: null,
      assumptions: [], contradictions: [] };
  renderAdvice(res);
  renderRounds();
  renderPrintSheet(res, analyses);
}

/* ---------------- 打印校准单 ---------------- */

function renderPrintSheet(res, analyses) {
  if (!state.bundle) { $("printContent").innerHTML = ""; return; }
  const s = state.bundle.settings;
  const now = new Date();
  const rows = roundResiduals();
  const segRows = [];
  if (currentRound()) {
    for (const a of analyses) {
      const ss = a.settings;
      const driftCell = a.decRate_as_s !== null ? a.decRate_as_s.toFixed(4)
        : (a.usable && a.decSign ? (a.decSign > 0 ? "向北↑(仅方向)" : "向南↓(仅方向)") : "—");
      segRows.push(`<tr><td>${KIND_LABEL[a.seg.kind]}${a.seg.locked ? "🔒" : ""}<br><span class="sheet-note">A=${ss.azimuth ?? "—"}° h=${ss.altitude ?? "—"}°</span></td>
        <td>${a.n}</td><td>${a.duration_s.toFixed(0)}s</td>
        <td>${a.slope_tick_min === null ? "—" : a.slope_tick_min.toFixed(3)}</td>
        <td>${driftCell}</td>
        <td>${[...a.warnings, ...a.refusals].join("；") || "无"}</td></tr>`);
    }
  }
  const signTxt = (v, sg) => v !== null ? v.toFixed(4) : (sg ? (sg > 0 ? "北漂(仅方向)" : "南漂(仅方向)") : "—");
  const roundRows = rows.map((r) => `<tr><td>第 ${r.round.seq} 轮</td>
    <td>${signTxt(r.merRate, r.merSign)}</td>
    <td>${signTxt(r.altRate, r.altSign)}</td>
    <td>${[r.round.adjustment && r.round.adjustment.az, r.round.adjustment && r.round.adjustment.alt].filter(Boolean).join("；") || "—"}</td></tr>`).join("");
  $("printContent").innerHTML = `
    <p>会话：${state.bundle.name}　打印时间：${now.toLocaleString()}</p>
    <h3>观测设置</h3>
    <table><tr><th>半球</th><th>赤道仪</th><th>纬度</th><th>方位/高度</th><th>推算 H/δ</th><th>翻转</th><th>刻度增大端</th><th>角尺度</th></tr><tr>
      <td>${s.hemisphere === "N" ? "北" : "南"}半球</td><td>${s.mountType === "GEM" ? "德式 GEM" : "叉式/无换向"}</td>
      <td>${s.latitude ?? "—"}°</td><td>${s.azimuth ?? "—"}° / ${s.altitude ?? "—"}°</td>
      <td>${(() => {
        if (s.azimuth === null || s.altitude === null) return "—";
        const g = Calc.hdOf(s.hemisphere === "S" ? -(s.latitude ?? 0) : (s.latitude ?? 0), s.azimuth, s.altitude);
        return `H=${(g.H * 180 / Math.PI).toFixed(1)}° δ=${(g.dec * 180 / Math.PI).toFixed(1)}°`;
      })()}</td>
      <td>${({none:"无",diag:"天顶镜",mirror:"反射",rotate180:"180°",custom:"自定义"})[s.flip]}</td>
      <td>${s.scaleDir === "N" ? "真实北" : "真实南"}</td><td>${s.arcsecPerTick ? s.arcsecPerTick + ' ″/格' : "未标定（仅方向）"}</td></tr></table>
    <h3>当前轮次各测段</h3>
    <table><tr><th>测段</th><th>点数</th><th>时长</th><th>斜率(格/分)</th><th>赤纬漂移(″/s)</th><th>警告/拒绝依据</th></tr>
      ${segRows.join("") || "<tr><td colspan=6>无</td></tr>"}</table>
    <h3>调整结论（当前轮，为应执行的修正动作）</h3>
    <table><tr><th>方位轴</th><th>高度轴</th></tr><tr>
      <td>${res.dA === null && !res.azCorrection ? "未定"
        : `${res.azCorrection === "east" ? "向东拧" : "向西拧"} ${res.dA !== null && s.arcsecPerTick && s.latitude !== null ? Math.abs(res.dA).toFixed(0) + "″" : "（仅方向）"}`}</td>
      <td>${res.dh === null && !res.altCorrection ? "未定"
        : `${res.altCorrection === "up" ? "抬高" : "降低"} ${res.dh !== null && s.arcsecPerTick && s.latitude !== null ? Math.abs(res.dh).toFixed(0) + "″" : "（仅方向）"}`}</td>
    </tr></table>
    <p class="sheet-note">${(res.assumptions || []).join("　")}</p>
    <h3>逐轮残余漂移</h3>
    <table><tr><th>轮次</th><th>方位残余(″/s)</th><th>高度残余(″/s)</th><th>实际调整记录</th></tr>${roundRows}</table>
    <p class="sheet-note">本单由漂移法校准推演台生成；带“仅方向/未定/前提”字样时表示数据不足，不应据此做定量调整。</p>`;
}

/* ---------------- 导入导出 ---------------- */

async function exportJSON() {
  if (!state.bundle) { alert("还没有会话可导出。"); return; }
  const b = await api("GET", `/api/sessions/${state.bundle.id}/export`);
  const blob = new Blob([JSON.stringify(b, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${state.bundle.name.replace(/\s+/g, "_")}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importJSON(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error("文件不是合法 JSON：" + e.message); }
    if (data.__export_format__ && data.__export_format__ !== "drift-align-station/v1")
      throw new Error(`不支持的导出格式：${data.__export_format__}`);
    const r = await api("POST", "/api/import", data);
    await loadSessionList();
    if (r.session_ids && r.session_ids[0]) await loadBundle(r.session_ids[0]);
    alert(`导入成功，已恢复 ${r.session_ids.length} 个会话。`);
  } catch (e) { alert("导入失败：" + e.message); }
  input.value = "";
}

/* ---------------- 事件绑定与启动 ---------------- */

function onFlipChange() {
  $("customRot").disabled = $("flip").value !== "custom";
}

function bind() {
  $("newSessionBtn").addEventListener("click", () => createSession().catch((e) => alert(e.message)));
  $("newRoundBtn").addEventListener("click", () => createRound().catch((e) => alert(e.message)));
  $("sessionSelect").addEventListener("change", (e) => {
    if (!e.target.value) return;   // 占位项不触发卸载，避免渲染空状态崩溃
    loadBundle(e.target.value);
  });
  $("exportBtn").addEventListener("click", exportJSON);
  $("importFile").addEventListener("change", (e) => importJSON(e.target));
  $("printBtn").addEventListener("click", () => {
    if (!state.bundle) { alert("还没有会话。"); return; }
    renderAll();
    window.print();
  });

  for (const id of ["hemisphere", "mountType", "latitude", "azimuth", "altitude",
                    "declination", "flip", "customRot", "scaleDir", "arcsecPerTick"])
    $(id).addEventListener("input", localSettingsChanged);
  // change 事件保证 select/number 在键盘输入之外（滚轮、粘贴）也能即时重算
  for (const id of ["hemisphere", "mountType", "flip", "scaleDir", "latitude",
                    "azimuth", "altitude", "declination", "customRot", "arcsecPerTick"])
    $(id).addEventListener("change", localSettingsChanged);
  $("flip").addEventListener("change", onFlipChange);

  $("segKind").addEventListener("change", (e) => { state.segKind = e.target.value; renderAll(); });
  $("markBtn").addEventListener("click", markPoint);
  $("undoBtn").addEventListener("click", undoPoint);
  $("clearPtsBtn").addEventListener("click", clearSegmentPoints);
  $("lockSegBtn").addEventListener("click", toggleLock);

  $("saveAdjBtn").addEventListener("click", async () => {
    const round = currentRound();
    if (!round) { alert("请先开始一轮观测。"); return; }
    await api("PATCH", `/api/rounds/${round.id}`, {
      adjustment: { az: $("adjAz").value.trim(), alt: $("adjAlt").value.trim() },
    });
    await refreshBundle();
    alert("已保存本轮调整记录。");
  });

  // 热键：刻度输入框内 Space=提交打点并保持焦点便于连续记录；
  //       其他输入/选择控件内的按键一律不拦截。
  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    const inField = tag === "input" || tag === "select" || tag === "textarea";
    const isTickField = e.target === $("tickInput");
    if (inField && !isTickField) return;

    if (e.code === "Space") {
      e.preventDefault();
      if (state.busy) return;
      markPoint().then(() => $("tickInput").focus());
      return;
    }
    if (isTickField) return;   // 刻度框内只放行 Space，其余热键交给页面
    if (e.key === "u" || e.key === "U") { e.preventDefault(); undoPoint(); }
    else if (e.key === "m" || e.key === "M") { $("segKind").value = "meridian"; state.segKind = "meridian"; renderAll(); }
    else if (e.key === "e" || e.key === "E") { $("segKind").value = "east_low"; state.segKind = "east_low"; renderAll(); }
    else if (e.key === "w" || e.key === "W") { $("segKind").value = "west_low"; state.segKind = "west_low"; renderAll(); }
    else if (e.key === "l" || e.key === "L") { toggleLock(); }
  });
}

(async function init() {
  bind();
  await loadSessionList();
  if (state.list.length) await loadBundle(state.list[0].id);
  else { applySettings({}); renderAll(); }
})();
