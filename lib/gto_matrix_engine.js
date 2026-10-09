/**
 * gto_matrix_engine.js - 翻前极化静态 GTO 矩阵与 EV 决策查询统一权威引擎 (Single Source of Truth)
 * 
 * 职责：
 * 1. 统一浏览器端与 Node.js 测试端的翻前 GTO 矩阵查询实现，彻底根治双实现漂移 (D-120 / 审计问题 05)；
 * 2. 完整覆盖 6-max / 8-max / 9-max 桌型相对位置拓扑自适应；
 * 3. 涵盖全深度 (8~100BB) 连续非均匀深度线性插值与最深/最短平滑锚定；
 * 4. 深度集成官方微尺寸 (Micro-Sizing) 查询、几何尺度推导与非标尺寸底池赔率自适应补偿；
 * 5. 深度对接 Pokercode ICM 3-1-3 动态风险溢价模型与反事实损失计算；
 * 6. 统一最大余数法归一化 (Largest Remainder Method)，严格保障概率非负且闭合为 100%。
 * 
 * Version: PokerCode v3.25.2 正式版
 */

(function(global) {
  'use strict';

  let _matrixData = null;
  let _evMatrixData = null;
  const _gtoDepthsCache = {};

  const VALID_GTO_HAND_REGEX = /^([2-9TJQKA])(\1|(?!\1)[2-9TJQKA][so])$/;

  /**
   * 载入预编译 GTO 策略矩阵
   */
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
        const pJs = path.join(__dirname, 'preflop_gto_matrix.js');
        if (fs.existsSync(pJs)) {
          if (typeof window === 'undefined') {
            globalThis.window = globalThis;
          }
          require(pJs);
          if (globalThis.PREFLOP_GTO_MATRIX || (typeof window !== 'undefined' && window.PREFLOP_GTO_MATRIX)) {
            _matrixData = globalThis.PREFLOP_GTO_MATRIX || window.PREFLOP_GTO_MATRIX;
            return _matrixData;
          }
        }
        const pJson = typeof customDataOrPath === 'string' ? customDataOrPath : path.join(__dirname, 'preflop_gto_matrix.json');
        if (fs.existsSync(pJson)) {
          _matrixData = JSON.parse(fs.readFileSync(pJson, 'utf8'));
        }
      } catch (e) {}
    }
    return _matrixData;
  }

  /**
   * 载入预编译 GTO EV 矩阵
   */
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
        const pJs = path.join(__dirname, 'preflop_gto_ev_matrix.js');
        if (fs.existsSync(pJs)) {
          if (typeof window === 'undefined') {
            globalThis.window = globalThis;
          }
          require(pJs);
          if (globalThis.PREFLOP_GTO_EV_MATRIX || (typeof window !== 'undefined' && window.PREFLOP_GTO_EV_MATRIX)) {
            _evMatrixData = globalThis.PREFLOP_GTO_EV_MATRIX || window.PREFLOP_GTO_EV_MATRIX;
            return _evMatrixData;
          }
        }
        const pJson = typeof customDataOrPath === 'string' ? customDataOrPath : path.join(__dirname, 'preflop_gto_ev_matrix.json');
        if (fs.existsSync(pJson)) {
          _evMatrixData = JSON.parse(fs.readFileSync(pJson, 'utf8'));
        }
      } catch (e) {}
    }
    return _evMatrixData;
  }

  /**
   * 最大余数法 (Largest Remainder Method / Hamilton Rule) 归一化四维动作向量
   * [Fold, Call, Raise, Jam]，保证和严格等于 100% 且各分量非负
   */
  function sanitizeGtoVector(v) {
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

  /**
   * 非均匀深度频率线性插值
   */
  /**
   * 唯一权威最大余数法频率归一化工具 (Hamilton Rule / Largest Remainder Method, Issue 10)
   * 保证概率非负且整数总和严格闭合为 100%。支持数值数组与对象键值对。
   */
  function normalizeFrequencies(input) {
    if (!input) return Array.isArray(input) ? [100, 0, 0, 0] : { check: 100 };
    if (Array.isArray(input)) {
      if (input.length === 0) return [100, 0, 0, 0];
      const raw = input.map(x => {
        const n = Number(x);
        return (Number.isFinite(n) && n > 0) ? n : 0;
      });
      const sum = raw.reduce((a, b) => a + b, 0);
      if (sum <= 0) {
        const res = new Array(raw.length).fill(0);
        res[0] = 100;
        return res;
      }
      const normalized = raw.map(x => (x / sum) * 100);
      const floors = normalized.map(Math.floor);
      let rem = 100 - floors.reduce((a, b) => a + b, 0);
      const diffs = normalized.map((x, i) => ({ idx: i, diff: x - floors[i] }))
                              .sort((a, b) => b.diff - a.diff);
      for (let i = 0; i < rem; i++) {
        floors[diffs[i].idx]++;
      }
      return floors;
    }

    if (typeof input === 'object') {
      const keys = Object.keys(input);
      if (keys.length === 0) return { check: 100 };
      let rawSum = 0;
      const validValues = {};
      keys.forEach(k => {
        const rawNum = Number(input[k]);
        const v = (Number.isFinite(rawNum) && rawNum > 0) ? rawNum : 0;
        validValues[k] = v;
        rawSum += v;
      });
      if (rawSum <= 0) {
        const res = {};
        keys.forEach((k, i) => { res[k] = (i === 0 ? 100 : 0); });
        return res;
      }
      let sum = 0;
      const integerParts = {};
      const remainders = [];
      keys.forEach(k => {
        const normalized = (validValues[k] / rawSum) * 100;
        const fl = Math.floor(normalized);
        integerParts[k] = fl;
        sum += fl;
        remainders.push({ k, rem: normalized - fl });
      });
      remainders.sort((a, b) => b.rem - a.rem);
      let deficit = 100 - sum;
      let idx = 0;
      while (deficit > 0 && idx < remainders.length) {
        integerParts[remainders[idx].k]++;
        deficit--;
        idx++;
      }
      return integerParts;
    }

    return { check: 100 };
  }

  /**
   * 非均匀深度频率线性插值
   */
  function interpolateGtoFrequencies(vLo, vHi, weight) {
    const raw = [
      Math.max(0, vLo[0] * (1 - weight) + vHi[0] * weight),
      Math.max(0, vLo[1] * (1 - weight) + vHi[1] * weight),
      Math.max(0, vLo[2] * (1 - weight) + vHi[2] * weight),
      Math.max(0, vLo[3] * (1 - weight) + vHi[3] * weight)
    ];
    return normalizeFrequencies(raw);
  }

  /**
   * 查找矩阵中指定位置与动作序列的可用深度列表
   */
  function findAvailableGtoDepths(matrix, heroPos, seqKey) {
    const effPos = (seqKey === 'RFI' && heroPos === 'HJ') ? 'MP' : ((seqKey === 'RFI' && heroPos === 'LJ') ? 'UTG' : heroPos);
    const cacheKey = `${effPos}_${seqKey}`;
    if (_gtoDepthsCache[cacheKey]) return _gtoDepthsCache[cacheKey];
    const keys = Object.keys(matrix.nodes || {});
    const suffix1 = `_${effPos}_${seqKey}`;
    let matched = keys.filter(k => k.endsWith(suffix1));
    if (matched.length === 0 && seqKey === 'vs_MP_RFI') {
      matched = keys.filter(k => k.endsWith(`_${effPos}_vs_UTG1_RFI`));
    }
    if (matched.length === 0 && (seqKey === 'vs_UTG1_RFI' || seqKey === 'vs_U+1_RFI')) {
      matched = keys.filter(k => k.endsWith(`_${effPos}_vs_UTG_RFI`));
    }
    if (matched.length === 0 && (seqKey === 'SQUEEZE' || seqKey.includes('SQUEEZE'))) {
      matched = keys.filter(k => k.includes(`_${effPos}_SQUEEZE`));
    }
    if (matched.length === 0 && (seqKey === 'COLD_4BET' || seqKey.includes('COLD_4BET'))) {
      matched = keys.filter(k => k.includes(`_${effPos}_COLD_4BET`));
    }
    if (matched.length === 0) return null;
    const depths = matched.map(k => parseFloat(k.split('_')[0])).filter(d => !isNaN(d));
    const sorted = Array.from(new Set(depths)).sort((a, b) => a - b);
    _gtoDepthsCache[cacheKey] = sorted;
    return sorted;
  }

  /**
   * 获取推荐微尺寸与非标尺寸自适应信息 (v5.0 / Stage 3 v3.20)
   */
  function getGtoSizing(heroPos, vsPos, effStack, actionSeq = 'vs_RFI', facingBet = null, callersCount = 0, is6Max = false) {
    if (typeof effStack !== 'number' || isNaN(effStack) || effStack <= 0) return null;
    let effHeroPos = heroPos || 'CO';
    let effVsPos = vsPos || 'UTG';
    if (is6Max) {
      if (actionSeq === 'RFI') {
        if (heroPos === 'UTG') effHeroPos = 'LJ';
        else if (heroPos === 'MP') effHeroPos = 'HJ';
      } else if (actionSeq === 'vs_RFI') {
        if (vsPos === 'UTG') effVsPos = 'LJ';
        else if (vsPos === 'MP') effVsPos = 'HJ';
        if (heroPos === 'UTG') effHeroPos = 'LJ';
        else if (heroPos === 'MP') effHeroPos = 'HJ';
      }
    }

    let seqKey = actionSeq;
    if (actionSeq === 'vs_RFI') seqKey = `vs_${effVsPos}_RFI`;
    else if (actionSeq === 'vs_3BET' || actionSeq === 'vs_3Bet') seqKey = `vs_${effVsPos}_3BET`;

    const depths = [8, 10, 12, 15, 20, 25, 30, 35, 40, 60];
    let loDepth = 8, hiDepth = 60;
    for (let i = 0; i < depths.length; i++) {
      if (depths[i] <= effStack) loDepth = depths[i];
      if (depths[i] >= effStack) { hiDepth = depths[i]; break; }
    }

    const matrix = loadGtoMatrix();
    let baselineSizing = null;

    // 1. 优先查表 matrix.sizings 获取 GTO Wizard 解算真值
    if (matrix && matrix.sizings) {
      const candidateKeys = [];
      if (actionSeq === 'RFI') {
        if (is6Max) candidateKeys.push(`${loDepth}_${effHeroPos}_6M_RFI`);
        candidateKeys.push(`${loDepth}_${effHeroPos}_RFI`);
      } else if (actionSeq === 'vs_RFI') {
        candidateKeys.push(`${loDepth}_${effHeroPos}_vs_${effVsPos}_RFI`);
        if (effVsPos === 'MP') candidateKeys.push(`${loDepth}_${effHeroPos}_vs_UTG1_RFI`);
        if (effVsPos === 'UTG1' || effVsPos === 'U+1') candidateKeys.push(`${loDepth}_${effHeroPos}_vs_UTG_RFI`);
      } else if (actionSeq === 'SQUEEZE' || actionSeq.includes('SQUEEZE')) {
        candidateKeys.push(`${loDepth}_${effHeroPos}_SQUEEZE_vs_${effVsPos}`);
        candidateKeys.push(`${loDepth}_${effHeroPos}_SQUEEZE`);
      } else if (actionSeq === 'vs_3BET' || actionSeq === 'vs_3Bet') {
        candidateKeys.push(`${loDepth}_${effHeroPos}_FACING_3BET_vs_${effVsPos}`);
        candidateKeys.push(`${loDepth}_${effHeroPos}_vs_${effVsPos}_3BET`);
      } else if (actionSeq === 'COLD_4BET' || actionSeq === 'COLD_4Bet') {
        candidateKeys.push(`${loDepth}_${effHeroPos}_COLD_4BET_vs_${effVsPos}`);
      } else if (actionSeq === 'vs_4BET' || actionSeq === 'vs_4Bet') {
        candidateKeys.push(`${loDepth}_${effHeroPos}_FACING_4BET_vs_${effVsPos}`);
        candidateKeys.push(`${loDepth}_${effHeroPos}_vs_${effVsPos}_4BET`);
      } else if (actionSeq === 'vs_LIMP') {
        candidateKeys.push(`${loDepth}_${effHeroPos}_vs_SB_LIMP`);
        candidateKeys.push(`${loDepth}_${effHeroPos}_vs_LIMP`);
      }

      for (const k of candidateKeys) {
        if (typeof matrix.sizings[k] === 'number') {
          baselineSizing = matrix.sizings[k] === 999 ? effStack : matrix.sizings[k];
          break;
        }
      }

      if (baselineSizing === null && loDepth !== hiDepth) {
        const hiCandidateKeys = candidateKeys.map(k => k.replace(new RegExp(`^${loDepth}_`), `${hiDepth}_`));
        for (const k of hiCandidateKeys) {
          if (typeof matrix.sizings[k] === 'number') {
            baselineSizing = matrix.sizings[k] === 999 ? effStack : matrix.sizings[k];
            break;
          }
        }
      }
    }

    // 2. 若当前节点未精确收录，启动 GTO Wizard 官方微尺寸几何推导中枢
    if (typeof baselineSizing !== 'number') {
      if (actionSeq === 'RFI') {
        if (effStack <= 15) {
          baselineSizing = 2.0;
        } else if (effHeroPos === 'SB') {
          baselineSizing = effStack >= 40 ? 3.0 : 2.5;
        } else if (effHeroPos === 'BTN') {
          baselineSizing = effStack >= 40 ? 2.2 : 2.1;
        } else if (effHeroPos === 'CO') {
          baselineSizing = 2.2;
        } else {
          baselineSizing = 2.0;
        }
      } else if (actionSeq === 'vs_RFI') {
        const isIP = (effHeroPos === 'BTN' ||
                      (effHeroPos === 'CO' && effVsPos !== 'BTN') ||
                      (effHeroPos === 'HJ' && ['UTG', 'UTG1', 'MP', 'LJ'].includes(effVsPos)) ||
                      (effHeroPos === 'LJ' && ['UTG', 'UTG1', 'MP'].includes(effVsPos)));
        if (effStack <= 15) {
          baselineSizing = effStack; // ≤15BB 浅码直接触发全推
        } else if (effStack <= 25) {
          baselineSizing = isIP ? 5.5 : 7.5;
        } else {
          baselineSizing = isIP ? 6.5 : (effHeroPos === 'BB' ? 8.92 : 9.0);
        }
      } else if (actionSeq === 'SQUEEZE' || actionSeq.includes('SQUEEZE')) {
        const isIP = effHeroPos === 'BTN' || effHeroPos === 'CO';
        const base = isIP ? 6.5 : (effHeroPos === 'BB' ? 10.0 : 9.0);
        baselineSizing = Number((base + (callersCount || 1) * (facingBet || 2.2)).toFixed(1));
      } else if (actionSeq.includes('3BET') || actionSeq === 'vs_3BET') {
        if (effStack <= 25) {
          baselineSizing = effStack;
        } else {
          baselineSizing = (effHeroPos === 'BTN' || effHeroPos === 'CO') ? 18.0 : 21.0;
        }
      } else if (actionSeq.includes('4BET') || actionSeq === 'COLD_4BET') {
        if (effStack <= 25) {
          baselineSizing = effStack;
        } else {
          baselineSizing = 20.0;
        }
      } else {
        baselineSizing = 2.2;
      }
    }

    // 3. 非标尺寸自适应 (Non-standard Sizing Adaptation & Pot Odds Scaling)
    let adaptiveSizing = baselineSizing;
    let isNonStandard = false;
    let oddsDelta = 0;
    let defendMult = 1.0;
    const baseOpen = (actionSeq === 'RFI') ? baselineSizing : (effStack <= 15 ? 2.0 : 2.2);

    if (actionSeq === 'vs_RFI' && typeof facingBet === 'number' && facingBet > 0 && Math.abs(facingBet - baseOpen) > 0.25) {
      isNonStandard = true;
      const isIP = (effHeroPos === 'BTN' || (effHeroPos === 'CO' && effVsPos !== 'BTN') || (effHeroPos === 'HJ' && ['UTG', 'UTG1', 'LJ'].includes(effVsPos)));
      const mult = isIP ? 3.0 : 4.0;
      adaptiveSizing = Number((facingBet * mult + (callersCount || 0) * facingBet).toFixed(1));

      // 筹码门槛截断：若加注额达有效筹码 55%，MTT 博弈论直接转化为全推 All-in Jam
      if (adaptiveSizing >= 0.55 * effStack) {
        adaptiveSizing = effStack;
      }

      // 底池赔率恶化/改善与频率补偿测算
      const pot0 = baseOpen + 1.5 + 1.0; // 基准底池（含盲注与前注）
      const call0 = Math.max(0, baseOpen - (effHeroPos === 'BB' ? 1.0 : effHeroPos === 'SB' ? 0.5 : 0));
      const odds0 = call0 / (pot0 + call0);

      const potAct = facingBet + 1.5 + 1.0 + (callersCount || 0) * facingBet;
      const callAct = Math.max(0, facingBet - (effHeroPos === 'BB' ? 1.0 : effHeroPos === 'SB' ? 0.5 : 0));
      const oddsAct = callAct / (potAct + callAct);

      oddsDelta = Number(((oddsAct - odds0) * 100).toFixed(1));
      // 当赔率变差时 (oddsAct > odds0)，defendMult < 1.0 收紧；反之放宽
      defendMult = Number(Math.max(0.60, Math.min(1.30, odds0 / oddsAct)).toFixed(2));
    }

    return {
      baselineSizing: Number(baselineSizing.toFixed(1)),
      sizing: Number(adaptiveSizing.toFixed(1)),
      isNonStandard,
      facingBet: typeof facingBet === 'number' ? facingBet : baseOpen,
      baselineOpen: baseOpen,
      oddsDelta,
      defendMult
    };
  }

  /**
   * 翻前博弈节点与请求覆盖状态权威仲裁 (resolvePreflopMatch)
   * 严格区分来源精度与请求适用性，彻底杜绝非标尺寸冒充 exact 与 EV 错配 (D-134 / Task 1)
   */
  function resolvePreflopMatch(context, nodeMeta) {
    const hasNode = nodeMeta && !!nodeMeta.hasNode;
    const isDepthExact = nodeMeta && !!nodeMeta.isDepthExact;
    const isNonStandard = context && !!context.isNonStandard;
    const facingBet = context && context.facingBet != null ? context.facingBet : null;
    const baselineOpen = context && context.baselineOpen != null ? context.baselineOpen : 2.2;

    if (!hasNode) {
      return {
        status: 'unsupported',
        isReference: false,
        reason: '未收录该博弈节点',
        strategyApplicable: false,
        evApplicable: false
      };
    }

    if (isNonStandard) {
      return {
        status: 'reference',
        isReference: true,
        reason: `非标开池尺度 (${facingBet}BB 偏离基准 ${baselineOpen}BB)，基于标准解提供参考基准`,
        strategyApplicable: true,
        evApplicable: false // 官方无非标开池原生 EV，禁止冒用标准 EV
      };
    }

    return {
      status: isDepthExact ? 'exact' : 'interpolated',
      isReference: false,
      reason: isDepthExact ? 'GTO Wizard 求解器精准匹配' : '相邻深度线性插值',
      strategyApplicable: true,
      evApplicable: true
    };
  }

  /**
   * 翻前静态 GTO 策略矩阵主查询函数 (queryGtoPreflop)
   */
  function queryGtoPreflop(heroPos, vsPos, effStack, hand, actionSeq = 'vs_RFI', facingBet = null, callersCount = 0) {
    if (typeof effStack !== 'number' || isNaN(effStack) || !Number.isFinite(effStack)) return null;
    if (typeof hand !== 'string' || !VALID_GTO_HAND_REGEX.test(hand.trim())) return null;
    const cleanHand = hand.trim();

    const matrix = loadGtoMatrix();
    if (!matrix || !matrix.nodes) return null;

    let effHeroPos = heroPos;
    let effVsPos = vsPos;

    // 桌型相对位置映射（6-max / 8-max / 9-max 自适应）：
    const cfg = (typeof globalThis !== 'undefined' && globalThis.gameConfig) ||
                (typeof window !== 'undefined' && window.gameConfig);
    const is6Max = typeof cfg !== 'undefined' && cfg.tableSize === '6max';
    const is9Max = typeof cfg !== 'undefined' && cfg.tableSize === '9max';

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
    } else if (is9Max) {
      if (actionSeq === 'RFI') {
        if (heroPos === 'MP') effHeroPos = 'UTG1';
        else if (heroPos === 'UTG1' || heroPos === 'U+1') effHeroPos = 'UTG';
      }
      if (actionSeq === 'vs_RFI') {
        if (vsPos === 'MP') effVsPos = 'UTG1';
        else if (vsPos === 'UTG1' || vsPos === 'U+1') effVsPos = 'UTG';
        if (heroPos === 'MP') effHeroPos = 'UTG1';
      }
      if (actionSeq === 'SQUEEZE' || (actionSeq && actionSeq.includes('SQUEEZE'))) {
        if (vsPos === 'MP') effVsPos = 'UTG1';
        else if (vsPos === 'UTG1' || vsPos === 'U+1') effVsPos = 'UTG1';
        else if (vsPos === 'UTG') effVsPos = 'UTG';
        if (heroPos === 'MP') effHeroPos = 'UTG1';
      }
    }

    let seqKey = actionSeq;
    if (actionSeq === 'vs_RFI') seqKey = `vs_${effVsPos}_RFI`;
    else if (actionSeq === 'vs_3BET' || actionSeq === 'vs_3Bet') seqKey = `vs_${effVsPos}_3BET`;

    const depths = findAvailableGtoDepths(matrix, effHeroPos, seqKey) || (matrix.depths || [8, 10, 12, 15, 20, 25, 30, 35, 40, 60, 80, 100]);
    if (!depths || !depths.length) return null;
    const minD = depths[0], maxD = depths[depths.length - 1];
    const effLookup = Math.max(minD, Math.min(maxD, effStack));

    let loDepth = depths[0], hiDepth = depths[depths.length - 1];
    for (let i = 0; i < depths.length; i++) {
      if (depths[i] <= effLookup) loDepth = depths[i];
      if (depths[i] >= effLookup) { hiDepth = depths[i]; break; }
    }

    function getNode(depth) {
      if (!matrix.nodes) return {};
      if (seqKey === 'SQUEEZE' || seqKey.includes('SQUEEZE')) {
        if (effVsPos && matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_${effVsPos}`]) return matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_${effVsPos}`];
        if (effVsPos && matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_${effVsPos}1`]) return matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_${effVsPos}1`];
        if (effVsPos === 'UTG1' && matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_UTG`]) return matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_UTG`];
        if (effVsPos === 'UTG' && matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_UTG1`]) return matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_UTG1`];
        if (matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_UTG_BTN`]) return matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_UTG_BTN`];
        if (matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE`]) return matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE`];
      }
      let k = `${depth}_${effHeroPos}_${seqKey}`;
      if (matrix.nodes[k]) return matrix.nodes[k];
      if (seqKey.startsWith('vs_') && seqKey.endsWith('_RFI')) {
        if ((effVsPos === 'MP' || vsPos === 'MP') && matrix.nodes[`${depth}_${effHeroPos}_vs_UTG1_RFI`]) return matrix.nodes[`${depth}_${effHeroPos}_vs_UTG1_RFI`];
        if ((effVsPos === 'UTG1' || effVsPos === 'U+1' || vsPos === 'UTG1' || vsPos === 'U+1') && matrix.nodes[`${depth}_${effHeroPos}_vs_UTG_RFI`]) return matrix.nodes[`${depth}_${effHeroPos}_vs_UTG_RFI`];
        if (effHeroPos === 'LJ' && matrix.nodes[`${depth}_MP_${seqKey}`]) return matrix.nodes[`${depth}_MP_${seqKey}`];
        if (effHeroPos === 'HJ' && matrix.nodes[`${depth}_MP_${seqKey}`]) return matrix.nodes[`${depth}_MP_${seqKey}`];
      }
      if (seqKey === 'RFI') {
        if (matrix.nodes[`${depth}_${effHeroPos}_RFI`]) return matrix.nodes[`${depth}_${effHeroPos}_RFI`];
        if (effHeroPos === 'HJ' && matrix.nodes[`${depth}_MP_RFI`]) return matrix.nodes[`${depth}_MP_RFI`];
        if (effHeroPos === 'MP' && matrix.nodes[`${depth}_HJ_RFI`]) return matrix.nodes[`${depth}_HJ_RFI`];
        if (effHeroPos === 'LJ' && matrix.nodes[`${depth}_UTG_RFI`]) return matrix.nodes[`${depth}_UTG_RFI`];
        if (effHeroPos === 'UTG' && matrix.nodes[`${depth}_UTG_6M_RFI`]) return matrix.nodes[`${depth}_UTG_6M_RFI`];
      }
      if (seqKey === 'SQUEEZE' || seqKey.includes('SQUEEZE')) {
        if (matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_${effVsPos}`]) return matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_${effVsPos}`];
        if (matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_${effVsPos}1`]) return matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_${effVsPos}1`];
        if (matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_UTG_BTN`]) return matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_UTG_BTN`];
        if (matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE`]) return matrix.nodes[`${depth}_${effHeroPos}_SQUEEZE`];
      }
      if (seqKey.includes('COLD_4BET')) {
        if (matrix.nodes[`${depth}_${effHeroPos}_COLD_4BET_vs_${effVsPos}1`]) return matrix.nodes[`${depth}_${effHeroPos}_COLD_4BET_vs_${effVsPos}1`];
        if (matrix.nodes[`${depth}_${effHeroPos}_COLD_4BET_vs_${effVsPos}`]) return matrix.nodes[`${depth}_${effHeroPos}_COLD_4BET_vs_${effVsPos}`];
        if (matrix.nodes[`${depth}_${effHeroPos}_COLD_4BET`]) return matrix.nodes[`${depth}_${effHeroPos}_COLD_4BET`];
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
      return null;
    }

    const rawLo = nodeLo[cleanHand] || (hasLo ? [100, 0, 0, 0] : null);
    const rawHi = nodeHi[cleanHand] || (hasHi ? [100, 0, 0, 0] : null);

    const cLo = rawLo ? sanitizeGtoVector(rawLo) : null;
    const cHi = rawHi ? sanitizeGtoVector(rawHi) : null;

    let resultVec = null;
    if (loDepth === hiDepth) {
      resultVec = cLo || cHi;
    } else if (!cLo || !cHi) {
      return null;
    } else {
      const weight = (effLookup - loDepth) / (hiDepth - loDepth);
      resultVec = interpolateGtoFrequencies(cLo, cHi, weight);
    }

    // 动态 ICM 风险溢价调整 (DEF-ICM-GTO / Stage 2 v3.19)
    const getIcmFn = (typeof globalThis !== 'undefined' && globalThis.getICM313Context) ||
                     (typeof window !== 'undefined' && window.getICM313Context);
    if (resultVec && typeof getIcmFn === 'function' && typeof cfg !== 'undefined') {
      const hs = (typeof globalThis !== 'undefined' && typeof globalThis.globalHeroStack !== 'undefined') ? globalThis.globalHeroStack : effStack;
      const vs = (typeof globalThis !== 'undefined' && typeof globalThis.globalVillainStack !== 'undefined') ? globalThis.globalVillainStack : effStack;
      const avg = (typeof globalThis !== 'undefined' && typeof globalThis.globalAvgStack !== 'undefined' && globalThis.globalAvgStack > 0) ? globalThis.globalAvgStack : effStack;
      const icm = getIcmFn(hs, vs, avg, cfg.stage);
      if (icm && icm.isICMStage && icm.riskPremium > 0) {
        const rp = Math.min(0.40, icm.riskPremium / 100);
        if (resultVec[1] > 0 && resultVec[0] < 100) {
          const shiftCall = Math.round(resultVec[1] * Math.min(1.0, rp * 1.5));
          if (shiftCall > 0) {
            resultVec[1] = Math.max(0, resultVec[1] - shiftCall);
            resultVec[0] = Math.min(100, resultVec[0] + shiftCall);
          }
        }
        if (resultVec[3] > 0 && resultVec[0] < 100) {
          const shiftJam = Math.round(resultVec[3] * Math.min(0.8, rp * 2.0));
          if (shiftJam > 0) {
            resultVec[3] = Math.max(0, resultVec[3] - shiftJam);
            resultVec[0] = Math.min(100, resultVec[0] + shiftJam);
          }
        }
        if (resultVec[2] > 0 && resultVec[0] < 100) {
          const shiftRaise = Math.round(resultVec[2] * Math.min(0.4, rp * 1.0));
          if (shiftRaise > 0) {
            resultVec[2] = Math.max(0, resultVec[2] - shiftRaise);
            resultVec[0] = Math.min(100, resultVec[0] + shiftRaise);
          }
        }
        const cleanVec = sanitizeGtoVector(resultVec);
        if (cleanVec) {
          for (let i = 0; i < 4; i++) resultVec[i] = cleanVec[i];
        }
      }
    }

    // Dimension 2: 绑定求解器精准微尺寸与非标尺寸自适应 (v5.0 / Stage 3 v3.20)
    const sizingInfo = getGtoSizing(effHeroPos, effVsPos, effStack, actionSeq, facingBet, callersCount, is6Max);
    if (resultVec && sizingInfo) {
      resultVec.sizing = sizingInfo.sizing;
      resultVec.sizingInfo = sizingInfo;
      // 注意：彻底废除无扑克数学依据的伪缩放公式（停止人为制造 AA 17% 弃牌，D-134 / Task 1）：
      // 严禁将加注/跟注频率粗暴打折转入 Fold！保持求解器原生向量作为真实或参考基准。
    } else if (resultVec && matrix && matrix.sizings) {
      const sizingKey = `${loDepth}_${effHeroPos}_${seqKey}`;
      const matchedSizing = matrix.sizings[sizingKey] ||
          matrix.sizings[`${loDepth}_${effHeroPos}_FACING_3BET_vs_${effVsPos}`] ||
          matrix.sizings[`${loDepth}_${effHeroPos}_RFI`];
      if (typeof matchedSizing === 'number') {
        resultVec.sizing = matchedSizing;
      }
    }

    if (resultVec) {
      const isNonStandard = !!(sizingInfo && sizingInfo.isNonStandard);
      const matchResult = resolvePreflopMatch({
        heroPos: effHeroPos,
        vsPos: effVsPos,
        effStack,
        actionSeq,
        facingBet,
        baselineOpen: sizingInfo ? sizingInfo.baselineOpen : 2.2,
        isNonStandard
      }, {
        hasNode: !!(nodeLo || nodeHi),
        isDepthExact: loDepth === hiDepth
      });

      resultVec.frequencies = [resultVec[0], resultVec[1], resultVec[2], resultVec[3]];
      resultVec.source = 'GTO_MATRIX';
      resultVec.coverageStatus = matchResult.status;
      resultVec.isReference = (matchResult.status === 'reference');
      resultVec.matchResult = matchResult;
      resultVec.toStructured = function() {
        return {
          frequencies: [this[0], this[1], this[2], this[3]],
          sizing: this.sizing,
          sizingInfo: this.sizingInfo,
          source: this.source,
          coverageStatus: this.coverageStatus,
          isReference: this.isReference,
          matchResult: this.matchResult
        };
      };
      resultVec.toJSON = function() {
        return this.toStructured();
      };
    }

    return resultVec;
  }

  /**
   * 翻前 GTO 期望值 (EV) 与动态 ICM 风险溢价模型 (queryGtoEv)
   */
  function queryGtoEv(heroPos, vsPos, effStack, hand, actionSeq = 'vs_RFI', heroStack = null, villainStack = null, avgStack = null, stage = null, facingBet = null, callersCount = 0) {
    if (typeof effStack !== 'number' || isNaN(effStack) || !Number.isFinite(effStack)) return null;
    if (typeof hand !== 'string' || !VALID_GTO_HAND_REGEX.test(hand.trim())) return null;
    const cleanHand = hand.trim();

    // 针对非标开池尺度且非动态 ICM 测算模式：标准求解器加注 EV 与非标自适应尺寸不匹配，严禁拼接冒用 (D-134 / Task 1)
    const isICMStage = stage && stage !== 'normal';
    const baseOpen = (actionSeq === 'RFI') ? 2.0 : (effStack <= 15 ? 2.0 : 2.2);
    if (!isICMStage && actionSeq === 'vs_RFI' && typeof facingBet === 'number' && facingBet > 0 && Math.abs(facingBet - baseOpen) > 0.25) {
      return null;
    }

    const evMatrix = loadGtoEvMatrix();
    if (!evMatrix || !evMatrix.nodes) return null;

    let effHeroPos = heroPos;
    let effVsPos = vsPos;

    const cfg = (typeof globalThis !== 'undefined' && globalThis.gameConfig) ||
                (typeof window !== 'undefined' && window.gameConfig);
    const is6Max = typeof cfg !== 'undefined' && cfg.tableSize === '6max';
    const is9Max = typeof cfg !== 'undefined' && cfg.tableSize === '9max';

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
    } else if (is9Max) {
      if (actionSeq === 'RFI') {
        if (heroPos === 'MP') effHeroPos = 'UTG1';
        else if (heroPos === 'UTG1' || heroPos === 'U+1') effHeroPos = 'UTG';
      }
      if (actionSeq === 'vs_RFI') {
        if (vsPos === 'MP') effVsPos = 'UTG1';
        else if (vsPos === 'UTG1' || vsPos === 'U+1') effVsPos = 'UTG';
        if (heroPos === 'MP') effHeroPos = 'UTG1';
      }
      if (actionSeq === 'SQUEEZE' || (actionSeq && actionSeq.includes('SQUEEZE'))) {
        if (vsPos === 'MP') effVsPos = 'UTG1';
        else if (vsPos === 'UTG1' || vsPos === 'U+1') effVsPos = 'UTG1';
        else if (vsPos === 'UTG') effVsPos = 'UTG';
        if (heroPos === 'MP') effHeroPos = 'UTG1';
      }
    }

    let seqKey = actionSeq;
    if (actionSeq === 'vs_RFI') seqKey = `vs_${effVsPos}_RFI`;
    else if (actionSeq === 'vs_3BET' || actionSeq === 'vs_3Bet') seqKey = `vs_${effVsPos}_3BET`;

    const depths = evMatrix.depths || [8, 10, 12, 15, 20, 25, 30, 35, 40, 60, 80, 100];
    const minD = depths[0], maxD = depths[depths.length - 1];
    const effLookup = Math.max(minD, Math.min(maxD, effStack));

    let loDepth = depths[0], hiDepth = depths[depths.length - 1];
    for (let i = 0; i < depths.length; i++) {
      if (depths[i] <= effLookup) loDepth = depths[i];
      if (depths[i] >= effLookup) { hiDepth = depths[i]; break; }
    }

    function getEvNode(depth) {
      if (!evMatrix.nodes) return {};
      if (seqKey === 'SQUEEZE' || seqKey.includes('SQUEEZE')) {
        if (effVsPos && evMatrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_${effVsPos}`]) return evMatrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_${effVsPos}`];
        if (effVsPos && evMatrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_${effVsPos}1`]) return evMatrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_${effVsPos}1`];
        if (effVsPos === 'UTG1' && evMatrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_UTG`]) return evMatrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_UTG`];
        if (effVsPos === 'UTG' && evMatrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_UTG1`]) return evMatrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_UTG1`];
        if (evMatrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_UTG_BTN`]) return evMatrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_UTG_BTN`];
        if (evMatrix.nodes[`${depth}_${effHeroPos}_SQUEEZE`]) return evMatrix.nodes[`${depth}_${effHeroPos}_SQUEEZE`];
      }
      let k = `${depth}_${effHeroPos}_${seqKey}`;
      if (evMatrix.nodes[k]) return evMatrix.nodes[k];
      if (seqKey.startsWith('vs_') && seqKey.endsWith('_RFI')) {
        if ((effVsPos === 'MP' || vsPos === 'MP') && evMatrix.nodes[`${depth}_${effHeroPos}_vs_UTG1_RFI`]) return evMatrix.nodes[`${depth}_${effHeroPos}_vs_UTG1_RFI`];
        if ((effVsPos === 'UTG1' || effVsPos === 'U+1' || vsPos === 'UTG1' || vsPos === 'U+1') && evMatrix.nodes[`${depth}_${effHeroPos}_vs_UTG_RFI`]) return evMatrix.nodes[`${depth}_${effHeroPos}_vs_UTG_RFI`];
        if (effHeroPos === 'LJ' && evMatrix.nodes[`${depth}_MP_${seqKey}`]) return evMatrix.nodes[`${depth}_MP_${seqKey}`];
        if (effHeroPos === 'HJ' && evMatrix.nodes[`${depth}_MP_${seqKey}`]) return evMatrix.nodes[`${depth}_MP_${seqKey}`];
      }
      if (seqKey === 'SQUEEZE' || seqKey.includes('SQUEEZE')) {
        if (evMatrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_${effVsPos}`]) return evMatrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_${effVsPos}`];
        if (evMatrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_${effVsPos}1`]) return evMatrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_${effVsPos}1`];
        if (evMatrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_UTG_BTN`]) return evMatrix.nodes[`${depth}_${effHeroPos}_SQUEEZE_vs_UTG_BTN`];
        if (evMatrix.nodes[`${depth}_${effHeroPos}_SQUEEZE`]) return evMatrix.nodes[`${depth}_${effHeroPos}_SQUEEZE`];
      }
      if (seqKey.includes('COLD_4BET')) {
        if (evMatrix.nodes[`${depth}_${effHeroPos}_COLD_4BET_vs_${effVsPos}1`]) return evMatrix.nodes[`${depth}_${effHeroPos}_COLD_4BET_vs_${effVsPos}1`];
        if (evMatrix.nodes[`${depth}_${effHeroPos}_COLD_4BET_vs_${effVsPos}`]) return evMatrix.nodes[`${depth}_${effHeroPos}_COLD_4BET_vs_${effVsPos}`];
        if (evMatrix.nodes[`${depth}_${effHeroPos}_COLD_4BET`]) return evMatrix.nodes[`${depth}_${effHeroPos}_COLD_4BET`];
      }
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

    let rawEvVec = null;
    if (loDepth === hiDepth || !nodeLo || !nodeHi) {
      rawEvVec = (nodeLo ? evLo : evHi).slice();
    } else {
      const weight = (effLookup - loDepth) / (hiDepth - loDepth);
      rawEvVec = [
        Number((evLo[0] * (1 - weight) + evHi[0] * weight).toFixed(2)),
        Number((evLo[1] * (1 - weight) + evHi[1] * weight).toFixed(2)),
        Number((evLo[2] * (1 - weight) + evHi[2] * weight).toFixed(2)),
        Number((evLo[3] * (1 - weight) + evHi[3] * weight).toFixed(2))
      ];
    }

    // 1. 纯筹码期望值 (ChipEV): Fold 恒为 0.00BB
    const cEV = [
      0.00,
      Number(rawEvVec[1].toFixed(2)),
      Number(rawEvVec[2].toFixed(2)),
      Number(rawEvVec[3].toFixed(2))
    ];

    // 2. 动态 ICM 风险溢价评估 (Pokercode ICM 3-1-3)
    const hs = (heroStack != null) ? heroStack : ((typeof globalThis !== 'undefined' && typeof globalThis.globalHeroStack !== 'undefined') ? globalThis.globalHeroStack : effStack);
    const vs = (villainStack != null) ? villainStack : ((typeof globalThis !== 'undefined' && typeof globalThis.globalVillainStack !== 'undefined') ? globalThis.globalVillainStack : effStack);
    const avg = (avgStack != null && avgStack > 0) ? avgStack : ((typeof globalThis !== 'undefined' && typeof globalThis.globalAvgStack !== 'undefined' && globalThis.globalAvgStack > 0) ? globalThis.globalAvgStack : (hs || effStack || 40));
    const stg = stage || (typeof cfg !== 'undefined' && cfg.stage ? cfg.stage : 'normal');

    const getIcmFn = (typeof globalThis !== 'undefined' && globalThis.getICM313Context) ||
                     (typeof window !== 'undefined' && window.getICM313Context);
    const icm = (typeof getIcmFn === 'function') ? getIcmFn(hs, vs, avg, stg) : null;
    const isICM = !!(icm && icm.isICMStage && icm.riskPremium > 0);
    const rp = isICM ? Math.min(0.50, icm.riskPremium / 100) : 0.0;

    // 3. 风险筹码测算 (RiskPot): 各动作置于险境的筹码量
    const riskPotFold = 0.0;
    let baseCall = 2.2;
    if (typeof facingBet === 'number' && facingBet > 0) {
      baseCall = facingBet;
    } else if (actionSeq === 'RFI') {
      baseCall = 1.0;
    } else if (seqKey.includes('3BET')) {
      baseCall = 6.5;
    } else if (seqKey.includes('4BET')) {
      baseCall = 18.0;
    } else if (seqKey.includes('SQUEEZE')) {
      baseCall = 8.0;
    }
    const riskPotCall = Number(Math.min(effStack, baseCall).toFixed(2));

    // Raise 尺寸
    let baseRaise = 2.2;
    const sInfo = getGtoSizing(effHeroPos, effVsPos, effStack, actionSeq, facingBet, callersCount, is6Max);
    if (sInfo && sInfo.sizing) {
      baseRaise = sInfo.sizing;
    } else if (matrix && matrix.sizings) {
      const sizingKey = `${loDepth}_${effHeroPos}_${seqKey}`;
      const matchedSizing = matrix.sizings[sizingKey] ||
          matrix.sizings[`${loDepth}_${effHeroPos}_FACING_3BET_vs_${effVsPos}`] ||
          matrix.sizings[`${loDepth}_${effHeroPos}_RFI`];
      if (typeof matchedSizing === 'number') baseRaise = matchedSizing;
    } else if (seqKey.includes('3BET')) {
      baseRaise = 18.0;
    } else if (actionSeq === 'vs_RFI') {
      baseRaise = 6.5;
    }
    const riskPotRaise = Number(Math.min(effStack, baseRaise).toFixed(2));
    const riskPotJam = Number(effStack.toFixed(2));
    const riskPots = [0, riskPotCall, riskPotRaise, riskPotJam];

    // 4. ICM 惩罚项计算: Penalty = RP × RiskPot
    const penalties = [
      0.00,
      Number((rp * riskPotCall).toFixed(2)),
      Number((rp * riskPotRaise).toFixed(2)),
      Number((rp * riskPotJam).toFixed(2))
    ];

    // 5. ICM 净期望值: EV_ICM = EV_cEV - Penalty
    const icmEV = [
      0.00,
      Number((cEV[1] - penalties[1]).toFixed(2)),
      Number((cEV[2] - penalties[2]).toFixed(2)),
      Number((cEV[3] - penalties[3]).toFixed(2))
    ];

    const resultEv = isICM ? icmEV.slice() : cEV.slice();

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

    // 6. 反事实损失 (Counterfactual Loss)
    resultEv.loss = {
      F: Number((resultEv[0] - maxVal).toFixed(2)),
      C: Number((resultEv[1] - maxVal).toFixed(2)),
      R: Number((resultEv[2] - maxVal).toFixed(2)),
      RAI: Number((resultEv[3] - maxVal).toFixed(2))
    };
    const otherEvs = resultEv.filter((_, idx) => idx !== bestIdx);
    resultEv.suboptimalLoss = otherEvs.length > 0 ? Math.abs(Number((Math.max(...otherEvs) - maxVal).toFixed(2))) : 0;

    const maxCEv = Math.max(...cEV);
    resultEv.cLoss = {
      F: Number((cEV[0] - maxCEv).toFixed(2)),
      C: Number((cEV[1] - maxCEv).toFixed(2)),
      R: Number((cEV[2] - maxCEv).toFixed(2)),
      RAI: Number((cEV[3] - maxCEv).toFixed(2))
    };

    // 7. 挂载完整 ICM 证据链元数据
    resultEv.cEV = cEV;
    resultEv.icmEV = icmEV;
    resultEv.penalties = penalties;
    resultEv.riskPots = riskPots;
    resultEv.rp = rp;
    resultEv.rpPercent = icm ? icm.riskPremium : 0;
    resultEv.isICM = isICM;
    resultEv.icmPosture = icm ? icm.posture : 'normal';
    resultEv.ev_f = resultEv[0];
    resultEv.ev_c = resultEv[1];
    resultEv.ev_r = resultEv[2];
    resultEv.ev_j = resultEv[3];

    resultEv.evs = [resultEv[0], resultEv[1], resultEv[2], resultEv[3]];
    resultEv.toStructured = function() {
      return {
        evs: [this[0], this[1], this[2], this[3]],
        bestAction: this.bestAction,
        bestEv: this.bestEv,
        loss: this.loss,
        suboptimalLoss: this.suboptimalLoss,
        cLoss: this.cLoss,
        isICM: this.isICM,
        rpPercent: this.rpPercent,
        icmPosture: this.icmPosture
      };
    };
    resultEv.toJSON = function() {
      return this.toStructured();
    };

    return resultEv;
  }

  // Export to global / window
  global.loadGtoMatrix = loadGtoMatrix;
  global.loadGtoEvMatrix = loadGtoEvMatrix;
  global.sanitizeGtoVector = sanitizeGtoVector;
  global.sanitizeVector = sanitizeGtoVector; // 向后兼容旧命名
  global.normalizeFrequencies = normalizeFrequencies;
  global.closeFrequencies = normalizeFrequencies; // 统一归一化权威实现 (Issue 10)
  global.interpolateGtoFrequencies = interpolateGtoFrequencies;
  global.interpolateFrequencies = interpolateGtoFrequencies; // 向后兼容旧命名
  global.findAvailableGtoDepths = findAvailableGtoDepths;
  global.findAvailableDepths = findAvailableGtoDepths; // 向后兼容旧命名
  global.getGtoSizing = getGtoSizing;
  global.resolvePreflopMatch = resolvePreflopMatch;
  global.queryGtoPreflop = queryGtoPreflop;
  global.queryGtoEv = queryGtoEv;

  // Export to CommonJS / Node
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      loadGtoMatrix,
      loadGtoEvMatrix,
      sanitizeGtoVector,
      sanitizeVector: sanitizeGtoVector,
      normalizeFrequencies,
      closeFrequencies: normalizeFrequencies,
      interpolateGtoFrequencies,
      interpolateFrequencies: interpolateGtoFrequencies,
      findAvailableGtoDepths,
      findAvailableDepths: findAvailableGtoDepths,
      getGtoSizing,
      resolvePreflopMatch,
      queryGtoPreflop,
      queryGtoEv
    };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
