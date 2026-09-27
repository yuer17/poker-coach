// 翻后 GTO 极化策略宏模板引擎 (Phase 3 - Module 3 & 4)
// 设计者：GPT-6-Astra (首席架构师) + Gemini (主程)
// 目标：将 [牌面簇] × [手牌分桶] × [战术角色] 映射为 GTO 基准策略，并通过三道物理铁闸裁决

(function(global) {
  function getClassifier() {
    if (typeof global.classifyBoardTexture === 'function') return global.classifyBoardTexture;
    if (typeof require !== 'undefined') {
      try { return require('./postflop_board_classifier.js').classifyBoardTexture; } catch(e) {}
    }
    return null;
  }

  function getBucketer() {
    if (typeof global.bucketHeroHand === 'function') return global.bucketHeroHand;
    if (typeof require !== 'undefined') {
      try { return require('./postflop_hand_bucketer.js').bucketHeroHand; } catch(e) {}
    }
    return null;
  }

  /**
   * 核心决策派发引擎
   * @param {Object} ctx - 牌局翻后上下文
   *   - heroCards: ['Td', '2d']
   *   - boardCards: ['5d', '5h', '3c']
   *   - betRatio: 对手下注占底池比例 (如 0.30 表示 30% mini-cbet)
   *   - spr: 筹码底池比 (如 5.2)
   *   - isOOP: 是否在不利位置 (如 BB)
   *   - isPFR: 是否翻前主动加注者
   * @returns {Object} { action: string, frequencies: Array<number>, reason: string, guardrailApplied: string|null }
   */
  function evaluatePostflopGto(ctx) {
    if (!ctx || !Array.isArray(ctx.heroCards) || ctx.heroCards.length < 2 || !Array.isArray(ctx.boardCards) || ctx.boardCards.length < 3 || ctx.heroCards.some(c => !c) || ctx.boardCards.some(c => !c)) {
      return { action: 'CHECK', frequencies: [0, 0, 0, 0], reason: '手牌或公牌数据未就绪', guardrailApplied: 'INVALID_INPUT' };
    }

    const { heroCards, boardCards, betRatio = 0.33, spr = 4.0, isOOP = true, isPFR = false } = ctx;

    const fnClassify = getClassifier();
    const fnBucket = getBucketer();

    const texture = fnClassify ? fnClassify(boardCards) : {};
    const hand = fnBucket ? fnBucket(heroCards, boardCards) : {};

    // 场景 0: 面对过牌 (无人下注，betRatio <= 0)
    if (betRatio <= 0) {
      if (isPFR) {
        // 翻前主动进攻者 (PFR) 拥有范围优势进行持续下注 (C-Bet)
        if (hand.bucket === 'NUTS_PREMIUM' || hand.bucket === 'STRONG_DRAW') {
          return {
            action: 'BET',
            frequencies: [0, 20, 80, 0], // [Check, SmallBet, LargeBet, Jam] -> 抽象为动作映射
            reason: `💡 GTO 宏模板 [PFR 持续下注]：作为翻前加注者持 ${hand.details}，公牌面发起持续下注榨取价值与施压。`,
            guardrailApplied: null
          };
        } else if (hand.bucket === 'BACKDOOR_POTENTIAL' && texture.isDry) {
          return {
            action: 'BET',
            frequencies: [0, 60, 40, 0],
            reason: `💡 GTO 宏模板 [PFR 干燥面小注搜刮]：持 ${hand.details}，干燥牌面以 25%~33% 小注高频偷池。`,
            guardrailApplied: null
          };
        } else {
          return {
            action: 'CHECK',
            frequencies: [70, 30, 0, 0],
            reason: `💡 GTO 宏模板 [PFR 控池过牌]：持 ${hand.details}，过牌控池看转牌。`,
            guardrailApplied: null
          };
        }
      } else {
        // OOP 非进攻者 (如 BB)：GTO 标准线以 100% Check 范围防守过给 PFR
        return {
          action: 'CHECK',
          frequencies: [100, 0, 0, 0],
          reason: `💡 GTO 宏模板 [OOP 标准过牌]：在不利位置面对翻前加注者，100% 范围过牌等待对手行动。`,
          guardrailApplied: null
        };
      }
    }

    // 计算理论 MDF (最低防守频率)
    // MDF = 1 / (1 + betRatio)
    const mdfFloor = Math.round((1 / (1 + betRatio)) * 100);

    let frequencies = [0, 100, 0, 0]; // [Fold, Call, Raise, Jam]
    let primaryAction = 'CALL';
    let reason = '';
    let guardrailApplied = null;

    // 场景 1: 面对对手小尺度持续下注 (Mini C-Bet <= 38%)
    if (betRatio <= 0.38) {
      if (hand.bucket === 'NUTS_PREMIUM') {
        // 顶级强牌：在干燥面慢打平跟设陷阱，在湿润面加注造大底池
        if (texture.isDry) {
          frequencies = [0, 70, 30, 0]; // 70% Call 陷阱 / 30% Raise
          primaryAction = 'CALL';
          reason = `💡 GTO 宏模板 [干燥面对子面慢打]：持有 ${hand.details}，公牌面干燥，慢打跟注诱捕对手转牌继续诈唬。`;
        } else {
          frequencies = [0, 20, 80, 0]; // 80% 快速加注造池
          primaryAction = 'RAISE';
          reason = `💡 GTO 宏模板 [湿润面价值保护]：持有 ${hand.details}，公牌湿润有听牌可能，快速加注榨取价值。`;
        }
      } else if (hand.bucket === 'STRONG_DRAW') {
        // 强听牌 (8+ outs)：以高频 45% Check-Raise 半诈唬，55% Call 买赔率
        frequencies = [0, 55, 45, 0];
        primaryAction = isOOP ? 'RAISE' : 'CALL';
        reason = `💡 GTO 宏模板 [半诈唬进攻]：持有 ${hand.details}，面对小注混合 ${isOOP ? 'Check-Raise' : '在位平跟浮动'} 与买花。`;
      } else if (hand.bucket === 'MARGINAL_MADE') {
        // 边际成牌 (中对/底对)：100% 坚决跟注捍卫防守，绝不向小注屈服
        frequencies = [0, 100, 0, 0];
        primaryAction = 'CALL';
        reason = `💡 GTO 宏模板 [弹性捍卫]：持有 ${hand.details}，面对 ${Math.round(betRatio * 100)}% 小注拥有充足底池赔率，纯跟注抓诈。`;
      } else if (hand.bucket === 'BACKDOOR_POTENTIAL') {
        // 双后门潜力：OOP 极化 Check-Raise 反击 / IP 在位浮动跟注
        if (isOOP) {
          frequencies = [25, 35, 40, 0]; // 40% Check-Raise, 35% Float, 25% Fold
          primaryAction = 'RAISE';
          reason = `💡 GTO 宏模板 [OOP 极化反击与 MDF 捍卫]：持有 ${hand.details}，公牌含大量空气，以 40% 极化 Check-Raise 惩罚过宽 C-Bet 并捍卫 MDF 底线 (${mdfFloor}%)。`;
        } else {
          frequencies = [15, 65, 20, 0]; // 在位持位置优势多跟注浮动 (Float)
          primaryAction = 'CALL';
          reason = `💡 GTO 宏模板 [IP 在位浮动跟注]：持有 ${hand.details}，在有利位置跟注浮动 (Float)，看转牌多条发展路线。`;
        }
      } else {
        // 纯空气牌 (AIR_WEAK)：面对小注有后门时可低频抵抗，否则弃牌
        frequencies = [80, 20, 0, 0];
        primaryAction = 'FOLD';
        reason = `💡 GTO 宏模板 [弱牌弃牌]：无成牌无转机，面对下注果断弃牌止损。`;
      }
    } else {
      // 场景 2: 面对常规尺度下注 (> 38%)
      if (hand.bucket === 'NUTS_PREMIUM') {
        frequencies = [0, 30, 70, 0];
        primaryAction = 'RAISE';
        reason = `💡 GTO 宏模板 [强牌进攻]：持有 ${hand.details}，面对正常尺度加注造大底池。`;
      } else if (hand.bucket === 'STRONG_DRAW') {
        frequencies = [0, 75, 25, 0];
        primaryAction = 'CALL';
        reason = `💡 GTO 宏模板 [听牌买赔率]：持有 ${hand.details}（${hand.outs} outs），平跟买赔率。`;
      } else if (hand.bucket === 'MARGINAL_MADE') {
        frequencies = [15, 85, 0, 0];
        primaryAction = 'CALL';
        reason = `💡 GTO 宏模板 [中等牌控池]：持有 ${hand.details}，平跟控 SPR 抓对手持续诈唬。`;
      } else {
        frequencies = [100, 0, 0, 0];
        primaryAction = 'FOLD';
        reason = `💡 GTO 宏模板 [无成牌弃牌]：面对标准下注无足够赔率，弃牌止损。`;
      }
    }

    // ── Module 4: 物理常识铁闸覆盖 (Sanity Guardrails Override) ──
    // 铁闸 A: 超浅筹码承诺 (SPR < 1.5)
    if (spr <= 1.5 && ['NUTS_PREMIUM', 'STRONG_DRAW'].includes(hand.bucket)) {
      frequencies = [0, 0, 0, 100];
      primaryAction = 'ALLIN';
      guardrailApplied = 'SPR_COMMITMENT_GUARDRAIL';
      reason += `\n⚡ [SPR 物理铁闸触发]：SPR=${spr.toFixed(2)} <= 1.5 已深度套池，强牌/强听牌直接 All-in 寻求打光全部筹码。`;
    }

    // 铁闸 B: MDF 刚性底线保证（面对小注时整体防守不能崩盘）
    if (betRatio <= 0.35 && frequencies[0] === 100 && hand.hasBackdoor) {
      frequencies = [30, 40, 30, 0];
      primaryAction = 'CALL';
      guardrailApplied = 'MDF_DEFENSE_FLOOR_GUARDRAIL';
      reason += `\n⚡ [MDF 物理铁闸触发]：理论最低防守频率 ${mdfFloor}%，手牌具备后门转机，强制禁止 100% 弃牌。`;
    }

    return {
      primaryAction,
      frequencies,
      reason,
      guardrailApplied,
      texture,
      hand
    };
  }

  global.evaluatePostflopGto = evaluatePostflopGto;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { evaluatePostflopGto };
    exports.evaluatePostflopGto = evaluatePostflopGto;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
