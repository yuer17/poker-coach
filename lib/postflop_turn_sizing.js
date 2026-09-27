// 翻后转牌多档位注额求解引擎 (Phase 9A - Turn Multi-Tier Sizing Engine)
// 设计者：GPT-6-Astra (首席架构师) + Gemini (主程)
// 依据：TASK-ASTRA-037 架构裁决：转牌极化下注尺度与底池几何学 (Turn Pot Geometry)

(function(global) {
  'use strict';

  /**
   * 严格计算底池几何学最佳注额比 (Geometric Sizing Ratio)
   * 求解二次方程 2*g^2 + 2*g - SPR = 0，使得转牌与河牌两街下注占底池比例 g 完全相同，
   * 最终在河牌精准全押，实现筹码利用效率最大化。
   * @param {number} spr - 筹码底池比 (effStack / pot)
   * @returns {number} 理论几何倍数 g (如 0.75 表示 75% 底池)
   */
  function calculateGeometricRatio(spr) {
    if (!spr || spr <= 0.2) return 0;
    // 2g^2 + 2g - spr = 0 => g = (-1 + sqrt(1 + 2*spr)) / 2
    const g = (-1 + Math.sqrt(1 + 2 * spr)) / 2;
    return Math.max(0.1, Math.min(2.5, g));
  }

  /**
   * 计算打完转牌推荐尺度被跟注后，河牌的预计剩余 SPR
   * @param {number} pot - 转牌初始底池
   * @param {number} effStack - 初始有效筹码
   * @param {number} betBb - 转牌下注额 (BB)
   * @returns {number} 河牌剩余 SPR
   */
  function predictRiverSpr(pot, effStack, betBb) {
    if (betBb <= 0) return pot > 0 ? effStack / pot : 0;
    const riverPot = pot + 2 * betBb;
    const remainingStack = Math.max(0, effStack - betBb);
    return riverPot > 0 ? (remainingStack / riverPot) : 0;
  }

  /**
   * 转牌多档位注额求解核心引擎
   * @param {Object} ctx - 决策上下文
   * @returns {Object} 包含主推荐档位、BB 数、多档位离散频率分布与底池几何学规划
   */
  function evaluateTurnSizing(ctx) {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    if (!ctx) {
      return {
        status: 'INVALID_INPUT',
        primaryTier: 'CHECK',
        primaryBb: 0,
        action: 'CHECK',
        frequencies: { check: 100, small: 0, medium: 0, strong: 0, overbet: 0, allin: 0 },
        potGeometry: { currentSpr: 0, riverSprAfterBet: 0, geometricRatio: 0, planDesc: '数据输入为空' },
        rationale: '数据输入为空'
      };
    }

    const pot = Math.max(0.1, ctx.pot || 10);
    const effStack = Math.max(0, ctx.effStack !== undefined ? ctx.effStack : 50);
    const spr = pot > 0 ? (ctx.spr !== undefined ? ctx.spr : effStack / pot) : 0;
    const heroPos = ctx.heroPos || 'IP';
    const equity = ctx.equity !== undefined ? ctx.equity : 50;
    const outs = ctx.outs || 0;
    const turnTrans = ctx.turnTransition || { runoutType: 'BRICK_BLANK', advantageShift: 'neutral' };
    const handBucket = ctx.handBucket || '无对';
    const isFacingBet = !!(ctx.isFacingBet || (ctx.villainBet && ctx.villainBet > 0));
    const isMultiway = !!ctx.isMultiway;
    const mwN = Math.max(0, (ctx.mwTotalCount || 2) - 2);

    // 基础离散档位计算（注额上限不得超出 effStack）
    const betSmallBb = Math.min(effStack, Math.round(pot * 0.33 * 10) / 10);
    const betMediumBb = Math.min(effStack, Math.round(pot * 0.67 * 10) / 10);
    const betStrongBb = Math.min(effStack, Math.round(pot * 0.75 * 10) / 10);
    const betOverBb = Math.min(effStack, Math.round(pot * 1.25 * 10) / 10);
    const allinBb = Math.round(effStack * 10) / 10;

    const geomRatio = calculateGeometricRatio(spr);

    // 0. 特殊前置情况：面对对手下注 / 零筹码
    if (isFacingBet) {
      return {
        status: 'FACING_BET_DELEGATED',
        primaryTier: 'FACING_BET',
        primaryBb: 0,
        action: 'DEFEND',
        frequencies: { check: 0, small: 0, medium: 0, strong: 0, overbet: 0, allin: 0 },
        potGeometry: { currentSpr: spr, riverSprAfterBet: 0, geometricRatio: geomRatio, planDesc: '面对下注由防守引擎接管' },
        rationale: '对手已下注，注额尺度由防守加注与跟注逻辑决定'
      };
    }

    if (effStack <= 0) {
      return {
        status: 'ZERO_STACK',
        primaryTier: 'CHECK',
        primaryBb: 0,
        action: 'CHECK',
        frequencies: { check: 100, small: 0, medium: 0, strong: 0, overbet: 0, allin: 0 },
        potGeometry: { currentSpr: 0, riverSprAfterBet: 0, geometricRatio: 0, planDesc: '筹码已全下打光' },
        rationale: '筹码已打光，过牌进入摊牌'
      };
    }

    // 1. 超浅码承诺区 (SPR <= 1.2)
    if (spr <= 1.2) {
      const isCommitValue = equity >= 55 || handBucket === '两对+' || outs >= 8;
      if (isCommitValue) {
        const riverSpr = predictRiverSpr(pot, effStack, allinBb);
        return {
          status: 'COMMIT_SHOVE',
          primaryTier: '全押',
          primaryBb: allinBb,
          action: 'ALLIN',
          frequencies: { check: 10, small: 0, medium: 0, strong: 15, overbet: 0, allin: 75 },
          potGeometry: {
            currentSpr: spr,
            riverSprAfterBet: riverSpr,
            geometricRatio: geomRatio,
            planDesc: `超浅码 (SPR ${spr.toFixed(1)} <= 1.2)，一枪打光最契合杠杆与弃牌率`
          },
          rationale: '极低 SPR 承诺区，强成牌与强听牌直接全押，消除多余复杂街决策'
        };
      } else {
        return {
          status: 'COMMIT_CHECK',
          primaryTier: '过牌',
          primaryBb: 0,
          action: 'CHECK',
          frequencies: { check: 85, small: 0, medium: 0, strong: 0, overbet: 0, allin: 15 },
          potGeometry: { currentSpr: spr, riverSprAfterBet: spr, geometricRatio: geomRatio, planDesc: '弱手牌在超浅码过牌控池' },
          rationale: '浅码无成手无听牌，过牌保留底牌摊牌机会，避免无谓送筹码'
        };
      }
    }

    // 2. 根据牌面质地跃迁 (Turn Runout) 与成手分桶 (Hand Bucket) 进行多档位博弈求解
    let primaryTier = '过牌';
    let primaryBb = 0;
    let action = 'CHECK';
    let frequencies = { check: 100, small: 0, medium: 0, strong: 0, overbet: 0, allin: 0 };
    let rationale = '';
    let planDesc = '';

    const runType = turnTrans.runoutType || 'BRICK_BLANK';

    // ── 情况 A: 顶级成手 / 坚果牌力 (两对+、三条、同花、顺子、葫芦) ──
    if (handBucket === '两对+' || equity >= 78) {
      if (heroPos === 'IP' && ctx.isDelayedCBetNode) {
        primaryTier = '75% 底池';
        primaryBb = betStrongBb;
        action = 'BET';
        frequencies = { check: 15, small: 10, medium: 25, strong: 50, overbet: 0, allin: 0 };
        rationale = '💡 Pokercode 延时 C-Bet：翻牌双方过牌后对手转牌再次 Check 范围极度封顶，持有坚果/强牌释放延时持续下注榨取高额价值';
        planDesc = `延时下注 75% (${betStrongBb}BB) 施压其封顶范围`;
      } else if (runType === 'FLUSH_COMPLETER' || runType === 'STRAIGHT_COMPLETER') {
        // 牌面出现成花/成顺，但 Hero 本身是极强牌
        primaryTier = '75% 底池';
        primaryBb = betStrongBb;
        action = 'BET';
        frequencies = { check: 20, small: 10, medium: 20, strong: 50, overbet: 0, allin: 0 };
        rationale = '危险面持有超强牌，下注 75% 向更差成牌榨取高额价值并向听牌收取高额保护费';
        planDesc = `转牌下注 75% (${betStrongBb}BB)，河牌剩余 SPR 降至 ${predictRiverSpr(pot, effStack, betStrongBb).toFixed(1)}，河牌价值推注通道畅通`;
      } else if (spr >= 3.0 && (runType === 'BRICK_BLANK' || runType === 'OVERCARD')) {
        // 深码干燥/白牌面：坚果具备极化超池下注资格 (Overbet 125%)
        primaryTier = '125% 超池';
        primaryBb = betOverBb;
        action = 'BET';
        frequencies = { check: 15, small: 5, medium: 10, strong: 30, overbet: 40, allin: 0 };
        rationale = '白板/超牌转折极度利好坚果，采用 125% 超池施加最大压力，底池几何学精准对齐河牌推注';
        planDesc = `转牌 125% 超池 (${betOverBb}BB)，河牌底池几何倍数完美收敛至 1.0 左右全押线`;
      } else {
        // 常规强牌重注 (75% 底池)
        primaryTier = '75% 底池';
        primaryBb = betStrongBb;
        action = 'BET';
        frequencies = { check: 10, small: 15, medium: 25, strong: 50, overbet: 0, allin: 0 };
        rationale = '绝对坚果强牌价值下注，75% 底池重注构建健康价值/诈唬几何模型';
        planDesc = `下注 75% (${betStrongBb}BB) 建立主力价值线，河牌预期 SPR 为 ${predictRiverSpr(pot, effStack, betStrongBb).toFixed(1)}`;
      }
    }
    // ── 情况 B: 强顶对 / 超对 (TPTK / Overpair, equity 65~77%) ──
    else if (handBucket === '顶对' && equity >= 62) {
      if (runType === 'BOARD_PAIR') {
        // 公牌成对（BOARD_PAIR）：对手明三条风险上升，顶对打不动三条，收敛至小注或过牌
        primaryTier = '33% 底池';
        primaryBb = betSmallBb;
        action = 'BET';
        frequencies = { check: 45, small: 40, medium: 15, strong: 0, overbet: 0, allin: 0 };
        rationale = '公对牌面大幅压缩对手被跟注区间，顶对以 33% 小注控池与防守性索取薄价值为主';
        planDesc = `小注 33% (${betSmallBb}BB) 控制底池膨胀，保持在河牌的安全防线`;
      } else if (runType === 'FLUSH_COMPLETER' || runType === 'STRAIGHT_COMPLETER') {
        // 听牌成牌转折面：大幅收敛
        primaryTier = '过牌';
        primaryBb = 0;
        action = 'CHECK';
        frequencies = { check: 65, small: 25, medium: 10, strong: 0, overbet: 0, allin: 0 };
        rationale = '转牌发出连顺/成花转折，跟注者范围反超，顶对转入过牌防守与抓诈通道';
      } else if (heroPos === 'IP' && ctx.isDelayedCBetNode) {
        primaryTier = '75% 底池';
        primaryBb = betStrongBb;
        action = 'BET';
        frequencies = { check: 20, small: 20, medium: 20, strong: 40, overbet: 0, allin: 0 };
        rationale = '💡 Pokercode 延时 C-Bet：翻牌双方过牌后对手转牌再次 Check 范围极度封顶，顶对强踢脚下注 75% 强力施压并向更差成牌榨取高额价值';
        planDesc = `延时下注 75% (${betStrongBb}BB) 施压其封顶范围`;
      } else {
        // 干燥面或超牌面：标准第二枪持续施压 (Double Barrel 67%~75%)
        primaryTier = '75% 底池';
        primaryBb = betStrongBb;
        action = 'BET';
        frequencies = { check: 20, small: 20, medium: 20, strong: 40, overbet: 0, allin: 0 };
        rationale = '顶对强踢脚标准第二枪，75% 尺度向弱对与浮动听牌收取保护费';
        planDesc = `下注 75% (${betStrongBb}BB)，河牌 SPR 预计降至 ${predictRiverSpr(pot, effStack, betStrongBb).toFixed(1)}`;
      }
    }
    // ── 情况 C: 边缘摊牌价值 / 弱顶对 / 中对 / A高牌 (Marginal Showdown Value, equity 40~61%) ──
    else if (handBucket === '弱对' || (equity >= 40 && equity < 62 && outs < 8)) {
      // 实战手牌教训：A-high / 中弱对在配对面上绝不可盲目下注 1/3 底池膨胀底池！
      primaryTier = '过牌';
      primaryBb = 0;
      action = 'CHECK';
      if (heroPos === 'IP' && runType === 'BOARD_PAIR') {
        frequencies = { check: 90, small: 10, medium: 0, strong: 0, overbet: 0, allin: 0 };
        rationale = '公对牌面下注将严重隔离更差牌（只会被明三条与高对跟注），持中等摊牌价值应 90% 过牌控池';
        planDesc = '过牌免费看河牌，最大化实现手中摊牌胜率';
      } else if (heroPos === 'IP' && ctx.isDelayedCBetNode) {
        const isStation = (ctx.villainProfile === 'calling_station');
        if (isStation) {
          primaryTier = '过牌';
          primaryBb = 0;
          action = 'CHECK';
          frequencies = { check: 100, small: 0, medium: 0, strong: 0, overbet: 0, allin: 0 };
          rationale = '💡 Pokercode 延时 C-Bet 刹车：对手画像为跟注站（calling_station），纯空气牌/边缘牌诈唬无法迫使其弃牌，过牌控池';
          planDesc = '跟注站不弃牌，过牌防回撤';
        } else {
          primaryTier = '33% 底池';
          primaryBb = betSmallBb;
          action = 'BET';
          frequencies = { check: 30, small: 70, medium: 0, strong: 0, overbet: 0, allin: 0 };
          rationale = '💡 Pokercode 2-2-4 [转牌延时 C-Bet]：翻牌双方过牌后对手转牌再次 Check，其范围极度弱化封顶（Capped）。在位释放 70% 延时持续下注扫荡死钱';
          planDesc = `33% 延时小注 (${betSmallBb}BB) 施压其过宽弃牌`;
        }
      } else {
        frequencies = { check: 80, small: 20, medium: 0, strong: 0, overbet: 0, allin: 0 };
        rationale = '弱成手兼具摊牌价值但无力承受下注造大底池，纳什最优策略为过牌控池';
        planDesc = '维持当前底池大小进入河牌';
      }
    }
    // ── 情况 D: 强抽牌 / 强听牌 (Combo Draws / OESD / Flush Draw, Outs >= 8) ──
    else if (outs >= 8) {
      if (spr <= 2.2) {
        // 中浅码强抽牌：高频全推半诈唬
        primaryTier = '全押';
        primaryBb = allinBb;
        action = 'ALLIN';
        frequencies = { check: 20, small: 0, medium: 10, strong: 20, overbet: 0, allin: 50 };
        rationale = `持有 ${outs} 张强进张，中浅码 (SPR ${spr.toFixed(1)}) 推进全押享受弃牌率与出路双重 EV 爆发`;
        planDesc = `全下推进 ${allinBb}BB 打光，最大化兑现翻后半诈唬胜率`;
      } else {
        // 深码强抽牌：75% 重注半诈唬
        primaryTier = '75% 底池';
        primaryBb = betStrongBb;
        action = 'BET';
        frequencies = { check: 35, small: 15, medium: 15, strong: 35, overbet: 0, allin: 0 };
        rationale = `持 ${outs} 张高额进张，释放 75% 底池下注持续给对手防守端施加弃牌压力`;
        planDesc = `转牌下注 75% (${betStrongBb}BB)，若被跟注河牌仍保留 ${predictRiverSpr(pot, effStack, betStrongBb).toFixed(1)} SPR 防回撤空间`;
      }
    }
    // ── 情况 E: 弱听牌与纯空气 (Air / Low Equity < 35%) ──
    else {
      // 多人底池纯空气绝对禁止诈唬
      if (isMultiway && mwN > 0) {
        primaryTier = '过牌';
        primaryBb = 0;
        action = 'CHECK';
        frequencies = { check: 100, small: 0, medium: 0, strong: 0, overbet: 0, allin: 0 };
        rationale = `多人底池 (${mwN + 2} 人在局) 弃牌率几何级数归零，纯空气禁止下注，100% 过牌`;
        planDesc = '多人池控险过牌';
      } else if (heroPos === 'IP' && ctx.isDelayedCBetNode) {
        const isStation = (ctx.villainProfile === 'calling_station' && equity < 50);
        if (isStation) {
          primaryTier = '过牌';
          primaryBb = 0;
          action = 'CHECK';
          frequencies = { check: 100, small: 0, medium: 0, strong: 0, overbet: 0, allin: 0 };
          rationale = '💡 Pokercode 延时 C-Bet 刹车：对手画像为跟注站（calling_station），纯空气牌诈唬无法迫使其弃牌，过牌控池';
          planDesc = '跟注站不弃牌，过牌防回撤';
        } else {
          primaryTier = '33% 底池';
          primaryBb = betSmallBb;
          action = 'BET';
          frequencies = { check: 30, small: 70, medium: 0, strong: 0, overbet: 0, allin: 0 };
          rationale = '💡 Pokercode 2-2-4 [转牌延时 C-Bet]：翻牌双方过牌后对手转牌再次 Check，其范围极度弱化封顶（Capped）。在有利位置释放 70% 延时持续下注扫荡死钱';
          planDesc = `33% 延时小注 (${betSmallBb}BB) 剥削其过宽弃牌`;
        }
      } else {
        // 单挑且转牌为干燥超牌面，具有微量极化大注诈唬配比
        const hasBlocker = ctx.hasNutBlocker || (ctx.heroCards && ctx.heroCards.some(c => c.startsWith('A') || c.startsWith('K')));
        if (hasBlocker && (runType === 'OVERCARD' || runType === 'BRICK_BLANK') && spr >= 2.5) {
          primaryTier = '过牌';
          primaryBb = 0;
          action = 'CHECK';
          frequencies = { check: 75, small: 0, medium: 0, strong: 15, overbet: 10, allin: 0 };
          rationale = '单挑持大高张阻断牌，在干燥/超牌转折面上保留 25% 极化大注诈唬配比，75% 多数过牌放弃';
          planDesc = '绝大多数时候过牌放弃，低频大注维持纳什平衡';
        } else {
          primaryTier = '过牌';
          primaryBb = 0;
          action = 'CHECK';
          frequencies = { check: 100, small: 0, medium: 0, strong: 0, overbet: 0, allin: 0 };
          rationale = '手牌胜率低下且缺乏阻断效应，严正过牌止损';
          planDesc = '过牌放弃';
        }
      }
    }

    const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const latencyUs = Math.round((t1 - t0) * 1000 * 10) / 10;

    const riverSprAfterBet = predictRiverSpr(pot, effStack, primaryBb);

    return {
      status: 'MATCHED_TURN_SIZING',
      primaryTier,
      primaryBb,
      action,
      frequencies,
      potGeometry: {
        currentSpr: Math.round(spr * 10) / 10,
        riverSprAfterBet: Math.round(riverSprAfterBet * 10) / 10,
        geometricRatio: Math.round(geomRatio * 100) / 100,
        planDesc
      },
      rationale,
      latencyUs: latencyUs > 0 ? latencyUs : 0.1,
      sizingTiers: [
        { label: '过牌 (0%)', bb: 0, freq: frequencies.check },
        { label: '小注 (33%)', bb: betSmallBb, freq: frequencies.small },
        { label: '中注 (67%)', bb: betMediumBb, freq: frequencies.medium },
        { label: '重注 (75%)', bb: betStrongBb, freq: frequencies.strong },
        { label: '超池 (125%)', bb: betOverBb, freq: frequencies.overbet },
        { label: '全押 (Jam)', bb: allinBb, freq: frequencies.allin }
      ]
    };
  }

  global.calculateGeometricRatio = calculateGeometricRatio;
  global.evaluateTurnSizing = evaluateTurnSizing;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      calculateGeometricRatio,
      evaluateTurnSizing
    };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
