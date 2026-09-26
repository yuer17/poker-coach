// 翻后 GTO 极化策略宏模板引擎 (Phase 3 - Module 3 & 4)
// 设计者：GPT-6-Astra (首席架构师) + Gemini (主程)
// 目标：将 [牌面簇] × [手牌分桶] × [战术角色] 映射为 GTO 基准策略，并通过三道物理铁闸裁决

import { classifyBoardTexture } from './postflop_board_classifier.js';
import { bucketHeroHand } from './postflop_hand_bucketer.js';

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
export function evaluatePostflopGto(ctx) {
  const { heroCards, boardCards, betRatio = 0.33, spr = 4.0, isOOP = true, isPFR = false } = ctx;

  const texture = classifyBoardTexture(boardCards);
  const hand = bucketHeroHand(heroCards, boardCards);

  // 计算理论 MDF (最低防守频率)
  // MDF = 1 / (1 + betRatio)
  const mdfFloor = Math.round((1 / (1 + betRatio)) * 100);

  let frequencies = [0, 100, 0, 0]; // [Fold, Call, Raise, Jam]
  let primaryAction = 'CALL';
  let reason = '';
  let guardrailApplied = null;

  // 场景 1: OOP 防守面对对手小尺度持续下注 (Mini C-Bet <= 38%)
  if (betRatio <= 0.38) {
    if (hand.bucket === 'NUTS_PREMIUM') {
      // 顶级强牌：在干燥面慢打平跟设陷阱，在湿润面加注造大底池
      if (texture.isDry) {
        frequencies = [0, 70, 30, 0]; // 70% Call 陷阱 / 30% Raise
        primaryAction = 'CALL';
        reason = `💡 GTO 宏模板 [干燥面对子面慢打]：手持 ${hand.details}，公牌结构干燥（${texture.clusterKey}），对手范围充满空气；以 70% 高频平跟设下陷阱诱捕，30% 极化加注建立底池。`;
      } else {
        frequencies = [0, 30, 70, 0];
        primaryAction = 'RAISE';
        reason = `💡 GTO 宏模板 [湿润面主动造池]：手持 ${hand.details}，公牌潮湿，以 70% 频率发起价值加注保护胜率。`;
      }
    } else if (hand.bucket === 'STRONG_DRAW') {
      // 强听牌：半诈唬加注或平跟
      frequencies = [0, 50, 50, 0];
      primaryAction = 'RAISE';
      reason = `💡 GTO 宏模板 [强听牌半诈唬]：手持 ${hand.details}（${hand.outs} 张补牌），平跟与加注混合对抗小注。`;
    } else if (hand.bucket === 'MARGINAL_MADE') {
      // 中等成牌：严格平跟抓诈，受 MDF 铁闸保护
      frequencies = [0, 100, 0, 0];
      primaryAction = 'CALL';
      reason = `💡 GTO 宏模板 [中等成牌抓诈]：手持 ${hand.details}，面对 ${Math.round(betRatio*100)}% 小注拥有充足底池赔率与摊牌价值，坚决平跟捍卫（理论 MDF=${mdfFloor}%）。`;
    } else if (hand.bucket === 'BACKDOOR_POTENTIAL') {
      // 双后门潜力：极化反击与浮动跟注（彻底解决 T2s 案例）
      frequencies = [25, 35, 40, 0]; // 25% Fold, 35% Float, 40% Raise
      primaryAction = 'RAISE';
      reason = `💡 GTO 极化反击 [捍卫 MDF 与惩罚空气]：面对对手 ${Math.round(betRatio*100)}% Mini C-bet，公牌为干燥对子面（${texture.clusterKey}），对手范围包含大量两张高牌空气；手牌持 ${hand.details}，以 40% 极化 Check-Raise + 35% 浮动跟注发起反击，严防被免费剥削。`;
    } else {
      // 纯空气：在干燥面面对超小注，部分跟注以满足 MDF 底线
      if (betRatio <= 0.25) {
        frequencies = [60, 40, 0, 0];
        primaryAction = 'CALL';
        reason = `💡 MDF 底线捍卫 [超小注防剥削]：面对仅 ${Math.round(betRatio*100)}% 极小注，部分浮动跟注维持最低防守频率（MDF=${mdfFloor}%）。`;
      } else {
        frequencies = [100, 0, 0, 0];
        primaryAction = 'FOLD';
        reason = `💡 GTO 宏模板 [纯空气弃牌]：手持 ${hand.details}，无后门转机，果断弃牌止损。`;
      }
    }
  } else {
    // 场景 2: 面对标准尺寸下注 (>38%)
    if (hand.bucket === 'NUTS_PREMIUM') {
      frequencies = [0, 40, 60, 0];
      primaryAction = 'RAISE';
      reason = `💡 GTO 宏模板 [价值加注]：持有 ${hand.details}，面对标准尺寸持续加注造池。`;
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
