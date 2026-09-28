// 翻前极化静态 GTO 矩阵运行时查询引擎 (Phase 2)
// 设计者：GPT-6-Astra (首席架构师) + Gemini (主程)
// 性能目标：内存占用 < 2MB, 单次查询时延 < 0.05ms, 支持非均匀深度线性插值

(function(global) {
  let _matrixData = null;

  function loadGtoMatrix(customDataOrPath) {
    if (_matrixData) return _matrixData;
    if (typeof window !== 'undefined' && window.PREFLOP_GTO_MATRIX) {
      _matrixData = window.PREFLOP_GTO_MATRIX;
      return _matrixData;
    }
    if (typeof globalThis !== 'undefined' && globalThis.PREFLOP_GTO_MATRIX) {
      _matrixData = globalThis.PREFLOP_GTO_MATRIX;
      return _matrixData;
    }
    if (typeof customDataOrPath === 'object' && customDataOrPath !== null) {
      _matrixData = customDataOrPath;
      return _matrixData;
    }
    // Node.js sync read
    if (typeof require !== 'undefined') {
      try {
        const fs = require('fs');
        const path = require('path');
        const p = typeof customDataOrPath === 'string' ? customDataOrPath : path.join(__dirname, 'preflop_gto_matrix.json');
        if (fs.existsSync(p)) {
          _matrixData = JSON.parse(fs.readFileSync(p, 'utf8'));
        }
      } catch (e) {}
    }
    return _matrixData;
  }

  function interpolateFrequencies(vLo, vHi, weight) {
    const raw = [
      Math.max(0, vLo[0] * (1 - weight) + vHi[0] * weight),
      Math.max(0, vLo[1] * (1 - weight) + vHi[1] * weight),
      Math.max(0, vLo[2] * (1 - weight) + vHi[2] * weight),
      Math.max(0, vLo[3] * (1 - weight) + vHi[3] * weight)
    ];
    const sum = raw[0] + raw[1] + raw[2] + raw[3];
    if (sum <= 0) return [100, 0, 0, 0];
    const normalized = raw.map(x => (x / sum) * 100);
    const floors = normalized.map(Math.floor);
    let rem = 100 - (floors[0] + floors[1] + floors[2] + floors[3]);
    const diffs = normalized.map((x, i) => ({ idx: i, diff: x - floors[i] }))
                            .sort((a, b) => b.diff - a.diff);
    for (let i = 0; i < rem; i++) {
      floors[diffs[i].idx]++;
    }
    return floors;
  }

  const _depthsCache = {};
  function findAvailableDepths(matrix, heroPos, seqKey) {
    const effPos = (seqKey === 'RFI' && heroPos === 'HJ') ? 'MP' : ((seqKey === 'RFI' && heroPos === 'LJ') ? 'UTG' : heroPos);
    const cacheKey = `${effPos}_${seqKey}`;
    if (_depthsCache[cacheKey]) return _depthsCache[cacheKey];
    const keys = Object.keys(matrix.nodes || {});
    const suffix1 = `_${effPos}_${seqKey}`;
    let matched = keys.filter(k => k.endsWith(suffix1));
    if (matched.length === 0 && seqKey === 'SQUEEZE') {
      matched = keys.filter(k => k.includes(`_${effPos}_SQUEEZE`));
    }
    if (matched.length === 0) return null;
    const depths = matched.map(k => parseFloat(k.split('_')[0])).filter(d => !isNaN(d));
    const sorted = Array.from(new Set(depths)).sort((a, b) => a - b);
    _depthsCache[cacheKey] = sorted;
    return sorted;
  }

  function queryGtoPreflop(heroPos, vsPos, effStack, hand, actionSeq = 'vs_RFI') {
    if (typeof effStack !== 'number' || isNaN(effStack) || !Number.isFinite(effStack)) {
      return null;
    }
    if (typeof hand !== 'string' || !hand) {
      return null;
    }
    const HAND_RE = /^([2-9TJQKA])([2-9TJQKA])([so]?)$/;
    const hm = hand.match(HAND_RE);
    if (!hm) return null;
    if (hm[1] === hm[2] && hm[3] !== '') return null;
    if (hm[1] !== hm[2] && !hm[3]) return null;

    const matrix = loadGtoMatrix();
    if (!matrix || !matrix.nodes) {
      return null;
    }

    let effHeroPos = heroPos;
    let effVsPos = vsPos;
    if (actionSeq === 'RFI' && heroPos === 'HJ') effHeroPos = 'MP';
    if (actionSeq === 'RFI' && heroPos === 'LJ') effHeroPos = 'UTG';

    let seqKey = actionSeq;
    if (actionSeq === 'vs_RFI') {
      seqKey = `vs_${effVsPos}_RFI`;
    }

    const depths = findAvailableDepths(matrix, effHeroPos, seqKey) || (matrix.depths || [8, 10, 12, 15, 20, 25, 30, 40, 60]);
    if (!depths || !depths.length) return null;
    const minD = depths[0], maxD = depths[depths.length - 1];
    if (effStack < minD || effStack > maxD) return null;

    let loDepth = depths[0], hiDepth = depths[depths.length - 1];
    for (let i = 0; i < depths.length; i++) {
      if (depths[i] <= effStack) loDepth = depths[i];
      if (depths[i] >= effStack) { hiDepth = depths[i]; break; }
    }

    function getNode(depth) {
      if (!matrix.nodes) return {};
      let k = `${depth}_${effHeroPos}_${seqKey}`;
      if (matrix.nodes[k]) return matrix.nodes[k];
      if (seqKey === 'RFI') {
        if (effHeroPos === 'HJ' && matrix.nodes[`${depth}_MP_RFI`]) return matrix.nodes[`${depth}_MP_RFI`];
        if (effHeroPos === 'LJ' && matrix.nodes[`${depth}_UTG_RFI`]) return matrix.nodes[`${depth}_UTG_RFI`];
      }
      if (seqKey === 'SQUEEZE') {
        if (matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_UTG_BTN`]) return matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_UTG_BTN`];
        if (matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE`]) return matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE`];
      }
      return {};
    }

    const nodeLo = getNode(loDepth);
    const nodeHi = getNode(hiDepth);

    const hasLo = Object.keys(nodeLo).length > 0;
    const hasHi = Object.keys(nodeHi).length > 0;

    if (!hasLo && !hasHi) {
      return null; // 节点缺失返回 null，绝不误判为 100% 弃牌
    }

    const vecLo = nodeLo[hand];
    const vecHi = nodeHi[hand];

    function sanitize(v) {
      if (!v || !Array.isArray(v) || v.length !== 4) return null;
      if (v.some(x => typeof x !== 'number' || isNaN(x) || !Number.isFinite(x) || x < 0)) return null;
      const s = v.reduce((a, b) => a + b, 0);
      if (s <= 0 || !Number.isFinite(s)) return null;
      const floors = v.map(x => Math.floor(x / s * 100));
      let rem = 100 - floors.reduce((a, b) => a + b, 0);
      const diffs = v.map((x, i) => ({ idx: i, diff: (x / s * 100) - floors[i] }))
                       .sort((a, b) => b.diff - a.diff);
      for (let i = 0; i < rem; i++) floors[diffs[i].idx]++;
      return floors;
    }

    const cLo = vecLo ? sanitize(vecLo) : (hasLo ? [100, 0, 0, 0] : null);
    const cHi = vecHi ? sanitize(vecHi) : (hasHi ? [100, 0, 0, 0] : null);

    if (loDepth === hiDepth) {
      return cLo || cHi;
    }

    // 插值必须两端端点同时有效，任意一端损坏或缺失坚决拒绝并返回 null，绝不单侧静默替代 (ASTRA-042-04)
    if (!cLo || !cHi) return null;

    const weight = (effStack - loDepth) / (hiDepth - loDepth);
    return interpolateFrequencies(cLo, cHi, weight);
  }

  // Export to global / window
  global.loadGtoMatrix = loadGtoMatrix;
  global.queryGtoPreflop = queryGtoPreflop;

  // Export to CommonJS / Node
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { loadGtoMatrix, queryGtoPreflop };
    exports.loadGtoMatrix = loadGtoMatrix;
    exports.queryGtoPreflop = queryGtoPreflop;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
