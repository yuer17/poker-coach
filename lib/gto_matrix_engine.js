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
    const f = vLo[0] * (1 - weight) + vHi[0] * weight;
    const c = vLo[1] * (1 - weight) + vHi[1] * weight;
    const r = vLo[2] * (1 - weight) + vHi[2] * weight;
    const j = vLo[3] * (1 - weight) + vHi[3] * weight;

    const fN = Math.round(f);
    const cN = Math.round(c);
    const rN = Math.round(r);
    const jN = 100 - fN - cN - rN;
    return [fN, cN, rN, jN];
  }

  const _depthsCache = {};
  function findAvailableDepths(matrix, heroPos, seqKey) {
    const cacheKey = `${heroPos}_${seqKey}`;
    if (_depthsCache[cacheKey]) return _depthsCache[cacheKey];
    const keys = Object.keys(matrix.nodes || {});
    const suffix1 = `_${heroPos}_${seqKey}`;
    let matched = keys.filter(k => k.endsWith(suffix1));
    if (matched.length === 0 && seqKey === 'SQUEEZE') {
      matched = keys.filter(k => k.includes(`_${heroPos}_SQUEEZE`));
    }
    if (matched.length === 0) return null;
    const depths = matched.map(k => parseFloat(k.split('_')[0])).filter(d => !isNaN(d));
    const sorted = Array.from(new Set(depths)).sort((a, b) => a - b);
    _depthsCache[cacheKey] = sorted;
    return sorted;
  }

  function queryGtoPreflop(heroPos, vsPos, effStack, hand, actionSeq = 'vs_RFI') {
    const matrix = loadGtoMatrix();
    if (!matrix || !matrix.nodes) {
      return [100, 0, 0, 0];
    }

    let seqKey = actionSeq;
    if (actionSeq === 'vs_RFI') {
      seqKey = `vs_${vsPos}_RFI`;
    }

    const depths = findAvailableDepths(matrix, heroPos, seqKey) || (matrix.depths || [8, 10, 12, 15, 20, 25, 30, 40, 60]);

    let loDepth = depths[0], hiDepth = depths[depths.length - 1];
    for (let i = 0; i < depths.length; i++) {
      if (depths[i] <= effStack) loDepth = depths[i];
      if (depths[i] >= effStack) { hiDepth = depths[i]; break; }
    }

    function getNode(depth) {
      if (!matrix.nodes) return {};
      let k = `${depth}_${heroPos}_${seqKey}`;
      if (matrix.nodes[k]) return matrix.nodes[k];
      if (seqKey === 'SQUEEZE') {
        if (matrix.nodes[`${depth}_${heroPos}_SQUEEZE_vs_UTG_BTN`]) return matrix.nodes[`${depth}_${heroPos}_SQUEEZE_vs_UTG_BTN`];
        if (matrix.nodes[`${depth}_${heroPos}_SQUEEZE`]) return matrix.nodes[`${depth}_${heroPos}_SQUEEZE`];
      }
      return {};
    }

    const nodeLo = getNode(loDepth);
    const nodeHi = getNode(hiDepth);

    const vecLo = nodeLo[hand] || [100, 0, 0, 0];
    const vecHi = nodeHi[hand] || [100, 0, 0, 0];

    if (loDepth === hiDepth) {
      return vecLo;
    }

    const weight = (effStack - loDepth) / (hiDepth - loDepth);
    return interpolateFrequencies(vecLo, vecHi, weight);
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
