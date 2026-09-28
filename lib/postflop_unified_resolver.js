/**
 * postflop_unified_resolver.js - 翻后决策单一事实源仲裁器 (Unified Action Resolver)
 * 
 * 职责：终结"多大脑"割裂，统一权威动作、频率矩阵、注额尺度与策略理由，
 * 将河牌终局博弈、转牌跃迁与几何注额、过牌加注极化反击、多人底池动力学与底层 Micro-LUT
 * 深度合流为单一权威事实源 (Single Source of Truth)，保证全站 UI (顶栏 HUD、决策依据主卡、
 * 行动按钮星标以及微卡片) 100% 动作零矛盾闭环。
 * 
 * Version: PokerCode v3.00 正式版
 */

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.UnifiedResolver = factory();
        root.resolveUnifiedDecision = root.UnifiedResolver.resolveUnifiedDecision;
        root.closeFrequencies = root.UnifiedResolver.closeFrequencies;
        root.computeMonteCarloVariance = root.UnifiedResolver.computeMonteCarloVariance;
        root.createUncertaintyContext = root.UnifiedResolver.createUncertaintyContext;
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /**
     * 计算蒙特卡洛抽样三态无偏样本方差与动态置信区间 (Astra-043 终审定理)
     * 支持真实逐样本二阶矩 (S1, S2)、份额数组 (multiwayShares)、精确枚举与三态计数。
     */
    function computeMonteCarloVariance(win, tie, loss, total, multiwayShares, options) {
        options = options || {};

        // 严格全局参数防线：杜绝 NaN 或负数字段绕过
        if (options.equity !== undefined && options.equity !== null) {
            const eqN = Number(options.equity);
            if (!Number.isFinite(eqN) || isNaN(eqN) || eqN < 0 || eqN > 100) {
                return { valid: false, mean: 0, variance: 0, se: 0, ciDelta: 0, ciLow: 0, ciHigh: 0, sampleSize: 0, method: 'UNAVAILABLE' };
            }
        }
        if (win !== undefined && win !== null) {
            const wn = Number(win);
            if (!Number.isFinite(wn) || isNaN(wn) || wn < 0) {
                return { valid: false, mean: 0, variance: 0, se: 0, ciDelta: 0, ciLow: 0, ciHigh: 0, sampleSize: 0, method: 'UNAVAILABLE' };
            }
        }
        if (tie !== undefined && tie !== null) {
            const tn = Number(tie);
            if (!Number.isFinite(tn) || isNaN(tn) || tn < 0) {
                return { valid: false, mean: 0, variance: 0, se: 0, ciDelta: 0, ciLow: 0, ciHigh: 0, sampleSize: 0, method: 'UNAVAILABLE' };
            }
        }
        if (loss !== undefined && loss !== null) {
            const ln = Number(loss);
            if (!Number.isFinite(ln) || isNaN(ln) || ln < 0) {
                return { valid: false, mean: 0, variance: 0, se: 0, ciDelta: 0, ciLow: 0, ciHigh: 0, sampleSize: 0, method: 'UNAVAILABLE' };
            }
        }

        // 优先检查精确枚举模式 (支持单组合 N=1 到全量组合，零抽样误差)
        if (options.method === 'EXACT_ENUMERATION' || options.method === 'exact') {
            const N_exact = Number(total);
            if (!Number.isFinite(N_exact) || N_exact < 1 || !Number.isInteger(N_exact)) {
                return {
                    valid: false,
                    mean: 0,
                    variance: 0,
                    se: 0,
                    ciDelta: 0,
                    ciLow: 0,
                    ciHigh: 0,
                    sampleSize: 0,
                    method: 'UNAVAILABLE'
                };
            }

            // 严格前置脏字段防御：若传入了 win/tie/loss 计数字段，严禁绕过校验 (拒绝 NaN、负数、非整数、求和不守恒)
            const hasWin = (win !== undefined && win !== null);
            const hasTie = (tie !== undefined && tie !== null);
            const hasLoss = (loss !== undefined && loss !== null);
            let w = 0, t = 0, l = 0;
            if (hasWin || hasTie || hasLoss) {
                w = hasWin ? Number(win) : 0;
                t = hasTie ? Number(tie) : 0;
                l = hasLoss ? Number(loss) : (N_exact - w - t);

                if (!Number.isFinite(w) || !Number.isFinite(t) || !Number.isFinite(l) ||
                    !Number.isInteger(w) || !Number.isInteger(t) || !Number.isInteger(l) ||
                    w < 0 || t < 0 || l < 0 ||
                    (w + t + l !== N_exact)) {
                    return {
                        valid: false,
                        mean: 0,
                        variance: 0,
                        se: 0,
                        ciDelta: 0,
                        ciLow: 0,
                        ciHigh: 0,
                        sampleSize: 0,
                        method: 'UNAVAILABLE'
                    };
                }
            }

            // 严格前置 equity 字段校验 (若提供，必须为 [0, 100] 有限数值)
            const hasEq = (options.equity !== undefined && options.equity !== null);
            if (hasEq) {
                const eqNum = Number(options.equity);
                if (!Number.isFinite(eqNum) || eqNum < 0 || eqNum > 100) {
                    return {
                        valid: false,
                        mean: 0,
                        variance: 0,
                        se: 0,
                        ciDelta: 0,
                        ciLow: 0,
                        ciHigh: 0,
                        sampleSize: 0,
                        method: 'UNAVAILABLE'
                    };
                }
            }

            if (!hasEq && !hasWin && !hasTie && !hasLoss) {
                // 没有提供任何结果证据 (既无 equity 又无 win/tie/loss 计数)
                return {
                    valid: false,
                    mean: 0,
                    variance: 0,
                    se: 0,
                    ciDelta: 0,
                    ciLow: 0,
                    ciHigh: 0,
                    sampleSize: 0,
                    method: 'UNAVAILABLE'
                };
            }

            let tShare = 0.5;
            if (t > 0) {
                if (typeof options.tieShare === 'number') {
                    if (!Number.isFinite(options.tieShare) || options.tieShare <= 0 || options.tieShare > 1) {
                        return {
                            valid: false,
                            mean: 0,
                            variance: 0,
                            se: 0,
                            ciDelta: 0,
                            ciLow: 0,
                            ciHigh: 0,
                            sampleSize: 0,
                            method: 'UNAVAILABLE'
                        };
                    }
                    tShare = options.tieShare;
                } else if (options.playerCount && options.playerCount > 2) {
                    // 多人平局缺少实际份额证据时，不能按总人数猜测
                    return {
                        valid: false,
                        mean: 0,
                        variance: 0,
                        se: 0,
                        ciDelta: 0,
                        ciLow: 0,
                        ciHigh: 0,
                        sampleSize: 0,
                        method: 'UNAVAILABLE'
                    };
                }
            }
            const countDerivedP = (w * 1.0 + t * tShare) / N_exact;
            if (hasEq) {
                const optP = Number(options.equity) / 100;
                // 如果传入了计数值，必须验证 options.equity 与计数推导权益的一致性，矛盾时拒绝放行
                if ((w > 0 || t > 0 || (w + t === N_exact) || (w + t + (losses || 0) === N_exact)) && Math.abs(countDerivedP - optP) > 0.015) {
                    return {
                        valid: false,
                        mean: 0,
                        variance: 0,
                        se: 0,
                        ciDelta: 0,
                        ciLow: 0,
                        ciHigh: 0,
                        sampleSize: 0,
                        method: 'UNAVAILABLE'
                    };
                }
            }
            const p = (w > 0 || t > 0 || (w + t === N_exact)) ? countDerivedP : (hasEq ? Number(options.equity) / 100 : countDerivedP);

            if (!Number.isFinite(p) || p < 0 || p > 1) {
                return {
                    valid: false,
                    mean: 0,
                    variance: 0,
                    se: 0,
                    ciDelta: 0,
                    ciLow: 0,
                    ciHigh: 0,
                    sampleSize: 0,
                    method: 'UNAVAILABLE'
                };
            }

            return {
                valid: true,
                mean: p,
                variance: 0,
                se: 0,
                ciDelta: 0,
                ciLow: p,
                ciHigh: p,
                sampleSize: N_exact,
                method: 'EXACT_ENUMERATION'
            };
        }

        const N = Number(total);
        if (!Number.isFinite(N) || N < 2 || !Number.isInteger(N)) {
            return {
                valid: false,
                mean: 0,
                variance: 0,
                se: 0,
                ciDelta: 0,
                ciLow: 0,
                ciHigh: 0,
                sampleSize: 0,
                method: 'UNAVAILABLE'
            };
        }

        // 真实二阶矩输入 (S1 = sum X_i, S2 = sum X_i^2)
        if (typeof options.s1 === 'number' && typeof options.s2 === 'number') {
            const S1 = options.s1;
            const S2 = options.s2;
            // 严格必要合法性校验：有限数、0 <= S1 <= N、S1^2/N - 1e-9 <= S2 <= S1 + 1e-9
            if (!Number.isFinite(S1) || !Number.isFinite(S2) ||
                S1 < -1e-9 || S1 > N + 1e-9 ||
                S2 < ((S1 * S1) / N) - 1e-9 || S2 > S1 + 1e-9) {
                return {
                    valid: false,
                    mean: 0,
                    variance: 0,
                    se: 0,
                    ciDelta: 0,
                    ciLow: 0,
                    ciHigh: 0,
                    sampleSize: 0,
                    method: 'UNAVAILABLE'
                };
            }
            const mean = Math.max(0, Math.min(1, S1 / N));
            const variance = Math.max(0, (S2 - (S1 * S1) / N) / (N - 1));
            const se = Math.sqrt(variance / N);
            const ciDelta = 1.96 * se;
            return {
                valid: true,
                mean,
                variance,
                se,
                ciDelta,
                ciLow: Math.max(0, mean - ciDelta),
                ciHigh: Math.min(1, mean + ciDelta),
                sampleSize: N,
                method: 'MULTINOMIAL_SHARES'
            };
        }

        // 逐样本份额数组 (multiwayShares)
        if (Array.isArray(multiwayShares) && multiwayShares.length >= 2) {
            const nShares = multiwayShares.length;
            let sumShare = 0;
            let sumShareSq = 0;
            for (let i = 0; i < nShares; i++) {
                const s = Number(multiwayShares[i]);
                if (!Number.isFinite(s) || s < -1e-9 || s > 1 + 1e-9) {
                    return {
                        valid: false,
                        mean: 0,
                        variance: 0,
                        se: 0,
                        ciDelta: 0,
                        ciLow: 0,
                        ciHigh: 0,
                        sampleSize: 0,
                        method: 'UNAVAILABLE'
                    };
                }
                const clamped = Math.max(0, Math.min(1, s));
                sumShare += clamped;
                sumShareSq += clamped * clamped;
            }
            const mean = sumShare / nShares;
            const variance = Math.max(0, (sumShareSq - (sumShare * sumShare) / nShares) / (nShares - 1));
            const se = Math.sqrt(variance / nShares);
            const ciDelta = 1.96 * se;
            return {
                valid: true,
                mean,
                variance,
                se,
                ciDelta,
                ciLow: Math.max(0, mean - ciDelta),
                ciHigh: Math.min(1, mean + ciDelta),
                sampleSize: nShares,
                method: 'MULTINOMIAL_SHARES'
            };
        }

        const Nw = Number(win);
        const Nt = Number(tie);
        const Nl = Number(loss);

        // 样本计数非负整数性与守恒校验 (Nw, Nt, Nl 必须为整数且和为 N)
        if (!Number.isFinite(Nw) || !Number.isFinite(Nt) || !Number.isFinite(Nl) ||
            !Number.isInteger(Nw) || !Number.isInteger(Nt) || !Number.isInteger(Nl) ||
            Nw < 0 || Nt < 0 || Nl < 0 ||
            (Nw + Nt + Nl) !== N) {
            return {
                valid: false,
                mean: 0,
                variance: 0,
                se: 0,
                ciDelta: 0,
                ciLow: 0,
                ciHigh: 0,
                sampleSize: 0,
                method: 'UNAVAILABLE'
            };
        }

        const playerCount = options.playerCount || 2;
        let tieShare = 0.5;
        if (Nt > 0) {
            if (typeof options.tieShare === 'number') {
                if (!Number.isFinite(options.tieShare) || options.tieShare <= 0 || options.tieShare > 1) {
                    return {
                        valid: false,
                        mean: 0,
                        variance: 0,
                        se: 0,
                        ciDelta: 0,
                        ciLow: 0,
                        ciHigh: 0,
                        sampleSize: 0,
                        method: 'UNAVAILABLE'
                    };
                }
                tieShare = options.tieShare;
            } else if (playerCount > 2) {
                // 多人平局缺少实际份额证据时，不能按总人数猜测
                return {
                    valid: false,
                    mean: 0,
                    variance: 0,
                    se: 0,
                    ciDelta: 0,
                    ciLow: 0,
                    ciHigh: 0,
                    sampleSize: 0,
                    method: 'UNAVAILABLE'
                };
            }
        }

        const S1 = Nw * 1.0 + Nt * tieShare;
        const S2 = Nw * 1.0 + Nt * (tieShare * tieShare);
        const pHat = S1 / N;
        const s2 = (N / (N - 1)) * Math.max(0, (S2 / N) - (pHat * pHat));
        const se = Math.sqrt(s2 / N);
        const ciDelta = 1.96 * se;

        return {
            valid: true,
            mean: pHat,
            variance: s2,
            se,
            ciDelta,
            ciLow: Math.max(0, pHat - ciDelta),
            ciHigh: Math.min(1, pHat + ciDelta),
            sampleSize: N,
            method: 'MULTINOMIAL_TRINARY'
        };
    }

    /**
     * 从 equityResult 提取完备真实的样本计数与统计参数
     */
    function extractCountsFromEquityResult(eqRes, fallbackTotal) {
        if (!eqRes || typeof eqRes !== 'object') {
            return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount: 2, method: 'UNAVAILABLE' };
        }

        const playerCount = Number(eqRes.playerCount) > 1 ? Number(eqRes.playerCount) : 2;

        // 严格前置全局脏字段防御：对已提供的任何统计字段执行整组严格校验，杜绝任何分支绕过
        if (eqRes.equity !== undefined && eqRes.equity !== null) {
            const eqNum = Number(eqRes.equity);
            if (!Number.isFinite(eqNum) || isNaN(eqNum) || eqNum < 0 || eqNum > 100) {
                return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount: 2, method: 'UNAVAILABLE' };
            }
        }
        const countKeys = ['winCount', 'tieCount', 'loseCount', 'wins', 'ties', 'losses'];
        for (const k of countKeys) {
            if (eqRes[k] !== undefined && eqRes[k] !== null) {
                const n = Number(eqRes[k]);
                if (!Number.isFinite(n) || isNaN(n) || !Number.isInteger(n) || n < 0) {
                    return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount: 2, method: 'UNAVAILABLE' };
                }
            }
        }
        const rateKeys = ['winRate', 'tieRate', 'loseRate'];
        for (const k of rateKeys) {
            if (eqRes[k] !== undefined && eqRes[k] !== null) {
                const r = Number(eqRes[k]);
                if (!Number.isFinite(r) || isNaN(r) || r < 0 || r > 100) {
                    return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount: 2, method: 'UNAVAILABLE' };
                }
            }
        }
        if (eqRes.s1 !== undefined || eqRes.s2 !== undefined) {
            if (eqRes.s1 === undefined || eqRes.s2 === undefined) {
                return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount: 2, method: 'UNAVAILABLE' };
            }
            const s1n = Number(eqRes.s1);
            const s2n = Number(eqRes.s2);
            if (!Number.isFinite(s1n) || !Number.isFinite(s2n) || isNaN(s1n) || isNaN(s2n) || s1n < 0 || s2n < 0) {
                return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount: 2, method: 'UNAVAILABLE' };
            }
        }
        if (eqRes.multiwayShares !== undefined && eqRes.multiwayShares !== null) {
            if (!Array.isArray(eqRes.multiwayShares) || eqRes.multiwayShares.length < 2 ||
                eqRes.multiwayShares.some(x => !Number.isFinite(Number(x)) || isNaN(Number(x)) || Number(x) < 0 || Number(x) > 1)) {
                return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount: 2, method: 'UNAVAILABLE' };
            }
        }

        // 识别精确枚举模式：必须显式标记为 exact / EXACT_ENUMERATION，杜绝从普通 validCombos 误升级
        const isExact = eqRes.method === 'exact' || eqRes.method === 'EXACT_ENUMERATION';
        if (isExact) {
            const rawCombos = Number(eqRes.validCombos || eqRes.total || eqRes.sampleCount || eqRes.totalCombos || 0);
            if (!Number.isFinite(rawCombos) || !Number.isInteger(rawCombos) || rawCombos < 1) {
                // 绝不凭空制造 1000 样本！缺失证据直接返回 UNAVAILABLE
                return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount, method: 'UNAVAILABLE' };
            }
            const combos = rawCombos;

            // 无论是否有 equity，只要传入了任何计数字段，均必须进行严格非负整数和守恒校验，绝不绕过脏字段
            const hasWinField = (eqRes.winCount !== undefined && eqRes.winCount !== null) || (eqRes.wins !== undefined && eqRes.wins !== null);
            const hasTieField = (eqRes.tieCount !== undefined && eqRes.tieCount !== null) || (eqRes.ties !== undefined && eqRes.ties !== null);
            const hasLoseField = (eqRes.loseCount !== undefined && eqRes.loseCount !== null) || (eqRes.losses !== undefined && eqRes.losses !== null);

            if (hasWinField || hasTieField || hasLoseField) {
                const w = hasWinField ? Number(eqRes.winCount !== undefined ? eqRes.winCount : eqRes.wins) : 0;
                const t = hasTieField ? Number(eqRes.tieCount !== undefined ? eqRes.tieCount : eqRes.ties) : 0;
                const l = hasLoseField ? Number(eqRes.loseCount !== undefined ? eqRes.loseCount : eqRes.losses) : (combos - w - t);
                if (!Number.isFinite(w) || !Number.isFinite(t) || !Number.isFinite(l) ||
                    !Number.isInteger(w) || !Number.isInteger(t) || !Number.isInteger(l) ||
                    w < 0 || t < 0 || l < 0 || (w + t + l !== combos)) {
                    return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount, method: 'UNAVAILABLE' };
                }
            }

            const hasEqField = (eqRes.equity !== undefined && eqRes.equity !== null);
            if (hasEqField) {
                const eqNum = Number(eqRes.equity);
                if (!Number.isFinite(eqNum) || eqNum < 0 || eqNum > 100) {
                    return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount, method: 'UNAVAILABLE' };
                }
            }

            if (!hasWinField && !hasEqField) {
                return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount, method: 'UNAVAILABLE' };
            }

            let wins, ties, losses;
            if (hasWinField || hasTieField || hasLoseField) {
                wins = hasWinField ? Number(eqRes.winCount !== undefined ? eqRes.winCount : eqRes.wins) : 0;
                ties = hasTieField ? Number(eqRes.tieCount !== undefined ? eqRes.tieCount : eqRes.ties) : 0;
                losses = hasLoseField ? Number(eqRes.loseCount !== undefined ? eqRes.loseCount : eqRes.losses) : (combos - wins - ties);
                const derivedEq = ((wins + ties * (eqRes.tieShare || 0.5)) / combos) * 100;
                if (hasEqField && Math.abs(derivedEq - Number(eqRes.equity)) > 1.5) {
                    return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount, method: 'UNAVAILABLE' };
                }
            } else {
                const eqVal = Number(eqRes.equity) / 100;
                wins = Math.round(eqVal * combos);
                ties = 0;
                losses = Math.max(0, combos - wins);
            }
            return {
                wins,
                ties,
                losses,
                total: combos,
                equity: eqRes.equity !== undefined ? eqRes.equity : ((wins + ties * (eqRes.tieShare || 0.5)) / combos * 100),
                tieShare: eqRes.tieShare,
                valid: true,
                playerCount,
                method: 'EXACT_ENUMERATION'
            };
        }

        // 提取样本规模：支持 sampleCount, validSims, samples, total, validCombos
        const rawTotal = (typeof eqRes.sampleCount === 'number' && eqRes.sampleCount > 0) ? eqRes.sampleCount
                       : (typeof eqRes.validSims === 'number' && eqRes.validSims > 0) ? eqRes.validSims
                       : (typeof eqRes.samples === 'number' && eqRes.samples > 0) ? eqRes.samples
                       : (typeof eqRes.total === 'number' && eqRes.total > 0) ? eqRes.total
                       : (typeof eqRes.validCombos === 'number' && eqRes.validCombos > 0) ? eqRes.validCombos
                       : (fallbackTotal && fallbackTotal > 0 ? fallbackTotal : null);

        if (!rawTotal || !Number.isFinite(rawTotal) || !Number.isInteger(rawTotal) || rawTotal < 2) {
            return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount, method: 'UNAVAILABLE' };
        }

        const total = rawTotal;

        // 统一规范化计数字段别名
        const hasWin = (eqRes.wins !== undefined && eqRes.wins !== null) || (eqRes.winCount !== undefined && eqRes.winCount !== null);
        const hasTie = (eqRes.ties !== undefined && eqRes.ties !== null) || (eqRes.tieCount !== undefined && eqRes.tieCount !== null);
        const hasLose = (eqRes.losses !== undefined && eqRes.losses !== null) || (eqRes.loseCount !== undefined && eqRes.loseCount !== null);

        let wVal = hasWin ? Number(eqRes.wins !== undefined ? eqRes.wins : eqRes.winCount) : null;
        let tVal = hasTie ? Number(eqRes.ties !== undefined ? eqRes.ties : eqRes.tieCount) : null;
        let lVal = hasLose ? Number(eqRes.losses !== undefined ? eqRes.losses : eqRes.loseCount) : null;

        // 若传入了计数值，执行严格非负整数与总和守恒校验
        if (hasWin || hasTie || hasLose) {
            const w = hasWin ? wVal : 0;
            const t = hasTie ? tVal : 0;
            const l = hasLose ? lVal : (total - w - t);
            if (!Number.isInteger(w) || !Number.isInteger(t) || !Number.isInteger(l) ||
                w < 0 || t < 0 || l < 0 || (w + t + l !== total)) {
                return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount, method: 'UNAVAILABLE' };
            }
            wVal = w;
            tVal = t;
            lVal = l;
        }

        // 若传入了三个率，执行率求和守恒校验
        if (eqRes.winRate !== undefined && eqRes.tieRate !== undefined && eqRes.loseRate !== undefined) {
            const rSum = Number(eqRes.winRate) + Number(eqRes.tieRate) + Number(eqRes.loseRate);
            if (Math.abs(rSum - 100) > 1.0) {
                return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount, method: 'UNAVAILABLE' };
            }
        }

        // 如果携带了真实样本二阶矩 S1/S2 或多方实际份额数组
        if (typeof eqRes.s1 === 'number' && typeof eqRes.s2 === 'number') {
            const s1 = eqRes.s1;
            const s2 = eqRes.s2;
            if (s1 < 0 || s1 > total || s2 < (s1 * s1 / total) - 1e-9 || s2 > s1 + 1e-9) {
                return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount, method: 'UNAVAILABLE' };
            }
            // 若同时提供了计数，验证矩与计数同源一致性 (单挑下 S1 = W + 0.5T, S2 = W + 0.25T)
            if (hasWin || hasTie || hasLose) {
                const expS1 = wVal + tVal * 0.5;
                const expS2 = wVal + tVal * 0.25;
                if (Math.abs(s1 - expS1) > 0.05 || Math.abs(s2 - expS2) > 0.05) {
                    return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount, method: 'UNAVAILABLE' };
                }
            }
            // 若同时提供了费率，验证费率与矩一致性
            if (eqRes.equity !== undefined && eqRes.equity !== null) {
                const eqDerived = (s1 / total) * 100;
                if (Math.abs(eqDerived - Number(eqRes.equity)) > 1.5) {
                    return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount, method: 'UNAVAILABLE' };
                }
            }
            return {
                s1,
                s2,
                total,
                valid: true,
                playerCount,
                method: 'MULTINOMIAL_SHARES'
            };
        }
        if (Array.isArray(eqRes.multiwayShares) && eqRes.multiwayShares.length >= 2) {
            return {
                multiwayShares: eqRes.multiwayShares,
                total: eqRes.multiwayShares.length,
                valid: true,
                playerCount,
                method: 'MULTINOMIAL_SHARES'
            };
        }

        let wins, ties, losses;

        // 路径 A: 直接提供了胜平计数值 (使用规范化后的 wVal / tVal)
        if (wVal !== null && tVal !== null) {
            wins = wVal;
            ties = tVal;
            losses = (lVal !== null) ? lVal : (total - wins - ties);

            // 若同时提供了 equity，必须验证 counts 推导权益与 equity 一致性
            if (eqRes.equity !== undefined && eqRes.equity !== null) {
                const countEq = ((wins + ties * 0.5) / total) * 100;
                if (Math.abs(countEq - Number(eqRes.equity)) > 1.5) {
                    return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount, method: 'UNAVAILABLE' };
                }
            }
            return { wins, ties, losses, total, valid: true, playerCount, method: 'MULTINOMIAL_TRINARY' };
        }
        // 路径 B: 提供了百分比费率 (winRate / tieRate / loseRate / equity)
        else if (eqRes.winRate !== undefined || eqRes.equity !== undefined || eqRes.tieRate !== undefined || eqRes.loseRate !== undefined) {
            // 前置检查每一个提供的字段，绝不把 NaN 转换为 0 制造虚假样本
            if (eqRes.equity !== undefined && eqRes.equity !== null) {
                const eqNum = Number(eqRes.equity);
                if (!Number.isFinite(eqNum) || eqNum < 0 || eqNum > 100) {
                    return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount, method: 'UNAVAILABLE' };
                }
            }
            if (eqRes.winRate !== undefined && eqRes.winRate !== null) {
                const wr = Number(eqRes.winRate);
                if (!Number.isFinite(wr) || wr < 0 || wr > 100) {
                    return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount, method: 'UNAVAILABLE' };
                }
            }
            if (eqRes.tieRate !== undefined && eqRes.tieRate !== null) {
                const tr = Number(eqRes.tieRate);
                if (!Number.isFinite(tr) || tr < 0 || tr > 100) {
                    return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount, method: 'UNAVAILABLE' };
                }
            }
            if (eqRes.loseRate !== undefined && eqRes.loseRate !== null) {
                const lr = Number(eqRes.loseRate);
                if (!Number.isFinite(lr) || lr < 0 || lr > 100) {
                    return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount, method: 'UNAVAILABLE' };
                }
            }

            const wRate = (typeof eqRes.winRate === 'number') ? eqRes.winRate : (typeof eqRes.equity === 'number' ? eqRes.equity : 0);
            const tRate = (typeof eqRes.tieRate === 'number') ? eqRes.tieRate : 0;
            const lRate = (typeof eqRes.loseRate === 'number') ? eqRes.loseRate : Math.max(0, 100 - wRate - tRate);

            if (!Number.isFinite(wRate) || !Number.isFinite(tRate) || !Number.isFinite(lRate) ||
                wRate < 0 || tRate < 0 || lRate < 0 ||
                wRate > 100 || tRate > 100 || lRate > 100) {
                return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount, method: 'UNAVAILABLE' };
            }

            const rawSum = wRate + tRate + lRate;
            if (rawSum <= 0 || Math.abs(rawSum - 100) > 1.0) {
                return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount, method: 'UNAVAILABLE' };
            }

            const normW = (wRate / rawSum) * total;
            const normT = (tRate / rawSum) * total;
            const normL = (lRate / rawSum) * total;

            const floorW = Math.floor(normW);
            const floorT = Math.floor(normT);
            const floorL = Math.floor(normL);

            let deficit = total - (floorW + floorT + floorL);
            const rems = [
                { k: 'w', rem: normW - floorW },
                { k: 't', rem: normT - floorT },
                { k: 'l', rem: normL - floorL }
            ].sort((a, b) => b.rem - a.rem);

            const counts = { w: floorW, t: floorT, l: floorL };
            for (let i = 0; i < deficit && i < rems.length; i++) {
                counts[rems[i].k]++;
            }

            wins = counts.w;
            ties = counts.t;
            losses = counts.l;
            return { wins, ties, losses, total, valid: true, playerCount, method: 'MULTINOMIAL_TRINARY' };
        } else {
            return { wins: 0, ties: 0, losses: 0, total: 0, valid: false, playerCount, method: 'UNAVAILABLE' };
        }

        return { wins, ties, losses, total, valid: true, playerCount, method: 'MULTINOMIAL_TRINARY' };
    }

    /**
     * 构建结构化多维不确定性上下文 (UncertaintyContext · Astra-043 契约)
     */
    function createUncertaintyContext(equity, potOdds, stats, opts) {
        opts = opts || {};
        const isFacingAllin = !!opts.isFacingAllin;
        const street = opts.street || 'turn';
        const isMultiway = !!opts.isMultiway;
        const isFacingBet = opts.isFacingBet !== undefined ? !!opts.isFacingBet : true;

        const noPlayersBehind = !!opts.noPlayersBehind;

        // 判定行动是否关闭：
        // 1. 若外部显式指定 callClosesAction，直接遵从
        // 2. 河牌若无身后待行动者且面对下注，跟注关闭行动 (Showdown)
        // 3. 面对全下且为单挑 (或无身后待行动者)，跟注关闭行动
        let callCloses = false;
        if (opts.callClosesAction !== undefined) {
            callCloses = !!opts.callClosesAction;
        } else if (street === 'river') {
            callCloses = (!isMultiway || noPlayersBehind) && isFacingBet;
        } else if (isFacingAllin) {
            callCloses = !isMultiway || noPlayersBehind;
        }

        // 区分"本轮跟注是否关闭行动"与"后续是否仍有下注决策"
        let continuationModel = 'UNMODELED';
        if (opts.continuationModel !== undefined) {
            continuationModel = opts.continuationModel;
        } else if (callCloses) {
            if (opts.street === 'river') {
                continuationModel = 'NOT_REQUIRED';
            } else if (opts.hasChipsBehind === false) {
                // 明确无剩余筹码时无需续街模型 (F_certified)
                continuationModel = 'NOT_REQUIRED';
            } else if (isFacingAllin && !isMultiway && opts.hasChipsBehind !== true) {
                // 单挑面对全下且无剩余筹码 (未明确证明仍有筹码)，跟注即终局
                continuationModel = 'NOT_REQUIRED';
            } else {
                // 多人底池即使有人全下，只要仍有人有筹码；或明确仍有筹码续街时，绝对保持 UNMODELED
                continuationModel = 'UNMODELED';
            }
        }

        const isTerminalNode = (continuationModel === 'NOT_REQUIRED');

        // 统一按百分数尺度比较 (equity 和 potOdds 均以 0~100 百分数传入)
        // 消除 equity > 1 ? / 100 的歧义，防止 0.5% 误判为 50%
        const eqPct = (typeof equity === 'number' && Number.isFinite(equity)) ? equity : 0;
        const oddsPct = (typeof potOdds === 'number' && Number.isFinite(potOdds)) ? potOdds : 0;

        // stats 缺少或无效时，保持不可判断状态 UNAVAILABLE，绝不虚构确定性
        if (!stats || !stats.valid || !stats.sampleSize) {
            return {
                sampling: {
                    method: 'UNAVAILABLE',
                    ciDelta: 0,
                    validSamples: 0,
                    isThresholdInCI: false
                },
                structural: {
                    callClosesAction: callCloses,
                    continuationModel: continuationModel,
                    rangeSource: opts.rangeSource || 'ESTIMATED',
                    priorSource: opts.priorSource || 'MICRO_LUT_HEURISTIC',
                    utilityModel: opts.isICM ? 'ICM_PROXY' : 'CHIP_EV'
                },
                comparison: {
                    metric: opts.isICM ? 'ICM_UTILITY' : 'STATIC_EQUITY',
                    state: 'UNAVAILABLE',
                    overallState: 'UNAVAILABLE'
                }
            };
        }

        // 严格以统计样本真实均值 (stats.mean) 为置信区间中心，绝不用外部 equity 偏移统计区间
        const sampleMeanPct = (typeof stats.mean === 'number' && Number.isFinite(stats.mean)) ? stats.mean * 100 : eqPct;
        const deltaPct = typeof stats.ciDelta === 'number' ? stats.ciDelta * 100 : 2.25;
        const ciLow = Math.max(0, sampleMeanPct - deltaPct);
        const ciHigh = Math.min(100, sampleMeanPct + deltaPct);
        const isThresholdInCI = (oddsPct >= ciLow - 1e-6 && oddsPct <= ciHigh + 1e-6);
        const isBoundary = isThresholdInCI;
        const validSamples = stats.sampleSize;

        const isExact = stats.method === 'EXACT_ENUMERATION';
        // 退化样本或小样本检测：非精确枚举下，样本量不足 (< 30) 或样本方差为 0 时 (包含全部平局方差为0等情况)，全量降级为 SMALL_SAMPLE_UNRELIABLE
        const isDegenerate = !isExact && (validSamples < 30 || stats.variance === 0);

        let overallState;
        let compState;
        if (isDegenerate) {
            overallState = 'SMALL_SAMPLE_UNRELIABLE';
            compState = 'UNRELIABLE';
        } else if (isTerminalNode) {
            // MC 抽样分离不可标 DETERMINISTIC_SIGN，使用准确语义 CI_SIGN_SEPARATED；精确枚举才为 DETERMINISTIC_SIGN
            overallState = isBoundary ? 'TERMINAL_BOUNDARY' : (isExact ? 'DETERMINISTIC_SIGN' : 'CI_SIGN_SEPARATED');
            compState = isBoundary ? 'BOUNDARY' : 'SIGN_SEPARATED';
        } else {
            overallState = isBoundary ? 'STATIC_EQUITY_BOUNDARY' : 'NON_TERMINAL_ESTIMATE';
            compState = isBoundary ? 'BOUNDARY' : 'ESTIMATE';
        }

        return {
            sampling: {
                method: stats.method || 'MULTINOMIAL_TRINARY',
                ciDelta: stats.ciDelta || 0,
                validSamples,
                isThresholdInCI: isThresholdInCI
            },
            structural: {
                callClosesAction: callCloses,
                continuationModel: continuationModel,
                rangeSource: opts.rangeSource || 'ESTIMATED',
                priorSource: opts.priorSource || 'MICRO_LUT_HEURISTIC',
                utilityModel: opts.isICM ? 'ICM_PROXY' : 'CHIP_EV'
            },
            comparison: {
                metric: opts.isICM ? 'ICM_UTILITY' : 'STATIC_EQUITY',
                state: compState,
                overallState
            }
        };
    }

    /**
     * 最大余数法 (Largest Remainder Method / Hamilton Rule)
     * 保证概率非负且严格闭合为 100% (含大数/Number.MAX_VALUE 缩放防溢出)
     */
    function closeFrequencies(freqObj) {
        if (!freqObj || typeof freqObj !== 'object') return { fold: 100 };
        const rawKeys = Object.keys(freqObj);
        if (rawKeys.length === 0) return { fold: 100 };

        // 统一小写 keys 并预先置 0
        const allKeys = [];
        const seen = new Set();
        for (const k of rawKeys) {
            const kl = k.toLowerCase();
            if (!seen.has(kl)) {
                seen.add(kl);
                allKeys.push(kl);
            }
        }

        // 先扫描计算原始权重的最大值，确定缩放因子，防范在合并同名键前两个 MAX_VALUE 相加溢出为 Infinity
        let maxVal = 0;
        for (const k of rawKeys) {
            const val = Number(freqObj[k]);
            if (Number.isFinite(val) && val > maxVal) maxVal = val;
        }

        // 全 0 或全非数降级保底：给首个 key 赋予 100%，其余保持 0
        if (maxVal <= 0) {
            const res = {};
            allKeys.forEach((k, idx) => { res[k] = (idx === 0 ? 100 : 0); });
            return res;
        }

        // 大数动态缩放因子 (防止多个 MAX_VALUE 相加溢出为 Infinity)
        const scale = maxVal > 1e150 ? (1 / maxVal) : 1;
        const scaledValues = {};
        for (const k of allKeys) scaledValues[k] = 0;
        let scaledSum = 0;

        for (const k of rawKeys) {
            const val = Number(freqObj[k]);
            const kLower = k.toLowerCase();
            if (Number.isFinite(val) && val > 0) {
                const scaled = val * scale;
                scaledValues[kLower] = (scaledValues[kLower] || 0) + scaled;
                scaledSum += scaled;
            }
        }

        if (scaledSum <= 0) {
            const res = {};
            allKeys.forEach((k, idx) => { res[k] = (idx === 0 ? 100 : 0); });
            return res;
        }

        // 预归一化至 100 并以最大余数法分配
        let sum = 0;
        const integerParts = {};
        const remainders = [];

        for (const k of allKeys) {
            const normalized = (scaledValues[k] / scaledSum) * 100;
            const fl = Math.floor(normalized);
            integerParts[k] = fl;
            sum += fl;
            remainders.push({ k, rem: normalized - fl });
        }

        remainders.sort((a, b) => b.rem - a.rem);

        let deficit = 100 - sum;
        for (let i = 0; i < deficit && i < remainders.length; i++) {
            integerParts[remainders[i].k]++;
        }
        for (let i = 0; deficit < 0 && i < remainders.length; i++) {
            const k = remainders[remainders.length - 1 - i].k;
            if (integerParts[k] > 0) {
                integerParts[k]--;
                deficit++;
            }
        }

        return integerParts;
    }

    /**
     * 终审收口器：全出口严格闭合概率单纯形、冻结对象并锁定 frequencies 属性
     * 全局权威动作统一依据最高频动作 (Blocker 4 · a* = argmax_{a in A_legal} f_a)
     * 保证：f_a >= 0, a not in A(I) => f_a = 0, sum f_a = 100, sizing(a*) in S(I, a*)
     */
    function finalizeDecisionResult(result, legalActions) {
        if (!result || typeof result !== 'object') return result;
        const hasExplicitEffStack = (result.math && typeof result.math.effStack === 'number') || (typeof result.effStack === 'number');
        const effStack = hasExplicitEffStack ? ((result.math && typeof result.math.effStack === 'number') ? result.math.effStack : result.effStack) : 100;
        const toCall = (result.math && typeof result.math.toCall === 'number') ? result.math.toCall : (typeof result.toCall === 'number' ? result.toCall : ((result.math && result.math.villainBet) || result.villainBet || 0));
        const villainBet = (result.math && typeof result.math.villainBet === 'number') ? result.math.villainBet : (typeof result.villainBet === 'number' ? result.villainBet : 0);
        const highestBet = (result.math && typeof result.math.highestBet === 'number') ? result.math.highestBet : (typeof result.highestBet === 'number' ? result.highestBet : Math.max(villainBet, toCall));
        const lastRaiseInc = (result.math && typeof result.math.lastRaiseInc === 'number') ? result.math.lastRaiseInc : (typeof result.lastRaiseInc === 'number' ? result.lastRaiseInc : toCall);
        const minRaiseInc = Math.max(lastRaiseInc, toCall, 2.0);
        const minRaiseTo = (result.math && typeof result.math.minRaiseTo === 'number') ? result.math.minRaiseTo : (typeof result.minRaiseTo === 'number' ? result.minRaiseTo : (highestBet + minRaiseInc));
        const isFacingAllin = !!(result.isFacingAllin || (result.math && result.math.isFacingAllin) || (effStack <= toCall));
        const hasFacingBetActions = (result.primaryAction === 'FOLD' || result.primaryAction === 'CALL') ||
            (result.frequencies && (result.frequencies.call !== undefined || result.frequencies.fold !== undefined ||
                                   result.frequencies.CALL !== undefined || result.frequencies.FOLD !== undefined));
        const isFacingBet = (result.isFacingBet !== undefined) ? !!result.isFacingBet :
            !!((result.math && result.math.villainBet > 0) || (result.math && result.math.toCall > 0) || toCall > 0 || hasFacingBetActions);

        // 1. 构造当前状态下的精确合法动作集合 A(I)
        let legal;
        const isMultiway = !!((result.math && result.math.isMultiway) || (result.multiwayDynamics && result.multiwayDynamics.isMultiway));
        const activeNonAllin = (result.math && typeof result.math.activeNonAllinCount === 'number') ? result.math.activeNonAllinCount : null;
        const canMultiwayContest = isMultiway && activeNonAllin !== null && activeNonAllin >= 2 && effStack > toCall;

        if (Array.isArray(legalActions) && legalActions.length > 0) {
            legal = legalActions.map(a => a.toUpperCase());
            // 硬边界守卫：无论外部传入何种数组，必须遵守面对下注、全下、零筹码与最小加注约束
            if (isFacingBet) {
                // 面对下注时，CHECK 和 BET 绝对非法，必须剔除
                legal = legal.filter(a => a !== 'CHECK' && a !== 'BET');
                if (effStack <= toCall) {
                    legal = legal.filter(a => a === 'FOLD' || a === 'CALL');
                } else if (isFacingAllin && !canMultiwayContest) {
                    legal = legal.filter(a => a === 'FOLD' || a === 'CALL');
                } else if (effStack <= toCall * 1.15) {
                    legal = legal.filter(a => a !== 'RAISE');
                    if (!legal.includes('ALLIN') && effStack > toCall) legal.push('ALLIN');
                }
            } else {
                legal = legal.filter(a => a === 'CHECK' || a === 'BET' || a === 'ALLIN');
            }
        } else if (isFacingBet) {
            if (effStack <= toCall) {
                legal = ['FOLD', 'CALL'];
            } else if (isFacingAllin && !canMultiwayContest) {
                legal = ['FOLD', 'CALL'];
            } else if (effStack <= toCall * 1.15) {
                legal = ['FOLD', 'CALL', 'ALLIN'];
            } else {
                legal = ['FOLD', 'CALL', 'RAISE', 'ALLIN'];
            }
        } else {
            legal = ((typeof result.effStack === 'number' && result.effStack <= 0) || (result.math && typeof result.math.effStack === 'number' && result.math.effStack <= 0)) ? ['CHECK'] : ['CHECK', 'BET', 'ALLIN'];
        }
        const legalLower = legal.map(a => a.toLowerCase());

        // 2. 规范化候选动作、处理合法 ALLIN 转换与大数防溢出 (全部在频率闭合与 argmax 之前完成)
        let rawFreqs = result.frequencies || {};
        if (typeof rawFreqs !== 'object' || rawFreqs === null) {
            rawFreqs = { [(result.primaryAction || (isFacingBet ? 'FOLD' : 'CHECK')).toLowerCase()]: 100 };
        }

        // 大数预缩放因子：先找出最大有限值进行动态缩放，再合并同名键，彻底消除同名键相加为 Infinity
        let maxRaw = 1;
        for (const v of Object.values(rawFreqs)) {
            const n = Number(v);
            if (Number.isFinite(n) && n > maxRaw) maxRaw = n;
        }
        const scaleFactor = maxRaw > 1e150 ? (1 / maxRaw) : 1;

        const filteredLegalFreqs = {};
        for (const act of legalLower) filteredLegalFreqs[act] = 0;
        let sumLegalMass = 0;

        for (const [k, v] of Object.entries(rawFreqs)) {
            let kl = k.toLowerCase();
            const val = Number(v) * scaleFactor;
            if (!Number.isFinite(val) || val <= 0) continue;

            // 规则与筹码约束映射 (在单纯形闭合前完成)
            if (!isFacingBet) {
                if (kl === 'raise') kl = 'bet';
                if (kl === 'call' || kl === 'fold') continue;
            } else {
                if (kl === 'bet') kl = 'raise';
                // 若筹码不足以做出有效加注 (effStack <= toCall * 1.15)
                if (kl === 'raise') {
                    if (!legalLower.includes('raise')) {
                        if (legalLower.includes('allin')) {
                            kl = 'allin'; // 筹码不足以加注，加注频率合法映射为全下
                        } else {
                            continue; // 面对全下只有 FOLD/CALL，加注直接舍弃
                        }
                    }
                }
            }

            if (legalLower.includes(kl)) {
                filteredLegalFreqs[kl] = (filteredLegalFreqs[kl] || 0) + val;
                sumLegalMass += val;
            }
        }

        // 若合法质量为 0 (例如面对下注只传入了 CHECK: 100)，进入安全保底
        if (sumLegalMass <= 0) {
            if (isFacingBet) {
                filteredLegalFreqs['fold'] = 100;
            } else {
                filteredLegalFreqs['check'] = 100;
            }
        }

        // 闭合合法动作的概率单纯形 (保证 sum f_a = 100)
        result.frequencies = closeFrequencies(filteredLegalFreqs);

        // 3. 全局最高频合法主动作统一 (a* = argmax_{a in A_legal} f_a, f_a* > 0)
        const priorityOrder = ['ALLIN', 'RAISE', 'BET', 'CALL', 'CHECK', 'FOLD'];
        let maxF = -1;
        let bestA = null;

        for (const act of legal) {
            const f = result.frequencies[act.toLowerCase()] || 0;
            if (f > maxF) {
                maxF = f;
                bestA = act;
            } else if (f === maxF && maxF > 0 && bestA) {
                const curPri = priorityOrder.indexOf(act);
                const bestPri = priorityOrder.indexOf(bestA);
                if (curPri !== -1 && (bestPri === -1 || curPri < bestPri)) {
                    bestA = act;
                }
            }
        }

        if (!bestA || maxF <= 0) {
            bestA = isFacingBet ? 'FOLD' : 'CHECK';
        }

        // 锁定主动作，此后绝不再更改 primaryAction
        result.primaryAction = bestA;

        // 4. 注额合法域 S(I, a*) 约束与理由一致性闭环 (绝不覆写 primaryAction)
        if (bestA === 'FOLD' || bestA === 'CHECK') {
            result.sizing = '';
            if (bestA === 'FOLD' && result.reasoning && result.reasoning.includes('防守看河牌')) {
                result.reasoning = result.reasoning.replace(/防守看河牌[！!]/g, '维持弃牌建议。').replace(/防守看河牌/g, '维持弃牌建议');
            }
        } else if (bestA === 'CALL') {
            if (effStack > 0 && effStack <= toCall) {
                result.sizing = `All-in ${effStack.toFixed(1)}BB（全押）`;
            } else {
                result.sizing = '';
            }
        } else if (bestA === 'ALLIN') {
            result.sizing = (effStack > 0) ? `All-in ${effStack.toFixed(1)}BB（全押）` : '全押';
        } else if (bestA === 'RAISE') {
            let raiseBb = 0;
            if (result.sizing) {
                const match = String(result.sizing).match(/([\d.]+)\s*BB/i);
                if (match) raiseBb = parseFloat(match[1]);
            }
            if (!raiseBb || raiseBb < minRaiseTo) {
                raiseBb = minRaiseTo;
            }
            if (effStack > 0 && raiseBb > effStack) {
                raiseBb = effStack;
            }
            if (!result.sizing || !String(result.sizing).trim()) {
                result.sizing = `${raiseBb.toFixed(1)}BB`;
            } else if (/全押|All-in|push/i.test(String(result.sizing)) || (effStack > 0 && raiseBb >= effStack)) {
                result.sizing = (effStack > 0) ? `All-in ${effStack.toFixed(1)}BB（全押）` : '全押';
            } else if (String(result.sizing).includes('%') || String(result.sizing).includes('x') || String(result.sizing).includes('底池')) {
                // 保留上游引擎的描述性尺度标注 (如 75% 底池、2.5x 等)
            } else {
                result.sizing = `${raiseBb.toFixed(1)}BB`;
            }
        } else if (bestA === 'BET') {
            let betBb = 0;
            if (result.sizing) {
                const match = String(result.sizing).match(/([\d.]+)\s*BB/i);
                if (match) betBb = parseFloat(match[1]);
            }
            if (!betBb || betBb <= 0) {
                betBb = Math.max(2.0, (result.math && result.math.pot ? result.math.pot * 0.5 : 5.0));
            }
            if (/全押|All-in|push/i.test(String(result.sizing)) || (effStack > 0 && betBb >= effStack)) {
                result.sizing = (effStack > 0) ? `All-in ${effStack.toFixed(1)}BB（全押）` : '全押';
            } else if (!result.sizing || !String(result.sizing).trim()) {
                result.sizing = `${betBb.toFixed(1)}BB`;
            } else if (String(result.sizing).includes('%') || String(result.sizing).includes('x') || String(result.sizing).includes('底池')) {
                // 保留上游引擎的描述性尺度标注 (如 75% 底池、50% 底池等)
            } else {
                result.sizing = `${betBb.toFixed(1)}BB`;
            }
        }

        try {
            Object.freeze(result.frequencies);
            Object.defineProperty(result, 'frequencies', {
                value: result.frequencies,
                writable: false,
                configurable: false,
                enumerable: true
            });
        } catch (e) {}
        result.isUnified = true;
        return result;
    }

    /**
     * 决策合流仲裁核心函数
     * @param {Object} result - postEngine 初始装配的决策对象
     * @param {Object} state - 当前 postState 全局上下文
     * @param {Object} ctx - 环境参数 (board, pot, villainBet, effStack, heroPos, heroIsOOP 等)
     * @returns {Object} 仲裁归一化后的决策对象
     */
    function resolveUnifiedDecision(result, state, ctx) {
        if (!result || typeof result !== 'object') return result;
        ctx = ctx || {};
        state = state || {};

        const board = ctx.board || (state.board ? state.board.filter(c => c !== null) : []);
        const boardN = Array.isArray(board) ? board.filter(c => c !== null).length : 0;
        const street = ctx.street || (boardN === 5 ? 'river' : (boardN === 4 ? 'turn' : 'flop'));
        const villainBet = (typeof ctx.villainBet === 'number') ? ctx.villainBet : ((result.math && result.math.villainBet) || 0);
        const pot = (typeof ctx.pot === 'number') ? ctx.pot : ((result.math && result.math.pot) || 0);
        const toCall = (typeof ctx.toCall === 'number') ? ctx.toCall : ((result.math && typeof result.math.toCall === 'number') ? result.math.toCall : (typeof result.toCall === 'number' ? result.toCall : (villainBet > 0 ? villainBet : 0)));
        const hasExplicitEffStack = (typeof ctx.effStack === 'number') ||
            (result.math && typeof result.math.effStack === 'number') ||
            (typeof result.effStack === 'number');
        const effStack = hasExplicitEffStack
            ? ((typeof ctx.effStack === 'number') ? ctx.effStack : ((result.math && typeof result.math.effStack === 'number') ? result.math.effStack : result.effStack))
            : 100;
        const heroPos = ctx.heroPos || (state.heroPosition || 'IP');
        const heroIsOOP = ctx.heroIsOOP !== undefined ? ctx.heroIsOOP : (heroPos === 'OOP' || heroPos === 'BB' || heroPos === 'SB');
        const isMultiway = !!((result.math && result.math.isMultiway) || (result.multiwayDynamics && result.multiwayDynamics.isMultiway) || ctx.isMultiway);
        const activeNonAllin = (typeof ctx.activeNonAllinCount === 'number') ? ctx.activeNonAllinCount :
            ((result.math && typeof result.math.activeNonAllinCount === 'number') ? result.math.activeNonAllinCount : null);
        const canMultiwayContest = isMultiway && activeNonAllin !== null && activeNonAllin >= 2 && effStack > toCall;
        const isFacingAllin = !!((ctx && ctx.isFacingAllin) || result.isFacingAllin || (result.math && result.math.isFacingAllin) || (effStack > 0 && toCall >= effStack)) && !canMultiwayContest;
        const isFacingBet = (ctx && ctx.isFacingBet !== undefined) ? !!ctx.isFacingBet :
                            (result.isFacingBet !== undefined ? !!result.isFacingBet : (villainBet > 0 || toCall > 0));

        const highestBet = (typeof ctx.highestBet === 'number') ? ctx.highestBet :
            ((result.math && typeof result.math.highestBet === 'number') ? result.math.highestBet : Math.max(villainBet, toCall));
        const lastRaiseInc = (typeof ctx.lastRaiseInc === 'number' && ctx.lastRaiseInc > 0) ? ctx.lastRaiseInc :
            ((result.math && typeof result.math.lastRaiseInc === 'number' && result.math.lastRaiseInc > 0) ? result.math.lastRaiseInc : (toCall > 0 ? toCall : 2.0));
        const minRaiseInc = (typeof ctx.minRaiseInc === 'number' && ctx.minRaiseInc > 0) ? ctx.minRaiseInc :
            ((result.math && typeof result.math.minRaiseInc === 'number' && result.math.minRaiseInc > 0) ? result.math.minRaiseInc : Math.max(lastRaiseInc, 2.0));
        const minRaiseTo = (typeof ctx.minRaiseTo === 'number' && ctx.minRaiseTo > 0) ? ctx.minRaiseTo :
            ((result.math && typeof result.math.minRaiseTo === 'number' && result.math.minRaiseTo > 0) ? result.math.minRaiseTo : (highestBet + minRaiseInc));
        const canRaise = (ctx.canRaise !== undefined) ? !!ctx.canRaise :
            (result.canRaise !== undefined ? !!result.canRaise : (result.math && result.math.canRaise !== undefined ? !!result.math.canRaise : true));

        // 单一事实源同步至 result 与 result.math
        result.effStack = effStack;
        result.toCall = toCall;
        result.highestBet = highestBet;
        result.lastRaiseInc = lastRaiseInc;
        result.minRaiseInc = minRaiseInc;
        result.minRaiseTo = minRaiseTo;
        result.canRaise = canRaise;
        result.isFacingAllin = isFacingAllin;
        result.isFacingBet = isFacingBet;
        if (!result.math) result.math = {};
        result.math.effStack = effStack;
        result.math.toCall = toCall;
        result.math.villainBet = villainBet;
        result.math.highestBet = highestBet;
        result.math.lastRaiseInc = lastRaiseInc;
        result.math.minRaiseInc = minRaiseInc;
        result.math.minRaiseTo = minRaiseTo;
        result.math.canRaise = canRaise;
        result.math.isFacingAllin = isFacingAllin;
        result.math.isFacingBet = isFacingBet;
        if (activeNonAllin !== null) result.math.activeNonAllinCount = activeNonAllin;

        // 记录原始值以供调试与对账
        result._rawPrimaryAction = result.primaryAction;
        result._rawFrequencies = Object.assign({}, result.frequencies || {});
        result._rawSizing = result.sizing;

        // 预先提取真实采样统计数据与构建不确定性上下文 (覆盖 sampleCount 等真实采样规模)
        const eqRes = state.equityResult || {};
        const counts = extractCountsFromEquityResult(eqRes);
        const equity = (result.math && typeof result.math.equity === 'number') ? result.math.equity : (eqRes.equity || 0);
        const potOdds = (result.math && typeof result.math.requiredEq === 'number') ? result.math.requiredEq : ((result.math && result.math.pot > 0) ? ((toCall / (result.math.pot + toCall)) * 100) : 28.57);
        const mcStats = computeMonteCarloVariance(counts.wins, counts.ties, counts.losses, counts.total, counts.multiwayShares, {
            playerCount: counts.playerCount,
            s1: counts.s1,
            s2: counts.s2,
            method: counts.method,
            equity: eqRes.equity,
            tieShare: eqRes.tieShare
        });
        const deltaCI = mcStats.valid ? (mcStats.ciDelta * 100) : 0;

        let legalActions;
        if (!isFacingBet) {
            legalActions = (effStack <= 0) ? ['CHECK'] : ['CHECK', 'BET', 'ALLIN'];
        } else if (effStack <= 0 || effStack <= toCall) {
            legalActions = ['FOLD', 'CALL'];
        } else if (!canRaise || (isFacingAllin && !canMultiwayContest)) {
            legalActions = ['FOLD', 'CALL'];
        } else if (effStack <= toCall * 1.15) {
            legalActions = ['FOLD', 'CALL', 'ALLIN'];
        } else {
            legalActions = ['FOLD', 'CALL', 'RAISE', 'ALLIN'];
        }

        if (Array.isArray(ctx.legalActions) && ctx.legalActions.length > 0) {
            const extLegal = ctx.legalActions.map(a => String(a).toUpperCase());
            const intersected = legalActions.filter(a => extLegal.includes(a));
            if (intersected.length > 0) legalActions = intersected;
        }

        if (!result.uncertainty) {
            const lut = result.lutResult || (result.shadowRes && result.shadowRes.lutResult);
            const isMw = (result.multiwayDynamics && result.multiwayDynamics.isMultiway) || (ctx && ctx.isMultiway);
            const noPlayersBehind = !!(ctx && ctx.noPlayersBehind) || !!(state && state.noPlayersBehind) || !!result.noPlayersBehind;
            const explicitCallCloses = (ctx && ctx.callClosesAction !== undefined) ? !!ctx.callClosesAction : (result.callClosesAction !== undefined ? !!result.callClosesAction : undefined);

            result.uncertainty = createUncertaintyContext(equity, potOdds, mcStats, {
                callClosesAction: explicitCallCloses,
                isFacingAllin: isFacingAllin,
                street: street,
                isMultiway: isMw,
                isFacingBet: isFacingBet,
                noPlayersBehind: noPlayersBehind,
                hasChipsBehind: ctx ? ctx.hasChipsBehind : undefined,
                continuationModel: (ctx && ctx.continuationModel) || result.continuationModel,
                sampleCount: counts.total,
                rangeSource: 'ESTIMATED',
                priorSource: lut ? 'MICRO_LUT_HEURISTIC' : 'MACRO_TEMPLATE'
            });
        }

        // ── 仲裁优先级 0: 极端边缘场景终极兜底 (Facing All-in / Re-Raise Shove Ultimate Mathematical Shield) ──
        if (result.isFacingAllin || (result.reasoning && result.reasoning.includes('终极数学兜底'))) {
            result.arbitrationSource = 'ULTIMATE_MATH_SHIELD';
            return finalizeDecisionResult(result, legalActions);
        }

        // ── 仲裁优先级 1: 河牌终局博弈 (River Terminal Engine) ──
        if (street === 'river' && result.riverTerminal && result.riverTerminal.status === 'MATCHED_RIVER_TERMINAL') {
            const rt = result.riverTerminal;
            const rawAction = rt.primaryAction; // 'CHECK', 'BET_LARGE', 'BET_SMALL', 'CALL', 'RAISE', 'FOLD'
            let unifiedAct = rawAction;
            let unifiedSizing = result.sizing;
            let unifiedFreqs = {};

            if (rawAction === 'BET_LARGE' || rawAction === 'BET_SMALL') {
                unifiedAct = 'BET';
                unifiedSizing = (rawAction === 'BET_LARGE')
                    ? (rt.sizing || result.sizing || '75% 底池')
                    : (rt.sizing || result.sizing || '33% 底池');
            } else if (rawAction === 'RAISE' || rawAction === 'ALLIN') {
                unifiedAct = isFacingBet ? 'RAISE' : 'BET';
                unifiedSizing = (rawAction === 'ALLIN' || (effStack > 0 && effStack <= villainBet * 2.5))
                    ? '全押'
                    : (rt.sizing || result.sizing || `${Math.max(minRaiseTo, Math.max(villainBet * 2.5, villainBet + pot * 0.5)).toFixed(1)}BB`);
            } else if (rawAction === 'CALL') {
                unifiedAct = 'CALL';
                unifiedSizing = '';
            } else if (rawAction === 'CHECK') {
                unifiedAct = 'CHECK';
                unifiedSizing = '';
            } else if (rawAction === 'FOLD') {
                unifiedAct = 'FOLD';
                unifiedSizing = '';
            }

            if (rt.frequencies) {
                const rf = rt.frequencies;
                if (isFacingBet) {
                    if (effStack > 0 && effStack <= villainBet * 2.5) {
                        unifiedFreqs = closeFrequencies({
                            fold: rf.FOLD || 0,
                            call: rf.CALL || 0,
                            raise: (rf.RAISE || 0) + (rf.ALLIN || 0)
                        });
                    } else {
                        unifiedFreqs = closeFrequencies({
                            fold: rf.FOLD || 0,
                            call: rf.CALL || 0,
                            raise: rf.RAISE || 0,
                            allin: rf.ALLIN || 0
                        });
                    }
                } else {
                    unifiedFreqs = closeFrequencies({
                        check: rf.CHECK || 0,
                        bet: (rf.BET_SMALL || 0) + (rf.BET_LARGE || 0),
                        allin: rf.ALLIN || 0
                    });
                }
            }

            // 多人底池河牌纯空气压制：面对下注严禁 CHECK，必须弃牌；未下注时纯空气诈唬压制为过牌
            const isMw = (result.multiwayDynamics && result.multiwayDynamics.isMultiway) || (ctx && ctx.isMultiway);
            if (isMw) {
                if (isFacingBet) {
                    if (rt.terminalTier === 'PURE_AIR') {
                        unifiedAct = 'FOLD';
                        unifiedSizing = '';
                        unifiedFreqs = closeFrequencies({ fold: 100, call: 0, raise: 0 });
                    }
                } else {
                    if (rt.terminalTier === 'PURE_AIR' || (unifiedAct === 'BET' && ((result.math && result.math.equity < 35) || (result._rawFrequencies && result._rawFrequencies.bet === 0)))) {
                        unifiedAct = 'CHECK';
                        unifiedSizing = '';
                        unifiedFreqs = closeFrequencies({ check: 100, bet: 0 });
                    }
                }
            }
            // 若河牌处于未下注主动节点，且底层已由 TexasSolver / 强价值逻辑 / 坚果阻断连贯三桶线产出更精准的频率与主动作
            else if (!isFacingBet && result._rawFrequencies) {
                // 如果底牌原本已有主动下注主动作且下注频率高于过牌频率，保留其下注主导频率与主动作
                if (result._rawPrimaryAction === 'BET' && (result._rawFrequencies.bet || 0) > (result._rawFrequencies.check || 0)) {
                    unifiedFreqs = closeFrequencies(result._rawFrequencies);
                    unifiedAct = 'BET';
                    if (result._rawSizing) unifiedSizing = result._rawSizing;
                }
                // 如果底牌原本已有高频强价值下注 (>= 75%)，保留其高频下注与主动作
                else if ((result._rawFrequencies.bet || 0) >= 75) {
                    unifiedFreqs = closeFrequencies(result._rawFrequencies);
                    unifiedAct = 'BET';
                    if (result._rawSizing) unifiedSizing = result._rawSizing;
                }
                // 如果底牌已经过 TexasSolver 校准注入了诈唬下注频率 (bet > 0)，保留其校准频率
                else if (result.reasoning && result.reasoning.includes('TexasSolver') && (result._rawFrequencies.bet || 0) > 0) {
                    unifiedFreqs = closeFrequencies(result._rawFrequencies);
                }
            }

            result.primaryAction = unifiedAct;
            result.sizing = unifiedSizing;
            if (Object.keys(unifiedFreqs).length > 0) {
                result.frequencies = unifiedFreqs;
            }
            if (rt.tactics || rt.tierName) {
                if (result.reasoning && (result.reasoning.includes('坚果阻断') || result.reasoning.includes('三桶') || result.reasoning.includes('TexasSolver'))) {
                    result.reasoning = `🛑 [河牌终局博弈 · ${rt.tierName || '纳什终局'}]：${result.reasoning}`;
                } else {
                    result.reasoning = `🛑 [河牌终局博弈 · ${rt.tierName || '纳什终局'}]：${rt.tactics || result.reasoning || ''}`;
                }
            }
            result.arbitrationSource = 'RIVER_TERMINAL';
            return finalizeDecisionResult(result, legalActions);
        }

        // ── 仲裁优先级 2: 翻后过牌加注 (Check-Raise Engine) ──
        if (isFacingBet && heroIsOOP && result.checkRaiseDecision && result.checkRaiseDecision.action === 'CHECK_RAISE') {
            const cr = result.checkRaiseDecision;
            const raiseF = cr.crFrequency || 35;
            const isValueCR = cr.categoryLabel?.includes('价值') || cr.tacticalReasoning?.includes('价值') ||
                              cr.category === 'VALUE' || (result.equityResult && result.equityResult.equity >= 65);
            const foldF = isValueCR ? 0 : Math.min(25, Math.max(0, 100 - raiseF));
            const callF = Math.max(0, 100 - raiseF - foldF);
            if (cr.isAllIn) {
                result.primaryAction = 'ALLIN';
                result.sizing = (effStack > 0) ? `All-in ${effStack.toFixed(1)}BB（全押）` : (cr.recommendedRaiseToBb ? `All-in ${cr.recommendedRaiseToBb.toFixed(1)}BB（全押）` : '全押');
                result.frequencies = {
                    allin: raiseF,
                    raise: 0,
                    call: callF,
                    fold: foldF
                };
            } else {
                result.primaryAction = 'RAISE';
                result.sizing = `${cr.recommendedRaiseToBb.toFixed(1)}BB`;
                result.frequencies = {
                    raise: raiseF,
                    allin: 0,
                    call: callF,
                    fold: foldF
                };
            }
            if (cr.tacticalReasoning) {
                result.reasoning = `⚔️ [翻后过牌加注 · ${cr.categoryLabel || '极化反击'}]：${cr.tacticalReasoning}`;
            }
            result.arbitrationSource = 'CHECK_RAISE';
            return finalizeDecisionResult(result, legalActions);
        }

        // ── 仲裁优先级 2.5: 转牌面对下注 · 静态权益临界带与策略先验仲裁 (TASK-ASTRA-043) ──
        if (street === 'turn' && isFacingBet && !result.isFacingAllin) {
            // 统计无效或小样本方差退化时，绝对禁止触发数学救援
            if (!mcStats || !mcStats.valid || (result.uncertainty && result.uncertainty.comparison && (result.uncertainty.comparison.overallState === 'SMALL_SAMPLE_UNRELIABLE' || result.uncertainty.comparison.state === 'UNRELIABLE'))) {
                return finalizeDecisionResult(result, legalActions);
            }

            const sprVal = (result.math && typeof result.math.spr === 'number') ? result.math.spr : (ctx.spr || 2.0);
            const toCall = (result.math && typeof result.math.toCall === 'number') ? result.math.toCall : villainBet;

            // 提取抽牌与合法先验信息 (严格校验状态白名单与动作合法性，排除 CHECK-only 脏先验)
            function extractValidPrior(res, isFacing) {
                const lut = res.lutResult || (res.shadowRes && res.shadowRes.lutResult);
                if (!lut || typeof lut !== 'object') return null;
                const allowedStatuses = ['MATCHED_LUT', 'SUCCESS', 'EXACT_MATCH', 'INTERPOLATED'];
                if (!lut.status || !allowedStatuses.includes(lut.status)) return null;
                if (!lut.frequencies || typeof lut.frequencies !== 'object') return null;

                let sum = 0;
                const freqs = {};
                for (const [k, v] of Object.entries(lut.frequencies)) {
                    const num = Number(v);
                    const ku = k.toUpperCase();
                    if (Number.isFinite(num) && num > 0) {
                        // 面对下注时，CHECK 是非法动作，严禁计入先验质量
                        if (isFacing && ku === 'CHECK') continue;
                        if (!isFacing && (ku === 'FOLD' || ku === 'CALL')) continue;
                        freqs[ku] = num;
                        sum += num;
                    }
                }
                if (sum <= 0) return null;
                return { raw: lut, freqs, sum };
            }

            const validPrior = extractValidPrior(result, isFacingBet);
            const outs = (state.equityResult && typeof state.equityResult.outs === 'number') ? state.equityResult.outs : (result.outs || 0);

            // 静态临界带判定：实际准入门槛必须与不确定性上下文严格单源对齐，杜绝二次拼接置信区间
            const uncert = result.uncertainty;
            const isBoundary = !!(uncert && uncert.sampling && uncert.sampling.isThresholdInCI);

            // 核心治理 (Astra-043 终审准入)：
            // 仅当上游候选动作为 FOLD 或以 FOLD 为主 (>= 80%) 时，才作为受害者评估救援！
            // 若上游候选动作已是正期望进攻或防守 (RAISE / BET / CALL / ALLIN)，绝不越权降级！
            const upstreamAct = (result.primaryAction || '').toUpperCase();
            const upstreamFoldFreq = (result.frequencies ? (result.frequencies.fold ?? result.frequencies.FOLD ?? 0) : 0);
            const isUpstreamFold = (upstreamAct === 'FOLD') || (upstreamFoldFreq >= 80) || (!result.primaryAction);

            if (isUpstreamFold) {
                const statEquity = (mcStats && mcStats.valid) ? (mcStats.mean * 100) : equity;
                const isDirectOddsMet = (statEquity >= potOdds);
                const isStrongDraw = (outs >= 8);

                // 无适用合法先验时，严禁仅凭静态权益和 outs 强行覆盖弃牌 (无续街价值证明不可凭空制造跟注)
                if (!validPrior) {
                    return finalizeDecisionResult(result, legalActions);
                }

                // 仅当满足场景 A (强进张且静态胜率满足赔率) 或场景 B (置信临界带) 时，才评估仲裁干预
                if ((isDirectOddsMet && isStrongDraw) || isBoundary) {
                    const foldShare = validPrior.freqs.FOLD || 0;
                    const callShare = validPrior.freqs.CALL || 0;
                    const raiseShare = validPrior.freqs.RAISE || 0;
                    const allinShare = validPrior.freqs.ALLIN || 0;
                    const defendShare = callShare + raiseShare + allinShare;
                    const isPriorFoldDominant = (foldShare > defendShare);

                    // 若先验存在且先验明确判定弃牌为主，严格遵从先验，绝不越权强行跟注
                    if (isPriorFoldDominant) {
                        result.frequencies = {
                            fold: foldShare,
                            call: callShare,
                            raise: raiseShare,
                            allin: allinShare
                        };
                        result.primaryAction = 'FOLD';
                        result.sizing = '';
                        result.reasoning = `⚡ [策略仲裁 · 策略先验弃牌]：转牌 SPR=${sprVal.toFixed(1)}，当前先验以弃牌为主（弃牌 ${foldShare}%），维持弃牌建议。`;
                        result.arbitrationSource = 'STATIC_EQUITY_BOUNDARY';
                        return finalizeDecisionResult(result, legalActions);
                    }

                    // 先验判定防守占优：100% 忠实遵从先验分配，彻底拆除任何 Math.max(callShare, 70) 硬编码
                    // 必须完整保留 fold, call, raise, allin 四元结构，绝不合并或丢弃 raiseShare / allinShare
                    result.frequencies = {
                        fold: foldShare,
                        call: callShare,
                        raise: raiseShare,
                        allin: allinShare
                    };
                    let targetSizing = '';
                    if (allinShare >= Math.max(callShare, raiseShare, foldShare) && allinShare > 0) {
                        targetSizing = (effStack > 0) ? `All-in ${effStack.toFixed(1)}BB（全押）` : '全押';
                    } else if (raiseShare >= Math.max(callShare, allinShare, foldShare) && raiseShare > 0) {
                        targetSizing = validPrior.raw.sizing || `${(villainBet * 2.5).toFixed(1)}BB`;
                    } else {
                        targetSizing = (validPrior.raw && validPrior.raw.sizing) || '';
                    }
                    result.sizing = targetSizing;
                    const reasonTag = isDirectOddsMet ? '进张胜率保护' : '静态权益临界带';
                    result.reasoning = `⚡ [策略仲裁 · ${reasonTag} (Prior 驱动)]：转牌 SPR=${sprVal.toFixed(1)}，持有 ${outs} 张进张（静态胜率 ${equity.toFixed(1)}%），需跟注 ${toCall.toFixed(1)}BB（底池赔率 ${potOdds.toFixed(1)}%）。依据适用策略先验恢复防守！`;
                    result.arbitrationSource = 'STATIC_EQUITY_BOUNDARY';
                    return finalizeDecisionResult(result, legalActions);
                }
            }
        }

        // ── 仲裁优先级 3: 转牌跃迁与多档位几何注额 (Turn Sizing & Transition Engine) ──
        if (street === 'turn' && result.turnSizing && result.turnSizing.status === 'MATCHED_TURN_SIZING') {
            const ts = result.turnSizing;
            if (!isFacingBet) {
                // 若转牌原本已被 TexasSolver (环节 7 驱动量校准) 精确解算频率，保留其频率与理由
                if (result.reasoning && result.reasoning.includes('TexasSolver')) {
                    if (ts.primaryTier && ts.primaryTier !== '过牌' && ts.primaryBb > 0 && !result.sizing) {
                        result.sizing = `${ts.primaryTier} (${ts.primaryBb}BB)`;
                    }
                    result.arbitrationSource = 'TURN_SIZING';
                    result.isUnified = true;
                    return finalizeDecisionResult(result, legalActions);
                }
                if (ts.primaryTier === '过牌' || ts.action === 'CHECK') {
                    result.primaryAction = 'CHECK';
                    result.sizing = '';
                    const chkF = (ts.frequencies && ts.frequencies.check !== undefined) ? ts.frequencies.check : 90;
                    result.frequencies = closeFrequencies({
                        check: chkF,
                        bet: Math.max(0, 100 - chkF)
                    });
                } else if (ts.primaryTier === 'ALLIN' || ts.action === 'ALLIN') {
                    result.primaryAction = 'BET';
                    result.sizing = (effStack > 0) ? `All-in ${effStack.toFixed(1)}BB（全押）` : '全押';
                    const allinF = (ts.frequencies && ts.frequencies.allin !== undefined) ? ts.frequencies.allin : 75;
                    result.frequencies = closeFrequencies({
                        bet: allinF,
                        check: Math.max(0, 100 - allinF)
                    });
                } else {
                    result.primaryAction = 'BET';
                    result.sizing = `${ts.primaryTier}${ts.primaryBb > 0 ? ` (${ts.primaryBb}BB)` : ''}`;
                    const chkF = (ts.frequencies && ts.frequencies.check !== undefined) ? ts.frequencies.check : 20;
                    result.frequencies = closeFrequencies({
                        bet: Math.max(0, 100 - chkF),
                        check: chkF
                    });
                }
                if (ts.rationale) {
                    const tName = result.turnTransition ? (result.turnTransition.typeName || '') : '';
                    const xrTag = (result.actionLine && result.actionLine.isPostXRNode) ? ' · Check-Raise 第二桶持续施压' : '';
                    result.reasoning = `🔄 [转牌几何规划${tName ? ` · ${tName}` : ''}${xrTag}]：${ts.rationale}`;
                }
                result.arbitrationSource = 'TURN_SIZING';
                result.isUnified = true;
                return finalizeDecisionResult(result, legalActions);
            }
        }

        // ── 仲裁优先级 4: 多人底池纯诈唬压制 (Multiway Dynamics Engine) ──
        if (result.multiwayDynamics && result.multiwayDynamics.isMultiway) {
            const mw = result.multiwayDynamics;
            if (!isFacingBet && !mw.pureBluffAllowed && (result.frequencies && result.frequencies.bet > 0)) {
                const equity = (state.equityResult ? state.equityResult.equity : 0);
                if (equity < 30) {
                    result.primaryAction = 'CHECK';
                    result.sizing = '';
                    result.frequencies = { check: 100, bet: 0 };
                    result.reasoning = `👥 [多人底池控池]：${mw.numContenders}人底池严禁空气牌诈唬，100% 采取防守过牌；${result.reasoning || ''}`;
                    result.arbitrationSource = 'MULTIWAY_SUPPRESSION';
                    result.isUnified = true;
                    return finalizeDecisionResult(result, legalActions);
                }
            }
        }

        // ── 仲裁优先级 5: 对手画像与节点锁定剥削偏转保护 (Villain Profile & Exploit Integration, DEF-MW-04) ──
        const exploitOffset = result.exploitOffset || (ctx && ctx.exploitOffset) || null;
        const vProfile = result.villainProfile || (ctx && ctx.villainProfile) || (state && state.villainProfile) || null;

        if (exploitOffset && exploitOffset.applied) {
            // 前端 R-02 节点锁定剥削已显式生效，保留剥削主动作与注额，防止被底层统合裁决器抹杀
            if (result._rawPrimaryAction && legalActions.includes(result._rawPrimaryAction)) {
                result.primaryAction = result._rawPrimaryAction;
                result.sizing = result._rawSizing || result.sizing;
                if (result._rawFrequencies && Object.keys(result._rawFrequencies).length > 0) {
                    result.frequencies = closeFrequencies(result._rawFrequencies);
                }
            }
            if (exploitOffset.note && !(result.reasoning && result.reasoning.includes('节点锁定剥削'))) {
                result.reasoning = (result.reasoning ? result.reasoning + '\n' : '') + `🎯 [节点锁定剥削偏转]：${exploitOffset.note}`;
            }
            result.arbitrationSource = 'EXPLOIT_NODELOCK';
            result.isUnified = true;
            return finalizeDecisionResult(result, legalActions);
        } else if (vProfile && vProfile.id && vProfile.id !== 'balanced') {
            // 对手画像偏转 (bluffBias, cbetBias) 微调
            if (result.frequencies) {
                const freqs = Object.assign({}, result.frequencies);
                if (!isFacingBet && typeof vProfile.cbetBias === 'number' && vProfile.cbetBias !== 0) {
                    if (freqs.bet !== undefined && freqs.check !== undefined) {
                        freqs.bet = Math.max(0, Math.min(100, freqs.bet + vProfile.cbetBias));
                        freqs.check = Math.max(0, 100 - freqs.bet);
                        result.frequencies = closeFrequencies(freqs);
                    }
                } else if (isFacingBet && typeof vProfile.bluffBias === 'number' && vProfile.bluffBias !== 0) {
                    if (freqs.call !== undefined && freqs.fold !== undefined) {
                        const shift = Math.round(vProfile.bluffBias * 0.25);
                        freqs.call = Math.max(0, Math.min(100, freqs.call + shift));
                        freqs.fold = Math.max(0, 100 - freqs.call - (freqs.raise || 0) - (freqs.allin || 0));
                        result.frequencies = closeFrequencies(freqs);
                    }
                }
                if (!result.primaryAction || !result.arbitrationSource) {
                    let maxAct = result.primaryAction;
                    let maxF = -1;
                    for (const [actKey, fVal] of Object.entries(result.frequencies)) {
                        if (fVal > maxF) {
                            maxF = fVal;
                            maxAct = actKey.toUpperCase();
                        }
                    }
                    if (maxAct && legalActions.includes(maxAct)) {
                        result.primaryAction = maxAct;
                    }
                }
            }
        }

        // ── 兜底保证：频率严格闭合为 100% ──
        if (!result.arbitrationSource) {
            result.arbitrationSource = 'BASE_GTO_ENGINE';
        }
        return finalizeDecisionResult(result, legalActions);
    }

    return {
        closeFrequencies: closeFrequencies,
        finalizeDecisionResult: finalizeDecisionResult,
        resolveUnifiedDecision: resolveUnifiedDecision,
        computeMonteCarloVariance: computeMonteCarloVariance,
        createUncertaintyContext: createUncertaintyContext,
        extractCountsFromEquityResult: extractCountsFromEquityResult
    };
}));
