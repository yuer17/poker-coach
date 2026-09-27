// 翻后 Micro-LUT 极速查询引擎 (Phase 4 - Engine)
// 设计者：GPT-6-Astra (首席架构师) + Gemini (主程)
// 依据：TASK-ASTRA-036 架构白皮书：基于 TypedArray 预解策略矩阵的 O(1) 微秒级寻址引擎

(function(global) {
  function getBoardClassifier() {
    if (typeof global.classifyFlopToCluster === 'function' && typeof global.getFlopIndex === 'function') {
      return {
        classifyFlopToCluster: global.classifyFlopToCluster,
        cardStringToIndex: global.cardStringToIndex,
        getFlopIndex: global.getFlopIndex
      };
    }
    if (typeof require !== 'undefined') {
      try { return require('./postflop_board_classifier.js'); } catch(e) {}
    }
    return null;
  }

  function getHandBucketer() {
    if (typeof global.bucketHeroHand === 'function') {
      return { bucketHeroHand: global.bucketHeroHand };
    }
    if (typeof require !== 'undefined') {
      try { return require('./postflop_hand_bucketer.js'); } catch(e) {}
    }
    return null;
  }

  function getPostflopLut() {
    if (typeof global.lookupPostflopLutBytes === 'function') {
      return {
        lookupFlopClusterByIdx: global.lookupFlopClusterByIdx,
        lookupPostflopLutBytes: global.lookupPostflopLutBytes,
        POSTFLOP_POLICY_LUT: global.POSTFLOP_POLICY_LUT
      };
    }
    if (typeof require !== 'undefined') {
      try { return require('./postflop_lut.js'); } catch(e) {}
    }
    return null;
  }

  function isValidCard(c) {
    return typeof c === 'string' && c.length >= 2;
  }

  /**
   * 翻后 Micro-LUT 预解决策核心查询入口
   * @param {Array<string>} heroCards - 手牌两张，如 ['Td', '2d']
   * @param {Array<string>} boardCards - 公牌数组，至少 3 张，如 ['5d', '5h', '3c']
   * @param {Object} opts - 场景上下文参数 { spr, betRatio, isOOP, isPFR, is3Bet }
   * @returns {Object} 包含 primaryAction, frequencies, clusterId, subBucketId, latencyUs
   */
  function queryPostflopLut(heroCards, boardCards, opts = {}) {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    if (!Array.isArray(heroCards) || heroCards.length < 2 || !isValidCard(heroCards[0]) || !isValidCard(heroCards[1]) ||
        !Array.isArray(boardCards) || boardCards.length < 3 || boardCards.slice(0, 3).some(c => !isValidCard(c))) {
      return {
        status: 'INVALID_INPUT',
        primaryAction: 'CHECK',
        frequencies: { CHECK: 100 },
        latencyUs: 0
      };
    }

    const classifier = getBoardClassifier();
    const bucketer = getHandBucketer();
    const lut = getPostflopLut();

    if (!classifier || !bucketer || !lut) {
      return {
        status: 'ENGINE_NOT_LOADED',
        primaryAction: 'CHECK',
        frequencies: { CHECK: 100 },
        latencyUs: 0
      };
    }

    // 1. 牌面簇查询 (Colex 快速查表)
    let clusterId = 0;
    const c0 = classifier.cardStringToIndex(boardCards[0]);
    const c1 = classifier.cardStringToIndex(boardCards[1]);
    const c2 = classifier.cardStringToIndex(boardCards[2]);

    if (c0 >= 0 && c1 >= 0 && c2 >= 0 && typeof lut.lookupFlopClusterByIdx === 'function') {
      const flopIdx = classifier.getFlopIndex(c0, c1, c2);
      clusterId = lut.lookupFlopClusterByIdx(flopIdx);
    } else {
      clusterId = classifier.classifyFlopToCluster(boardCards).clusterId;
    }

    // 2. 手牌 24 细分子桶
    const buck = bucketer.bucketHeroHand(heroCards, boardCards);
    const subBucketId = buck.subBucketId !== undefined ? buck.subBucketId : 23;

    // 3. SPR 档位离散化 (0: <=1.5, 1: 1.5~4.0, 2: 4.0~8.0, 3: >8.0)
    const spr = opts.spr !== undefined ? opts.spr : 4.0;
    let sprTier = 2;
    if (spr <= 1.5) sprTier = 0;
    else if (spr <= 4.0) sprTier = 1;
    else if (spr <= 8.0) sprTier = 2;
    else sprTier = 3;

    // 4. 下注尺度离散化 (0: 面对过牌, 1: <=33%, 2: 34%~66%, 3: >=67%)
    const betRatio = opts.betRatio !== undefined ? opts.betRatio : 0;
    let sizeTier = 0;
    if (betRatio <= 0) sizeTier = 0;
    else if (betRatio <= 0.33) sizeTier = 1;
    else if (betRatio <= 0.66) sizeTier = 2;
    else sizeTier = 3;

    // 5. 上下文家族判定 (0..5)
    const is3Bet = !!opts.is3Bet;
    const isPFR = opts.isPFR !== undefined ? !!opts.isPFR : false;
    const isOOP = opts.isOOP !== undefined ? !!opts.isOOP : true;

    let contextId = 3; // 默认: 单次加注池不在位跟注者 (如 BB vs BTN)
    if (is3Bet) {
      contextId = isOOP ? 5 : 4;
    } else if (isPFR) {
      contextId = isOOP ? 2 : 0;
    } else {
      contextId = isOOP ? 3 : 1;
    }

    // 6. O(1) 预解矩阵内存查找
    const bytes = lut.lookupPostflopLutBytes(clusterId, subBucketId, sprTier, sizeTier, contextId);
    const pcts = bytes.map(b => Math.round((b / 255) * 100));

    // 归一化四舍五入残差，确保频率和严格等于 100%
    const sumPcts = pcts.reduce((a, b) => a + b, 0);
    pcts[0] += (100 - sumPcts);

    // 动作槽位映射
    const actionNames = (sizeTier === 0)
      ? ['CHECK', 'BET_SMALL', 'BET_LARGE', 'ALLIN']
      : ['FOLD', 'CALL', 'RAISE', 'ALLIN'];

    let maxIdx = 0;
    for (let i = 1; i < 4; i++) {
      if (pcts[i] > pcts[maxIdx]) maxIdx = i;
    }

    const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const latencyUs = Math.max(0.1, Number((t1 - t0) * 1000));

    return {
      status: 'MATCHED_LUT',
      clusterId,
      subBucketId,
      macroBucket: buck.bucket,
      sprTier,
      sizeTier,
      contextId,
      primaryAction: actionNames[maxIdx],
      frequencies: {
        [actionNames[0]]: pcts[0],
        [actionNames[1]]: pcts[1],
        [actionNames[2]]: pcts[2],
        [actionNames[3]]: pcts[3]
      },
      latencyUs: Number(latencyUs.toFixed(2))
    };
  }

  /**
   * Fedor Holz 相对权益比与动态保本点 R_c 计算
   * R = N * e, R_c = N * (b / (1 + 2b))
   */
  function calculateFedorRc(equityPct, potBeforeBet, betAmount, numPlayers = 2) {
    const e = (equityPct || 0) / 100;
    const b = (potBeforeBet > 0) ? (betAmount / potBeforeBet) : 0;
    const R = numPlayers * e;
    const Rc = (1 + 2 * b > 0) ? (numPlayers * (b / (1 + 2 * b))) : 0;
    return {
      R: Number(R.toFixed(3)),
      Rc: Number(Rc.toFixed(3)),
      canDefend: R >= Rc,
      edge: Number((R - Rc).toFixed(3)),
      bRatio: Number(b.toFixed(3))
    };
  }

  global.queryPostflopLut = queryPostflopLut;
  global.calculateFedorRc = calculateFedorRc;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { queryPostflopLut, calculateFedorRc };
    exports.queryPostflopLut = queryPostflopLut;
    exports.calculateFedorRc = calculateFedorRc;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
