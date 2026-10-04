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

  const VALID_HAND_REGEX = /^([2-9TJQKA])(\1|(?!\1)[2-9TJQKA][so])$/;

  function sanitizeVector(v) {
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

  function queryGtoPreflop(heroPos, vsPos, effStack, hand, actionSeq = 'vs_RFI') {
    if (typeof effStack !== 'number' || isNaN(effStack) || !Number.isFinite(effStack)) {
      return null;
    }
    if (typeof hand !== 'string' || !VALID_HAND_REGEX.test(hand.trim())) {
      return null;
    }
    const cleanHand = hand.trim();

    const matrix = loadGtoMatrix();
    if (!matrix || !matrix.nodes) {
      return null;
    }

    let effHeroPos = heroPos;
    let effVsPos = vsPos;

    // 桌型相对位置映射（6-max / 8-max / 9-max 自适应）：
    // 若当前为 6-max，UTG 身后剩 5 人对应 8-max 的 LJ，MP 身后剩 4 人对应 8-max 的 HJ
    const is6Max = (typeof globalThis !== 'undefined' && globalThis.gameConfig && globalThis.gameConfig.tableSize === '6max') ||
                  (typeof window !== 'undefined' && window.gameConfig && window.gameConfig.tableSize === '6max');
    if (is6Max) {
      if (actionSeq === 'RFI') {
        if (heroPos === 'UTG') effHeroPos = 'LJ';
        else if (heroPos === 'MP') effHeroPos = 'HJ';
      }
      if (actionSeq === 'vs_RFI') {
        if (vsPos === 'UTG') effVsPos = 'LJ';
        else if (vsPos === 'MP') effVsPos = 'HJ';
        if (heroPos === 'UTG') effHeroPos = 'LJ';
        else if (heroPos === 'MP') effHeroPos = 'HJ';
      }
    }

    let seqKey = actionSeq;
    if (actionSeq === 'vs_RFI') {
      seqKey = `vs_${effVsPos}_RFI`;
    } else if (actionSeq === 'vs_3BET' || actionSeq === 'vs_3Bet') {
      seqKey = `vs_${effVsPos}_3BET`;
    }

    const depths = findAvailableDepths(matrix, effHeroPos, seqKey) || (matrix.depths || [8, 10, 12, 15, 20, 25, 30, 35, 40, 60, 80, 100]);
    if (!depths || !depths.length) return null;
    const minD = depths[0], maxD = depths[depths.length - 1];
    const targetEff = Math.max(minD, Math.min(maxD, effStack));

    let loDepth = depths[0], hiDepth = depths[depths.length - 1];
    for (let i = 0; i < depths.length; i++) {
      if (depths[i] <= targetEff) loDepth = depths[i];
      if (depths[i] >= targetEff) { hiDepth = depths[i]; break; }
    }

    function getNode(depth) {
      if (!matrix.nodes) return {};
      let k = `${depth}_${effHeroPos}_${seqKey}`;
      if (matrix.nodes[k]) return matrix.nodes[k];
      if (seqKey === 'RFI') {
        if (matrix.nodes[`${depth}_${effHeroPos}_RFI`]) return matrix.nodes[`${depth}_${effHeroPos}_RFI`];
        if (effHeroPos === 'HJ' && matrix.nodes[`${depth}_MP_RFI`]) return matrix.nodes[`${depth}_MP_RFI`];
        if (effHeroPos === 'MP' && matrix.nodes[`${depth}_HJ_RFI`]) return matrix.nodes[`${depth}_HJ_RFI`];
        if (effHeroPos === 'LJ' && matrix.nodes[`${depth}_UTG_RFI`]) return matrix.nodes[`${depth}_UTG_RFI`];
        if (effHeroPos === 'UTG' && matrix.nodes[`${depth}_UTG_6M_RFI`]) return matrix.nodes[`${depth}_UTG_6M_RFI`];
      }
      if (seqKey === 'SQUEEZE') {
        if (matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_UTG_BTN`]) return matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_UTG_BTN`];
        if (matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE`]) return matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE`];
      }
      if (seqKey.includes('3BET')) {
        if (matrix.nodes[`${depth}_${effHeroPos}_${seqKey}`]) return matrix.nodes[`${depth}_${effHeroPos}_${seqKey}`];
        if (matrix.nodes[`${depth}_${effHeroPos}_FACING_3BET_vs_${effVsPos}`]) return matrix.nodes[`${depth}_${effHeroPos}_FACING_3BET_vs_${effVsPos}`];
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

    const rawLo = nodeLo[cleanHand] || (hasLo ? [100, 0, 0, 0] : null);
    const rawHi = nodeHi[cleanHand] || (hasHi ? [100, 0, 0, 0] : null);

    const cLo = rawLo ? sanitizeVector(rawLo) : null;
    const cHi = rawHi ? sanitizeVector(rawHi) : null;

    let resultVec = null;
    if (loDepth === hiDepth) {
      resultVec = cLo || cHi;
    } else if (!cLo || !cHi) {
      return null;
    } else {
      const weight = (targetEff - loDepth) / (hiDepth - loDepth);
      resultVec = interpolateFrequencies(cLo, cHi, weight);
    }

    // 动态 ICM 风险溢价调整 (DEF-ICM-GTO)
    const getIcmFn = (typeof globalThis !== 'undefined' && globalThis.getICM313Context) ||
                     (typeof window !== 'undefined' && window.getICM313Context);
    const cfg = (typeof globalThis !== 'undefined' && globalThis.gameConfig) ||
                (typeof window !== 'undefined' && window.gameConfig);
    if (resultVec && typeof getIcmFn === 'function' && cfg) {
      const vStack = (typeof globalThis !== 'undefined' && typeof globalThis.globalVillainStack !== 'undefined') ? globalThis.globalVillainStack : effStack;
      const aStack = (typeof globalThis !== 'undefined' && typeof globalThis.globalAvgStack !== 'undefined') ? globalThis.globalAvgStack : effStack;
      const icm = getIcmFn(effStack, vStack, aStack, cfg.stage);
      if (icm && icm.isICMStage && icm.riskPremium > 0) {
        const rp = Math.min(0.35, icm.riskPremium / 100);
        if (resultVec[1] > 0 && resultVec[0] < 100) {
          const shift = Math.round(resultVec[1] * rp);
          if (shift > 0) {
            resultVec[1] = Math.max(0, resultVec[1] - shift);
            resultVec[0] = Math.min(100, resultVec[0] + shift);
          }
        }
      }
    }

    // Dimension 2: 绑定微尺寸 (Micro-Sizing)
    if (resultVec && matrix.sizings) {
      const sizingKey = `${loDepth}_${effHeroPos}_${seqKey}`;
      const matchedSizing = matrix.sizings[sizingKey] ||
          matrix.sizings[`${loDepth}_${effHeroPos}_FACING_3BET_vs_${effVsPos}`] ||
          matrix.sizings[`${loDepth}_${effHeroPos}_RFI`];
      if (typeof matchedSizing === 'number') {
        resultVec.sizing = matchedSizing;
      }
    }

    return resultVec;
  }

  let _evMatrixData = null;
  function loadGtoEvMatrix(customDataOrPath) {
    if (_evMatrixData) return _evMatrixData;
    if (typeof window !== 'undefined' && window.PREFLOP_GTO_EV_MATRIX) {
      _evMatrixData = window.PREFLOP_GTO_EV_MATRIX;
      return _evMatrixData;
    }
    if (typeof globalThis !== 'undefined' && globalThis.PREFLOP_GTO_EV_MATRIX) {
      _evMatrixData = globalThis.PREFLOP_GTO_EV_MATRIX;
      return _evMatrixData;
    }
    if (typeof customDataOrPath === 'object' && customDataOrPath !== null) {
      _evMatrixData = customDataOrPath;
      return _evMatrixData;
    }
    if (typeof require !== 'undefined') {
      try {
        const fs = require('fs');
        const path = require('path');
        const p = typeof customDataOrPath === 'string' ? customDataOrPath : path.join(__dirname, 'preflop_gto_ev_matrix.json');
        if (fs.existsSync(p)) {
          _evMatrixData = JSON.parse(fs.readFileSync(p, 'utf8'));
        }
      } catch (e) {}
    }
    return _evMatrixData;
  }

  function queryGtoEv(heroPos, vsPos, effStack, hand, actionSeq = 'vs_RFI') {
    if (typeof effStack !== 'number' || isNaN(effStack) || !Number.isFinite(effStack)) return null;
    if (typeof hand !== 'string' || !VALID_HAND_REGEX.test(hand.trim())) return null;
    const cleanHand = hand.trim();
    const evMatrix = loadGtoEvMatrix();
    if (!evMatrix || !evMatrix.nodes) return null;

    let effHeroPos = heroPos;
    let effVsPos = vsPos;
    const is6Max = (typeof globalThis !== 'undefined' && globalThis.gameConfig && globalThis.gameConfig.tableSize === '6max') ||
                  (typeof window !== 'undefined' && window.gameConfig && window.gameConfig.tableSize === '6max');
    if (is6Max) {
      if (actionSeq === 'RFI') {
        if (heroPos === 'UTG') effHeroPos = 'LJ';
        else if (heroPos === 'MP') effHeroPos = 'HJ';
      }
      if (actionSeq === 'vs_RFI') {
        if (vsPos === 'UTG') effVsPos = 'LJ';
        else if (vsPos === 'MP') effVsPos = 'HJ';
        if (heroPos === 'UTG') effHeroPos = 'LJ';
        else if (heroPos === 'MP') effHeroPos = 'HJ';
      }
    }

    let seqKey = actionSeq;
    if (actionSeq === 'vs_RFI') seqKey = `vs_${effVsPos}_RFI`;
    else if (actionSeq === 'vs_3BET' || actionSeq === 'vs_3Bet') seqKey = `vs_${effVsPos}_3BET`;

    const depths = evMatrix.depths || [8, 10, 12, 15, 20, 25, 30, 35, 40, 60, 80, 100];
    const minD = depths[0], maxD = depths[depths.length - 1];
    const targetEff = Math.max(minD, Math.min(maxD, effStack));

    let loDepth = depths[0], hiDepth = depths[depths.length - 1];
    for (let i = 0; i < depths.length; i++) {
      if (depths[i] <= targetEff) loDepth = depths[i];
      if (depths[i] >= targetEff) { hiDepth = depths[i]; break; }
    }

    function getEvNode(depth) {
      let k = `${depth}_${effHeroPos}_${seqKey}`;
      if (evMatrix.nodes[k]) return evMatrix.nodes[k];
      if (seqKey.includes('3BET')) {
        if (evMatrix.nodes[`${depth}_${effHeroPos}_FACING_3BET_vs_${effVsPos}`]) return evMatrix.nodes[`${depth}_${effHeroPos}_FACING_3BET_vs_${effVsPos}`];
      }
      if (seqKey === 'RFI') {
        if (evMatrix.nodes[`${depth}_${effHeroPos}_RFI`]) return evMatrix.nodes[`${depth}_${effHeroPos}_RFI`];
        if (effHeroPos === 'HJ' && evMatrix.nodes[`${depth}_MP_RFI`]) return evMatrix.nodes[`${depth}_MP_RFI`];
        if (effHeroPos === 'MP' && evMatrix.nodes[`${depth}_HJ_RFI`]) return evMatrix.nodes[`${depth}_HJ_RFI`];
        if (effHeroPos === 'LJ' && evMatrix.nodes[`${depth}_UTG_RFI`]) return evMatrix.nodes[`${depth}_UTG_RFI`];
      }
      return null;
    }

    const nodeLo = getEvNode(loDepth);
    const nodeHi = getEvNode(hiDepth);
    if (!nodeLo && !nodeHi) return null;

    const evLo = nodeLo && nodeLo[cleanHand] ? nodeLo[cleanHand] : [0, 0, 0, 0];
    const evHi = nodeHi && nodeHi[cleanHand] ? nodeHi[cleanHand] : [0, 0, 0, 0];

    let resultEv = null;
    if (loDepth === hiDepth || !nodeLo || !nodeHi) {
      resultEv = (nodeLo ? evLo : evHi).slice();
    } else {
      const weight = (targetEff - loDepth) / (hiDepth - loDepth);
      resultEv = [
        Number((evLo[0] * (1 - weight) + evHi[0] * weight).toFixed(2)),
        Number((evLo[1] * (1 - weight) + evHi[1] * weight).toFixed(2)),
        Number((evLo[2] * (1 - weight) + evHi[2] * weight).toFixed(2)),
        Number((evLo[3] * (1 - weight) + evHi[3] * weight).toFixed(2))
      ];
    }

    const actionNames = ['弃', '跟', '加', '推'];
    let bestIdx = 0;
    let maxVal = -Infinity;
    for (let i = 0; i < 4; i++) {
      if (resultEv[i] > maxVal) {
        maxVal = resultEv[i];
        bestIdx = i;
      }
    }
    resultEv.bestAction = actionNames[bestIdx];
    resultEv.bestEv = maxVal;
    resultEv.loss = {
      F: Number((resultEv[0] - maxVal).toFixed(2)),
      C: Number((resultEv[1] - maxVal).toFixed(2)),
      R: Number((resultEv[2] - maxVal).toFixed(2)),
      RAI: Number((resultEv[3] - maxVal).toFixed(2))
    };
    return resultEv;
  }

  // Export to global / window
  global.loadGtoMatrix = loadGtoMatrix;
  global.loadGtoEvMatrix = loadGtoEvMatrix;
  global.queryGtoPreflop = queryGtoPreflop;
  global.queryGtoEv = queryGtoEv;

  // Export to CommonJS / Node
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { loadGtoMatrix, loadGtoEvMatrix, queryGtoPreflop, queryGtoEv };
    exports.loadGtoMatrix = loadGtoMatrix;
    exports.loadGtoEvMatrix = loadGtoEvMatrix;
    exports.queryGtoPreflop = queryGtoPreflop;
    exports.queryGtoEv = queryGtoEv;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
