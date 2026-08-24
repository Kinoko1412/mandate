pragma circom 2.0.0;

include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";

// carbon_proof — 供應商私密持有各製程階段排放分量，證明：
//   總碳足跡（totalScaled）= sum_i(quantityScaled[i] * factorScaled[i]) / SCALE
// 且 totalScaled <= complianceThresholdScaled（合規區間）。
//
// 私密輸入（不揭露）：quantityScaled[N] —— 各製程階段的排放分量（已用 SCALE=10^6
//   定點表示，對齊 packages/contracts/fixedPoint.js 的共用 scale 慣例）。
// 公開輸入：factorScaled[N] —— 各製程階段對應的公開排放係數；complianceThresholdScaled ——
//   合規上限。
// 公開輸出：totalScaled —— 總 tCO2e（海關申報需要，不藏）；compliant —— 是否落在合規區間。
//
// 設計取捨（README 有完整說明）：
//   - INPUT_BITS 範圍檢查每個私密/公開輸入，避免惡意 prover 利用 field 環繞（wraparound）
//     偽造遠超真實量級的分量、卻在除以 SCALE 或模運算後看起來很小。
//   - 除法只做一次（在加總之後），不是每個階段都做一次除法——除法在 circom 裡沒有原生
//     運算子，用「見證賦值 quotient/remainder + 範圍檢查 + 乘回驗證」的標準模式實作，
//     必須明確驗證 remainder < SCALE，否則同一個 sum 可以對應到多組 (quotient, remainder)。
template CarbonProof(N, INPUT_BITS, SUM_BITS) {
    signal input quantityScaled[N]; // private
    signal input factorScaled[N];   // public
    signal input complianceThresholdScaled; // public

    signal output totalScaled;
    signal output compliant;

    component qRange[N];
    component fRange[N];
    signal contribution[N];
    signal sumDoubleScaled[N + 1];
    sumDoubleScaled[0] <== 0;

    for (var i = 0; i < N; i++) {
        // 範圍檢查：quantityScaled[i] / factorScaled[i] 必須落在 [0, 2^INPUT_BITS)。
        // Num2Bits 若輸入的正規field值 >= 2^INPUT_BITS 會讓重組約束無法滿足，等於強制拒絕。
        qRange[i] = Num2Bits(INPUT_BITS);
        qRange[i].in <== quantityScaled[i];
        fRange[i] = Num2Bits(INPUT_BITS);
        fRange[i].in <== factorScaled[i];

        contribution[i] <== quantityScaled[i] * factorScaled[i];
        sumDoubleScaled[i + 1] <== sumDoubleScaled[i] + contribution[i];
    }

    // sumDoubleScaled[N] 是「雙倍 scale」（quantityScaled 跟 factorScaled 都帶一個 SCALE），
    // 除以 SCALE 還原成單一 scale，對齊 fixedPoint.js 的 mulScaled 慣例。
    signal quotient;
    signal remainder;
    quotient <-- sumDoubleScaled[N] \ 1000000;
    remainder <-- sumDoubleScaled[N] % 1000000;
    // 乘回驗證：確保 witness 賦的 quotient/remainder 真的滿足 sum = quotient*SCALE + remainder，
    // 不是隨便填兩個數字。
    sumDoubleScaled[N] === quotient * 1000000 + remainder;

    // remainder 必須嚴格小於 SCALE，否則 (quotient, remainder) 不是唯一分解
    // （例如 quotient-1, remainder+1000000 也會滿足上面那條乘回驗證）。
    component remainderRange = LessThan(SUM_BITS);
    remainderRange.in[0] <== remainder;
    remainderRange.in[1] <== 1000000;
    remainderRange.out === 1;

    totalScaled <== quotient;

    component complianceCheck = LessEqThan(SUM_BITS);
    complianceCheck.in[0] <== totalScaled;
    complianceCheck.in[1] <== complianceThresholdScaled;
    compliant <== complianceCheck.out;
}

// N=4：對齊分工計畫「CBAM 原生類別」框架（直接排放／產量／precursor／分攤依據）四個階段。
// INPUT_BITS=64：單一階段分量/係數上限 2^64（遠超真實量級，但遠小於 bn128 field，
//   兩個 64-bit 數相乘最多 128-bit，四個相加最多 130-bit，不會在 field 內環繞）。
// SUM_BITS=132：涵蓋 sumDoubleScaled 與 complianceThreshold 的比較範圍。
component main {public [factorScaled, complianceThresholdScaled]} = CarbonProof(4, 64, 132);
