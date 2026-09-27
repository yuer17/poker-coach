// 翻后转牌掉牌特征跃迁与范围优势转移分析器 (Phase 8 - Module 1)
// 设计者：GPT-6-Astra (首席架构师) + Gemini (主程)
// 依据：TASK-ASTRA-036 架构裁决：转牌 Runout 特征动态转移与多街连续博弈

(function(global) {
  const RANK_VALUES = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    'T': 10, 't': 10, 'J': 11, 'j': 11, 'Q': 12, 'q': 12, 'K': 13, 'k': 13, 'A': 14, 'a': 14
  };

  function parseCard(cardStr) {
    if (!cardStr || typeof cardStr !== 'string' || cardStr.length < 2) return null;
    const r = cardStr[0].toUpperCase();
    const s = cardStr[1].toLowerCase();
    const v = RANK_VALUES[r];
    if (!v) return null;
    return { rank: r, suit: s, value: v, str: cardStr };
  }

  /**
   * 分析转牌掉牌性质及范围优势迁移 (Turn Runout Dynamics)
   * @param {Array<string>} flopBoard - 翻牌三张，如 ['5d', '5h', '3c']
   * @param {string} turnCardStr - 转牌一张，如 'Kd'
   * @returns {Object} 掉牌分类、范围迁移判定与战术解说
   */
  function classifyTurnRunout(flopBoard, turnCardStr) {
    if (!flopBoard || flopBoard.length < 3 || !turnCardStr) {
      return {
        runoutType: 'UNKNOWN',
        type: 'UNKNOWN',
        typeName: '未知掉牌',
        label: '未知掉牌',
        advantageShift: 'neutral',
        advShift: 'Neutral',
        shiftName: '中性平衡',
        description: '公牌数据不完整',
        tactics: '公牌数据不完整'
      };
    }

    const flop = flopBoard.slice(0, 3).map(parseCard).filter(Boolean);
    const turn = parseCard(turnCardStr);
    if (flop.length < 3 || !turn) {
      return {
        runoutType: 'UNKNOWN',
        typeName: '未知掉牌',
        advantageShift: 'neutral',
        shiftName: '中性平衡',
        description: '卡牌解析异常'
      };
    }

    const flopRanks = flop.map(c => c.value);
    const flopMaxRank = Math.max(...flopRanks);
    const flopSuits = flop.map(c => c.suit);
    
    // 统计公牌花色分布
    const suitCounts = {};
    flopSuits.forEach(s => { suitCounts[s] = (suitCounts[s] || 0) + 1; });
    const turnSuitCount = (suitCounts[turn.suit] || 0) + 1;

    // 统计公牌配对情况
    const allBoardRanks = [...flopRanks, turn.value];
    const rankCounts = {};
    allBoardRanks.forEach(r => { rankCounts[r] = (rankCounts[r] || 0) + 1; });
    const isTurnPaired = rankCounts[turn.value] >= 2;

    // 检查是否完成顺子或听顺延展
    const uniqueRanks = Array.from(new Set(allBoardRanks)).sort((a, b) => a - b);
    let maxConnectedRun = 1;
    let currentRun = 1;
    for (let i = 1; i < uniqueRanks.length; i++) {
      if (uniqueRanks[i] === uniqueRanks[i - 1] + 1) {
        currentRun++;
        if (currentRun > maxConnectedRun) maxConnectedRun = currentRun;
      } else {
        currentRun = 1;
      }
    }
    // 特殊处理 A234 顺子潜力 (轮子)
    if (uniqueRanks.includes(14) && uniqueRanks.includes(2) && uniqueRanks.includes(3) && uniqueRanks.includes(4)) {
      if (maxConnectedRun < 4) maxConnectedRun = 4;
    }

    let runoutType = 'BRICK_BLANK';
    let typeName = '干燥无关白牌';
    let advantageShift = 'neutral_blank';
    let shiftName = '维持翻牌优势';
    let description = '';

    // 1. 公牌成花或同花听牌显著增强
    if (turnSuitCount >= 3) {
      runoutType = 'FLUSH_COMPLETER';
      typeName = turnSuitCount >= 4 ? '四同花公牌面' : '三同花危险面';
      advantageShift = 'caller_favored';
      shiftName = '偏向防守方/极化';
      description = `转牌带来第三张同花 (${turn.suit.toUpperCase()})，大量同花听牌命中，范围显著极化，防守方暗花与强听牌密度骤增。`;
    }
    // 2. 超牌掉落 (Overcard) - 最经典的 PFR 范围优势增强
    else if (turn.value > flopMaxRank && turn.value >= 10) {
      runoutType = 'OVERCARD';
      typeName = `超牌 (${turn.rank})`;
      advantageShift = 'pfr_favored';
      shiftName = '显著偏向翻前开池者';
      description = `转牌落顶超牌 (${turn.rank})，高度重合翻前加注者（PFR）的未受限大高张范围，跟注者中对/底对被压制，支持第二枪 (Double Barrel) 持续施压。`;
    }
    // 3. 顺子成牌或强连张听牌延展
    else if (maxConnectedRun >= 4) {
      runoutType = 'STRAIGHT_COMPLETER';
      typeName = '连张顺子成牌/高危面';
      advantageShift = 'caller_favored';
      shiftName = '偏向翻前平跟者';
      description = `转牌点数 (${turn.rank}) 促成 4 连张顺子结构，显著利好平跟者（Caller）的同花连张范围，进攻方需谨慎防范顺子暗雷。`;
    }
    // 4. 公牌配对
    else if (isTurnPaired) {
      runoutType = 'BOARD_PAIR';
      typeName = `公牌成对 (${turn.rank}${turn.rank})`;
      advantageShift = 'pfr_favored';
      shiftName = '利好翻前主动方';
      description = `转牌与公牌配对成双对，降低对手两对组合密度并拉大坚果葫芦差距，翻前加注者范围优势稳固。`;
    }
    // 5. 其他低牌连张微变
    else if (maxConnectedRun === 3 && turn.value <= 9) {
      runoutType = 'STRAIGHT_DRAW_OPEN';
      typeName = '中低连张抽牌面';
      advantageShift = 'caller_favored';
      shiftName = '跟注方听牌增多';
      description = `转牌补充了低端连张，带来开放式顺子听牌潜力，跟注方浮动卡牌具有更高转牌转机。`;
    }
    // 6. 干燥无关牌 (Brick)
    else {
      runoutType = 'BRICK_BLANK';
      typeName = `干燥白牌 (${turn.rank})`;
      advantageShift = 'pfr_favored';
      shiftName = '原优势纯粹延续';
      description = `转牌为干燥无关牌 (${turn.rank})，完全未改变翻牌牌力结构与听牌格局，原有主动权与范围优势原样延续。`;
    }

    return {
      runoutType,
      type: runoutType === 'BRICK_BLANK' ? 'BLANK' : runoutType,
      typeName,
      label: typeName,
      turnCard: turn.str,
      flopMaxRank,
      turnRankValue: turn.value,
      turnRank: turn.value,
      advantageShift,
      advShift: advantageShift === 'pfr_favored' ? 'Raiser' : (advantageShift === 'caller_favored' ? 'Caller' : 'Neutral'),
      shiftName,
      turnSuitCount,
      isTurnPaired,
      description,
      tactics: description
    };
  }

  global.classifyTurnRunout = classifyTurnRunout;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { classifyTurnRunout };
    exports.classifyTurnRunout = classifyTurnRunout;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
