// 翻后河牌终局博弈均衡与阻断极化分析器 (Phase 8 - Module 2)
// 设计者：GPT-6-Astra (首席架构师) + Gemini (主程)
// 依据：TASK-ASTRA-036 架构裁决：河牌终局零听牌博弈截断与极化抓诈/价值平衡

(function(global) {
  const RANK_VALUES = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    'T': 10, 't': 10, 'J': 11, 'j': 11, 'Q': 12, 'q': 12, 'K': 13, 'k': 13, 'A': 14, 'a': 14
  };

  function parseCard(cardStr) {
    if (!cardStr || typeof cardStr !== 'string' || cardStr.length < 2) return null;
    return {
      rank: cardStr[0].toUpperCase(),
      suit: cardStr[1].toLowerCase(),
      value: RANK_VALUES[cardStr[0].toUpperCase()] || 0,
      str: cardStr
    };
  }

  /**
   * 河牌终局状态博弈深度分析
   * @param {Array<string>} heroCards - 手牌两张，如 ['Ah', 'Kd']
   * @param {Array<string>} boardCards - 公牌五张，如 ['5d', '5h', '3c', '9s', '2d']
   * @param {number} pot - 当前底池（含下注）
   * @param {number} villainBet - 对手河牌下注额 (若 0 表示面对过牌)
   * @param {number} effStack - 剩余有效筹码
   * @param {Object} opts - 附加配置 (如 heroEquity, relStr)
   * @returns {Object} 终局牌力阶层、阻断效应、纳什均衡动作与文字解析
   */
  function analyzeRiverTerminal(heroCards, boardCards, pot, villainBet, effStack, opts = {}) {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (!heroCards || heroCards.length < 2 || !boardCards || boardCards.length < 5) {
      return {
        status: 'INVALID_INPUT',
        terminalTier: 'UNKNOWN',
        tierName: '数据不完整'
      };
    }

    const h1 = parseCard(heroCards[0]);
    const h2 = parseCard(heroCards[1]);
    const board = boardCards.slice(0, 5).map(parseCard).filter(Boolean);

    if (!h1 || !h2 || board.length < 5) {
      return {
        status: 'INVALID_INPUT',
        terminalTier: 'UNKNOWN',
        tierName: '卡牌解析异常'
      };
    }

    // 1. 公牌花色分布（检测单色或三同花）
    const boardSuits = {};
    board.forEach(c => { boardSuits[c.suit] = (boardSuits[c.suit] || 0) + 1; });
    let flushSuit = null;
    for (const [s, cnt] of Object.entries(boardSuits)) {
      if (cnt >= 3) flushSuit = s;
    }

    // 2. 阻断效应扫描 (Blocker Analysis)
    const blockers = [];
    if (flushSuit) {
      const boardHasAce = board.some(c => c.suit === flushSuit && c.rank === 'A');
      const hasNutAce = (h1.suit === flushSuit && h1.rank === 'A') || (h2.suit === flushSuit && h2.rank === 'A');
      const hasKing = (h1.suit === flushSuit && h1.rank === 'K') || (h2.suit === flushSuit && h2.rank === 'K');
      if (hasNutAce || (boardHasAce && hasKing)) {
        blockers.push('NUT_FLUSH_BLOCKER');
      } else if (hasKing) {
        blockers.push('SECOND_FLUSH_BLOCKER');
      }
    }
    // 顶对/坚果顺阻断
    const maxBoardRank = Math.max(...board.map(c => c.value));
    if (h1.value === maxBoardRank || h2.value === maxBoardRank) {
      blockers.push('TOP_PAIR_BLOCKER');
    }

    // 3. 终局牌力等级映射 (Terminal Strength Tier) (A06/A07 修复: 兼容数值与字符串)
    const rawRelStr = opts.relStrength || (opts.equityResult ? opts.equityResult.relStrength : 'HIGH_CARD');
    const relStrNum = typeof rawRelStr === 'number' ? rawRelStr : parseFloat(rawRelStr);
    const relStr = String(rawRelStr);
    const equity = opts.equity !== undefined ? opts.equity : (opts.equityResult ? opts.equityResult.equity : 50);

    // 检测公牌坚果平分 (Chop Pot Nuts): 如公牌皇家同花顺等
    let isBoardNutChop = false;
    if (board.length === 5) {
      const bSuits = board.map(c => c.suit);
      const bRanks = board.map(c => c.rank);
      const isMonotone = bSuits.every(s => s === bSuits[0]);
      if (isMonotone && ['A', 'K', 'Q', 'J', 'T'].every(r => bRanks.includes(r))) {
        isBoardNutChop = true;
      }
    }

    const isNutsByRel = isBoardNutChop || (equity >= 49 && equity <= 51 && relStrNum >= 90) || (!isNaN(relStrNum) && relStrNum >= 95) || ['FOUR_OF_A_KIND', 'FULL_HOUSE', 'FLUSH', 'STRAIGHT', 'NUTS_QUADS_FULLHOUSE'].includes(relStr);
    const isStrongByRel = (!isNaN(relStrNum) && relStrNum >= 80) || ['SET_TRIPS', 'TWO_PAIR_TOP'].some(s => relStr.includes(s));
    const isTopPairByRel = (!isNaN(relStrNum) && relStrNum >= 60) || ['OVERPAIR', 'TOP_PAIR', 'TWO_PAIR_WEAK'].some(s => relStr.includes(s));

    let terminalTier = 'MARGINAL_SHOWDOWN';
    let tierName = '边际摊牌价值';
    let gAction = 'CHECK';
    let frequencies = { FOLD: 0, CALL: 100, RAISE: 0, ALLIN: 0 };

    const potBefore = Math.max(0.1, pot - villainBet);
    const bRatio = potBefore > 0 ? (villainBet / potBefore) : 0;
    const mdf = (bRatio > 0) ? (1 / (1 + bRatio)) * 100 : 100;
    const reqEq = (bRatio > 0) ? (villainBet / (potBefore + 2 * villainBet)) * 100 : 0;

    // 面对对手下注
    if (villainBet > 0) {
      if (isBoardNutChop) {
        terminalTier = 'ABSOLUTE_NUTS';
        tierName = '公牌坚果平分底池 (Chop Pot)';
        gAction = 'CALL';
        frequencies = { FOLD: 0, CALL: 100, RAISE: 0, ALLIN: 0 };
      } else if (equity >= 85 || isNutsByRel) {
        terminalTier = 'ABSOLUTE_NUTS';
        tierName = '绝对强价值/坚果';
        if (effStack <= villainBet * 2.5) {
          gAction = 'ALLIN';
          frequencies = { FOLD: 0, CALL: 15, RAISE: 15, ALLIN: 70 };
        } else {
          gAction = 'RAISE';
          frequencies = { FOLD: 0, CALL: 25, RAISE: 65, ALLIN: 10 };
        }
      } else if (equity >= 65 || isStrongByRel) {
        terminalTier = 'STRONG_VALUE';
        tierName = '优质成牌/价值跟注';
        gAction = 'CALL';
        frequencies = { FOLD: 0, CALL: 85, RAISE: 15, ALLIN: 0 };
      } else if (equity >= 28 || equity >= reqEq || isTopPairByRel || (!isNaN(relStrNum) && relStrNum >= 30) || (opts.handBucket && opts.handBucket !== '无对' && opts.handBucket !== '空气')) {
        terminalTier = 'MARGINAL_SHOWDOWN';
        tierName = '中坚抓诈牌 (Bluff Catcher)';
        // 依据下注尺度与阻断效应裁决
        const hasNutBlocker = blockers.includes('NUT_FLUSH_BLOCKER');
        if (bRatio <= 0.35) {
          // 小注必跟
          gAction = 'CALL';
          frequencies = { FOLD: 15, CALL: 85, RAISE: 0, ALLIN: 0 };
        } else if (bRatio <= 0.75) {
          gAction = (equity >= reqEq || hasNutBlocker) ? 'CALL' : 'FOLD';
          frequencies = (equity >= reqEq || hasNutBlocker) ? { FOLD: 35, CALL: 65, RAISE: 0, ALLIN: 0 } : { FOLD: 70, CALL: 30, RAISE: 0, ALLIN: 0 };
        } else {
          // 大注/超池：A07 修复：严格贯彻单挑正期望 ChipEV 判据 (equity >= reqEq + 2 即支持抓诈)
          if (equity >= reqEq + 2) {
            gAction = 'CALL';
            frequencies = hasNutBlocker ? { FOLD: 35, CALL: 65, RAISE: 0, ALLIN: 0 } : { FOLD: 45, CALL: 55, RAISE: 0, ALLIN: 0 };
          } else if (equity >= reqEq - 2 && hasNutBlocker) {
            gAction = 'CALL';
            frequencies = { FOLD: 45, CALL: 55, RAISE: 0, ALLIN: 0 };
          } else {
            gAction = 'FOLD';
            frequencies = hasNutBlocker ? { FOLD: 45, CALL: 55, RAISE: 0, ALLIN: 0 } : { FOLD: 80, CALL: 20, RAISE: 0, ALLIN: 0 };
          }
        }
      } else {
        terminalTier = 'PURE_AIR';
        tierName = '无胜率空气高牌';
        if (blockers.includes('NUT_FLUSH_BLOCKER')) {
          // 坚果同花 Blocker 极化加注诈唬
          gAction = 'RAISE';
          frequencies = { FOLD: 60, CALL: 0, RAISE: 40, ALLIN: 0 };
        } else {
          gAction = 'FOLD';
          frequencies = { FOLD: 100, CALL: 0, RAISE: 0, ALLIN: 0 };
        }
      }
    } else {
      // 面对过牌 (Hero 行动轮)
      if (equity >= 80 || ['FOUR_OF_A_KIND', 'FULL_HOUSE', 'FLUSH', 'STRAIGHT'].includes(relStr)) {
        terminalTier = 'ABSOLUTE_NUTS';
        tierName = '坚果大价值榨取';
        gAction = 'BET_LARGE';
        frequencies = { CHECK: 0, BET_SMALL: 15, BET_LARGE: 70, ALLIN: 15 };
      } else if (equity >= 60 || ['THREE_OF_A_KIND', 'TWO_PAIR', 'TOP_PAIR'].includes(relStr)) {
        terminalTier = 'STRONG_VALUE';
        tierName = '薄价值下注/控池';
        gAction = 'BET_SMALL';
        frequencies = { CHECK: 35, BET_SMALL: 65, BET_LARGE: 0, ALLIN: 0 };
      } else if (equity >= 30) {
        terminalTier = 'MARGINAL_SHOWDOWN';
        tierName = '免费看牌/过牌摊牌';
        gAction = 'CHECK';
        frequencies = { CHECK: 100, BET_SMALL: 0, BET_LARGE: 0, ALLIN: 0 };
      } else {
        terminalTier = 'PURE_AIR';
        tierName = '纯空气/极化诈唬候选';
        if (blockers.includes('NUT_FLUSH_BLOCKER') && !opts.isMultiway) {
          gAction = 'BET_LARGE';
          frequencies = { CHECK: 65, BET_SMALL: 0, BET_LARGE: 35, ALLIN: 0 };
        } else {
          gAction = 'CHECK';
          frequencies = { CHECK: 100, BET_SMALL: 0, BET_LARGE: 0, ALLIN: 0 };
        }
      }
    }

    const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const latencyUs = Math.max(0.1, Math.round((t1 - t0) * 1000 * 10) / 10);

    return {
      status: 'MATCHED_RIVER_TERMINAL',
      terminalTier,
      tierName,
      blockers,
      primaryAction: gAction,
      frequencies,
      bRatio: Number(bRatio.toFixed(3)),
      mdf: Number(mdf.toFixed(1)),
      requiredEquity: Number(reqEq.toFixed(1)),
      latencyUs: latencyUs
    };
  }

  global.analyzeRiverTerminal = analyzeRiverTerminal;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { analyzeRiverTerminal };
    exports.analyzeRiverTerminal = analyzeRiverTerminal;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
