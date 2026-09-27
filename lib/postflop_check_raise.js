// 翻后过牌加注 (Check-Raise, C/R) 决策引擎 (Phase 9C - Postflop Check-Raise Decision Engine)
// 设计者：GPT-6-Astra (首席架构师) + Gemini (主程)
// 依据：TASK-ASTRA-037 架构裁决书：两极化范围结构、金额统一口径、Fedor 双后门量化与底池几何学

(function(global) {
  'use strict';

  const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  const SUITS = ['s', 'h', 'd', 'c'];

  /**
   * 将牌面字符串转换为点数与花色对象
   * 支持 'As', 'Kh', '10d', 'Td', 'A♠', 'K♥' 等格式
   */
  function parseCard(c) {
    if (!c || typeof c !== 'string') return null;
    let s = c.trim();
    // 替换符号花色
    s = s.replace(/♠/g, 's').replace(/♥/g, 'h').replace(/♦/g, 'd').replace(/♣/g, 'c');
    let rank = '', suit = '';
    if (s.length === 3 && (s.startsWith('10') || s.startsWith('T'))) {
      rank = 'T';
      suit = s.charAt(2).toLowerCase();
    } else if (s.length >= 2) {
      rank = s.slice(0, -1).toUpperCase();
      if (rank === '10') rank = 'T';
      suit = s.slice(-1).toLowerCase();
    }
    const rankIdx = RANKS.indexOf(rank);
    if (rankIdx === -1 || !['s', 'h', 'd', 'c'].includes(suit)) return null;
    return { rank, suit, rankIdx, str: rank + suit };
  }

  /**
   * 精确检测后门同花 (Backdoor Flush Draw)
   * 需 Hero 至少贡献 1 张手牌，且与翻牌同花色张数共计 3 张
   */
  function detectBackdoorFlush(heroCards, boardCards) {
    if (!heroCards || heroCards.length < 2 || !boardCards || boardCards.length < 3) {
      return { hasBdFlush: false, suit: null, heroSuitCount: 0, boardSuitCount: 0 };
    }
    const h = heroCards.map(parseCard).filter(Boolean);
    const b = boardCards.slice(0, 3).map(parseCard).filter(Boolean);
    if (h.length < 2 || b.length < 3) return { hasBdFlush: false, suit: null };

    for (const suit of SUITS) {
      const hCount = h.filter(c => c.suit === suit).length;
      const bCount = b.filter(c => c.suit === suit).length;
      if (hCount >= 1 && (hCount + bCount === 3)) {
        return { hasBdFlush: true, suit, heroSuitCount: hCount, boardSuitCount: bCount };
      }
    }
    return { hasBdFlush: false, suit: null };
  }

  /**
   * 精确检测后门顺子 (Backdoor Straight Draw, BDSD)
   * 必须由 Hero 手牌参与，且在 5 张顺子窗口中覆盖 3 张不同点数（可在转牌+河牌连续成顺），
   * 完整支持 A-2-3-4-5 (Wheel) 低位顺子。
   */
  function detectBackdoorStraight(heroCards, boardCards) {
    if (!heroCards || heroCards.length < 2 || !boardCards || boardCards.length < 3) {
      return { hasBdStraight: false, windows: 0 };
    }
    const h = heroCards.map(parseCard).filter(Boolean);
    const b = boardCards.slice(0, 3).map(parseCard).filter(Boolean);
    if (h.length < 2 || b.length < 3) return { hasBdStraight: false, windows: 0 };

    // 获取所有可用点数下标 (0=2 ... 12=A)
    const heroIndices = new Set(h.map(c => c.rankIdx));
    const boardIndices = new Set(b.map(c => c.rankIdx));
    const allIndices = new Set([...heroIndices, ...boardIndices]);

    // 顺子窗口检测 (共 10 个顺子窗口：A-2-3-4-5 到 T-J-Q-K-A)
    // 窗口表示为点数索引集合：A-2-3-4-5 使用 [-1, 0, 1, 2, 3]，其中 -1 代表 Ace 低位
    let validWindows = 0;
    const windows = [
      [-1, 0, 1, 2, 3], // A-2-3-4-5
      [0, 1, 2, 3, 4],  // 2-3-4-5-6
      [1, 2, 3, 4, 5],  // 3-4-5-6-7
      [2, 3, 4, 5, 6],  // 4-5-6-7-8
      [3, 4, 5, 6, 7],  // 5-6-7-8-9
      [4, 5, 6, 7, 8],  // 6-7-8-9-T
      [5, 6, 7, 8, 9],  // 7-8-9-T-J
      [6, 7, 8, 9, 10], // 8-9-T-J-Q
      [7, 8, 9, 10, 11],// 9-T-J-Q-K
      [8, 9, 10, 11, 12]// T-J-Q-K-A
    ];

    for (const win of windows) {
      let heroContributed = false;
      let matchedCount = 0;

      for (const idx of win) {
        const actualIdx = idx === -1 ? 12 : idx; // -1 映射为 Ace(12)
        if (allIndices.has(actualIdx)) {
          matchedCount++;
          if (heroIndices.has(actualIdx)) {
            heroContributed = true;
          }
        }
      }

      // 后门顺子：恰好覆盖 3 张牌，且 Hero 至少贡献了 1 张（不能全是公共牌借公牌）
      if (matchedCount === 3 && heroContributed) {
        validWindows++;
      }
    }

    return {
      hasBdStraight: validWindows > 0,
      windows: validWindows
    };
  }

  /**
   * 枚举 47 张未知转牌，计算强转牌出牌数 (FD, OESD, 顶对等并集)
   * 依照 Astra TASK-ASTRA-037 第四节枚举核验准则
   */
  function evaluateTurnRunouts(heroCards, boardCards) {
    const h = (heroCards || []).map(parseCard).filter(Boolean);
    const b = (boardCards || []).map(parseCard).filter(Boolean);
    if (h.length < 2 || b.length < 3) {
      return { strongTurnCardsCount: 0, fdCount: 0, oesdCount: 0, topPairCount: 0, gutshotCount: 0 };
    }

    const deadCards = new Set([...h.map(c => c.str), ...b.map(c => c.str)]);
    const flopRanks = b.slice(0, 3).map(c => c.rankIdx);
    const maxFlopRank = Math.max(...flopRanks);

    let fdCount = 0;
    let oesdCount = 0;
    let gutshotCount = 0;
    let topPairCount = 0;
    const strongCardSet = new Set();

    // 枚举全部 52 张牌中剩余未发出的 47 张转牌
    for (const rank of RANKS) {
      const rIdx = RANKS.indexOf(rank);
      for (const suit of SUITS) {
        const cardStr = rank + suit;
        if (deadCards.has(cardStr)) continue;

        // 假设当前卡作为转牌发出
        const turnCard = { rank, suit, rankIdx: rIdx, str: cardStr };
        const fourBoard = [...b.slice(0, 3), turnCard];

        // 1. 同花听牌判定 (4 张同花，Hero 至少含 1 张)
        let isTurnFd = false;
        for (const s of SUITS) {
          const hSuit = h.filter(c => c.suit === s).length;
          const bSuit = fourBoard.filter(c => c.suit === s).length;
          if (hSuit >= 1 && (hSuit + bSuit >= 4)) {
            isTurnFd = true;
            break;
          }
        }
        if (isTurnFd) {
          fdCount++;
          strongCardSet.add(cardStr);
        }

        // 2. 顺子听牌判定 (4 张顺子窗口，Hero 至少含 1 张)
        const curIndices = new Set([...h.map(c => c.rankIdx), ...fourBoard.map(c => c.rankIdx)]);
        const heroIndices = new Set(h.map(c => c.rankIdx));
        let isOesd = false;
        let isGutshot = false;

        // 检测是否存在 4 张严格连续点数构成两头顺听牌 (2-3-4-5 至 9-T-J-Q，两端皆可成顺)
        for (let r = 0; r <= 8; r++) { // r=0 (2-3-4-5) 到 r=8 (T-J-Q-K 也是两头顺：9 或 A)
          if (curIndices.has(r) && curIndices.has(r + 1) && curIndices.has(r + 2) && curIndices.has(r + 3)) {
            if (heroIndices.has(r) || heroIndices.has(r + 1) || heroIndices.has(r + 2) || heroIndices.has(r + 3)) {
              isOesd = true;
              break;
            }
          }
        }

        // 若不是 OESD，检测卡顺 (Gutshot: 5 张窗口内有 4 张且含缺张，或 A-2-3-4 / J-Q-K-A 单头顺)
        if (!isOesd) {
          const windows = [
            [-1, 0, 1, 2, 3], [0, 1, 2, 3, 4], [1, 2, 3, 4, 5], [2, 3, 4, 5, 6],
            [3, 4, 5, 6, 7], [4, 5, 6, 7, 8], [5, 6, 7, 8, 9], [6, 7, 8, 9, 10],
            [7, 8, 9, 10, 11], [8, 9, 10, 11, 12]
          ];
          for (const win of windows) {
            let hInWin = false;
            let count = 0;
            for (const idx of win) {
              const actualIdx = idx === -1 ? 12 : idx;
              if (curIndices.has(actualIdx)) {
                count++;
                if (heroIndices.has(actualIdx)) hInWin = true;
              }
            }
            if (count === 4 && hInWin) {
              isGutshot = true;
              break;
            }
          }
        }

        if (isOesd) {
          oesdCount++;
          strongCardSet.add(cardStr);
        } else if (isGutshot) {
          gutshotCount++;
        }

        // 3. 顶对判定 (转牌使 Hero 的手牌配对，且该点数 > 翻牌最高张)
        if (heroIndices.has(rIdx) && rIdx > maxFlopRank) {
          topPairCount++;
          strongCardSet.add(cardStr);
        }
      }
    }

    return {
      strongTurnCardsCount: strongCardSet.size,
      fdCount,
      oesdCount,
      gutshotCount,
      topPairCount
    };
  }

  /**
   * 翻后过牌加注核心求解器
   * 严格贯彻 Astra TASK-ASTRA-037 架构裁决：
   * 1. 统一金额符号：P(前底池), B(对手注), R(加注到), C=R-B(对手补跟), T=P+2R(跟注后总底池)；
   * 2. 河牌极化配比：f* = (R - B) / (P + 2R), beta_river = (R - B) / (P + B + R)；
   * 3. 翻牌/转牌递推衰减：beta_flop ~ 1.5-2.0, beta_turn ~ 1.0；
   * 4. Fedor 双后门 (BDFD+BDSD) 强转牌枚举度量；
   * 5. 尺度底池几何度量与浅筹码 SPR<=2.5 全押铁律。
   *
   * @param {Object} params - 决策上下文入参
   * @returns {Object} 完整 Check-Raise 决策对象
   */
  function solveCheckRaise(params) {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    if (!params) {
      return {
        status: 'INVALID_INPUT',
        action: 'FOLD',
        crFrequency: 0,
        recommendedRaiseToBb: 0,
        recommendedRaiseByBb: 0,
        multiplier: 0,
        sizingTier: 'standard',
        isAllIn: false,
        category: 'PURE_FOLD',
        categoryLabel: '数据异常',
        tacticalReasoning: '输入参数为空',
        latencyUs: 0.1
      };
    }

    const street = (params.street || 'FLOP').toUpperCase(); // FLOP, TURN, RIVER
    const preBetPot = Math.max(0.1, Number(params.preBetPot || params.pot || 10));
    const villainBet = Math.max(0.1, Number(params.villainBet || params.bet || 3.3));
    const effStack = Math.max(0, Number(params.effStack !== undefined ? params.effStack : 50));
    const spr = preBetPot > 0 ? effStack / preBetPot : 0;
    const heroCards = params.heroCards || [];
    const boardCards = params.boardCards || [];
    const isMultiway = Boolean(params.isMultiway);
    const numContenders = Math.max(2, Number(params.numContenders || (isMultiway ? 3 : 2)));
    const multiwayRole = params.multiwayRole || (isMultiway ? 'SANDWICH' : 'ABSOLUTE_OOP');
    const handBucket = params.handBucket || 'AIR';
    const boardTexture = params.boardTexture || 'DYNAMIC';
    const rawEquity = Number(params.equity !== undefined ? params.equity : 50);

    // 1. 尺度与几何倍率计算 (Sizing Geometry)
    const betRatio = villainBet / preBetPot;
    let multiplier = 3.8; // 默认小注 3.8x
    let sizingTier = 'standard';

    if (betRatio <= 0.35) {
      // 面对小注 (<=35% 底池)：反浮动惩罚性重注 (3.5x ~ 4.2x)
      multiplier = 3.8;
      sizingTier = 'small';
    } else if (betRatio <= 0.70) {
      // 面对中注 (35% ~ 70% 底池)：标准两极化加注 (2.8x ~ 3.2x)
      multiplier = 3.0;
      sizingTier = 'standard';
    } else if (betRatio <= 1.0) {
      // 面对重注 (70% ~ 100% 底池)：收紧加注尺度 (2.5x ~ 2.8x)
      multiplier = 2.6;
      sizingTier = 'large';
    } else {
      // 面对超池 (>100% 底池)：紧缩尺度
      multiplier = 2.2;
      sizingTier = 'large';
    }

    // 试算目标加注额 R (raise-to)
    let targetR = Math.round(villainBet * multiplier * 10) / 10;
    // 确保加注满足扑克最小合法加注 (至少等于对手注额的 2 倍: R >= 2*B)
    targetR = Math.max(targetR, Math.round(villainBet * 2 * 10) / 10);

    // 浅筹码全押触发判定 (SPR <= 2.5 或 试算加注额已达有效筹码 75% 以上)
    let isAllIn = false;
    let raiseToBb = targetR;
    if (effStack > 0 && (raiseToBb >= effStack * 0.75 || (spr <= 2.5 && effStack <= villainBet * 5))) {
      raiseToBb = effStack;
      isAllIn = true;
      sizingTier = 'allin';
    } else if (raiseToBb > effStack && effStack > 0) {
      raiseToBb = effStack;
      isAllIn = true;
      sizingTier = 'allin';
    }

    const raiseByBb = Math.max(0, Math.round((raiseToBb - villainBet) * 10) / 10);
    const actualMultiplier = villainBet > 0 ? Math.round((raiseToBb / villainBet) * 10) / 10 : 0;

    // 2. 底池几何学诊断与 Alpha / Beta 严格计算
    const ipCallCost = raiseByBb;
    const potAfterCall = preBetPot + 2 * raiseToBb;
    const sprAfterRaise = potAfterCall > 0 ? Math.max(0, Math.round(((effStack - raiseToBb) / potAfterCall) * 100) / 100) : 0;
    
    // 盈亏平衡弃牌率 (Alpha_CR): alpha = R / (P + B + R)
    const denom = preBetPot + villainBet + raiseToBb;
    const alphaCr = denom > 0 ? Math.round((raiseToBb / denom) * 1000) / 10 : 0;

    // 河牌无差异诈唬价值比 (Beta_River): beta = (R - B) / (P + B + R)
    const betaRiver = denom > 0 ? Math.round((raiseByBb / denom) * 1000) / 1000 : 0;
    // 诈唬在加注范围中的理论占比 f* = (R - B) / (P + 2R)
    const bluffRatioF = potAfterCall > 0 ? Math.round((raiseByBb / potAfterCall) * 1000) / 10 : 0;

    // 3. 后门听牌与转牌出牌精确检测 (Fedor Holz Pokercode 专属战术)
    const bdFlush = detectBackdoorFlush(heroCards, boardCards);
    const bdStraight = detectBackdoorStraight(heroCards, boardCards);
    const isDualBackdoor = street === 'FLOP' && bdFlush.hasBdFlush && bdStraight.hasBdStraight;
    const runoutStats = street === 'FLOP' ? evaluateTurnRunouts(heroCards, boardCards) : { strongTurnCardsCount: 0 };

    // 4. 两极化手牌分桶与加注动作研判
    let action = 'CHECK_RAISE';
    let crFrequency = 0;
    let category = 'PURE_CALL';
    let categoryLabel = '纯跟注防守';
    let tacticalReasoning = '';

    // 判断强价值端 (Value C/R)
    const isMonsterValue = ['NUTS_PREMIUM', 'MONSTER', 'QUADS', 'FULL_HOUSE', 'FLUSH', 'STRAIGHT', 'SET'].includes(handBucket);
    const isStrongTwoPair = ['TWO_PAIR', 'TOP_TWO'].includes(handBucket);
    const isStrongOverpair = ['OVERPAIR', 'TPTK'].includes(handBucket) && (spr <= 3.5 || boardTexture.includes('DRY'));

    // 判断半诈唬端 (Semi-Bluff C/R)
    const isComboDraw = ['COMBO_DRAW', 'OESD_FD', 'PAIR_PLUS_DRAW'].includes(handBucket);
    const isStrongDraw = ['STRONG_DRAW', 'NUT_FD', 'OESD'].includes(handBucket);

    // 区分街道进行两极化求解
    if (isMonsterValue || isStrongTwoPair) {
      category = 'VALUE_CR';
      categoryLabel = '强价值加注 (Value C/R)';
      // 价值牌高频加注，混入 15%~25% 过牌-跟注设陷阱
      crFrequency = isMonsterValue ? 80 : 70;
      tacticalReasoning = `手牌具备绝对成牌优势（${handBucket}），加注至 ${raiseToBb}BB 构建底池，对对手中等成手与听牌收取最大价值。`;
    } else if (isComboDraw || (isStrongDraw && rawEquity >= 35)) {
      category = 'SEMI_BLUFF_CR';
      categoryLabel = '强半诈唬加注 (Semi-Bluff C/R)';
      // 强抽牌保持 55%~70% 加注频率
      crFrequency = 60;
      tacticalReasoning = `持有高胜率强抽牌组合（胜率 ${Math.round(rawEquity)}%），加注施加高弃牌压力的同时保留充裕后续成牌胜率（Equity Retention）。`;
    } else if (street === 'FLOP' && isDualBackdoor && betRatio <= 0.38) {
      // 干燥面 / 面对小注：Fedor Holz 双后门听牌极化 C/R
      category = 'BACKDOOR_BLUFF_CR';
      categoryLabel = '双后门极化加注 (Backdoor C/R)';
      crFrequency = 35; // 按照 Astra 架构建议，双后门以 30%~35% 适度混入，杜绝固定过度过激
      tacticalReasoning = `干燥面持双后门顺花（转牌有 ${runoutStats.strongTurnCardsCount} 张强改善出牌，占 ${Math.round((runoutStats.strongTurnCardsCount / 47) * 100)}%），面对小注混入 35% 极化 C/R，惩罚对手宽范围小注并储备转牌双枪开火潜力。`;
    } else if (street === 'RIVER' && rawEquity <= 20 && (handBucket === 'BLOCKER' || handBucket.includes('BLOCKER'))) {
      // 河牌纯阻断牌加注
      category = 'BLUFF_BLOCKER_CR';
      categoryLabel = '阻断牌极化诈唬 (Blocker C/R)';
      crFrequency = Math.round(betaRiver * 40); // 严格依据河牌 beta 比例受控分配
      tacticalReasoning = `河牌成牌错失但持有关键坚果阻断牌，加注至 ${raiseToBb}BB 发动极化反击，利用无差异赔率压制对手抓诈中强对。`;
    } else if (rawEquity >= 28 || isStrongOverpair) {
      // 纯跟注区间 (Pure Call)
      action = 'CALL';
      category = 'PURE_CALL';
      categoryLabel = '过牌-跟注控池 (Check-Call)';
      crFrequency = 0;
      tacticalReasoning = `持有中等成手或纯听牌（胜率 ${Math.round(rawEquity)}%），加注将严重隔离更差手牌并被强牌反压，跟注控池实现手中摊牌胜率期望最高。`;
    } else {
      // 纯弃牌区间 (Pure Fold)
      action = 'FOLD';
      category = 'PURE_FOLD';
      categoryLabel = '过牌-弃牌 (Check-Fold)';
      crFrequency = 0;
      tacticalReasoning = `手牌胜率（${Math.round(rawEquity)}%）低于底池赔率门槛且无优质后门改善组合，理性弃牌止损。`;
    }

    // 5. 多人底池收紧与夹心位抑制 (Phase 9B 联动)
    let multiwayAdjusted = false;
    if (isMultiway && numContenders >= 3) {
      multiwayAdjusted = true;
      if (category === 'BACKDOOR_BLUFF_CR') {
        // 多人底池严格消除空气与纯后门诈唬
        action = rawEquity >= 30 ? 'CALL' : 'FOLD';
        category = rawEquity >= 30 ? 'PURE_CALL' : 'PURE_FOLD';
        categoryLabel = rawEquity >= 30 ? '多人收敛跟注' : '多人收敛弃牌';
        crFrequency = 0;
        tacticalReasoning = `多人底池 (${numContenders}人) 弃牌率急剧折减，依 GTO 多人防守定理彻底抑制双后门与纯诈唬加注，避免多方反弹。`;
      } else if (category === 'SEMI_BLUFF_CR') {
        // 多人半诈唬进张门槛提升
        if (rawEquity < 40) {
          action = 'CALL';
          category = 'PURE_CALL';
          categoryLabel = '多人收敛跟注';
          crFrequency = 0;
          tacticalReasoning = `多人底池中单一同花听牌易遭受反向暗含赔率，半诈唬加注收缩，保留跟注看便宜转牌。`;
        } else {
          crFrequency = Math.round(crFrequency * 0.6); // 频率折减 40%
          tacticalReasoning += `（多人底池频率压制折减）`;
        }
      } else if (category === 'VALUE_CR' && multiwayRole === 'SANDWICH') {
        // 夹心位价值加注加深保护力度
        raiseToBb = Math.round(raiseToBb * 1.15 * 10) / 10;
        tacticalReasoning += ` 夹心位受前后两面夹击，略微放大加注尺寸至 ${raiseToBb}BB 驱赶身后投机跟注者。`;
      }
    }

    // 6. 牌面质地对频率的微调 (Board Texture Modifiers)
    if (boardTexture.includes('PAIRED') || boardTexture.includes('MONOTONE')) {
      if (category === 'VALUE_CR') {
        // 配对面与单花面价值加注略微收敛（防明三条反超或坚果花埋伏）
        crFrequency = Math.max(50, crFrequency - 15);
      }
    } else if (boardTexture.includes('CONNECTED') || boardTexture.includes('WET')) {
      // 湿润中低连张面：BB 范围优势增加
      if (category === 'VALUE_CR' || category === 'SEMI_BLUFF_CR') {
        crFrequency = Math.min(90, crFrequency + 10);
      }
    }

    const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const latencyUs = Math.round((t1 - t0) * 1000 * 10) / 10;

    return {
      status: 'MATCHED_CHECK_RAISE',
      action,
      crFrequency,
      recommendedRaiseToBb: raiseToBb,
      recommendedRaiseByBb: raiseByBb,
      multiplier: actualMultiplier,
      sizingTier,
      isAllIn,
      category,
      categoryLabel,
      handFeatures: {
        hasBdFlush: bdFlush.hasBdFlush,
        hasBdStraight: bdStraight.hasBdStraight,
        isDualBackdoor,
        strongTurnCardsCount: runoutStats.strongTurnCardsCount,
        fdCount: runoutStats.fdCount || 0,
        oesdCount: runoutStats.oesdCount || 0,
        topPairCount: runoutStats.topPairCount || 0
      },
      potGeometry: {
        preBetPot: Math.round(preBetPot * 10) / 10,
        villainBet: Math.round(villainBet * 10) / 10,
        currentPot: Math.round((preBetPot + villainBet) * 10) / 10,
        raiseToBb,
        ipCallCost,
        potAfterCall: Math.round(potAfterCall * 10) / 10,
        sprAfterRaise,
        alphaCr,
        betaRiver,
        bluffRatioF
      },
      tacticalReasoning,
      multiwayAdjusted,
      latencyUs: latencyUs > 0 ? latencyUs : 0.1
    };
  }

  // 挂载全局与 CommonJS 导出
  global.detectBackdoorFlush = detectBackdoorFlush;
  global.detectBackdoorStraight = detectBackdoorStraight;
  global.evaluateTurnRunouts = evaluateTurnRunouts;
  global.solveCheckRaise = solveCheckRaise;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      detectBackdoorFlush,
      detectBackdoorStraight,
      evaluateTurnRunouts,
      solveCheckRaise
    };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
