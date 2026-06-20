# 모델 간 호환성 문제 분석 및 수정 보고서

대상: `애미나이 ver.1.8.33 (Flex)` — Google Gemini(나노바나나) / xAI Grok 이미지 생성·편집 웹앱(단일 HTML, React UMD)

작성 원칙: 코드에서 직접 검증 가능한 사실만 기술한다. 외부 모델의 안전성(safety) 판정 등 앱이 통제할 수 없는 영역은 명시적으로 구분한다.

---

## 1. 증상 (사용자 보고)

| # | 시나리오 | 결과 |
|---|----------|------|
| 1 | 나노바나나 1로 생성 → 다른 모델로 후속 편집 | 가능 |
| 2 | 다른 모델로 생성 → 나노바나나 1로 후속 편집 | 불가능 |
| 3 | 나노바나나 1로 생성 → 나노바나나 1로 계속 편집 | 가능 |

핵심은 **"동일 모델 편집(3)"과 "교차 모델 편집(2)"의 동작이 다르다**는 비대칭성이다.

## 2. 코드상 메커니즘 (검증된 사실)

`generateImages()`는 후속 편집 시 **3가지 연속성 모드** 중 하나를 고른다 (수정 전 기준 `original.html`):

- `direct` — 직전 이미지를 **새 업로드 이미지**(`role:'user'` inline)로 첨부
- `conversation` — 직전 이미지를 **모델 자신의 이전 출력**(`role:'model'` inline, 멀티턴 히스토리)으로 유지
- `memory` — 텍스트 메모리만 사용

모드 결정의 핵심 게이트는 `getReferenceCompatibility()`의 한 줄이었다:

```js
canUseGoogleModelHistory: targetProvider === 'google' && sourceProvider !== 'xai'
                          && !modelMismatch && !aspectMismatch
```

`modelMismatch`는 **소스 모델 ID ≠ 타깃 모델 ID**일 때 참, 즉 **모든 교차 모델 편집**에서 참이다. 따라서:

- **시나리오 3 (나노1→나노1)**: `modelMismatch=false` → `conversation` 모드. 모델이 **자기 출력**을 이어 편집.
- **시나리오 2 (타모델→나노1)**: `modelMismatch=true` → `conversation` 차단 → `direct` 모드로 강등. 모델이 직전 이미지를 **외부에서 들어온 사용자 사진**으로 취급.

이 강등이 동일 모델 편집과 교차 모델 편집의 **동작 차이를 만드는 코드상 직접 원인**이다.

### 2.1 `modelMismatch` 차단이 과도한 이유

두 Google 이미지 모델은 **동일한 `generateContent` 대화 스키마**를 공유한다. 교차 모델에서 실제로 존재하는 제약은 단 하나, **gemini-3 계열의 `thoughtSignature`(추론 상태 서명) 요구**뿐이다.

- 최신 공식 문서 확인: gemini-3 이미지 모델은 멀티턴 히스토리의 모든 Model 파트에 `thoughtSignature`를 요구하며, 누락 시 400 오류가 난다. (ai.google.dev/gemini-api/docs/gemini-3, /thought-signatures)
- 반면 **나노바나나 1 = `gemini-2.5-flash-image`는 서명을 요구하지 않는다.**

그런데 이 서명 제약은 이미 `generateImages()`의 **별도 게이트**에서 강제되고 있다:

```js
const canUseConversationModelImage = hasConversationModelImageRaw
  && referenceCompatibility.canUseGoogleModelHistory
  && (!requiresSignedGoogleModelHistory(modelId) || hasGoogleModelHistoryImageSignature(slicedMessages));
```

즉 `modelMismatch` 차단은 **불필요한 이중 차단**이었고, 그 부작용으로 *서명이 필요 없는 나노바나나 1조차* 교차 모델일 때 `conversation` 연속성을 못 쓰고 `direct`로 강등됐다.

## 3. 수정 내용 (`애미나이_수정본.html`)

1. **`canUseGoogleModelHistory`에서 `!modelMismatch` 제거** — Google↔Google 교차 편집에서 네이티브 대화 연속성을 허용. 비율 차이(`aspectMismatch`)는 아웃페인팅 재구성(direct 경로)이 필요하므로 그대로 유지.
2. **`filterGoogleModelHistoryPartsForRequest` 보강** — 서명을 요구하지 않는 타깃(나노바나나 1)으로 히스토리를 보낼 때 다른 모델이 남긴 잔여 `thoughtSignature`를 제거(`stripThoughtSignatureFromPart`). 무의미한 서명 전달로 인한 거부 가능성 차단.
3. **죽은 코드 정리**:
   - `shouldPreferGoogleTextContinuityFirst()` — 항상 `false`를 반환하던 더미 함수와 그 호출부 제거(동작 불변).
   - `shouldAdaptSingleImageEditReference` — 어디서도 소비되지 않던 필드 제거.

### 회귀 안전성 (검증)

- **나노1→나노프로/나노2 (gemini-3 타깃)**: gemini-3은 서명을 요구하고, 나노1 이미지엔 서명이 없으므로 `hasGoogleModelHistoryImageSignature=false` → `canUseConversationModelImage=false` → 종전대로 `direct`. **변화 없음(회귀 없음).**
- **나노프로/나노2→나노1 (gemini-2.5 타깃)**: 이제 `conversation` 모드 사용 → 시나리오 3과 동일 동작. **개선.**
- **동일 모델/동일 비율**: 종전과 동일.
- 인라인 스크립트 구문 검증(`vm.Script`) 통과, 잔여 미사용 const 0건.

## 4. 객관적 한계 (과장 없는 범위 고지)

- 본 수정은 **Google↔Google 교차 편집**의 코드상 비대칭(연속성 모드 강등)을 제거한다. 이것이 시나리오 3이 시나리오 2보다 관대했던 메커니즘이다.
- **xAI(Grok)→나노바나나 1** 방향은 Google 대화 히스토리에 소스 이미지가 존재하지 않으므로(타 provider 출력) 반드시 `direct` 참조로 보낼 수밖에 없다. 이 경로의 최종 허용/거부는 **Google 모델의 안전성 판정**이며 클라이언트 코드로 동일하게 맞출 수 없다.
- `safetySettings`(4개 카테고리 `BLOCK_ONLY_HIGH`)는 시나리오 2와 3에서 **동일**하므로 비대칭의 원인이 아니다. 본 수정에서는 안전성 임계값을 변경하지 않았다.
