// 翻后手牌宏观分桶器 (Phase 3 - Module 2)
// 设计者：GPT-6-Astra (首席架构师) + Gemini (主程)
// 目标：将玩家在特定牌面下的手牌，精准归入 4+1 大 GTO 分桶：
// [NUTS_PREMIUM, MARGINAL_MADE, STRONG_DRAW, BACKDOOR_POTENTIAL, AIR_WEAK]

(function(global) {
  const RANK_VALUES = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    'T': 10, 't': 10, 'J': 11, 'j': 11, 'Q': 12, 'q': 12, 'K': 13, 'k': 13, 'A': 14, 'a': 14
  };

  /**
   * 判定手牌在当前公牌下的 GTO 宏观分桶
   * @param {Array<string>} heroCards - 手牌两张，如 ['Td', '2d']
   * @param {Array<string>} boardCards - 公牌数组，如 ['5d', '5h', '3c']
   * @returns {Object} { bucket: string, details: string, outs: number, hasBackdoor: boolean }
   */
  function bucketHeroHand(heroCards, boardCards) {
    if (!heroCards || heroCards.length < 2 || !boardCards || boardCards.length < 3) {
      return { bucket: 'AIR_WEAK', details: '未知牌型', outs: 0, hasBackdoor: false };
    }

    const h1 = heroCards[0], h2 = heroCards[1];
    const r1 = RANK_VALUES[h1[0]] || 0, r2 = RANK_VALUES[h2[0]] || 0;
    const s1 = h1[1], s2 = h2[1];
    const isPocketPair = (r1 === r2);
    const isSuited = (s1 === s2);

    const bRanks = boardCards.map(c => RANK_VALUES[c[0]] || 0).sort((a,b)=>b-a);
    const bSuits = boardCards.map(c => c[1]);
    const maxBoardRank = bRanks[0];

    // 1. 计算公牌点数与 Hero 击中情况
    const boardCounts = {};
    for (const r of bRanks) {
      boardCounts[r] = (boardCounts[r] || 0) + 1;
    }
    const boardHasPair = Object.values(boardCounts).some(c => c >= 2);

    let hasTrips = false;
    let hasTwoPair = false;
    let hitTopPair = false;
    let hasOnePair = false;

    if (isPocketPair) {
      if (boardCounts[r1]) {
        hasTrips = true; // 暗三条 (Set)
      } else if (r1 > maxBoardRank) {
        hitTopPair = true; // 超对 (Overpair)
      } else if (boardHasPair) {
        // 口袋对 + 公牌对子: 仅当口袋对大于公牌第二大点数时才算强两对；弱口袋对属于边际成牌
        hasOnePair = true;
      } else {
        hasOnePair = true; // 弱口袋对
      }
    } else {
      const match1 = boardCounts[r1] || 0;
      const match2 = boardCounts[r2] || 0;

      if (match1 >= 2 || match2 >= 2) {
        hasTrips = true; // 明三条 (Trips)
      } else if (match1 >= 1 && match2 >= 1) {
        hasTwoPair = true; // 两张底牌均中对子 (真实两对)
      } else if (match1 >= 1 || match2 >= 1) {
        const hitRank = match1 >= 1 ? r1 : r2;
        if (hitRank === maxBoardRank) hitTopPair = true;
        else hasOnePair = true;
      }
    }

    // 2. 听牌与成牌判定 (Flush, Straight, Flush Draw, OESD, Gutshot)
    const allCards = [...heroCards, ...boardCards];
    const suitCounts = {};
    for (const c of allCards) {
      const s = c[1];
      suitCounts[s] = (suitCounts[s] || 0) + 1;
    }
    const maxSuitCount = Math.max(...Object.values(suitCounts));
    const isFlushDraw = (maxSuitCount === 4 && (heroCards.some(c => suitCounts[c[1]] >= 4)));
    const isMadeFlush = (maxSuitCount >= 5 && heroCards.some(c => suitCounts[c[1]] >= 5));

    // 顺子判定 (含 A-2-3-4-5 轮子顺与常规顺子)
    const distinctRanks = [...new Set(allCards.map(c => RANK_VALUES[c[0]] || 0))].sort((a,b)=>b-a);
    if (distinctRanks.includes(14)) distinctRanks.push(1); // Ace 作为 1

    let isMadeStraight = false;
    let isOESD = false;
    let hasGutshot = false;

    // 检查是否已成顺子 (连续 5 张且至少使用 1 张底牌)
    for (let i = 0; i + 4 < distinctRanks.length; i++) {
      if (distinctRanks[i] - distinctRanks[i+4] === 4) {
        const straightSpan = [distinctRanks[i], distinctRanks[i+1], distinctRanks[i+2], distinctRanks[i+3], distinctRanks[i+4]];
        const heroUsed = straightSpan.includes(r1) || straightSpan.includes(r2) || (straightSpan.includes(1) && (r1 === 14 || r2 === 14));
        if (heroUsed) {
          isMadeStraight = true;
          break;
        }
      }
    }

    // 若未成顺子，检查强听顺 (OESD: 4 连张两头听 / Gutshot: 卡张听)
    if (!isMadeStraight) {
      for (let i = 0; i + 3 < distinctRanks.length; i++) {
        if (distinctRanks[i] - distinctRanks[i+3] === 3) {
          const span = [distinctRanks[i], distinctRanks[i+1], distinctRanks[i+2], distinctRanks[i+3]];
          const heroUsed = span.includes(r1) || span.includes(r2) || (span.includes(1) && (r1 === 14 || r2 === 14));
          if (heroUsed) isOESD = true;
        }
      }
      if (!isOESD) {
        for (let i = 0; i + 3 < distinctRanks.length; i++) {
          if (distinctRanks[i] - distinctRanks[i+3] === 4) {
            const span = [distinctRanks[i], distinctRanks[i+1], distinctRanks[i+2], distinctRanks[i+3]];
            const heroUsed = span.includes(r1) || span.includes(r2) || (span.includes(1) && (r1 === 14 || r2 === 14));
            if (heroUsed) hasGutshot = true;
          }
        }
      }
    }

    // 3. 后门听牌判定 (Backdoor Flush & Straight) - 底牌必须实质贡献
    let hasBackdoorFlush = false;
    if (isSuited && boardCards.length === 3) {
      const flopSuitMatches = bSuits.filter(s => s === s1).length;
      if (flopSuitMatches === 1) hasBackdoorFlush = true; // 手牌同花 + 公牌一张同花 = 3张同花
    }

    let hasBackdoorStraight = false;
    if (boardCards.length === 3) {
      // 底牌必须至少有 1 张参与构成跨度 <= 4 的 3 张连牌潜力
      const heroRanks = [r1, r2];
      if (r1 === 14) heroRanks.push(1);
      if (r2 === 14) heroRanks.push(1);

      const bRanksSet = [...new Set(bRanks)];
      if (bRanksSet.includes(14)) bRanksSet.push(1);

      for (const hr of heroRanks) {
        for (let i = 0; i < bRanksSet.length; i++) {
          for (let j = i + 1; j < bRanksSet.length; j++) {
            const trio = [hr, bRanksSet[i], bRanksSet[j]].sort((a,b)=>a-b);
            if (trio[2] - trio[0] <= 4 && trio[0] !== trio[1] && trio[1] !== trio[2]) {
              hasBackdoorStraight = true;
              break;
            }
          }
          if (hasBackdoorStraight) break;
        }
        if (hasBackdoorStraight) break;
      }
    }

    // 4. 映射到 GTO 宏观 4+1 分桶
    // 4.1 Nuts / Premium (强两对、三条、顺子、同花、强顶对顶级踢脚)
    if (isMadeFlush || isMadeStraight || hasTrips || hasTwoPair || (hitTopPair && (r1 === 14 || r2 === 14 || isPocketPair))) {
      let desc = '强成牌';
      if (isMadeFlush) desc = '同花成牌';
      else if (isMadeStraight) desc = '顺子成牌';
      else if (hasTrips) desc = '三条/暗三';
      else if (hasTwoPair) desc = '两对';
      else desc = '顶对顶踢/超对';

      return {
        bucket: 'NUTS_PREMIUM',
        details: desc,
        outs: 0,
        hasBackdoor: false
      };
    }

    // 4.2 Strong Draw (强同花听牌、双头顺听牌、组合听牌)
    if (isFlushDraw || isOESD || (hasGutshot && isFlushDraw)) {
      return {
        bucket: 'STRONG_DRAW',
        details: isFlushDraw && isOESD ? '顺风同花双重巨抽' : (isFlushDraw ? '同花听牌 (9 outs)' : '双头顺听牌 (8 outs)'),
        outs: isFlushDraw && isOESD ? 15 : (isFlushDraw ? 9 : 8),
        hasBackdoor: false
      };
    }

    // 4.3 Marginal Made (普通顶对、中对、底对、口袋中对)
    if (hitTopPair || hasOnePair) {
      return {
        bucket: 'MARGINAL_MADE',
        details: hitTopPair ? '普通顶对' : (isPocketPair ? '口袋对子' : '中底对'),
        outs: 2,
        hasBackdoor: false
      };
    }

    // 4.4 Backdoor Potential (双后门潜力: 后门同花 + 后门顺子, 具备极化 Check-Raise 反击能力)
    if (hasBackdoorFlush && hasBackdoorStraight && boardCards.length === 3) {
      return {
        bucket: 'BACKDOOR_POTENTIAL',
        details: '双后门潜力 (后门同花+后门顺子)',
        outs: 3,
        hasBackdoor: true
      };
    }

    // 4.5 Air / Weak
    return {
      bucket: 'AIR_WEAK',
      details: '高牌/无成牌空气',
      outs: hasGutshot ? 4 : 0,
      hasBackdoor: hasBackdoorFlush || hasBackdoorStraight
    };
  }

  global.bucketHeroHand = bucketHeroHand;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { bucketHeroHand };
    exports.bucketHeroHand = bucketHeroHand;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
